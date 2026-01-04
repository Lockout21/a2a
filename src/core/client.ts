/**
 * AgentClient - 扁平化消息架构
 *
 * 核心特性：
 * - 扁平化消息结构：所有字段直接在Message级别
 * - 协议层+业务层分离：协议消息固定3种，业务消息完全开放
 * - call() 直接返回 BidirectionalStream
 * - 直接暴露 gRPC 双向流为 async iterable
 * - 自动环境检测：浏览器使用 WebSocket，Node.js 使用 gRPC
 */

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { PROTO_JSON } from '../generated/proto-json'
import type { ClientConfig, ClientBuilder, ClientPlugin, ClientHooks, InternalClientHooks, CallContext, CallOptions, BidirectionalStream, Message, AgentCard } from '../types'
import { generateMessageId, generateStreamId } from '../utils/id'
import { fromProtoMessage, toProtoMessage } from '../utils/message'
import { parseA2AAddress } from '../utils/endpoint'

/**
 * 检测运行环境
 */
const isBrowser = (): boolean => {
  return typeof (globalThis as any).window !== 'undefined' && typeof (globalThis as any).WebSocket !== 'undefined'
}

/**
 * 加载Proto定义（缓存）
 *
 * 使用 fromJSON() 从内嵌的 JSON 加载 proto 定义，
 * 完全不需要文件系统访问，适合打包为单文件使用。
 */
let protoCache: any = null
const loadProto = (): any => {
  if (protoCache) {
    return protoCache
  }

  // 使用 fromJSON 从内嵌的 JSON 加载 proto 定义
  const packageDefinition = protoLoader.fromJSON(PROTO_JSON, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false, // 关闭 defaults，避免与 oneof 冲突
    oneofs: true,
    bytes: Buffer, // 确保 bytes 字段始终解析为 Buffer (Uint8Array 兼容)
  })

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any
  protoCache = protoDescriptor.agent.v7
  return protoCache
}

/**
 * 创建 BidirectionalStream 包装器
 *
 * 将 gRPC 双向流包装为符合我们接口的对象
 */
const createBidirectionalStream = (grpcStream: grpc.ClientDuplexStream<any, any>, streamId: string): BidirectionalStream => {
  // 消息队列（用于实现 async iterator）
  const messageQueue: Message[] = []
  const pendingResolvers: Array<(value: IteratorResult<Message>) => void> = []
  let streamEnded = false
  let streamError: Error | null = null

  // 事件处理器存储
  const eventHandlers = {
    message: new Map<string, Array<(msg: Message) => void>>(),
  }

  // 监听 gRPC stream 的消息
  grpcStream.on('data', (protoMsg: any) => {
    const message = fromProtoMessage(protoMsg)
    console.log(`[Client:${streamId}] ← ${message.type}`, message)

    // 检查消息监听器（对所有消息类型）
    const handlers = eventHandlers.message.get(message.type)
    if (handlers && handlers.length > 0) {
      handlers.forEach(handler => {
        try {
          handler(message)
        } catch (err) {
          console.error(`[Client:${streamId}] Message handler error:`, err)
        }
      })
    }

    // 如果有等待中的 resolver，立即 resolve
    if (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift()!
      resolve({ value: message, done: false })
    } else {
      // 否则放入队列
      messageQueue.push(message)
    }
  })

  grpcStream.on('end', () => {
    console.log(`[Client:${streamId}] Stream ended`)
    streamEnded = true

    // 通知所有等待中的 resolver
    while (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift()!
      resolve({ value: undefined as any, done: true })
    }
  })

  grpcStream.on('error', (error: Error) => {
    console.error(`[Client:${streamId}] Stream error:`, error)
    streamError = error
    streamEnded = true

    // 通知所有等待中的 resolver
    while (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift()!
      resolve({ value: undefined as any, done: true })
    }
  })

  const stream: BidirectionalStream = {
    /**
     * 发送消息
     * 自动生成 messageId 和 timestamp（如果未提供）
     * 保留所有消息字段（包括 from、sessionId、traceId 等）
     */
    send: (message: Message) => {
      const fullMessage: Message = {
        ...message, // 保留所有字段（包括 from）
        messageId: message.messageId || generateMessageId(),
        timestamp: message.timestamp || Date.now(),
      }
      console.log(`[Client:${streamId}] → ${fullMessage.type}`, fullMessage)
      grpcStream.write(toProtoMessage(fullMessage))
    },

    /**
     * 实现 async iterator
     */
    [Symbol.asyncIterator]: () => {
      return {
        next: async (): Promise<IteratorResult<Message>> => {
          // 如果队列中有消息，立即返回
          if (messageQueue.length > 0) {
            const message = messageQueue.shift()!
            return { value: message, done: false }
          }

          // 如果流已结束或出错，返回 done
          if (streamEnded) {
            if (streamError) {
              throw streamError
            }
            return { value: undefined as any, done: true }
          }

          // 等待下一个消息
          return new Promise(resolve => {
            pendingResolvers.push(resolve)
          })
        },
      }
    },

    /**
     * 结束发送
     */
    end: () => {
      console.log(`[Client:${streamId}] Ending stream`)
      grpcStream.end()
    },

    /**
     * 取消流
     */
    cancel: (reason?: string) => {
      console.log(`[Client:${streamId}] Cancelling stream:`, reason)

      // 发送 Cancel 消息
      const cancelMessage: Message = {
        messageId: generateMessageId(),
        timestamp: Date.now(),
        type: 'cancel',
        text: reason || 'Cancelled by client',
      }

      grpcStream.write(toProtoMessage(cancelMessage))
      grpcStream.end()
    },

    /**
     * 监听特定类型的消息
     */
    on: (type: string, handler: (message: Message) => void) => {
      if (!eventHandlers.message.has(type)) {
        eventHandlers.message.set(type, [])
      }
      eventHandlers.message.get(type)!.push(handler)
      return stream
    },
  }

  return stream
}

