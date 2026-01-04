/**
 * ParasitePlugin - 寄生插件（Client 端）
 *
 * 生物学比喻：
 * - 本地 Agent（寄生者）主动连接到云端 Host Agent（宿主）
 * - 寄生者借助宿主的网络端点对外提供服务
 * - 寄生者依赖宿主存活，宿主断开则寄生者失去连接
 *
 * 核心功能：
 * 1. 连接到远程 Host Agent 并发送注册请求
 * 2. 保持双向流连接，接收来自 Host Agent 的调用转发
 * 3. 将调用路由到本地 Agent 的技能处理器
 *
 * 使用场景：
 * - Tool Agent 使用此插件，寄生到云端 Host Agent
 * - 注册后 Tool Agent 成为 "一等公民"，可被 Agent Selector 选择
 * - Host Agent 的调用通过双向流透明转发给 Tool Agent
 *
 * 消息协议：
 * - agent-register: 发送注册请求（data: { agentCard: AgentCard }）
 * - agent-unregister: 发送注销请求（无需参数，Server 通过 stream 映射识别）
 * - call: 接收调用转发（从 Host Agent 转发）
 * - done/error/progress: 发送调用响应（返回给 Host Agent）
 *
 * @example
 * ```typescript
 * // 业务层决定 namespace
 * const namespace = `tool-agent@${userId}`
 *
 * const parasitePlugin = createParasitePlugin({
 *   address: 'a2a://host-agent.example.com:50050',
 *   namespace,  // 必传，由外部决定
 * })
 *
 * const server = createAgentServer(config)
 *   .use(parasitePlugin)
 *
 * await server.start()
 * // Tool Agent 启动后自动寄生到 Host Agent
 * ```
 */

import type { ServerPlugin, ServerHooks, AgentCard, AgentConfig, BidirectionalStream, Message, SkillHandlers } from '../../types'
import { createAgentClient } from '../../core/client'
import { parseA2AAddress } from '../../utils/endpoint'
import { retry } from '@multi-agent/agent-kit'

/**
 * 事件回调配置
 */
export interface ParasiteEventCallbacks {
  /**
   * 连接断开时触发（与宿主断开）
   */
  onDisconnect?: () => void

  /**
   * 开始重连时触发
   * @param attempt 当前重试次数
   * @param delay 距离下次重试的延迟（毫秒）
   */
  onReconnecting?: (attempt: number, delay: number) => void

  /**
   * 重连成功时触发（重新寄生成功）
   */
  onReconnected?: () => void

  /**
   * 首次寄生成功时触发
   */
  onRegistered?: () => void

  /**
   * 发生错误时触发
   * @param error 错误对象
   */
  onError?: (error: Error) => void
}

/**
 * ParasitePlugin 配置
 */
export interface ParasitePluginConfig {
  /**
   * 宿主地址（Host Agent 地址）
   *
   * 格式：a2a[s]://host:port
   * - a2a://  表示无 TLS
   * - a2as:// 表示使用 TLS
   *
   * @example 'a2a://localhost:50050'
   * @example 'a2as://api.example.com:50050'
   */
  address: string
  /**
   * namespace（必传）
   *
   * 用于在宿主端标识此 Agent 的唯一路由键
   * 由业务层决定，ParasitePlugin 不关心其格式和含义
   * 例如："tool-agent@user123"、UUID、sessionId 等
   */
  namespace: string
  /**
   * 重连配置（可选）
   *
   * 用于控制连接失败或断开后的重试行为
   */
  reconnect?: ReconnectConfig
  /**
   * 事件回调（可选）
   *
   * 用于监听连接状态变化，实现用户通知等功能
   */
  callbacks?: ParasiteEventCallbacks
}

/**
 * ParasitePlugin 接口
 */
export interface ParasitePlugin extends ServerPlugin {
  /**
   * 检查是否已寄生到 Host Agent
   */
  isRegistered: () => boolean

  /**
   * 获取寄生状态
   */
  getRegistrationStatus: () => {
    registered: boolean
    registeredAt?: number
    /** 宿主地址（a2a:// 格式） */
    hostAddress: string
  }

  /**
   * 断开连接并脱离宿主
   */
  detach: () => Promise<void>
}

/**
 * 重连配置
 */
export interface ReconnectConfig {
  /** 最大重试次数（默认无限重试） */
  maxRetries?: number
  /** 基础延迟（毫秒，默认 2000） */
  baseDelay?: number
  /** 最大延迟（毫秒，默认 60000） */
  maxDelay?: number
}

/**
 * 默认重连配置
 */
const DEFAULT_RECONNECT_CONFIG: Required<ReconnectConfig> = {
  maxRetries: Infinity,
  baseDelay: 2000,
  maxDelay: 60000,
}

