/**
 * AgentServer - 扁平化消息架构
 *
 * 核心特性：
 * - 扁平化消息结构：所有字段直接在Message级别
 * - 协议层+业务层分离：协议消息固定3种，业务消息完全开放
 * - Context 暴露 BidirectionalStream
 * - Handler 直接使用 ctx.stream.send() 和 for await
 */

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { WebSocketServer, WebSocket } from 'ws'
import * as fs from 'fs'
import * as https from 'https'
import { PROTO_JSON } from '../generated/proto-json'
import {
  ErrorCode,
  type AgentConfig,
  type AgentCard,
  type ServerInstance,
  type ServerHooks,
  type InternalServerHooks,
  type ServerBuilder,
  type ServerPlugin,
  type Context,
  type BidirectionalStream,
  type Message,
  type SkillHandler,
  type MessageContext,
  type HandlerHooks,
  type HandlerContext,
  type AfterHandlerResultInfo,
} from '../types'
import { generateMessageId, generateStreamId } from '../utils/id'
import { fromProtoMessage, toProtoMessage } from '../utils/message'
import { parseA2AAddress, formatA2AAddress } from '../utils/endpoint'
import { mergeHooks, executeHookArray, executeAgentCardHooks } from './hooks'
import { createIOMetricsPlugin } from '../plugins/io-metrics-plugin/plugin'

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
 * 流事件钩子（函数式配置）
 */
interface StreamHooks {
  onCancel?: (message: Message) => void
  onEnd?: () => void
  onError?: (error: Error) => void
}

/**
 * 创建 BidirectionalStream 包装器（Server 端）
 *
 * 职责单一：只负责流包装 + 事件分发
 * 业务逻辑（如 abort、清理）由调用方在钩子中实现
 */
const createBidirectionalStream = (grpcStream: grpc.ServerDuplexStream<any, any>, streamId: string, selfAgentCard: AgentCard, hooks?: StreamHooks): BidirectionalStream => {
  const messageQueue: Message[] = []
  const pendingResolvers: Array<(value: IteratorResult<Message>) => void> = []
  let streamEnded = false
  let streamError: Error | null = null

  // 监听 gRPC stream 的消息
  grpcStream.on('data', (protoMsg: any) => {
    const message = fromProtoMessage(protoMsg)
    console.log(`[Server:${streamId}] ← ${message.type}`, message)

    // cancel 消息：触发钩子，不入队列
    if (message.type === 'cancel') {
      hooks?.onCancel?.(message)
      return
    }

    if (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift()!
      resolve({ value: message, done: false })
    } else {
      messageQueue.push(message)
    }
  })

  grpcStream.on('end', () => {
    console.log(`[Server:${streamId}] Stream ended`)
    streamEnded = true

    // 触发 onEnd 钩子
    hooks?.onEnd?.()

    // 通知所有等待中的 resolver
    while (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift()!
      resolve({ value: undefined as any, done: true })
    }
  })

  grpcStream.on('error', (error: Error) => {
    console.error(`[Server:${streamId}] Stream error:`, error)
    streamError = error
    streamEnded = true

    // 触发 onError 钩子
    hooks?.onError?.(error)

    // 通知所有等待中的 resolver
    while (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift()!
      resolve({ value: undefined as any, done: true })
    }
  })

  return {
    /**
     * 发送消息
     * 自动生成 messageId 和 timestamp（如果未提供）
     * from 字段由调用方决定：
     * - 直接发送：通常不传入 from，默认为当前 Agent 的 AgentCard
     * - 转发场景：传入原始消息的 from，保留来源信息
     */
    send: (message: Message) => {
      const fullMessage: Message = {
        messageId: message.messageId || generateMessageId(),
        timestamp: message.timestamp || Date.now(),
        // from: 调用方传入则使用，否则使用当前 Agent 的 AgentCard
        from: message.from ?? selfAgentCard,
        type: message.type,
        text: message.text,
        data: message.data,
      }
      console.log(`[Server:${streamId}] → ${fullMessage.type}`, fullMessage)

      // 发送消息
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
      console.log(`[Server:${streamId}] Ending stream`)
      streamEnded = true

      // 清空消息队列（取消后不应该继续处理队列中的消息）
      messageQueue.length = 0

      // 通知所有等待中的 resolver
      while (pendingResolvers.length > 0) {
        const resolve = pendingResolvers.shift()!
        resolve({ value: undefined as any, done: true })
      }

      grpcStream.end()
    },

    /**
     * 取消流
     */
    cancel: (reason?: string) => {
      console.log(`[Server:${streamId}] Cancelling stream:`, reason)
      grpcStream.end()
    },
  }
}

/**
 * 创建受保护的 Handler
 *
 * 将原始 handler 与 beforeHandler/afterHandler 钩子组合，
 * 返回一个自动执行钩子的 protectedHandler。
 *
 * 安全设计：
 * - Server 在启动时调用此函数包装所有 skill.handler
 * - 返回的 protectedHandler 被存入 skillHandlers Map
 * - 任何通过 skillHandlers 获取的 handler 都已包含钩子逻辑
 * - 确保插件无法绕过 beforeHandler/afterHandler 钩子
 *
 * @param skillName 技能名称
 * @param rawHandler 原始处理函数
 * @param hooks beforeHandler/afterHandler 钩子配置
 * @param agentId Agent ID，用于构造 HandlerContext
 * @returns 受保护的 SkillHandler
 */