/**
 * 合并 Client Hooks
 *
 * 将多个插件的钩子合并为内部使用的数组格式
 */
const mergeClientHooks = (...hooksList: ClientHooks[]): InternalClientHooks => {
  const result: InternalClientHooks = {}

  // 收集 beforeCall 钩子
  const beforeCallHooks = hooksList.filter(h => h && h.beforeCall).map(h => h.beforeCall!)
  if (beforeCallHooks.length > 0) {
    result.beforeCall = beforeCallHooks
  }

  // 收集 afterCall 钩子
  const afterCallHooks = hooksList.filter(h => h && h.afterCall).map(h => h.afterCall!)
  if (afterCallHooks.length > 0) {
    result.afterCall = afterCallHooks
  }

  // 收集 onError 钩子
  const onErrorHooks = hooksList.filter(h => h && h.onError).map(h => h.onError!)
  if (onErrorHooks.length > 0) {
    result.onError = onErrorHooks
  }

  return result
}

/**
 * 执行 Client Hook 数组
 */
const executeClientHooks = async <T extends (...args: any[]) => Promise<any>>(hooks: T[] | undefined, args: Parameters<T>): Promise<void> => {
  if (!hooks) return

  for (const hook of hooks) {
    await hook(...args)
  }
}

/**
 * 创建AgentClient（自动环境检测，支持插件）
 *
 * - 浏览器环境：自动使用 WebSocket 客户端
 * - Node.js 环境：使用 gRPC 客户端
 * - 支持 .use() 链式调用注册插件
 *
 * @param config Client配置
 * @returns ClientBuilder 支持链式调用的客户端构建器
 *
 * @example
 * // 基础用法（无插件）
 * const client = createAgentClient(config)
 * const stream = await client.call('execute', { ... })
 *
 * @example
 * // 使用插件
 * const client = createAgentClient(config)
 *   .use(loggingPlugin)
 *   .use(metricsPlugin)
 *
 * const stream = await client.call('execute', { ... })
 */
