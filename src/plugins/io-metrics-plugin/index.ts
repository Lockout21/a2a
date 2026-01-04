/**
 * IO 计量模块
 *
 * 基于输入输出的 Token 计量和计费功能
 *
 * 设计原则：
 * - 协议层计量：在 A2A 协议层计算 IO，开发者无法绑过
 * - 密码学防篡改：使用 HMAC 签名确保承诺不可伪造
 * - 平台解耦：通过 IOMetricsProvider 接口与具体平台解耦
 *
 * @example
 * ```typescript
 * import {
 *   createIOCommitment,
 *   verifyIOCommitment,
 *   createStreamCollector,
 *   tokenize,
 *   calculateCost,
 * } from '@multi-agent/a2a'
 *
 * // 创建输入承诺
 * const inputCommitment = createIOCommitment(
 *   JSON.stringify(params),
 *   traceId,
 *   'input',
 *   signingKey
 * )
 *
 * // 收集流式输出
 * const collector = createStreamCollector()
 * collector.collect('Hello ')
 * collector.collect('World!')
 *
 * // 创建输出承诺
 * const outputCommitment = createIOCommitment(
 *   collector.getText(),
 *   traceId,
 *   'output',
 *   signingKey
 * )
 * ```
 */

// 类型定义
export type { IOCommitment, VerifiedIOMetrics, AgentPricing, IOMetricsProvider } from './types'

// Token 计算
export { tokenize, calculateCost } from './tokenizer'

// 流式收集器
export { createStreamCollector } from './stream-collector'
export type { StreamCollector } from './stream-collector'

// IO 承诺
export { createIOCommitment, verifyIOCommitment } from './commitment'

// SDK 完整性
export { calculateSdkHash, getSdkVersion } from './integrity'

// 注意：createIOMetricsPlugin 是内置插件，不对外导出
// 框架在 AgentConfig.metricsProvider 配置时自动启用
