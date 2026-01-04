/**
 * Proto Message 转换工具
 *
 * 在 Proto 嵌套格式和 TypeScript 统一消息格式之间转换
 *
 * Proto 格式（oneof嵌套）:
 * {
 *   messageId: "...",
 *   timestamp: 123,
 *   content: {
 *     call: { skill: "foo", params: ... }
 *   }
 * }
 *
 * TypeScript 格式（统一结构）:
 * {
 *   messageId: "...",
 *   timestamp: 123,
 *   type: "call",
 *   text: "Calling skill: foo",
 *   data: ...
 * }
 */

import type { Message } from '../types'

// ============================================
// 编解码工具（单例复用）
// ============================================

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

/**
 * 解码：Uint8Array/Buffer → JSON 对象
 *
 * proto-loader 配置了 bytes: Buffer，但有时会接收到普通对象
 */
const decodeJSON = (data: any): any => {
  if (!data) {
    return undefined
  }

  // 如果是 Uint8Array 或 Buffer，直接解码
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    if (data.length === 0) {
      return undefined
    }
    return JSON.parse(textDecoder.decode(data))
  }

  // 如果是普通对象（gRPC 有时会这样传递 bytes），转换为 Buffer
  if (typeof data === 'object' && !Array.isArray(data)) {
    // 检查是否像 { '0': 123, '1': 34, ... } 这样的对象
    const keys = Object.keys(data)
    if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
      // 转换为 Buffer
      const buffer = Buffer.from(Object.values(data))
      return JSON.parse(textDecoder.decode(buffer))
    }
  }

  return undefined
}

/**
 * 编码：JSON 对象 → Uint8Array
 */
const encodeJSON = (value: any): Uint8Array | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  return textEncoder.encode(JSON.stringify(value))
}

// ============================================
// Proto → TypeScript (接收到的消息)
// ============================================

/**
 * 从 Proto 嵌套格式转换为 TypeScript 统一消息格式
 *
 * proto-loader 的 oneof 处理方式：
 * - oneof 字段直接在最外层（如 call, cancel, business）
 * - content 字段是字符串，标识使用的是哪个 oneof 字段
 */
export const fromProtoMessage = (protoMsg: any): Message => {
  const { messageId, timestamp, from, content } = protoMsg

  // proto-loader 把 oneof 的名字作为 content 的值
  if (typeof content === 'string') {
    // 协议消息：Call
    if (content === 'call' && protoMsg.call) {
      if (!protoMsg.call.text) {
        throw new Error(`Call message missing text field. messageId: ${messageId}`)
      }

      return {
        messageId,
        timestamp,
        from: from || undefined,
        type: 'call',
        text: protoMsg.call.text,
        data: decodeJSON(protoMsg.call.data), // 自动解码
      }
    }

    // 协议消息：Cancel
    if (content === 'cancel' && protoMsg.cancel) {
      if (!protoMsg.cancel.text) {
        throw new Error(`Cancel message missing text field. messageId: ${messageId}`)
      }

      return {
        messageId,
        timestamp,
        from: from || undefined,
        type: 'cancel',
        text: protoMsg.cancel.text,
        data: decodeJSON(protoMsg.cancel.data), // 自动解码
      }
    }

    // 业务消息：Business（完全开放）
    if (content === 'business' && protoMsg.business) {
      // 只检查 type 是否存在，text 允许为空字符串
      if (!protoMsg.business.type || protoMsg.business.text === undefined || protoMsg.business.text === null) {
        throw new Error(`Business message missing type or text field. messageId: ${messageId}`)
      }

      return {
        messageId,
        timestamp,
        from: from || undefined,
        type: protoMsg.business.type,
        text: protoMsg.business.text,
        data: decodeJSON(protoMsg.business.data), // 自动解码
      }
    }
  }

  throw new Error(`Unknown message format: messageId=${messageId}, content=${content}, ` + `expected: 'call'|'cancel'|'business', keys=${Object.keys(protoMsg).join(',')}`)
}

// ============================================
// TypeScript → Proto (发送的消息)
// ============================================

/**
 * 从 TypeScript 统一消息格式转换为 Proto 嵌套格式
 */
export const toProtoMessage = (msg: Message): any => {
  const { messageId, timestamp, from, type, text, data } = msg

  // 协议消息：Call
  if (type === 'call') {
    return {
      messageId,
      timestamp,
      from,
      call: {
        text,
        data: encodeJSON(data), // 自动编码
      },
    }
  }

  // 协议消息：Cancel
  if (type === 'cancel') {
    return {
      messageId,
      timestamp,
      from,
      cancel: {
        text,
        data: encodeJSON(data), // 自动编码
      },
    }
  }

  // 业务消息：所有其他类型
  return {
    messageId,
    timestamp,
    from,
    business: {
      type,
      text,
      data: encodeJSON(data), // 自动编码
    },
  }
}