export const createAgentClient = (config: ClientConfig): ClientBuilder => {
  // 浏览器环境检测：自动使用 WebSocket 客户端
  // Browser Client 现已支持完整的插件系统（beforeCall、afterCall、onError）
  if (isBrowser()) {
    console.log('[Client] Browser environment detected, using WebSocket')
    const { createBrowserClient } = require('../browser/client') as typeof import('../browser/client')
    // Browser Client 返回完整的 ClientBuilder，支持 .use() 链式调用
    return createBrowserClient(config)
  }

  console.log('[Client] Node.js environment detected, using gRPC')

  // 解析 A2A 地址
  const { host, port, secure, namespace } = parseA2AAddress(config.address)

  // 存储通过 use() 注册的插件钩子
  const hooksList: ClientHooks[] = []

  // 使用闭包保存状态
  let grpcClient: any = null

  // 超时时间（毫秒），默认 30 秒
  const timeout = config.timeout ?? 30000

  /**
   * 连接到Agent
   */
  const connectGrpc = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (grpcClient) {
        resolve()
        return
      }

      try {
        const proto = loadProto()
        const AgentService = proto.Agent

        const grpcAddress = `${host}:${port}`
        const credentials = secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure()

        grpcClient = new AgentService(grpcAddress, credentials, {
          'grpc.max_receive_message_length': 100 * 1024 * 1024, // 100MB
          'grpc.max_send_message_length': 100 * 1024 * 1024, // 100MB
          // gRPC Keepalive 配置：快速检测连接断开（解决云端重启后本地 Agent 无法及时重连的问题）
          'grpc.keepalive_time_ms': 30000, // 每 30 秒发送一次 keepalive ping
          'grpc.keepalive_timeout_ms': 10000, // 10 秒内没收到响应则认为连接断开
          'grpc.keepalive_permit_without_calls': 1, // 即使没有活跃 RPC 调用也发送 keepalive
          'grpc.http2.min_time_between_pings_ms': 10000, // 最小 ping 间隔 10 秒
        })

        console.log(`[Client] Connected to ${config.agentId} at ${grpcAddress}${secure ? ' (TLS)' : ''}`)
        resolve()
      } catch (error) {
        console.error('[Client] Failed to connect:', error)
        reject(error)
      }
    })
  }

  /**
   * 创建 gRPC metadata
   *
   * 合并配置中的 metadata 和 context 中的 metadata
   */
  const createMetadata = (contextMetadata: Record<string, string> = {}): grpc.Metadata => {
    const grpcMetadata = new grpc.Metadata()

    // 添加 namespace（用于路由到代理注册的 Agent）
    if (namespace) {
      grpcMetadata.add('x-agent-namespace', namespace)
    }

    // 合并 config.metadata 和 contextMetadata
    const allMetadata = { ...config.metadata, ...contextMetadata }

    // 添加所有 metadata
    Object.entries(allMetadata).forEach(([key, value]) => {
      // gRPC 规则：
      // - 普通字段（不以 -bin 结尾）：直接传字符串
      // - 二进制字段（以 -bin 结尾）：传 Buffer
      if (key.endsWith('-bin')) {
        grpcMetadata.add(key, Buffer.from(value, 'utf-8'))
      } else {
        grpcMetadata.add(key, value) // 直接传字符串
      }
    })

    return grpcMetadata
  }

  /**
   * 调用Agent技能，返回双向流（异步版本）
   *
   * 支持插件钩子：
   * 1. beforeCall: 调用前执行，可修改 params 和 metadata
   * 2. afterCall: 调用后执行，可包装 stream
   * 3. onError: 错误时执行
   *
   * @param skill - 技能名称
   * @param params - 调用参数
   * @param options - 调用选项（可选），用于传递 traceId 和 sessionId
   */
  const call = async <TParams = any>(skill: string, params: TParams, options?: CallOptions): Promise<BidirectionalStream> => {
    // 合并所有插件钩子
    const mergedHooks = mergeClientHooks(...hooksList)

    // 创建调用上下文（可被钩子修改）
    const context: CallContext = {
      agentId: config.agentId,
      skill,
      params,
      metadata: {}, // 钩子可以向这里注入数据
    }

    // 合并 metadata（x-trace-id, x-session-id, x-user-id 等）
    if (options?.metadata) {
      Object.assign(context.metadata, options.metadata)
    }

    try {
      // 1. 执行 beforeCall 钩子（获取 CallTicket、注入 metadata 等）
      await executeClientHooks(mergedHooks.beforeCall, [context])

      // 2. 等待连接建立
      await connectGrpc()

      const streamId = generateStreamId()

      // 3. 创建 gRPC metadata（合并 context.metadata，包含 traceId/sessionId）
      const metadata = createMetadata(context.metadata)

      // 4. 创建 Execute 调用，传入 metadata
      const grpcStream = grpcClient.Execute(metadata)
      let stream = createBidirectionalStream(grpcStream, streamId)

      // 5. 发送初始 Call 消息（使用可能被钩子修改的 params）
      const callMessage: Message = {
        messageId: generateMessageId(),
        timestamp: Date.now(),
        type: 'call',
        text: `Calling skill: ${skill}`,
        data: { skill, params: context.params },
      }
      stream.send(callMessage)

      // 6. 执行 afterCall 钩子（可包装 stream）
      if (mergedHooks.afterCall) {
        for (const hook of mergedHooks.afterCall) {
          stream = await hook(context, stream)
        }
      }

      // 7. 框架自动处理取消信号传播
      if (options?.signal) {
        const signal = options.signal

        // 如果调用时已经取消，立即取消 stream
        if (signal.aborted) {
          stream.cancel('Cancelled before call')
        } else {
          // 监听取消信号，自动调用 stream.cancel()
          const abortHandler = () => {
            console.log(`[Client:${streamId}] Signal aborted, cancelling stream`)
            stream.cancel('Cancelled by signal')
          }
          signal.addEventListener('abort', abortHandler, { once: true })
        }
      }

      // 8. 返回已就绪的 stream
      return stream
    } catch (error) {
      // 执行 onError 钩子
      if (mergedHooks.onError) {
        for (const hook of mergedHooks.onError) {
          await hook(error as Error, context)
        }
      }
      throw error
    }
  }

  /**
   * 建立到 Agent 的原始双向流连接（不发送任何初始消息）
   *
   * 返回纯净的双向流，适用于完全透明的消息转发场景。
   * 注意：此方法不执行插件钩子
   *
   * @returns Promise<BidirectionalStream>
   */
  const connectStream = async (): Promise<BidirectionalStream> => {
    await connectGrpc()

    const streamId = generateStreamId()

    // 创建 gRPC metadata（使用配置中的 metadata）
    const metadata = createMetadata()

    // 创建 Execute 调用，传入 metadata
    const grpcStream = grpcClient.Execute(metadata)
    const bidirectionalStream = createBidirectionalStream(grpcStream, streamId)

    console.log(`[Client:${streamId}] Raw stream connected (no initial message)`)

    return bidirectionalStream
  }

  /**
   * 获取Agent卡片
   */
  const getAgentCard = async (): Promise<AgentCard> => {
    await connectGrpc()

    return new Promise((resolve, reject) => {
      // 设置 deadline 防止永久卡住
      const deadline = new Date(Date.now() + timeout)

      grpcClient.GetAgentCard({}, { deadline }, (error: any, response: any) => {
        if (error) {
          console.error('[Client] Failed to get agent card:', error)
          reject(error)
        } else {
          // 反序列化 inputSchema 和 outputSchema (从 JSON 字符串到对象)
          const card: AgentCard = {
            ...response,
            skills:
              response.skills?.map((m: any) => ({
                ...m,
                inputSchema: m.inputSchema ? JSON.parse(m.inputSchema) : undefined,
                outputSchema: m.outputSchema ? JSON.parse(m.outputSchema) : undefined,
              })) || [],
          }
          resolve(card)
        }
      })
    })
  }

  /**
   * 健康检查
   */
  const checkHealth = async (): Promise<boolean> => {
    await connectGrpc()

    return new Promise((resolve, reject) => {
      // 设置 deadline 防止永久卡住
      const deadline = new Date(Date.now() + timeout)

      grpcClient.Check({}, { deadline }, (error: any, response: any) => {
        if (error) {
          console.error('[Client] Health check failed:', error)
          reject(error)
        } else {
          const status = response.status
          resolve(status === 1 || status === 'HEALTHY')
        }
      })
    })
  }

  /**
   * 关闭客户端
   */
  const close = (): Promise<void> => {
    return new Promise(resolve => {
      if (grpcClient) {
        try {
          grpcClient.close()
        } catch (error) {
          console.warn('[Client] Error closing gRPC client:', error)
        }
        grpcClient = null
      }

      console.log(`[Client] Closed connection to ${config.agentId}`)
      resolve()
    })
  }

  /**
   * Builder 对象 - 支持链式调用
   */
  const builder: ClientBuilder = {
    /**
     * 注册插件
     */
    use: (plugin: ClientPlugin) => {
      hooksList.push(plugin.hooks)
      return builder
    },

    call,
    connect: connectStream,
    getAgentCard,
    checkHealth,
    close,
  }

  return builder
}
