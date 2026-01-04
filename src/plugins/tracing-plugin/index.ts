/**
 * Tracing Plugin - 调用链追踪插件
 *
 * 专注于调用链追踪（spanId/parentSpanId），与 io-metrics-plugin 完全分离
 */

export { createTracingPlugin } from './plugin'
export type { TracingProvider, TracingPluginOptions, TraceRecord } from './types'
