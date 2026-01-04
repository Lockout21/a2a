/**
 * IO 计量内置插件
 *
 * 基于 Token 的 IO 计量和计费功能
 *
 * 功能：
 * 1. beforeStart: 注册到计费平台，获取签名密钥
 * 2. beforeHandler: 预调用检查、输入计量、包装 stream 收集输出
 * 3. afterHandler: 输出计量、生成 IO 承诺、上报指标
 *
 * 这是内置插件，当 AgentConfig 配置了 metricsProvider 时自动启用
 *
 * @example
 * ```typescript
 * // 内部使用，用户不需要手动调用
 * const plugin = createIOMetricsPlugin(metricsProvider, agentConfig)
 * server.use(plugin)
 * ```
 */

import type { ServerPlugin, AgentConfig, BidirectionalStream, Message } from '../../types'
import type { IOMetricsProvider, VerifiedIOMetrics } from './types'
import { createIOCommitment } from './commitment'
import { createStreamCollector, StreamCollector } from './stream-collector'
import { calculateSdkHash, getSdkVersion } from './integrity'

/**
 * IO 计量插件状态
 */
interface IOMetricsState {
  /** 签名密钥（从平台获取） */
  signingKey: string
  /** 是否已验证通过 */
  verified: boolean
  /** 计量提供者 */
  provider: IOMetricsProvider
}

/**
 * 生成指标 ID
 */
const generateMetricsId = (): string => {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 创建 IO 计量内置插件
 *
 * @param provider IO 计量提供者
 * @param _agentConfig Agent 配置（保留用于未来扩展）
 * @returns ServerPlugin
 */
export const createIOMetricsPlugin = (provider: IOMetricsProvider, _agentConfig: AgentConfig): ServerPlugin => {
  // 插件状态（在 beforeStart 中初始化）
  let state: IOMetricsState | null = null

  return {
    hooks: {
      /**
       * beforeStart: 注册到计费平台，获取签名密钥
       *
       * 如果注册失败，抛出错误阻止 Server 启动
       */
      beforeStart: async config => {
        console.log(`[IOMetrics] 正在注册到计费平台...`)

        const sdkVersion = getSdkVersion()
        const sdkHash = calculateSdkHash()

        const result = await provider.verifyIntegrity({
          sdkVersion,
          sdkHash,
          agentId: config.agentId,
        })

        if (!result.valid || !result.signingKey) {
          // 注册失败时禁止启动 Agent，防止白嫖
          const errorMsg = `计费平台注册失败: ${result.error || '未知错误'}，Agent 启动被阻止`
          console.error(`[IOMetrics] ${errorMsg}`)
          throw new Error(errorMsg)
        }

        state = {
          signingKey: result.signingKey,
          verified: true,
          provider,
        }

        console.log(`[IOMetrics] 计费平台注册成功，IO 计量已激活`)
      },

      /**
       * beforeHandler: 预调用检查、输入计量、包装 stream 收集输出
       */
      beforeHandler: async (stream, ctx) => {
        if (!state?.verified) {
          return
        }

        // 1. 预调用检查（验证用户余额）
        if (provider.preCallCheck) {
          const checkResult = await provider.preCallCheck({
            userId: ctx.userId,
            agentId: ctx.agentId,
            skill: ctx.skill,
            traceId: ctx.traceId,
          })

          if (!checkResult.allowed) {
            console.log(`[IOMetrics] 预调用检查失败: ${checkResult.reason}, code: ${checkResult.code}`)
            stream.send({
              type: 'error',
              text: checkResult.reason || '调用被拒绝',
              data: {
                code: checkResult.code || 'PRE_CALL_CHECK_FAILED',
                retryable: false,
              },
            })
            ctx.abort()
            return
          }
        }

        // 2. 记录调用开始时间
        // 注意：x-trace-id 和 x-span-id 的传播由 tracing-plugin 负责
        const startedAt = new Date().toISOString()
        ctx.metadata.set('startedAt', startedAt)

        // 3. 输入计量
        const inputContent = JSON.stringify(ctx.params)
        const inputCommitment = createIOCommitment(inputContent, ctx.traceId, 'input', state.signingKey, ctx.userId)
        console.log(`[IOMetrics] 输入 ${inputCommitment.tokens} tokens, userId: ${ctx.userId || '(anonymous)'}`)

        // 保存输入承诺到 context.metadata
        ctx.metadata.set('inputCommitment', inputCommitment)

        // 4. 创建输出收集器并包装 stream
        const outputCollector = createStreamCollector()
        ctx.metadata.set('outputCollector', outputCollector)

        const wrappedStream = wrapStreamForMetrics(stream, outputCollector)

        return { stream: wrappedStream }
      },

      /**
       * afterHandler: 输出计量、生成 IO 承诺、上报指标
       */
      afterHandler: async (_stream, ctx, result) => {
        if (!state?.verified) {
          return
        }

        const inputCommitment = ctx.metadata.get('inputCommitment')
        const outputCollector = ctx.metadata.get('outputCollector') as StreamCollector | undefined
        const startedAt = ctx.metadata.get('startedAt') as string | undefined

        if (!inputCommitment || !outputCollector || !startedAt) {
          return
        }

        // 输出计量
        const outputContent = outputCollector.getText()
        const outputCommitment = createIOCommitment(outputContent, ctx.traceId, 'output', state.signingKey, ctx.userId)
        console.log(`[IOMetrics] 输出 ${outputCommitment.tokens} tokens`)

        // 构建已验证的 IO 指标（spanId/parentSpanId 已迁移到 tracing-plugin）
        const metrics: VerifiedIOMetrics = {
          metricsId: generateMetricsId(),
          traceId: ctx.traceId,
          agentId: ctx.agentId,
          skill: ctx.skill,
          startedAt,
          inputCommitment,
          outputCommitment,
          duration: result.duration,
          userId: ctx.userId,
        }

        // 异步上报指标（不阻塞响应）
        console.log(`[IOMetrics] 正在上报指标...`)
        state.provider
          .reportMetrics(metrics)
          .then(() => {
            console.log(`[IOMetrics] 上报成功`)
          })
          .catch(err => {
            console.error(`[IOMetrics] 上报失败:`, err.message)
          })
      },
    },
  }
}

/**
 * 包装 stream 用于收集输出
 *
 * 拦截 stream.send() 方法，收集所有输出内容
 */
const wrapStreamForMetrics = (stream: BidirectionalStream, collector: StreamCollector): BidirectionalStream => {
  const originalSend = stream.send.bind(stream)

  return {
    ...stream,
    send: (message: Message) => {
      // 收集输出内容
      if (message.text) {
        collector.collect(message.text)
      }
      if (message.data) {
        collector.collect(JSON.stringify(message.data))
      }
      // 调用原始 send
      originalSend(message)
    },
  }
}
