/**
 * ID生成工具（纯函数）
 * 使用 Web 和 Node.js 都兼容的方法
 */

/**
 * 生成随机十六进制字符串
 */
const randomHex = (length: number): string => {
  let result = ''
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 16).toString(16)
  }
  return result
}

export const generateMessageId = (): string => {
  return `msg-${Date.now().toString(36)}-${randomHex(8)}`
}

export const generateQuestionId = (): string => {
  return `q-${Date.now().toString(36)}-${randomHex(6)}`
}

export const generateStreamId = (): string => {
  return `stream-${Date.now().toString(36)}-${randomHex(8)}`
}

export const generateRequestId = (): string => {
  return `req-${Date.now().toString(36)}-${randomHex(8)}`
}

/**
 * 生成链路追踪 ID
 * 格式: tr_{timestamp}_{random}
 */
export const generateTraceId = (): string => {
  return `tr_${Date.now()}_${randomHex(12)}`
}

/**
 * 生成 IO 指标 ID
 * 格式: m_{timestamp}_{random}
 */
export const generateMetricsId = (): string => {
  return `m_${Date.now()}_${randomHex(8)}`
}
