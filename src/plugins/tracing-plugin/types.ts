/**
 * Tracing Plugin 类型定义
 *
 * 专注于调用链追踪，与 io-metrics-plugin 完全分离
 */

/**
 * 调用链追踪记录
 */
export interface TraceRecord {
  /** 请求链 ID（整个请求链共用） */
  traceId: string

  /** 当前调用的唯一 ID */
  spanId: string

  /** 父调用的 Span ID（谁调用了我，根调用为 undefined） */
  parentSpanId?: string

  /** Agent ID */
  agentId: string

  /** 调用的技能名称 */
  skill: string

  /** 调用开始时间（ISO 8601 格式） */
  startedAt: string

  /** 执行时长（毫秒） */
  duration: number
}

/**
 * 调用链追踪提供者接口
 *
 * 平台方实现此接口，接收调用链数据
 */
export interface TracingProvider {
  /**
   * 上报调用链追踪数据
   *
   * @param record 追踪记录
   */
  reportTrace(record: TraceRecord): Promise<void>
}

/**
 * Tracing Plugin 配置选项
 */
export interface TracingPluginOptions {
  /** 调用链追踪提供者 */
  provider: TracingProvider
}