/**
 * 创建 ParasitePlugin（寄生插件）
 *
 * 使本地 Agent 能够寄生到远程 Host Agent，
 * 借助宿主的网络端点对外提供服务。
 */
export const createParasitePlugin = (config: ParasitePluginConfig): ParasitePlugin => {
  const { address: hostAddress, namespace, callbacks } = config
  // 验证地址格式（会在地址无效时抛出错误）
  parseA2AAddress(hostAddress)
  const reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...config.reconnect }

  // 状态
  let registered = false
  let registeredAt: number | undefined
  let stream: BidirectionalStream | null = null
  let agentCard: AgentCard | null = null
  /**
   * 已激活的 Handlers Map
   *
   * 由 Server 在 onStart 钩子中传递，包含所有技能的 handler
   * 这些 handler 已经组合了 beforeHandler/afterHandler 钩子，
   * 确保通过寄生转发的调用也会正确执行钩子（如 IO 计量）
   */
  let handlers: SkillHandlers | null = null
  let shouldReconnect = true // 控制是否应该重连
  let isFirstRegistration = true // 区分首次注册和重连

  /**
   * 处理来自 Host Agent 的调用转发
   *
   * 安全设计：
   * - 使用 handlers（已组合钩子的 handler）
   * - 确保通过寄生转发的调用也会正确执行 beforeHandler/afterHandler 钩子
   * - 解决之前直接调用 skillDef.handler() 绕过钩子的安全漏洞
   */
  const handleForwardedCall = async (message: Message): Promise<void> => {
    if (!stream || !handlers) {
      console.error('[ParasitePlugin] 收到调用转发但未准备好')
      return
    }

    const correlationId = message.data?.__parasiteCorrelationId
    const { skill, params } = message.data || {}

    console.log(`[ParasitePlugin] 收到调用转发 [${correlationId}]: ${skill}`)

    // 创建响应流包装器
    // 统一在一处注入 correlationId 和 from（Tool Agent 的 AgentCard）
    // 注意：寄生场景下 ctx.stream 是这个包装的 responseStream，不是框架包装的 stream
    // 所以需要手动设置 from 字段，否则消息会被标记为 Proxy Agent 发送
    const responseStream: BidirectionalStream = {
      send: (msg: Message) => {
        stream!.send({
          ...msg,
          from: agentCard!, // 设置 from 为 Tool Agent 的 AgentCard（消息来源身份）
          data: {
            ...msg.data,
            __parasiteCorrelationId: correlationId,
          },
        })
      },
      end: () => {}, // 寄生场景下不关闭流
      cancel: () => {}, // 寄生场景下不取消流
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: undefined as any, done: true }),
      }),
    }

    // 从 handlers 获取 handler（已组合 beforeHandler/afterHandler 钩子）
    const handler = handlers.get(skill)
    if (!handler) {
      responseStream.send({
        type: 'error',
        text: `技能 ${skill} 不存在`,
        data: { code: 'SKILL_NOT_FOUND', skill },
      })
      return
    }

    // 创建技能上下文（支持计费追踪）- 隧道解封装模式
    //
    // 隧道解封装设计（类似 VPN）：
    // - ParasiteHostPlugin 将原始 gRPC metadata 封装到 data.__parasiteGrpcMetadata 中
    // - 这里解封装并还原为与云端 Agent 一致的 ctx.metadata 接口
    // - Tool Agent 无需感知是否通过寄生调用，代码完全透明
    //
    // 为什么放在 data 而不是 message.metadata？
    // - Proto 的 Call 消息没有 metadata 字段，只有 Business 消息有
    // - data 是 bytes 类型，可以存储任意 JSON
    // - 这样 call 消息也能正确传递 gRPC metadata
    //
    // metadata 接口实现（模拟 gRPC Metadata API）：
    // - get(key): 返回 [value] 数组
    // - getMap(): 返回所有 metadata 的对象形式
    const tunnelledGrpcMetadata: Record<string, any> = message.data?.__parasiteGrpcMetadata || {}

    console.log(`[ParasitePlugin] 解封装 gRPC metadata:`, {
      hasMetadata: Object.keys(tunnelledGrpcMetadata).length > 0,
      metadataKeys: Object.keys(tunnelledGrpcMetadata),
      userId: tunnelledGrpcMetadata['x-user-id'],
    })

    // 创建统一的 metadata 接口对象（模拟 gRPC Metadata API）
    // 同时赋值给 ctx.metadata 和 ctx.grpcMetadata，确保与云端 Agent 行为一致
    // 这样 tracing-plugin 等框架插件可以透明地使用 ctx.grpcMetadata
    const metadataInterface = {
      get: (key: string) => {
        const value = tunnelledGrpcMetadata[key]
        return value !== undefined ? [value] : []
      },
      set: (key: string, value: any) => {
        // 写入隧道 metadata（供下游读取）
        tunnelledGrpcMetadata[key] = value
      },
      remove: (key: string) => {
        delete tunnelledGrpcMetadata[key]
      },
      getMap: () => tunnelledGrpcMetadata,
      toHttp2Headers: () => tunnelledGrpcMetadata,
      clone: function () { return this },
    }

    const ctx: any = {
      streamId: correlationId || 'parasite',
      stream: responseStream,
      // metadata 和 grpcMetadata 指向同一个接口对象
      // - metadata: 供业务代码使用（如 ctx.metadata.get('x-user-id')）
      // - grpcMetadata: 供 tracing-plugin 等框架插件使用（如 ctx.grpcMetadata?.get('x-span-id')）
      metadata: metadataInterface,
      grpcMetadata: metadataInterface,
      getAgentCard: () => agentCard!,
      getMetadata: () => undefined,
      // traceId/sessionId 通过 grpcMetadata 传递（单一数据源）
      // Handler 通过 ctx.metadata.get('x-trace-id') 访问
      message,
    }

    try {
      // 调用受保护的 handler（内部已包含 beforeHandler/afterHandler 钩子执行逻辑）
      const result = await handler(params, ctx)

      responseStream.send({
        type: 'done',
        text: `技能 ${skill} 执行完成`,
        data: { result },
      })
    } catch (error: any) {
      // 直接使用原始错误信息，与 server.ts 错误处理保持一致
      responseStream.send({
        type: 'error',
        text: error.message || String(error),
        data: {
          code: error.code || 'SKILL_EXECUTION_ERROR',
          retryable: error.retryable ?? false,
        },
      })
    }
  }

  /**
   * 处理来自 Host Agent 的消息（寄生成功后的消息处理）
   */
  const handleMessage = async (message: Message): Promise<void> => {
    switch (message.type) {
      case 'error':
        console.error(`[ParasitePlugin] 收到错误: ${message.text}`)
        callbacks?.onError?.(new Error(message.text || 'Unknown error'))
        break

      case 'call':
        // 调用转发
        await handleForwardedCall(message)
        break

      case 'answer':
      case 'cancel':
        // 后续消息，转发给当前正在执行的方法
        // TODO: 需要更复杂的会话管理来支持这个
        console.log(`[ParasitePlugin] 收到后续消息: ${message.type}`)
        break

      default:
        console.log(`[ParasitePlugin] 收到未知消息类型: ${message.type}`)
    }
  }

  /**
   * 启动消息监听循环（寄生成功后调用）
   *
   * 当连接断开时，如果 shouldReconnect 为 true，会触发重连
   */
  const runMessageLoop = async (): Promise<void> => {
    try {
      for await (const message of stream!) {
        await handleMessage(message)
      }
    } catch (error) {
      console.error('[ParasitePlugin] 流处理错误:', error)
    } finally {
      registered = false
      stream = null
      console.log('[ParasitePlugin] 与宿主断开连接')

      // 触发断开连接回调
      callbacks?.onDisconnect?.()

      // 触发重连
      if (shouldReconnect) {
        console.log('[ParasitePlugin] 检测到断线，准备重新注册...')
        scheduleReconnect()
      }
    }
  }

  /**
   * 调度重新注册（带指数退避）
   */
  const scheduleReconnect = (): void => {
    if (!shouldReconnect) return

    // 使用 retry 实现指数退避重连
    retry(
      async () => {
        if (!shouldReconnect) {
          throw new Error('重连已取消')
        }
        await connectAndRegister()
      },
      {
        maxRetries: reconnectConfig.maxRetries,
        baseDelay: reconnectConfig.baseDelay,
        maxDelay: reconnectConfig.maxDelay,
        onRetry: (error, attempt, delay) => {
          console.log(`[ParasitePlugin] 寄生失败，重试 ${attempt}/${reconnectConfig.maxRetries === Infinity ? '∞' : reconnectConfig.maxRetries} (延迟 ${Math.round(delay)}ms): ${error.message}`)
          callbacks?.onReconnecting?.(attempt, Math.round(delay))
        },
      },
    ).catch(err => {
      if (shouldReconnect) {
        console.error('[ParasitePlugin] 寄生最终失败:', err.message)
      }
    })
  }

  /**
   * 连接到 Host Agent 并注册
   *
   * 关键设计：等待注册响应后才返回
   * - 成功：收到 done 消息且 data.success === true
   * - 失败：收到 error 消息、流结束、或超时
   *
   * 这样 retry 机制才能正确判断连接是否成功
   */
  const connectAndRegister = async (): Promise<void> => {
    if (!agentCard) {
      throw new Error('AgentCard 未设置，请确保插件已正确初始化')
    }

    console.log(`[ParasitePlugin] 连接到宿主: ${hostAddress}`)

    // 整个连接+寄生过程的超时（10秒）
    const timeout = 10000
    let timeoutId: NodeJS.Timeout | null = null

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        console.log(`[ParasitePlugin] 寄生超时 (${timeout}ms)`)
        reject(new Error(`寄生超时 (${timeout}ms)`))
      }, timeout)
    })

    const doConnectAndRegister = async (): Promise<void> => {
      // 创建客户端
      const client = createAgentClient({
        agentId: 'parasite-client',
        address: hostAddress,
      })

      // 建立双向流连接
      console.log(`[ParasitePlugin] 正在建立连接...`)
      stream = await client.connect()
      console.log(`[ParasitePlugin] 连接已建立`)

      // 发送寄生注册消息
      stream.send({
        type: 'agent-register',
        text: `寄生 Agent: ${agentCard!.name}`,
        data: { agentCard, namespace },
      })
      console.log(`[ParasitePlugin] 已发送寄生请求: ${agentCard!.name}`)

      // 等待寄生响应
      console.log(`[ParasitePlugin] 等待宿主响应...`)
      const iterator = stream[Symbol.asyncIterator]()
      const { value: message, done } = await iterator.next()
      console.log(`[ParasitePlugin] 收到响应: type=${message?.type}, done=${done}`)

      if (done || !message) {
        throw new Error('连接意外关闭，未收到宿主响应')
      }

      // 处理寄生响应
      if (message.type === 'done' && message.data?.success && message.data?.agentId) {
        // 寄生成功
        registered = true
        registeredAt = Date.now()
        console.log(`[ParasitePlugin] 寄生成功: ${message.data.agentId}`)

        // 触发回调：区分首次注册和重连
        if (isFirstRegistration) {
          isFirstRegistration = false
          callbacks?.onRegistered?.()
        } else {
          callbacks?.onReconnected?.()
        }

        // 寄生成功后，启动消息循环处理后续消息（不阻塞）
        runMessageLoop()
        return
      }

      if (message.type === 'error') {
        throw new Error(message.text || '寄生失败')
      }

      // 其他消息类型视为异常
      throw new Error(`收到意外的寄生响应: ${message.type}`)
    }

    try {
      await Promise.race([doConnectAndRegister(), timeoutPromise])
    } finally {
      // 清理超时定时器
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }

  /**
   * 脱离宿主
   */
  const detach = async (): Promise<void> => {
    // 禁用自动重连
    shouldReconnect = false

    if (stream && registered) {
      // 发送注销消息（Server 端通过 stream 映射识别，无需参数）
      stream.send({
        type: 'agent-unregister',
        text: '脱离宿主',
      })
    }

    if (stream) {
      stream.end()
      stream = null
    }

    registered = false
    registeredAt = undefined
  }

  // 构建钩子
  const hooks: ServerHooks = {
    /**
     * Server 启动后自动寄生到 Host Agent
     *
     * 使用 retry 实现指数退避重试：
     * - 首次连接失败会自动重试
     * - 连接断开后也会自动重连
     *
     * @param agentConfig - Agent 配置
     * @param serverAgentCard - Agent 卡片
     * @param skillHandlers - 技能处理函数集合
     */
    onStart: async (agentConfig: AgentConfig, serverAgentCard: AgentCard, skillHandlers: SkillHandlers) => {
      agentCard = serverAgentCard
      // 保存 handlers，用于后续处理转发调用
      // 这些 handler 已经组合了 beforeHandler/afterHandler 钩子
      handlers = skillHandlers

      console.log(`[ParasitePlugin] Server 启动，开始寄生到 Host Agent`)

      // 使用 retry 进行首次连接（不阻塞启动）
      retry(() => connectAndRegister(), {
        maxRetries: reconnectConfig.maxRetries,
        baseDelay: reconnectConfig.baseDelay,
        maxDelay: reconnectConfig.maxDelay,
        onRetry: (error, attempt, delay) => {
          console.log(`[ParasitePlugin] 寄生失败，重试 ${attempt}/${reconnectConfig.maxRetries === Infinity ? '∞' : reconnectConfig.maxRetries} (延迟 ${Math.round(delay)}ms): ${error.message}`)
          // 首次连接失败也触发 onReconnecting 回调
          callbacks?.onReconnecting?.(attempt, Math.round(delay))
        },
      }).catch(err => {
        console.error('[ParasitePlugin] 寄生最终失败:', err.message)
      })
    },
  }

  // 返回插件实例
  return {
    hooks,

    /**
     * 检查是否已寄生
     */
    isRegistered: () => registered,

    /**
     * 获取寄生状态
     */
    getRegistrationStatus: () => ({
      registered,
      registeredAt,
      hostAddress,
    }),

    /**
     * 脱离宿主
     */
    detach,
  }
}
