/**
 * Browser Entry Point
 *
 * 浏览器环境专用入口，只导出 Client 相关功能
 *
 * 注意：此文件由开发者手动维护，不再自动生成
 * 如需添加新的浏览器端导出，请直接编辑此文件
 */

// 核心类型
export * from './types'

// Agent定义
export * from './core/agent-card'

// Client (浏览器版本)
export { createBrowserClient as createAgentClient } from './browser/client'

// 工具函数
export * from './utils/agent-info'
export * from './utils/id'

// IO 计量模块（浏览器兼容）
export { tokenize, calculateCost } from './plugins/io-metrics-plugin/tokenizer'
export { createStreamCollector } from './plugins/io-metrics-plugin/stream-collector'
export type { StreamCollector } from './plugins/io-metrics-plugin/stream-collector'
export type { IOCommitment, VerifiedIOMetrics, AgentPricing, IOMetricsProvider } from './plugins/io-metrics-plugin/types'
