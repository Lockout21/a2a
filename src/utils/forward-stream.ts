/**
 * Stream Forwarding Utility - 消息流转发工具
 *
 * 用于 Agent 间消息转发的通用逻辑：
 * - 过滤协议消息（call、cancel）
 * - 注入来源信息到 data.__forwardedFrom
 * - 转发到目标流
 * - 可选：收集响应内容
 */

import type { Message, BidirectionalStream } from '../types'

/**
 * 转发配置选项
 */
export interface ForwardStreamOptions {
  /** 消息来源信息，注入到 data.__forwardedFrom */
  source?: {
    agentId: string
    name: string
  }

  /** 是否收集响应内容（从 done 消息中提取） */
  collectResponse?: boolean

  /** 自定义消息过滤器，返回 false 跳过该消息 */
  filter?: (message: Message) => boolean

  /** 自定义消息转换器，转发前修改消息 */
  transform?: (message: Message) => Message

  /** 消息转发回调，用于日志或监控 */
  onForward?: (message: Message) => void
}

/**
 * 转发结果
 */
export interface ForwardStreamResult {
  /** 收集的响应内容（仅当 collectResponse 为 true 时） */
  response?: string

  /** 转发的消息数量 */
  forwardedCount: number

  /** 最后一条消息的类型 */
  lastMessageType?: string
}

/**
 * 转发消息流
 *
 * 将源流的消息转发到目标流，自动过滤协议消息并注入来源信息
 *
 * @param sourceStream - 源消息流（来自被调用的 Agent）
 * @param targetStream - 目标消息流（发送给调用方）
 * @param options - 转发配置
 * @returns 转发结果
 *
 * @example
 * ```typescript
 * // 基本用法
 * const result = await forwardStream(agentStream, ctx.stream)
 *
 * // 完整用法
 * const result = await forwardStream(agentStream, ctx.stream, {
 *   source: { agentId: 'frontend-agent', name: 'Frontend Agent' },
 *   collectResponse: true,
 * })
 *
 * console.log('响应:', result.response)
 * console.log('转发了', result.forwardedCount, '条消息')
 * ```
 */
export const forwardStream = async (
  sourceStream: BidirectionalStream,
  targetStream: BidirectionalStream,
  options?: ForwardStreamOptions
): Promise<ForwardStreamResult> => {
  const {
    source,
    collectResponse = false,
    filter,
    transform,
    onForward,
  } = options || {}

  let response: string | undefined
  let forwardedCount = 0
  let lastMessageType: string | undefined

  for await (const message of sourceStream) {
    // 1. 跳过协议消息
    if (message.type === 'call' || message.type === 'cancel') {
      continue
    }

    // 2. 自定义过滤
    if (filter && !filter(message)) {
      continue
    }

    // 3. 收集响应内容
    if (collectResponse) {
      if (message.type === 'done' && message.text) {
        response = message.text
      } else if (message.type === 'progress' && message.text && !response) {
        // 如果还没有 done 消息，先收集 progress
        response = message.text
      }
    }

    // 4. 构建转发消息
    // - 保留原始消息的 from 字段（协议层已自动注入 AgentCard）
    // - 将来源信息注入到 data.__forwardedFrom（用于调试）
    let forwardedMessage: Message = {
      ...message,
      // from 由协议层自动注入（AgentCard 类型），转发时保留原始值
      ...(source && {
        data: {
          ...message.data,
          __forwardedFrom: {
            agentId: source.agentId,
            name: source.name,
          },
        },
      }),
    }

    // 5. 自定义转换
    if (transform) {
      forwardedMessage = transform(forwardedMessage)
    }

    // 6. 转发
    targetStream.send(forwardedMessage)
    forwardedCount++
    lastMessageType = message.type

    // 7. 回调
    if (onForward) {
      onForward(forwardedMessage)
    }

    // 8. 终止消息后退出循环
    // done/error 表示 Agent 执行完成，无需等待流自然结束
    // 这对代理场景尤为重要，因为代理的 gRPC 流不会自动关闭
    if (message.type === 'done' || message.type === 'error') {
      break
    }
  }

  return {
    response,
    forwardedCount,
    lastMessageType,
  }
}