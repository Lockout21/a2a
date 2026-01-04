/**
 * Browser WebSocket Client
 *
 * 浏览器环境下的 Agent 客户端，通过 WebSocket 连接到 Agent Server
 *
 * 关键特性：
 * - 与 Node.js 的 gRPC 客户端完全相同的 API
 * - 支持双向流通信
 * - 支持 .use() 插件系统
 * - 消息队列管理
 * - 自动端口转换（用户端口 + 1）
 */

import type { ClientConfig, ClientBuilder, ClientPlugin, ClientHooks, CallContext, CallOptions, BidirectionalStream, Message, AgentCard } from '../types'
import { generateMessageId, generateStreamId } from '../utils/id'
import { parseA2AAddress } from '../utils/endpoint'

/**
 * 创建浏览器端 Agent 客户端（通过 WebSocket）
 *
 * 与 Node.js gRPC Client 完全相同的 API，通过 WebSocket 实现浏览器兼容。
 *
 * 关键特性：
 * - 与 Node.js 的 gRPC 客户端完全相同的 API
 * - 支持双向流通信
 * - 支持完整的 .use() 插件系统（beforeCall、afterCall、onError）
 * - 消息队列管理
 * - 自动端口转换（用户端口 + 1）
 *
 * @param config 客户端配置
 * @returns ClientBuilder 支持链式调用的客户端构建器
 */
