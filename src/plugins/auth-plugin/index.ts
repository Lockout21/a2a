/**
 * Auth Plugin - 认证插件
 *
 * 用于验证用户身份，将 userId 注入到 context 中供后续使用。
 *
 * @example
 * ```typescript
 * import { createAgentServer, createAuthPlugin } from '@multi-agent/a2a'
 *
 * const server = createAgentServer(config)
 *   .use(createAuthPlugin({
 *     platformUrl: 'http://8.153.165.230:50010/api',
 *     requireAuth: true,
 *   }))
 * ```
 */

export { createAuthPlugin } from './plugin'
export type { AuthPluginOptions, TokenVerifyResult } from './types'
