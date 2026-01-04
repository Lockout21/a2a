/**
 * Auth Plugin - 类型定义
 */

/**
 * Token 验证结果
 */
export interface TokenVerifyResult {
  /** 是否有效 */
  valid: boolean
  /** 用户 ID（验证成功时存在） */
  userId?: string
  /** 用户名（验证成功时存在） */
  username?: string
  /** 错误信息（验证失败时存在） */
  error?: string
}

/**
 * Auth Plugin 配置选项
 */
export interface AuthPluginOptions {
  /**
   * 平台 URL（用于验证 Token）
   *
   * 如果未提供或为空字符串，当收到 authorization header 时会拒绝请求，
   * 因为无法安全地验证 Token。
   *
   * @example 'http://8.153.165.230:50010/api'
   */
  platformUrl?: string

  /**
   * 是否强制要求登录
   *
   * - true: 未登录用户会收到错误消息，请求被中止
   * - false: 允许匿名用户访问
   *
   * @default true
   */
  requireAuth?: boolean

  /**
   * 自定义错误消息
   */
  messages?: {
    /** Token 无效时的错误消息 */
    tokenInvalid?: string
    /** 需要登录时的错误消息 */
    authRequired?: string
    /** 验证服务不可用时的错误消息 */
    serviceUnavailable?: string
    /** 平台未配置时的错误消息（收到 auth header 但无法验证） */
    platformNotConfigured?: string
  }
}