export const createBrowserClient = (config: ClientConfig): ClientBuilder => {
  // 解析 A2A 地址
  const { host, port, secure, namespace } = parseA2AAddress(config.address)

  let ws: WebSocket | null = null

  // 自动端口转换：WebSocket 端口 = gRPC 端口 + 1
  const wsPort = port + 1
  const wsProtocol = secure ? 'wss' : 'ws'
  const gatewayUrl = `${wsProtocol}://${host}:${wsPort}`

  // 存储所有活跃的流
  const activeStreams = new Map<string, any>()

  // 存储插件钩子
  const hooksList: ClientHooks[] = []

  /**
   * 执行 beforeCall 钩子
   * 按注册顺序依次执行，任何钩子抛出错误都会中断调用
   */
  const executeBeforeCallHooks = async (context: CallContext): Promise<void> => {
    for (const hooks of hooksList) {
      if (hooks.beforeCall) {
        await hooks.beforeCall(context)
      }
    }
  }

  /**
   * 执行 afterCall 钩子
   * 按注册顺序依次执行，每个钩子可以包装/增强 stream
   * 返回值作为下一个钩子的输入
   */
  const executeAfterCallHooks = async (context: CallContext, stream: BidirectionalStream): Promise<BidirectionalStream> => {
    let currentStream = stream
    for (const hooks of hooksList) {
      if (hooks.afterCall) {
        currentStream = await hooks.afterCall(context, currentStream)
      }
    }
    return currentStream
  }

  /**
   * 执行 onError 钩子
   * 按注册顺序依次执行，用于统一错误处理和日志记录
   */
  const executeOnErrorHooks = async (error: Error, context: CallContext): Promise<void> => {
    for (const hooks of hooksList) {
      if (hooks.onError) {
        await hooks.onError(error, context)
      }
    }
  }

  /**
   * 连接到 WebSocket Server
   */
  const connect = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        resolve()
        return
      }

      try {
        console.log(`[Browser] Connecting to ${gatewayUrl}`)
        ws = new WebSocket(gatewayUrl)

        ws.onopen = () => {
          console.log(`[Browser] Connected to ${config.agentId || 'Agent'} at ${gatewayUrl}${secure ? ' (TLS)' : ''}`)

          // 发送初始化消息（传递 agentId、namespace 和 metadata）
          const initMetadata = { ...config.metadata }
          if (namespace) {
            initMetadata['x-agent-namespace'] = namespace
          }

          ws!.send(
            JSON.stringify({
              type: 'init',
              agentId: config.agentId,
              metadata: initMetadata,
            }),
          )

          resolve()
        }

        ws.onerror = error => {
          console.error('[Browser] WebSocket connection error:', error)
          reject(new Error(`Failed to connect to WebSocket at ${gatewayUrl}`))
        }

        ws.onclose = () => {
          console.log('[Browser] WebSocket connection closed')
          // 清理所有流
          activeStreams.forEach(streamData => {
            if (streamData.handleClose) {
              streamData.handleClose()
            }
          })
          activeStreams.clear()
        }
      } catch (error) {
        console.error('[Browser] Failed to create WebSocket:', error)
        reject(error)
      }
    })
  }

  /**
   * 创建双向流
   */
  const createBidirectionalStream = (streamId: string): BidirectionalStream => {
    const messageQueue: Message[] = []
    const pendingResolvers: Array<(value: IteratorResult<Message>) => void> = []
    let streamEnded = false
    let streamError: Error | null = null

    const eventHandlers = {
      message: new Map<string, Array<(msg: Message) => void>>(),
    }

    /**
     * 处理来自 Server 的消息
     */
    const messageHandler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)

        // 只处理属于当前 stream 的消息
        if (data.streamId !== streamId) {
          return
        }

        // 处理 stream_end action（Server 调用 stream.end() 时发送）
        if (data.action === 'stream_end') {
          console.log(`[Browser:${streamId}] ← stream_end`)
          streamEnded = true

          // 通知所有等待中的 resolver
          while (pendingResolvers.length > 0) {
            const resolve = pendingResolvers.shift()!
            resolve({ value: undefined as any, done: true })
          }

          // 清理监听器
          ws?.removeEventListener('message', messageHandler)
          activeStreams.delete(streamId)
          return
        }

        const message: Message = data.message
        console.log(`[Browser:${streamId}] ← ${message.type}`)

        // 触发事件监听器
        const handlers = eventHandlers.message.get(message.type)
        if (handlers && handlers.length > 0) {
          handlers.forEach(handler => {
            try {
              handler(message)
            } catch (err) {
              console.error(`[Browser:${streamId}] Message handler error:`, err)
            }
          })
        }

        // 处理消息队列
        if (pendingResolvers.length > 0) {
          const resolve = pendingResolvers.shift()!
          resolve({ value: message, done: false })
        } else {
          messageQueue.push(message)
        }
      } catch (error) {
        console.error('[Browser] Failed to parse message:', error)
      }
    }

    // 注册消息监听器
    ws!.addEventListener('message', messageHandler)

    const stream: BidirectionalStream = {
      /**
       * 发送消息
       */
      send: (message: Message) => {
        const fullMessage: Message = {
          messageId: message.messageId || generateMessageId(),
          timestamp: message.timestamp || Date.now(),
          type: message.type,
          text: message.text,
          data: message.data,
        }

        console.log(`[Browser:${streamId}] → ${fullMessage.type}`)

        if (!ws || ws.readyState !== WebSocket.OPEN) {
          console.error('[Browser] WebSocket not connected, cannot send message')
          return
        }

        ws.send(
          JSON.stringify({
            streamId,
            message: fullMessage,
          }),
        )
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
        console.log(`[Browser:${streamId}] Ending stream`)
        streamEnded = true

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              streamId,
              action: 'end',
            }),
          )
        }

        // 移除监听器
        ws?.removeEventListener('message', messageHandler)
        activeStreams.delete(streamId)
      },

      /**
       * 取消流
       */
      cancel: (reason?: string) => {
        console.log(`[Browser:${streamId}] Cancelling stream:`, reason)

        const cancelMessage: Message = {
          messageId: generateMessageId(),
          timestamp: Date.now(),
          type: 'cancel',
          text: reason || 'Cancelled by client',
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              streamId,
              message: cancelMessage,
            }),
          )
        }

        streamEnded = true
        ws?.removeEventListener('message', messageHandler)
        activeStreams.delete(streamId)
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

    // 保存流引用
    activeStreams.set(streamId, {
      stream,
      handleClose: () => {
        streamEnded = true
        streamError = new Error('WebSocket connection closed')
        // 通知所有等待中的 resolver
        while (pendingResolvers.length > 0) {
          const resolve = pendingResolvers.shift()!
          resolve({ value: undefined as any, done: true })
        }
      },
    })

    return stream
  }

  /**
   * 调用 Agent 技能（返回双向流）
   *
   * 钩子执行顺序：
   * 1. beforeCall hooks - 可注入 metadata、修改 params
   * 2. 建立 WebSocket 连接
   * 3. 发送 call 消息
   * 4. afterCall hooks - 可包装/增强 stream
   * 5. 返回 stream 给调用方
   *
   * * onError hooks - 发生错误时执行
   *
   * @param skill - 技能名称
   * @param params - 调用参数
   * @param options - 调用选项（可选），用于传递 traceId 和 sessionId
   */
  const call = async <TParams = any>(skill: string, params: TParams, options?: CallOptions): Promise<BidirectionalStream> => {
    // 构建调用上下文
    const context: CallContext = {
      agentId: config.agentId || 'unknown',
      skill,
      params,
      metadata: { ...(config.metadata || {}) },
    }

    // 合并 metadata（x-trace-id, x-session-id, x-user-id 等）
    if (options?.metadata) {
      Object.assign(context.metadata, options.metadata)
    }

    try {
      // 1. 执行 beforeCall 钩子（插件可注入 metadata）
      await executeBeforeCallHooks(context)

      // 2. 确保连接已建立
      await connect()

      // 3. 创建双向流
      const streamId = generateStreamId()
      const stream = createBidirectionalStream(streamId)

      // 4. 发送初始 Call 消息
      stream.send({
        type: 'call',
        text: `Calling skill: ${skill}`,
        data: { skill, params: context.params },
      })

      // 5. 执行 afterCall 钩子（可包装/增强 stream）
      let finalStream = await executeAfterCallHooks(context, stream)

      // 6. 框架自动处理取消信号传播
      if (options?.signal) {
        const signal = options.signal

        // 如果调用时已经取消，立即取消 stream
        if (signal.aborted) {
          finalStream.cancel('Cancelled before call')
        } else {
          // 监听取消信号，自动调用 stream.cancel()
          const abortHandler = () => {
            console.log(`[Browser:${streamId}] Signal aborted, cancelling stream`)
            finalStream.cancel('Cancelled by signal')
          }
          signal.addEventListener('abort', abortHandler, { once: true })
        }
      }

      return finalStream
    } catch (error) {
      // 执行 onError 钩子
      await executeOnErrorHooks(error instanceof Error ? error : new Error(String(error)), context)
      throw error
    }
  }

  /**
   * 建立原始双向流（不发送初始消息）
   */
  const connectStream = async (): Promise<BidirectionalStream> => {
    await connect()

    const streamId = generateStreamId()
    return createBidirectionalStream(streamId)
  }

  /**
   * 获取 AgentCard
   */
  const getAgentCard = async (): Promise<AgentCard> => {
    await connect()

    return new Promise((resolve, reject) => {
      const requestId = generateMessageId()

      const handler = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data)

          if (data.requestId === requestId && data.type === 'agentCard') {
            ws!.removeEventListener('message', handler)
            resolve(data.agentCard)
          }

          if (data.requestId === requestId && data.type === 'error') {
            ws!.removeEventListener('message', handler)
            reject(new Error(data.message || 'Failed to get agent card'))
          }
        } catch (error) {
          console.error('[Browser] Failed to parse response:', error)
        }
      }

      ws!.addEventListener('message', handler)

      ws!.send(
        JSON.stringify({
          requestId,
          action: 'getAgentCard',
        }),
      )

      // 超时处理
      setTimeout(() => {
        ws!.removeEventListener('message', handler)
        reject(new Error('getAgentCard timeout (5s)'))
      }, 5000)
    })
  }

  /**
   * 健康检查
   */
  const checkHealth = async (): Promise<boolean> => {
    await connect()

    return new Promise((resolve, reject) => {
      const requestId = generateMessageId()

      const handler = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data)

          if (data.requestId === requestId && data.type === 'health') {
            ws!.removeEventListener('message', handler)
            resolve(data.healthy)
          }
        } catch (error) {
          console.error('[Browser] Failed to parse health response:', error)
        }
      }

      ws!.addEventListener('message', handler)

      ws!.send(
        JSON.stringify({
          requestId,
          action: 'checkHealth',
        }),
      )

      // 超时处理
      setTimeout(() => {
        ws!.removeEventListener('message', handler)
        reject(new Error('checkHealth timeout (5s)'))
      }, 5000)
    })
  }

  /**
   * 关闭客户端
   */
  const close = (): Promise<void> => {
    return new Promise(resolve => {
      // 关闭所有活跃的流
      activeStreams.forEach(streamData => {
        if (streamData.stream) {
          streamData.stream.end()
        }
      })
      activeStreams.clear()

      // 关闭 WebSocket 连接
      if (ws) {
        ws.close()
        ws = null
      }

      console.log(`[Browser] Closed connection to ${config.agentId}`)
      resolve()
    })
  }

  /**
   * ClientBuilder - 支持链式调用
   */
  const builder: ClientBuilder = {
    call,
    connect: connectStream,
    getAgentCard,
    checkHealth,
    close,

    /**
     * 注册插件
     */
    use: (plugin: ClientPlugin): ClientBuilder => {
      hooksList.push(plugin.hooks)
      return builder
    },
  }

  return builder
}
