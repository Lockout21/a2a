/**
 * ParasiteHostPlugin - 宿主端寄生插件
 *
 * 核心功能：
 * 1. 接收远程 Agent 的寄生请求（agent-register 消息）
 * 2. 管理已寄生 Agent 的 AgentCard 和双向流连接
 * 3. 将代理请求转发给对应的寄生 Agent（基于 namespace 路由）
 * 4. 提供 API 查询已寄生的 Agent 列表
 *
 * 使用场景：
 * - Host Agent 使用此插件，接受 Tool Agent 的寄生
 * - Tool Agent 寄生后成为 "一等公民"，可被 Agent Selector 选择
 * - 调用方通过 namespace 指定目标 Agent，Host Agent 透明转发
 *
 * 消息协议：
 * - agent-register: 寄生 Agent（data: { agentCard: AgentCard }）
 * - agent-unregister: 脱离寄生（无需参数，通过 stream 映射识别）
 * - tunneled-call: 隧道封装的 gRPC 调用（包含完整 gRPC Metadata）
 * - tunneled-response: 隧道封装的响应
 *
 * 隧道封装设计（类似 VPN）：
 * - 将完整的 gRPC 调用上下文（包括 Metadata）封装在消息中传输
 * - Tool Agent 解封装后获得与云端 Agent 一致的上下文
 * - 实现对 Tool Agent 完全透明的代理
 *
 * namespace 规则：
 * - Client 在 agent-register 消息的 data 中传递 namespace（必传）
 * - Server 直接使用，不关心其格式和含义
 * - 由业务层决定 namespace 的生成规则
 *
 * @example
 * ```typescript
 * const parasiteHostPlugin = createParasiteHostPlugin()
 *
 * const server = createAgentServer(config)
 *   .use(parasiteHostPlugin)
 *
 * await server.start()
 *
 * // 获取已注册的 Agent（包含替换后的 endpoint）
 * const registeredCards = parasiteHostPlugin.getRegisteredAgentCards({
 *   host: 'localhost',
 *   port: 50050
 * })
 * ```
 */

import type { ServerPlugin, ServerHooks, AgentCard, BidirectionalStream, Message } from '../../types'
import { generateMessageId } from '../../utils/id'

/**
 * 已注册 Agent 的内部数据结构
 */
interface RegisteredAgent {
  agentCard: AgentCard
  stream: BidirectionalStream
  registeredAt: number
}

/**
 * 待处理的寄生调用
 */
interface PendingParasiteCall {
  requesterStream: BidirectionalStream
  correlationId: string
  createdAt: number
}

/**
 * ParasiteHostPlugin 接口
 */
export interface ParasiteHostPlugin extends ServerPlugin {
  /**
   * 获取已注册的 Agent namespace 列表
   */
  getRegisteredAgents: () => string[]

  /**
   * 获取已注册 Agent 的 AgentCard 列表（替换 endpoint 为宿主地址）
   *
   * @param hostEndpoint 宿主服务器的 endpoint（Host Agent 的地址）
   * @returns AgentCard 列表，endpoint 已替换为 { host, port, namespace }
   */
  getRegisteredAgentCards: (hostEndpoint: { host: string; port: number }) => AgentCard[]

  /**
   * 检查指定 namespace 是否已注册
   */
  isRegistered: (namespace: string) => boolean

  /**
   * 获取指定 namespace 的原始 AgentCard（不替换 endpoint）
   */
  getAgentCard: (namespace: string) => AgentCard | undefined
}

/**
 * 创建 ParasiteHostPlugin
 */
