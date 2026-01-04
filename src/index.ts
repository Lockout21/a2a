/**
 * A2A v7 Framework - Main Entry Point
 *
 * 导出所有公开API（纯函数）
 */

// 核心类型
export * from './types'

// Agent定义
export * from './core/agent-card'

// Server
export * from './core/server'

// Client
export * from './core/client'

// Plugins
export * from './plugins/parasite-plugin'
export * from './plugins/mcp-plugin'
export * from './plugins/io-metrics-plugin'
export * from './plugins/tracing-plugin'
export * from './plugins/auth-plugin'

// 工具函数
export * from './utils'

// Agent Tools 构建器
export * from './tools'
