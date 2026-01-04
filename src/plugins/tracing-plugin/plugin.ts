/**
 * Tracing Plugin - 调用链追踪插件
 *
 * 功能：
 * 1. beforeHandler: 生成 spanId，读取 parentSpanId，写入 x-span-id 供下游读取
 * 2. afterHandler: 计算 duration，上报调用链数据到平台
 *
 * 与 io-metrics-plugin 的区别：
 * - tracing-plugin: 只负责调用链追踪（spanId/parentSpanId）
 * - io-metrics-plugin: 只负责 Token 计量和计费
 */

import type { ServerPlugin } from '../../types'
import type { TracingPluginOptions, TraceRecord } from './types'

/**
 * 生成 Span ID
 * 格式: sp_{timestamp}_{random}
 */
const generateSpanId = (): string => {
  return `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 创建调用链追踪插件
 *
 * @param options 插件配置
 * @returns ServerPlugin
 *
 * @example
 * ```typescript
 * const server = createAgentServer(config)
 *   .use(createTracingPlugin({
 *     provider: {
 *       reportTrace: async (record) => {
 *         await fetch(`${platformUrl}/api/traces/report`, {
 *           method: 'POST',
 *           headers: { 'Content-Type': 'application/json' },
 *           body: JSON.stringify(record),
 *         })
 *       }
 *     }
 *   }))
 * ```
 */
export const createTracingPlugin = (options: TracingPluginOptions): ServerPlugin => {
  const { provider } = options

  return {
    hooks: {
      /**
       * beforeHandler: 生成 spanId，读取 parentSpanId，写入 x-span-id
       */
      beforeHandler: async (_stream, ctx) => {
        // 1. 生成当前调用的 spanId
        const spanId = generateSpanId()
        const startTime = Date.now()
        const startedAt = new Date(startTime).toISOString()

        // 2. 从 gRPC metadata 读取上游传来的 x-span-id 作为 parentSpanId
        const parentSpanIdValue = ctx.grpcMetadata?.get('x-span-id')?.[0]
        const parentSpanId = parentSpanIdValue ? String(parentSpanIdValue) : undefined

        // 3. 将当前 spanId 写入 gRPC metadata，供下游 Agent 读取
        // 关键：业务代码使用 ctx.metadata.getMap() 传递 metadata 给下游时，
        // x-span-id 会自动包含在内
        ctx.grpcMetadata?.set('x-span-id', spanId)

        // 4. 确保 x-trace-id 传递给下游
        // 当前 Agent 可能是根节点（没有收到 x-trace-id），框架已为其生成 ctx.traceId
        // 需要将 ctx.traceId 写入 metadata，这样下游 Agent 才能共享同一个 traceId
        ctx.grpcMetadata?.set('x-trace-id', ctx.traceId)

        // 5. 保存数据到 context.metadata 供 afterHandler 使用
        ctx.metadata.set('_tracing', {
          spanId,
          parentSpanId,
          startTime,
          startedAt,
          skill: ctx.skill,
        })

        // 调试日志
        console.log(`[Tracing] [${ctx.agentId}] beforeHandler:`, {
          spanId,
          parentSpanId: parentSpanId || '(root)',
          skill: ctx.skill,
          traceId: ctx.traceId,
        })

        return undefined
      },

      /**
       * afterHandler: 计算 duration，上报调用链数据
       */
      afterHandler: async (_stream, ctx, result) => {
        const tracing = ctx.metadata.get('_tracing') as
          | {
              spanId: string
              parentSpanId?: string
              startTime: number
              startedAt: string
              skill: string
            }
          | undefined

        if (!tracing) {
          console.warn(`[Tracing] [${ctx.agentId}] afterHandler: missing tracing data`)
          return
        }

        const duration = result.duration

        // 构建调用链记录
        const record: TraceRecord = {
          traceId: ctx.traceId,
          spanId: tracing.spanId,
          parentSpanId: tracing.parentSpanId,
          agentId: ctx.agentId,
          skill: tracing.skill,
          startedAt: tracing.startedAt,
          duration,
        }

        // 调试日志
        console.log(`[Tracing] [${ctx.agentId}] afterHandler:`, {
          spanId: record.spanId,
          parentSpanId: record.parentSpanId || '(root)',
          duration: `${duration}ms`,
          success: result.success,
        })

        // 异步上报（不阻塞响应）
        provider
          .reportTrace(record)
          .then(() => {
            console.log(`[Tracing] [${ctx.agentId}] 上报成功`)
          })
          .catch(err => {
            console.error(`[Tracing] [${ctx.agentId}] 上报失败:`, err.message)
          })
      },
    },
  }
}
