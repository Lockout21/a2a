/**
 * Auth Plugin - 认证插件
 *
 * 功能：
 * 1. beforeHandler: 从 gRPC metadata 提取 authorization header
 * 2. 调用平台 API 验证 Token
 * 3. 验证成功：将 userId/username 存入 ctx.metadata 供后续使用
 * 4. 验证失败：发送错误消息并中止请求
 *
 * 设计原则：
 * - 不信任客户端传递的 userId，必须通过平台验证
 * - 验证后的 userId 通过 ctx.metadata 传递，而非 gRPC metadata
 * - 支持配置是否强制要求登录
 */

import type { ServerPlugin, BidirectionalStream, HandlerContext } from '../../types'
import type { AuthPluginOptions, TokenVerifyResult } from './types'

/**
 * 默认错误消息
 */
const DEFAULT_MESSAGES = {
  tokenInvalid: '登录已失效，请重新登录后再使用 Agent。',
  authRequired: '请先登录后再使用 Agent。在聊天框中输入 /login 进行登录。',
  serviceUnavailable: '认证服务暂时不可用，请稍后重试。',
  platformNotConfigured: '平台计费服务未配置，无法验证登录状态。请联系管理员。',
}

/**
 * 通过平台 API 验证 Token
 *
 * @param token - JWT Token
 * @param platformUrl - 平台 API 地址
 * @returns 验证结果
 */
const verifyTokenViaPlatform = async (token: string, platformUrl: string): Promise<TokenVerifyResult> => {
  try {
    const response = await fetch(`${platformUrl}/auth/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    if (!response.ok) {
      return { valid: false, error: `验证服务返回错误: ${response.status}` }
    }

    return (await response.json()) as TokenVerifyResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[Auth Plugin] 验证服务调用失败:', message)
    return { valid: false, error: `验证服务不可用: ${message}` }
  }
}

/**
 * 创建认证插件
 *
 * @param options - 插件配置
 * @returns ServerPlugin
 *
 * @example
 * ```typescript
 * const server = createAgentServer(config)
 *   .use(createAuthPlugin({
 *     platformUrl: 'http://8.153.165.230:50010/api',
 *     requireAuth: true,
 *   }))
 * ```
 *
 * @example
 * ```typescript
 * // 在 handler 中获取已认证的 userId
 * const handler = async (params, ctx) => {
 *   const userId = ctx.metadata.get('userId')
 *   const username = ctx.metadata.get('username')
 *   // ...
 * }
 * ```
 */
export const createAuthPlugin = (options: AuthPluginOptions): ServerPlugin => {
  const { platformUrl, requireAuth = true, messages = {} } = options

  const errorMessages = {
    ...DEFAULT_MESSAGES,
    ...messages,
  }

  return {
    hooks: {
      /**
       * beforeHandler: 验证 Token 并注入 userId
       */
      beforeHandler: async (stream: BidirectionalStream, ctx: HandlerContext) => {
        const authHeader = ctx.grpcMetadata?.get('authorization')?.[0]?.toString()

        // 有 authorization header，尝试验证
        if (authHeader) {
          // 检查是否配置了平台 URL
          if (!platformUrl) {
            // 平台未配置，无法安全验证 Token
            console.warn(`[Auth Plugin] [${ctx.traceId}] 平台未配置，无法验证 Token`)
            stream.send({
              type: 'error',
              text: errorMessages.platformNotConfigured,
              data: { code: 'PLATFORM_NOT_CONFIGURED' },
            })
            ctx.abort()
            return
          }

          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
          const result = await verifyTokenViaPlatform(token, platformUrl)

          if (result.valid && result.userId) {
            // 验证成功，存储到 gRPC metadata（供 handler 和下游 Agent 读取）
            ctx.grpcMetadata?.set('x-user-id', result.userId)
            if (result.username) {
              ctx.grpcMetadata?.set('x-username', result.username)
            }
            console.log(`[Auth Plugin] [${ctx.traceId}] 用户已认证: ${result.userId} (${result.username || 'unknown'})`)
            return
          }

          // Token 无效
          console.warn(`[Auth Plugin] [${ctx.traceId}] Token 验证失败: ${result.error}`)
          stream.send({
            type: 'error',
            text: `${errorMessages.tokenInvalid}${result.error ? ` (${result.error})` : ''}`,
            data: { code: 'AUTH_FAILED' },
          })
          ctx.abort()
          return
        }

        // 无 authorization header
        if (requireAuth) {
          console.warn(`[Auth Plugin] [${ctx.traceId}] 拒绝未登录用户`)
          stream.send({
            type: 'error',
            text: errorMessages.authRequired,
            data: { code: 'AUTH_REQUIRED' },
          })
          ctx.abort()
          return
        }

        // 允许匿名访问
        console.log(`[Auth Plugin] [${ctx.traceId}] 匿名用户访问`)
      },
    },
  }
}
