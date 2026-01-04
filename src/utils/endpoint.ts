/**
 * A2A 地址解析工具
 *
 * 地址格式规范：
 * a2a[s]://host:port[/namespace]
 *
 * 示例：
 * - a2a://localhost:50050          - 基础格式（无 TLS）
 * - a2as://api.example.com:50050   - TLS 加密
 * - a2a://localhost:50050/tool-agent@user123 - 带 namespace
 */

/**
 * 解析后的 A2A 地址
 */
export type ParsedA2AAddress = {
  /** 主机地址 */
  host: string
  /** 端口号 */
  port: number
  /** 是否使用 TLS (a2as://) */
  secure: boolean
  /** 命名空间（可选） */
  namespace?: string
}

/**
 * 解析 A2A 地址
 *
 * @param address - A2A 地址字符串
 * @returns 解析后的地址对象
 * @throws 如果地址格式无效
 *
 * @example
 * parseA2AAddress('a2a://localhost:50050')
 * // → { host: 'localhost', port: 50050, secure: false }
 *
 * parseA2AAddress('a2as://api.example.com:50050')
 * // → { host: 'api.example.com', port: 50050, secure: true }
 *
 * parseA2AAddress('a2a://localhost:50050/tool-agent@user123')
 * // → { host: 'localhost', port: 50050, secure: false, namespace: 'tool-agent@user123' }
 */
export const parseA2AAddress = (address: string): ParsedA2AAddress => {
  // 使用 URL API 解析
  const url = new URL(address)

  // 解析 scheme: a2a 或 a2as
  const scheme = url.protocol.replace(':', '')
  if (scheme !== 'a2a' && scheme !== 'a2as') {
    throw new Error(`Invalid A2A address scheme: "${scheme}" (expected "a2a" or "a2as")`)
  }

  // 验证端口
  const port = parseInt(url.port, 10)
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port in A2A address: "${url.port}"`)
  }

  // 验证主机
  if (!url.hostname) {
    throw new Error(`Missing host in A2A address: "${address}"`)
  }

  const secure = scheme === 'a2as'
  const namespace = url.pathname.slice(1) || undefined

  return {
    host: url.hostname,
    port,
    secure,
    namespace,
  }
}

/**
 * 格式化 A2A 地址
 *
 * @param host - 主机地址
 * @param port - 端口号
 * @param options - 可选配置
 * @returns A2A 地址字符串
 *
 * @example
 * formatA2AAddress('localhost', 50050)
 * // → 'a2a://localhost:50050'
 *
 * formatA2AAddress('api.example.com', 50050, { secure: true })
 * // → 'a2as://api.example.com:50050'
 *
 * formatA2AAddress('localhost', 50050, { namespace: 'tool-agent@user123' })
 * // → 'a2a://localhost:50050/tool-agent@user123'
 */
export const formatA2AAddress = (
  host: string,
  port: number,
  options?: { secure?: boolean; namespace?: string }
): string => {
  const scheme = options?.secure ? 'a2as' : 'a2a'
  const base = `${scheme}://${host}:${port}`

  if (options?.namespace) {
    return `${base}/${options.namespace}`
  }

  return base
}

/**
 * 检查是否为有效的 A2A 地址格式
 *
 * @param address - 待检查的字符串
 * @returns 是否为有效的 A2A 地址
 *
 * @example
 * isA2AAddress('a2a://localhost:50050')  // true
 * isA2AAddress('a2as://example.com:443') // true
 * isA2AAddress('http://example.com')     // false
 * isA2AAddress('localhost:50050')        // false
 */
export const isA2AAddress = (address: string): boolean => {
  try {
    parseA2AAddress(address)
    return true
  } catch {
    return false
  }
}