export const createParasiteHostPlugin = (): ParasiteHostPlugin => {
  // 已注册的 Agent 存储（key: agentId/namespace）
  const registeredAgents = new Map<string, RegisteredAgent>()

  // 待处理的寄生调用（key: correlationId）
  const pendingCalls = new Map<string, PendingParasiteCall>()

  // stream → namespace 映射（用于识别消息来自哪个寄生 Agent）
  const streamToNamespace = new Map<BidirectionalStream, string>()

  /**
   * 检查 stream 是否属于已注册的 Agent
   */
  const isRegisteredAgentStream = (stream: BidirectionalStream): boolean => {
    return streamToNamespace.has(stream)
  }

  /**
   * 处理 agent-register 消息（注册请求）
   *
   * namespace 规则：从 message.data.namespace 获取，直接使用
   */
  const handleRegister = (message: Message, stream: BidirectionalStream): void => {
    const { agentCard, namespace } = message.data || {}

    if (!agentCard || !agentCard.agentId) {
      console.error('[ParasiteHostPlugin] agent-register 消息缺少 agentCard 或 agentId')
      return
    }

    if (!namespace) {
      console.error('[ParasiteHostPlugin] agent-register 消息缺少 namespace')
      return
    }

    // 检查是否已注册
    if (registeredAgents.has(namespace)) {
      console.log(`[ParasiteHostPlugin] Agent ${namespace} 已存在，更新注册信息`)
      // 清理旧连接
      const oldAgent = registeredAgents.get(namespace)
      if (oldAgent) {
        streamToNamespace.delete(oldAgent.stream)
        oldAgent.stream.end()
      }
    }

    // 注册新 Agent
    registeredAgents.set(namespace, {
      agentCard,
      stream,
      registeredAt: Date.now(),
    })

    // 建立 stream → namespace 映射
    streamToNamespace.set(stream, namespace)

    console.log(`[ParasiteHostPlugin] Agent 注册成功: ${agentCard.name} (${namespace})`)
    console.log(`[ParasiteHostPlugin] 当前已注册 Agent 数量: ${registeredAgents.size}`)

    // 发送寄生成功响应（返回实际的 namespace，供客户端使用）
    stream.send({
      type: 'done',
      text: `Agent ${agentCard.name} 寄生成功`,
      data: { agentId: agentCard.agentId, namespace, success: true },
    })
  }

  /**
   * 处理 agent-unregister 消息（脱离寄生）
   *
   * 通过 stream → namespace 映射查找要脱离的 Agent
   * Client 只需在寄生时的同一 stream 上发送 unregister 消息即可
   */
  const handleDetach = (_message: Message, stream: BidirectionalStream): void => {
    // 从 stream 映射中查找 namespace
    const namespace = streamToNamespace.get(stream)

    if (!namespace) {
      console.error('[ParasiteHostPlugin] 该连接未寄生任何 Agent')
      return
    }

    // 清理映射
    streamToNamespace.delete(stream)

    // 取消注册
    registeredAgents.delete(namespace)
    console.log(`[ParasiteHostPlugin] Agent 取消注册: ${namespace}`)
    console.log(`[ParasiteHostPlugin] 当前已注册 Agent 数量: ${registeredAgents.size}`)

    // 发送脱离成功响应
    stream.send({
      type: 'done',
      text: `Agent ${namespace} 脱离成功`,
      data: { namespace, success: true },
    })
  }

  /**
   * 转发消息到寄生 Agent（隧道封装模式）
   *
   * 调用链路：原始请求方 → Host Agent → 寄生 Agent
   *
   * 流程：
   * 1. 查找已有的 correlationId（通过 requesterStream）
   * 2. 如果没有且是 call 消息，生成新的 correlationId 并存储 pending call
   * 3. 如果没有且不是 call 消息，返回 false（无法处理）
   * 4. 隧道封装：将 gRPC metadata 放入 data.__parasiteGrpcMetadata（类似 VPN 封装）
   *
   * 隧道封装设计（类似 VPN）：
   * - 问题：Proto 的 Call 消息没有 metadata 字段，只有 Business 消息有
   * - 解决：将 gRPC metadata 序列化后放入 data 字段（data 是 bytes，可存任意 JSON）
   * - 效果：Tool Agent 解封装后获得与云端 Agent 一致的 ctx.metadata 接口
   *
   * @param message - 要转发的消息
   * @param requesterStream - 请求方的流
   * @param namespace - 寄生 Agent 的 namespace
   * @param grpcMetadata - gRPC Metadata（可选，用于传递 x-user-id 等认证信息）
   * @returns boolean - 是否成功处理
   */
  const forwardToRegisteredAgent = (message: Message, requesterStream: BidirectionalStream, namespace: string, grpcMetadata?: any): boolean => {
    // 查找已注册的 Agent
    const registeredAgent = registeredAgents.get(namespace)
    if (!registeredAgent) {
      requesterStream.send({
        type: 'error',
        text: `Agent ${namespace} 未注册或已断开连接`,
        data: { code: 'AGENT_NOT_FOUND', namespace },
      })
      return true
    }

    const { stream: registeredStream } = registeredAgent

    // 查找已有的 correlationId（通过 requesterStream）
    let correlationId = [...pendingCalls.entries()].find(([_, pending]) => pending.requesterStream === requesterStream)?.[0]

    // 没有已有的 correlationId，说明是新调用
    // 只有 call 消息才能发起新调用，其他消息类型（如 answer）必须基于已有的 correlationId
    if (!correlationId) {
      if (message.type !== 'call') {
        return false
      }

      correlationId = generateMessageId()
      pendingCalls.set(correlationId, { requesterStream, correlationId, createdAt: Date.now() })
      console.log(`[ParasiteHostPlugin] 发起代理调用 [${correlationId}] → ${namespace}`)
    }

    // 隧道封装：将 gRPC metadata 放入 data.__parasiteGrpcMetadata
    // 这样 Tool Agent 可以从 data 中提取并还原完整的调用上下文
    const tunnelledGrpcMetadata = grpcMetadata?.getMap?.() || {}

    const forwardMessage: Message = {
      ...message,
      data: {
        ...message.data,
        __parasiteCorrelationId: correlationId,
        __parasiteGrpcMetadata: tunnelledGrpcMetadata, // 隧道封装的 gRPC metadata
      },
    }

    console.log(`[ParasiteHostPlugin] 转发消息 [${correlationId}] → ${namespace}: ${message.type}`, {
      hasGrpcMetadata: Object.keys(tunnelledGrpcMetadata).length > 0,
      metadataKeys: Object.keys(tunnelledGrpcMetadata),
    })
    registeredStream.send(forwardMessage)

    return true
  }

  /**
   * 处理寄生 Agent 的响应消息
   *
   * 通过 correlationId 路由到请求方
   */
  const handleRegisteredAgentResponse = (message: Message, _registeredStream: BidirectionalStream): boolean => {
    // 提取 correlationId
    const correlationId = message.data?.__parasiteCorrelationId

    if (!correlationId) {
      // 没有 correlationId，不是代理响应，忽略
      return false
    }

    // 查找 pending call
    const pendingCall = pendingCalls.get(correlationId)
    if (!pendingCall) {
      console.warn(`[ParasiteHostPlugin] 找不到 correlationId 对应的 pending call: ${correlationId}`)
      return false
    }

    const { requesterStream } = pendingCall

    // 移除内部字段后转发给请求方
    const { __parasiteCorrelationId, ...cleanData } = message.data || {}
    const cleanMessage: Message = {
      ...message,
      data: Object.keys(cleanData).length > 0 ? cleanData : undefined,
    }

    console.log(`[ParasiteHostPlugin] 转发响应 [${correlationId}] → 请求方: ${message.type}`)
    requesterStream.send(cleanMessage)

    // 如果是终止消息，清理 pending call
    if (message.type === 'done' || message.type === 'error') {
      pendingCalls.delete(correlationId)
      console.log(`[ParasiteHostPlugin] 代理调用完成 [${correlationId}]`)
    }

    return true
  }

  // 构建钩子
  const hooks: ServerHooks = {
    /**
     * beforeMessage - 在所有消息处理之前拦截
     *
     * 基于 namespace 路由：
     * - namespace 不存在或为 'default'：让 Host Agent 处理
     * - namespace 存在且不为 'default'：代理转发给已寄生的 Tool Agent
     *
     * 消息来源：
     * 1. 来自 Tool Agent（寄生/脱离/响应）- 通过 stream 映射识别
     * 2. 来自 Client（call/answer/cancel）- 通过 namespace 路由
     */
    beforeMessage: async (message, stream, context) => {
      // === 1. 处理注册/注销消息（来自 Tool Agent）===
      if (message.type === 'agent-register') {
        handleRegister(message, stream)
        return 'handled'
      }

      if (message.type === 'agent-unregister') {
        handleDetach(message, stream)
        return 'handled'
      }

      // === 2. 处理已注册 Agent 的响应消息 ===
      if (isRegisteredAgentStream(stream)) {
        const handled = handleRegisteredAgentResponse(message, stream)
        return handled ? 'handled' : 'pass'
      }

      // === 3. 处理来自 Client 的消息（基于 namespace 路由）===
      const namespace = context.namespace

      // ! 3.1 如果没有 namespace 或 namespace === 'default'，放行，让 Host Agent 处理
      if (!namespace || namespace === 'default') {
        return 'pass'
      }

      // ! 3.2 有 namespace 且 !== 'default'，转发给已注册 Agent
      // 传递 grpcMetadata 用于计费追踪（包含 x-user-id 等）
      const handled = forwardToRegisteredAgent(message, stream, namespace, context.grpcMetadata)
      return handled ? 'handled' : 'pass'
    },
  }

  // 返回插件实例
  return {
    hooks,

    /**
     * 获取已注册的 Agent namespace 列表
     */
    getRegisteredAgents: () => {
      return Array.from(registeredAgents.keys())
    },

    /**
     * 获取已注册 Agent 的 AgentCard 列表（替换 endpoint）
     */
    getRegisteredAgentCards: (hostEndpoint: { host: string; port: number }) => {
      return Array.from(registeredAgents.entries()).map(([namespace, { agentCard }]) => ({
        ...agentCard,
        endpoint: {
          host: hostEndpoint.host,
          port: hostEndpoint.port,
          namespace, // 使用实际的 namespace（多用户场景下为 agentId@userId）
          address: `a2a://${hostEndpoint.host}:${hostEndpoint.port}/${namespace}`,
        },
      }))
    },

    /**
     * 检查指定 namespace 是否已注册
     */
    isRegistered: (namespace: string) => {
      return registeredAgents.has(namespace)
    },

    /**
     * 获取指定 namespace 的原始 AgentCard
     */
    getAgentCard: (namespace: string) => {
      return registeredAgents.get(namespace)?.agentCard
    },
  }
}