const createProtectedHandler = (skillName: string, rawHandler: SkillHandler, hooks: HandlerHooks, agentId: string): SkillHandler => {
  /**
   * 受保护的 Handler
   *
   * 执行流程：
   * 1. 创建 AbortController
   * 2. 构造 HandlerContext（包含 signal 和 abort）
   * 3. 执行 beforeHandler 钩子（可通过 ctx.abort() 中止）
   * 4. 检查 signal.aborted，决定是否执行原始 handler
   * 5. 执行 afterHandler 钩子
   */
  return async (params: any, ctx: Context): Promise<any> => {
    const startTime = Date.now()

    // 1. 创建 AbortController（供钩子调用 ctx.abort() 使用）
    const abortController = new AbortController()

    // 2. 构造 HandlerContext - 供钩子使用的上下文
    // traceId 从 gRPC Metadata 获取（单一数据源）
    const handlerContext: HandlerContext = {
      skill: skillName,
      params,
      traceId: ctx.metadata.get('x-trace-id')?.[0]?.toString() || `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: ctx.metadata.get('x-user-id')?.[0]?.toString(),
      agentId,
      startTime,
      metadata: new Map(),
      grpcMetadata: ctx.metadata,
      signal: abortController.signal,
      abort: () => abortController.abort(),
    }

    // 用于传递给 handler 的 stream（可能被 beforeHandler 包装）
    let currentStream = ctx.stream

    // 3. 执行 beforeHandler 钩子
    if (hooks.beforeHandler && hooks.beforeHandler.length > 0) {
      for (const beforeHook of hooks.beforeHandler) {
        const result = await beforeHook(currentStream, handlerContext)

        // 钩子调用 ctx.abort() 会触发 signal.aborted = true
        if (handlerContext.signal.aborted) {
          // 钩子已通过 stream.send() 发送错误消息，直接返回
          return
        }

        // 更新 stream（可能被包装）
        if (result?.stream) {
          currentStream = result.stream
        }
      }
    }

    // 4. 执行原始 handler（使用可能被包装的 stream）
    let handlerResult: any
    let success = true
    let handlerError: Error | undefined

    try {
      // 创建带有包装 stream 的 ctx
      const wrappedCtx: Context = {
        ...ctx,
        stream: currentStream,
      }
      handlerResult = await rawHandler(params, wrappedCtx)
    } catch (error) {
      success = false
      handlerError = error instanceof Error ? error : new Error(String(error))
      throw error // 继续抛出，让上层处理
    } finally {
      // 5. 执行 afterHandler 钩子（无论成功或失败）
      if (hooks.afterHandler && hooks.afterHandler.length > 0) {
        const resultInfo: AfterHandlerResultInfo = {
          success,
          error: handlerError,
          duration: Date.now() - startTime,
        }

        // afterHandler 异步执行，不阻塞返回
        // 使用 Promise.all 并行执行所有 afterHandler
        Promise.all(
          hooks.afterHandler.map(afterHook =>
            afterHook(currentStream, handlerContext, resultInfo).catch(err => {
              console.error(`[a2a] afterHandler hook error:`, err)
            }),
          ),
        ).catch(() => {
          // 忽略 Promise.all 的错误，因为各个 hook 错误已在 map 中处理
        })
      }
    }

    return handlerResult!
  }
}

/**
 * 创建AgentServer（Builder 模式）
 *
 * @param agentConfig Agent配置
 * @returns ServerBuilder - 支持链式调用的构建器
 *
 * @example
 * const server = createAgentServer(agentConfig)
 *   .use(createMountManager())
 *   .use(loggingPlugin)
 *   .use({ beforeMessage: simpleHook })
 *
 * await server.start()
 */
export const createAgentServer = (agentConfig: AgentConfig): ServerBuilder => {
  // 解析 A2A 地址
  const { host: endpointHost, port: endpointPort, secure: endpointSecure } = parseA2AAddress(agentConfig.address)

  // 存储通过 use() 注册的 Server 端插件钩子
  const hooksList: ServerHooks[] = []
  let serverInstance: ServerInstance | null = null

  // 如果配置了 metricsProvider，自动注册 IO 计量内置插件
  if (agentConfig.metricsProvider) {
    const ioMetricsPlugin = createIOMetricsPlugin(agentConfig.metricsProvider, agentConfig)
    hooksList.push(ioMetricsPlugin.hooks)
  }

  /**
   * 辅助函数：构建 AgentCard
   * 在 builder 级别定义，供 onStart 钩子使用
   */
  const buildAgentCard = (): AgentCard => ({
    agentId: agentConfig.agentId,
    name: agentConfig.name,
    version: agentConfig.version,
    description: agentConfig.description || '',
    skills: agentConfig.skills.map(m => ({
      name: m.name,
      description: m.description || '',
      inputSchema: m.inputSchema,
      outputSchema: m.outputSchema,
    })),
    defaultSkill: agentConfig.defaultSkill,
    endpoint: {
      host: endpointHost,
      port: endpointPort,
      address: formatA2AAddress(endpointHost, endpointPort),
    },
  })

  /**
   * 内部函数：构建实际的 ServerInstance
   *
   * @param mergedHooks 合并后的钩子
   */
  const buildServerInstance = (mergedHooks: InternalServerHooks): ServerInstance => {
    const hooks = mergedHooks

    /**
     * 技能处理器映射表
     * - Key (string): 技能名称（如 'execute'、'greet'）
     * - Value (SkillHandler): 受保护的处理函数（已组合钩子）
     *
     * 安全设计：
     * - Server 内部将原始 handler 包装为 protectedHandler
     * - protectedHandler 内部执行 beforeHandler/afterHandler 钩子
     * - 插件从 skillHandlers 获取的 handler 已包含钩子逻辑
     */
    const skillHandlers = new Map<string, SkillHandler>()

    // 构造 Handler 钩子配置（从 mergedHooks 中提取）
    const handlerHooks = {
      beforeHandler: hooks.beforeHandler,
      afterHandler: hooks.afterHandler,
    }

    // 注册所有技能：将原始 handler 包装为受保护的 handler
    for (const skill of agentConfig.skills) {
      // 包装原始 handler，将钩子逻辑组合进去
      // 返回的 protectedHandler 已包含完整的钩子执行逻辑
      const protectedHandler = createProtectedHandler(skill.name, skill.handler, handlerHooks, agentConfig.agentId)
      skillHandlers.set(skill.name, protectedHandler)
    }

    // 构造当前 Agent 的完整 AgentCard（闭包中共享）
    // 注意：skills 中的 inputSchema/outputSchema 必须序列化为 JSON 字符串，
    // 因为 proto 定义中它们是 string 类型（与 handleGetAgentCard 保持一致）
    // 使用类型断言是因为 TypeScript 类型定义 inputSchema 为对象，但 gRPC 传输需要字符串
    const selfAgentCard: AgentCard = {
      agentId: agentConfig.agentId,
      name: agentConfig.name,
      version: agentConfig.version,
      description: agentConfig.description || '',
      skills: agentConfig.skills.map(m => ({
        name: m.name,
        description: m.description || '',
        // 序列化为 JSON 字符串，与 proto 定义匹配
        inputSchema: m.inputSchema ? JSON.stringify(m.inputSchema) : undefined,
        outputSchema: m.outputSchema ? JSON.stringify(m.outputSchema) : undefined,
      })) as AgentCard['skills'],
      defaultSkill: agentConfig.defaultSkill,
      endpoint: {
        host: endpointHost,
        port: endpointPort,
        address: formatA2AAddress(endpointHost, endpointPort),
      },
    }

    /**
     * 创建基础 Context（不包含 message，在收到 call 消息后注入）
     */
    type BaseContext = Omit<Context, 'message'>

    const createBaseContext = (streamId: string, stream: BidirectionalStream, grpcMetadata: grpc.Metadata, signal: AbortSignal, grpcCall?: grpc.ServerDuplexStream<any, any>): BaseContext => {
      // 使用闭包中的 selfAgentCard

      const baseContext: BaseContext = {
        streamId,
        stream,
        signal, // ✅ 框架自动管理的取消信号
        metadata: grpcMetadata, // ✅ 暴露原始 gRPC Metadata
        call: grpcCall, // ✅ 暴露原始 gRPC 调用对象（WebSocket 时为 undefined）

        // TODO 处理 websocket 兼容性问题
        getAgentCard: (): AgentCard => {
          // 使用 getHost() 获取客户端请求的目标地址，与 handleGetAgentCard 保持一致
          // 当 grpcCall 不存在时（WebSocket），使用配置的 host
          const hostAddress = (grpcCall as any)?.getHost?.() as string | undefined
          const resolvedHost = hostAddress ? hostAddress.substring(0, hostAddress.lastIndexOf(':')) || hostAddress : selfAgentCard.endpoint.host

          return {
            ...selfAgentCard,
            endpoint: {
              ...selfAgentCard.endpoint,
              host: resolvedHost,
              address: formatA2AAddress(resolvedHost, selfAgentCard.endpoint.port, { namespace: selfAgentCard.endpoint.namespace }),
            },
          }
        },

        getMetadata: <T = any>(key: string): T | undefined => {
          try {
            const buffer = grpcMetadata.get(key)?.[0]
            if (!buffer) {
              return undefined
            }
            const jsonString = buffer.toString('utf-8')
            return JSON.parse(jsonString) as T
          } catch (error) {
            console.warn(`[Context] Failed to parse metadata key "${key}":`, error)
            return undefined
          }
        },
      }

      return baseContext
    }

    /**
     * ! 处理Execute Stream（核心逻辑）
     */
    const handleExecuteStream = (grpcStream: grpc.ServerDuplexStream<any, any>) => {
      const streamId = generateStreamId()
      console.log(`[Server] New stream: ${streamId}`)

      // 1. 🔑 关键修复：AbortController 必须在创建流之前创建
      // 这样 onCancel 回调可以立即触发 abort，而不需要等待消息队列
      const abortController = new AbortController()

      // 2. 声明 stream 变量，供 hooks 中使用
      let stream: BidirectionalStream

      // 3. 包装为 BidirectionalStream，使用 hooks 对象配置
      stream = createBidirectionalStream(grpcStream, streamId, selfAgentCard, {
        onCancel: () => {
          // 当收到 cancel 消息时立即触发 abort
          console.log(`[Server:${streamId}] onCancel triggered, aborting controller`)
          abortController.abort()
          stream.end()

          // 调用插件系统的 ServerHooks.onCancel（异步执行，不阻塞）
          if (hooks?.onCancel && hooks.onCancel.length > 0) {
            const context: MessageContext = {
              metadata: new Map(),
              grpcMetadata: grpcStream.metadata,
              agentId: agentConfig.agentId,
              agentName: agentConfig.name,
              startTime: Date.now(),
            }
            Promise.all(hooks.onCancel.map(hook => hook(stream, context))).catch(err => {
              console.error(`[Server:${streamId}] ServerHooks.onCancel error:`, err)
            })
          }
        },
      })

      // 4. 创建基础 Context
      // 注：分离 grpcMetadata 和 grpcStream 参数，因为 WebSocket 场景没有 grpcStream，只有手动构造的 Metadata
      const baseCtx = createBaseContext(streamId, stream, grpcStream.metadata, abortController.signal, grpcStream)

      /**
       * 处理 'call' 类型消息
       * 返回 'continue' 表示继续主循环，'exit' 表示退出主循环
       */
      const handleCallMessage = async (message: Message): Promise<'continue' | 'exit'> => {
        const callData = message.data || {}
        const { skill, params } = callData
        const handler = skillHandlers.get(skill)

        // traceId/sessionId 通过 gRPC Metadata 传递（单一数据源）
        // Handler 通过 ctx.metadata.get('x-trace-id') 访问

        // 创建包含 message 的完整 Context
        const ctx: Context = {
          ...baseCtx,
          message, // 直接使用原始 message
        }

        // 场景1: 本地技能 - 等待 handler 完成（handler 接管 stream 控制权）
        // 注意：handler 已是 protectedHandler（由 createHandler 工厂函数生成）
        // beforeHandler/afterHandler 钩子已在 protectedHandler 内部执行，无需在此重复调用
        if (handler) {
          try {
            // 执行受保护的 handler（内部已包含钩子执行逻辑）
            await handler(params, ctx)
            console.log(`[Server:${streamId}] Handler completed successfully`)
          } catch (error: any) {
            console.error(`[Server:${streamId}] Handler error:`, error)
            // 直接使用原始错误码，保留业务错误码（如 UNAUTHORIZED）
            // 没有 code 的错误兜底为 HANDLER_ERROR
            stream.send({
              type: 'error',
              text: error.message,
              data: {
                code: error.code || ErrorCode.HANDLER_ERROR,
                retryable: error.retryable ?? false,
              },
            })
          }

          // Handler 完成后关闭 stream，通知 Client 端流已结束
          stream.end()
          return 'exit' // Handler 完成后退出主循环，避免竞态
        }

        // 场景2: 技能不存在 - 发送错误并退出
        stream.send({
          type: 'error',
          text: `Skill '${skill}' not found`,
          data: { code: ErrorCode.SKILL_NOT_FOUND, retryable: false },
        })
        stream.end()
        return 'exit'
      }

      /**
       * 使用钩子处理消息
       */
      const processMessageWithHooks = async (message: Message): Promise<'continue' | 'exit'> => {
        // 从 gRPC metadata 读取 namespace
        const namespaceValues = grpcStream.metadata.get('x-agent-namespace')
        const namespace = namespaceValues && namespaceValues.length > 0 ? String(namespaceValues[0]) : undefined

        // 创建消息上下文
        const context: MessageContext = {
          metadata: new Map(),
          grpcMetadata: grpcStream.metadata,
          agentId: agentConfig.agentId,
          agentName: agentConfig.name,
          startTime: Date.now(),
          namespace,
        }

        try {
          // ! 1. 执行 beforeMessage 钩子（支持短路）
          const beforeMessageResult = await executeHookArray(hooks?.beforeMessage, [message, stream, context])
          if (beforeMessageResult === 'handled') {
            // 消息已处理，跳过后续钩子和默认处理器，继续下一个消息
            await executeHookArray(hooks?.afterMessage, [message, stream, context, 'continue'])
            return 'continue'
          } else if (beforeMessageResult === 'exit') {
            // 消息已处理，退出消息循环
            await executeHookArray(hooks?.afterMessage, [message, stream, context, 'exit'])
            return 'exit'
          }

          let result: 'continue' | 'exit' = 'continue'
          let hookHandled = false

          // ! 2. 执行 onMessage 钩子（支持短路）
          const onMessageResult = await executeHookArray(hooks?.onMessage, [message, stream, context])
          if (onMessageResult === 'handled') {
            // 消息已处理，跳过后续钩子和默认处理器，继续下一个消息
            await executeHookArray(hooks?.afterMessage, [message, stream, context, 'continue'])
            return 'continue'
          } else if (onMessageResult === 'exit') {
            // 消息已处理，退出消息循环
            await executeHookArray(hooks?.afterMessage, [message, stream, context, 'exit'])
            return 'exit'
          }

          // ! 3. 根据消息类型执行对应钩子
          // 注：cancel 消息在 createBidirectionalStream 的 on('data') 中已被拦截处理，不会进入此处
          switch (message.type) {
            case 'call': {
              const skill = message.data?.skill as string | undefined
              const params = message.data?.params

              if (!skill) {
                stream.send({
                  type: 'error',
                  text: 'call 消息缺少 skill',
                  data: { code: ErrorCode.INVALID_CALL_MESSAGE },
                })
                break
              }

              // ! 执行 onCall 钩子
              const hookResult = await executeHookArray(hooks?.onCall, [skill, params, stream, context])

              if (hookResult === 'handled') {
                hookHandled = true
              } else if (hookResult === 'exit') {
                result = 'exit'
                hookHandled = true
              }
              break
            }
          }

          // 3. 如果钩子未处理，调用默认处理器
          if (!hookHandled) {
            switch (message.type) {
              case 'call':
                result = await handleCallMessage(message)
                break

              default:
                console.warn(`[Server:${streamId}] Unknown message type: ${message.type}`)
                result = 'continue'
            }
          }

          // ! 4. 执行 afterMessage 钩子
          await executeHookArray(hooks?.afterMessage, [message, stream, context, result])

          return result
        } catch (error: any) {
          // ! 5. 执行 onError 钩子
          if (hooks?.onError) {
            await hooks.onError(error, message, stream, context)
          } else {
            // 默认错误处理
            console.error('[Server] Error processing message:', error)
            stream.send({
              type: 'error',
              text: error.message || 'Internal server error',
              data: { code: ErrorCode.INTERNAL_ERROR },
            })
          }

          return 'continue'
        }
      }

      // ! 启动消息处理循环
      const processMessages = async () => {
        try {
          for await (const message of stream) {
            const action = await processMessageWithHooks(message)

            // 如果需要退出，直接 return
            if (action === 'exit') {
              return
            }
          }
        } catch (error) {
          console.error(`[Server:${streamId}] Stream processing error:`, error)
        }
      }

      processMessages().catch(error => {
        console.error(`[Server:${streamId}] Unhandled error in message loop:`, error)
      })
    }

    /**
     * 处理GetAgentCard请求
     */
    const handleGetAgentCard = (call: any, callback: any) => {
      // GetAgentCard 不需要完整的 Context，直接使用 selfAgentCard
      let agentCard = selfAgentCard

      // 使用 call.getHost() 获取客户端请求的目标地址
      // getHost() 返回格式: "ip:port" (如 "8.153.165.230:50054")
      // 注意: metadata.get(':authority') 在 @grpc/grpc-js 中返回空数组，不可用
      const hostAddress = call.getHost() as string
      const colonIndex = hostAddress.lastIndexOf(':')
      const resolvedHost = colonIndex !== -1 ? hostAddress.substring(0, colonIndex) : hostAddress
      const resolvedPort = colonIndex !== -1 ? parseInt(hostAddress.substring(colonIndex + 1), 10) : endpointPort

      // 如果配置了钩子，调用 onGetAgentCard
      if (hooks?.onGetAgentCard) {
        agentCard = executeAgentCardHooks(hooks.onGetAgentCard, agentCard, {
          agentId: agentConfig.agentId,
        })
      }

      // selfAgentCard 的 skills 已经在创建时序列化了 inputSchema/outputSchema
      // 这里直接使用，不再重复序列化
      const skillsForGrpc = agentCard.skills.map(m => ({
        name: m.name,
        description: m.description ?? '',
        inputSchema: m.inputSchema ?? '',
        outputSchema: m.outputSchema ?? '',
      }))

      callback(null, {
        agentId: agentCard.agentId,
        name: agentCard.name,
        version: agentCard.version,
        description: agentCard.description,
        skills: skillsForGrpc,
        defaultSkill: agentCard.defaultSkill,
        endpoint: {
          host: resolvedHost,
          port: resolvedPort,
          address: formatA2AAddress(resolvedHost, resolvedPort),
        },
      })
    }

    /**
     * 处理Check请求（健康检查）
     */
    const handleCheck = (_call: any, callback: any) => {
      callback(null, {
        status: 1, // HEALTHY
        message: 'OK',
      })
    }

    /**
     * 启动服务器
     */
    const start = async (): Promise<number> => {
      // 启动 gRPC 服务器
      return new Promise((resolve, reject) => {
        try {
          const proto = loadProto()
          const AgentService = proto.Agent

          const server = new grpc.Server({
            'grpc.max_receive_message_length': 100 * 1024 * 1024, // 100MB
            'grpc.max_send_message_length': 100 * 1024 * 1024, // 100MB
            // gRPC Keepalive 配置：快速检测连接断开（解决云端重启后客户端无法及时感知的问题）
            'grpc.keepalive_time_ms': 30000, // 每 30 秒发送一次 keepalive ping
            'grpc.keepalive_timeout_ms': 10000, // 10 秒内没收到响应则认为连接断开
            'grpc.keepalive_permit_without_calls': 1, // 即使没有活跃 RPC 调用也发送 keepalive
            'grpc.http2.min_ping_interval_without_data_ms': 10000, // 最小 ping 间隔 10 秒
          })

          // 注册服务
          server.addService(AgentService.service, {
            Execute: handleExecuteStream,
            GetAgentCard: handleGetAgentCard,
            Check: handleCheck,
          })

          // 绑定 gRPC 端口
          const grpcAddress = `${endpointHost}:${endpointPort}`

          // 创建 gRPC 凭证：TLS 或 Insecure
          let credentials: grpc.ServerCredentials
          if (endpointSecure && agentConfig.tls) {
            // 使用 TLS 证书
            const certChain = fs.readFileSync(agentConfig.tls.cert)
            const privateKey = fs.readFileSync(agentConfig.tls.key)
            const rootCert = agentConfig.tls.ca ? fs.readFileSync(agentConfig.tls.ca) : null

            credentials = grpc.ServerCredentials.createSsl(
              rootCert, // CA 证书（可选，用于客户端证书验证）
              [{ cert_chain: certChain, private_key: privateKey }],
              false, // 不强制客户端证书验证
            )
            console.log(`[Server] Using TLS with cert: ${agentConfig.tls.cert}`)
          } else if (endpointSecure && !agentConfig.tls) {
            // 配置了 a2as:// 但没有提供 TLS 配置
            throw new Error('[Server] TLS is required (a2as://) but no tls config provided in AgentConfig')
          } else {
            // 不使用 TLS
            credentials = grpc.ServerCredentials.createInsecure()
          }

          server.bindAsync(grpcAddress, credentials, (error, port) => {
            if (error) {
              console.error(`[Server] Failed to bind ${grpcAddress}:`, error)
              reject(error)
              return
            }

            console.log(`[Server] ${agentConfig.name} (${agentConfig.agentId}) gRPC listening on ${grpcAddress}${endpointSecure ? ' (TLS)' : ''}`)

            // 步骤 3: 启动 WebSocket 服务器（端口 +1）
            startWebSocketServer()

            resolve(port)
          })
        } catch (error) {
          console.error('[Server] Failed to start:', error)
          reject(error)
        }
      })
    }

    /**
     * 启动 WebSocket Server（浏览器支持）
     */
    const startWebSocketServer = () => {
      const wsPort = endpointPort + 1
      // WebSocket 需要监听 IPv4+IPv6 双栈，否则浏览器通过 localhost 连接时可能失败
      // 因为 localhost 会解析为 ::1 (IPv6) 和 127.0.0.1 (IPv4)，浏览器可能先尝试 IPv6
      // ws 库不像 gRPC，传入 localhost/127.0.0.1/0.0.0.0 时只监听 IPv4
      // :: 表示监听所有接口（包括 IPv4 和 IPv6）
      const wsHost = endpointHost === 'localhost' || endpointHost === '127.0.0.1' || endpointHost === '0.0.0.0' ? '::' : endpointHost

      // 创建 WebSocket 服务器（支持 TLS）
      let wss: WebSocketServer
      let httpsServer: https.Server | null = null

      if (endpointSecure && agentConfig.tls) {
        // 使用 TLS：创建 HTTPS server 并绑定 WebSocket
        const certChain = fs.readFileSync(agentConfig.tls.cert)
        const privateKey = fs.readFileSync(agentConfig.tls.key)

        httpsServer = https.createServer({
          cert: certChain,
          key: privateKey,
        })

        wss = new WebSocketServer({ server: httpsServer })

        httpsServer.listen(wsPort, wsHost === '::' ? undefined : wsHost, () => {
          console.log(`[WebSocket] ${agentConfig.name} WebSocket listening on wss://${endpointHost}:${wsPort} (TLS)`)
        })
      } else {
        // 不使用 TLS
        wss = new WebSocketServer({
          host: wsHost,
          port: wsPort,
        })
        console.log(`[WebSocket] ${agentConfig.name} WebSocket listening on ws://${endpointHost}:${wsPort}`)
      }

      wss.on('connection', (ws: WebSocket) => {
        console.log('[WebSocket] New browser client connected')

        // 客户端状态
        const clientState = {
          metadata: {} as Record<string, string>,
          agentId: agentConfig.agentId,
          streams: new Map<string, BidirectionalStream>(),
        }

        ws.on('message', async (data: Buffer) => {
          try {
            const parsed = JSON.parse(data.toString())

            // 处理初始化
            if (parsed.type === 'init') {
              clientState.metadata = parsed.metadata || {}
              clientState.agentId = parsed.agentId || agentConfig.agentId
              console.log(`[WebSocket] Client initialized: ${clientState.agentId}`, clientState.metadata)
              return
            }

            // 处理 getAgentCard
            if (parsed.action === 'getAgentCard') {
              ws.send(
                JSON.stringify({
                  requestId: parsed.requestId,
                  type: 'agentCard',
                  agentCard: selfAgentCard,
                }),
              )
              return
            }

            // 处理 checkHealth
            if (parsed.action === 'checkHealth') {
              ws.send(
                JSON.stringify({
                  requestId: parsed.requestId,
                  type: 'health',
                  healthy: true,
                }),
              )
              return
            }

            // 处理流消息
            const { streamId, message, action } = parsed

            if (!streamId) {
              console.error('[WebSocket] Missing streamId')
              return
            }

            // 创建新流
            if (!clientState.streams.has(streamId)) {
              // 1. 🔑 关键修复：AbortController 必须在创建流之前创建
              // 这样 onCancel 回调可以立即触发 abort，而不需要等待消息队列
              const abortController = new AbortController()

              // 2. 声明 wsStream 变量，供 hooks 中使用
              let wsStream: BidirectionalStream & { _emitMessage: (msg: Message) => void }

              // 3. 创建 WebSocket 双向流包装器，使用 hooks 对象配置
              wsStream = createWebSocketBidirectionalStream(ws, streamId, selfAgentCard, {
                onCancel: () => {
                  // 当收到 cancel 消息时立即触发 abort
                  console.log(`[WebSocket:${streamId}] onCancel triggered, aborting controller`)
                  abortController.abort()
                  wsStream.end()

                  // 调用插件系统的 ServerHooks.onCancel（异步执行，不阻塞）
                  if (hooks?.onCancel && hooks.onCancel.length > 0) {
                    // 为 WebSocket 构造 gRPC.Metadata 兼容对象
                    const wsGrpcMetadata = new grpc.Metadata()
                    Object.entries(clientState.metadata).forEach(([key, value]) => {
                      if (typeof value === 'object') {
                        wsGrpcMetadata.add(key, JSON.stringify(value))
                      } else {
                        wsGrpcMetadata.add(key, String(value))
                      }
                    })

                    const context: MessageContext = {
                      metadata: new Map(),
                      grpcMetadata: wsGrpcMetadata,
                      agentId: agentConfig.agentId,
                      agentName: agentConfig.name,
                      startTime: Date.now(),
                    }
                    Promise.all(hooks.onCancel.map(hook => hook(wsStream, context))).catch(err => {
                      console.error(`[WebSocket:${streamId}] ServerHooks.onCancel error:`, err)
                    })
                  }
                },
              })
              clientState.streams.set(streamId, wsStream)

              // 4. 启动消息处理（异步），传入 AbortController
              handleWebSocketStream(streamId, wsStream, clientState.metadata, abortController).catch(error => {
                console.error(`[WebSocket:${streamId}] Error in message loop:`, error)
              })
            }

            const stream = clientState.streams.get(streamId)

            // 处理结束
            if (action === 'end') {
              stream?.end()
              clientState.streams.delete(streamId)
              return
            }

            // 转发消息到流
            if (message) {
              // 模拟 gRPC 的事件发送（触发 'data' 事件）
              const wsStreamInternal = stream as any
              if (wsStreamInternal._emitMessage) {
                wsStreamInternal._emitMessage(message)
              }
            }
          } catch (error) {
            console.error('[WebSocket] Error processing message:', error)
          }
        })

        ws.on('close', () => {
          console.log('[WebSocket] Client disconnected')
          // 清理所有流
          clientState.streams.forEach(stream => stream.end())
          clientState.streams.clear()
        })
      })
    }

    /**
     * 创建 WebSocket 双向流包装器
     *
     * 职责单一：只负责流包装 + 事件分发
     * 业务逻辑（如 abort、清理）由调用方在钩子中实现
     */
    const createWebSocketBidirectionalStream = (ws: WebSocket, streamId: string, selfAgentCard: AgentCard, hooks?: StreamHooks): BidirectionalStream & { _emitMessage: (msg: Message) => void } => {
      const messageQueue: Message[] = []
      const pendingResolvers: Array<(value: IteratorResult<Message>) => void> = []
      let streamEnded = false

      const stream: any = {
        /**
         * 发送消息到浏览器
         * from 字段由调用方决定：
         * - 直接发送：通常不传入 from，默认为当前 Agent 的 AgentCard
         * - 转发场景：传入原始消息的 from，保留来源信息
         */
        send: (message: Message) => {
          const fullMessage: Message = {
            messageId: message.messageId || generateMessageId(),
            timestamp: message.timestamp || Date.now(),
            // from: 调用方传入则使用，否则使用当前 Agent 的 AgentCard
            from: message.from ?? selfAgentCard,
            type: message.type,
            text: message.text,
            data: message.data,
          }

          console.log(`[WebSocket:${streamId}] → ${fullMessage.type}`)

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                streamId,
                message: fullMessage,
              }),
            )
          }
        },

        /**
         * 实现 async iterator
         */
        [Symbol.asyncIterator]: () => {
          return {
            next: async (): Promise<IteratorResult<Message>> => {
              if (messageQueue.length > 0) {
                const message = messageQueue.shift()!
                return { value: message, done: false }
              }

              if (streamEnded) {
                return { value: undefined as any, done: true }
              }

              return new Promise(resolve => {
                pendingResolvers.push(resolve)
              })
            },
          }
        },

        end: () => {
          console.log(`[WebSocket:${streamId}] Ending stream`)

          // 向 Client 发送 stream_end 消息，通知流已结束
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                streamId,
                action: 'stream_end',
              }),
            )
          }

          streamEnded = true

          // 清空消息队列（取消后不应该继续处理队列中的消息）
          messageQueue.length = 0

          while (pendingResolvers.length > 0) {
            const resolve = pendingResolvers.shift()!
            resolve({ value: undefined as any, done: true })
          }
        },

        cancel: (reason?: string) => {
          console.log(`[WebSocket:${streamId}] Cancelling stream:`, reason)
          stream.end()
        },

        /**
         * 内部方法：接收来自浏览器的消息
         *
         * 关键修复：cancel 消息立即调用 onCancel 钩子，不进入队列
         * 这样即使 handler 正在阻塞执行，cancel 也能立即触发 AbortController.abort()
         */
        _emitMessage: (message: Message) => {
          console.log(`[WebSocket:${streamId}] ← ${message.type}`)

          // 🔑 关键：cancel 消息立即处理，不等待队列
          if (message.type === 'cancel') {
            console.log(`[WebSocket:${streamId}] Cancel message received, triggering immediate abort`)
            hooks?.onCancel?.(message)
            return // 不再放入队列，避免重复处理
          }

          if (pendingResolvers.length > 0) {
            const resolve = pendingResolvers.shift()!
            resolve({ value: message, done: false })
          } else {
            messageQueue.push(message)
          }
        },
      }

      return stream
    }

    /**
     * 处理 WebSocket 流消息（类似 handleExecuteStream）
     *
     * metadata 合并策略（与 gRPC Client 行为一致）：
     * 1. init 消息的 metadata（连接级别，类似 gRPC 连接时的 metadata）
     * 2. call 消息的 metadata（调用级别，由 beforeCall 钩子注入）
     * 调用级别的 metadata 会覆盖连接级别的同名字段
     *
     * @param abortController - 外部传入的 AbortController，由 onCancel 回调触发 abort
     */
    const handleWebSocketStream = async (streamId: string, stream: BidirectionalStream, clientMetadata: Record<string, string>, abortController: AbortController) => {
      // 注意：AbortController 现在由外部创建和管理
      // 当 cancel 消息到达时，onCancel 回调会立即触发 abort
      // 这里不再需要在 for await 循环中处理 cancel 消息

      try {
        // 等待消息
        for await (const message of stream) {
          // cancel 消息现在由 onCancel 回调处理（立即触发 abort）
          // 这里只做防御性检查
          if (message.type === 'cancel') {
            console.log(`[WebSocket:${streamId}] Cancel message in loop (should not happen):`, message.text)
            return
          }

          // 处理 call 消息
          if (message.type === 'call') {
            const { skill, params } = message.data || {}

            if (!skill) {
              stream.send({
                type: 'error',
                text: 'Missing skill in call message',
              })
              stream.end()
              return
            }

            // 使用 clientMetadata（从 init 消息获取）
            // 注：message.metadata 已移除，所有 metadata 通过 gRPC metadata 或 init 消息传递
            const mergedMetadata = { ...clientMetadata }

            // 创建 gRPC.Metadata 兼容对象
            // TODO 处理 websocket 和 grpc 兼容性问题
            const metadata = new grpc.Metadata()
            Object.entries(mergedMetadata).forEach(([key, value]) => {
              // 处理对象类型的 metadata 值（如 CallTicket）
              if (typeof value === 'object') {
                metadata.add(key, JSON.stringify(value))
              } else {
                metadata.add(key, String(value))
              }
            })

            // 创建基础 Context（使用合并后的 metadata）
            const baseCtx = createBaseContext(streamId, stream, metadata, abortController.signal)

            // 调用本地技能
            const handler = skillHandlers.get(skill)
            if (!handler) {
              stream.send({
                type: 'error',
                text: `Skill not found: ${skill}`,
              })
              stream.end()
              return
            }

            // traceId/sessionId 通过 metadata 传递（单一数据源）
            // Handler 通过 ctx.metadata.get('x-trace-id') 访问

            // 创建 Context
            // 注意：handler 已是 protectedHandler（由 createHandler 工厂函数生成）
            // beforeHandler/afterHandler 钩子已在 protectedHandler 内部执行，无需在此重复调用
            const ctx: Context = {
              ...baseCtx,
              stream,
              message, // 直接使用原始 message
            }

            try {
              // 执行受保护的 handler（内部已包含钩子执行逻辑）
              await handler(params, ctx)
              console.log(`[WebSocket:${streamId}] Handler completed successfully`)
            } catch (error: any) {
              console.error(`[WebSocket:${streamId}] Handler error:`, error)
              // 直接使用原始错误码，保留业务错误码（如 UNAUTHORIZED）
              // 没有 code 的错误兜底为 HANDLER_ERROR
              stream.send({
                type: 'error',
                text: error.message,
                data: {
                  code: error.code || ErrorCode.HANDLER_ERROR,
                  retryable: error.retryable ?? false,
                },
              })
            }

            // Handler 完成后关闭 stream，通知 Client 端流已结束
            stream.end()
            return
          }
        }
      } catch (error: any) {
        console.error(`[WebSocket:${streamId}] Unhandled error:`, error)
        stream.send({
          type: 'error',
          text: error.message || 'Internal server error',
        })
        stream.end()
      }
    }

    /**
     * 关闭服务器
     */
    const shutdown = (): Promise<void> => {
      return new Promise(resolve => {
        // TODO: 实现 shutdown 逻辑
        console.log(`[Server] ${agentConfig.name} shutdown`)
        resolve()
      })
    }

    // 返回 ServerInstance（包含 skillHandlers Map 供 onStart 钩子使用）
    return {
      get grpcServer() {
        // TODO: 返回实际的 grpc.Server 实例
        return null as any
      },
      start,
      shutdown,
      skillHandlers,
    }
  } // end of buildServerInstance

  /**
   * Builder 对象 - 支持链式调用
   */
  const builder: ServerBuilder = {
    /**
     * 注册 Server 端插件
     */
    use: (plugin: ServerPlugin) => {
      hooksList.push(plugin.hooks)
      return builder
    },

    /**
     * 启动服务器
     */
    start: async () => {
      if (serverInstance) {
        throw new Error('[Server] Server already started')
      }

      // 合并所有钩子
      const mergedHooks = mergeHooks(...hooksList)

      // ! 执行 beforeStart 钩子（同步执行，在服务器启动前）
      // IO 计量插件会在这里注册到计费平台，如果失败会抛出错误阻止启动
      if (mergedHooks.beforeStart && mergedHooks.beforeStart.length > 0) {
        for (const hook of mergedHooks.beforeStart) {
          await hook(agentConfig)
        }
      }

      // 构建 ServerInstance
      serverInstance = buildServerInstance(mergedHooks)

      // 启动服务器
      const port = await serverInstance.start()

      // ! 执行 onStart 钩子（并行执行，不阻塞）
      // 传递 skillHandlers，使插件（如 ParasitePlugin）能够调用技能
      if (mergedHooks.onStart && mergedHooks.onStart.length > 0) {
        const agentCard = buildAgentCard()
        // 此时 serverInstance 一定不为 null（刚刚赋值），使用 ! 断言
        const skillHandlers = serverInstance!.skillHandlers

        // 并行执行所有 onStart 钩子，不阻塞 start 返回
        Promise.all(
          mergedHooks.onStart.map(hook =>
            hook(agentConfig, agentCard, skillHandlers).catch(error => {
              console.error('[Server] onStart 钩子执行失败:', error)
            }),
          ),
        )
      }

      return port
    },

    /**
     * 关闭服务器
     */
    shutdown: async () => {
      if (!serverInstance) {
        console.warn('[Server] Server not started yet')
        return
      }

      await serverInstance.shutdown()
      serverInstance = null
    },

    /**
     * gRPC 服务器实例（只读）
     */
    get grpcServer() {
      if (!serverInstance) {
        throw new Error('[Server] Server not started yet. Call start() first.')
      }
      return serverInstance.grpcServer
    },
  }

  return builder
}
