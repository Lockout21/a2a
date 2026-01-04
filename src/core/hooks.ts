/**
 * Hooks System - 钩子系统核心逻辑
 *
 * 职责：
 * 1. 合并多个插件的钩子配置
 * 2. 执行钩子数组（支持短路机制）
 * 3. 执行 AgentCard 钩子链（管道模式）
 * 4. 执行 beforeHandler 钩子链（支持 stream 包装和中止）
 */

import type {
  ServerHooks,
  InternalServerHooks,
  OnGetAgentCardHook,
  AgentCard,
  BeforeHandlerHook,
  AfterHandlerHook,
  AfterHandlerResultInfo,
  HandlerContext,
  BidirectionalStream,
} from '../types'

/**
 * 合并多个插件的钩子
 *
 * 每个插件提供单个钩子函数，该函数收集它们并返回：
 * - 如果只有一个插件提供该钩子：返回单元素数组
 * - 如果多个插件提供该钩子：返回函数数组
 * - 如果没有插件提供该钩子：返回 undefined
 *
 * @param hooksList - 多个插件的钩子配置
 * @returns 合并后的钩子配置（内部格式，统一为数组）
 *
 * @example
 * ```typescript
 * const hooks1 = { beforeMessage: fn1 }
 * const hooks2 = { beforeMessage: fn2 }
 * const merged = mergeHooks(hooks1, hooks2)
 *
 * -> merged.beforeMessage = [fn1, fn2]
 * ```
 */
export const mergeHooks = (...hooksList: (ServerHooks | undefined)[]): InternalServerHooks => {
  const merged: InternalServerHooks = {}

  /**
   * 收集单个钩子字段（每个插件只提供单个函数）
   * 返回值：undefined | 函数数组（即使只有一个也返回数组）
   *
   * @example
   * - 0个插件提供钩子：undefined
   * - 1个插件提供钩子：[fn1]
   * - 多个插件提供钩子：[fn1, fn2, fn3]
   */
  const mergeHookField = <T>(key: keyof ServerHooks): T[] | undefined => {
    // 收集所有插件提供的该钩子函数（每个都是单个函数）
    const values = hooksList.filter(h => h && h[key]).map(h => h![key] as T)

    return values.length === 0 ? undefined : values
  }

  // 合并所有钩子字段
  merged.beforeStart = mergeHookField('beforeStart')
  merged.beforeMessage = mergeHookField('beforeMessage')
  merged.afterMessage = mergeHookField('afterMessage')
  merged.onMessage = mergeHookField('onMessage')
  merged.onCall = mergeHookField('onCall')
  merged.onCancel = mergeHookField('onCancel')
  merged.onGetAgentCard = mergeHookField('onGetAgentCard')
  merged.onStart = mergeHookField('onStart')
  merged.beforeHandler = mergeHookField('beforeHandler')
  merged.afterHandler = mergeHookField('afterHandler')

  // onError 特殊处理：只保留最后一个（错误处理器不支持多个）
  const errorHooks = hooksList.filter(h => h?.onError).map(h => h!.onError)
  if (errorHooks.length > 0) {
    merged.onError = errorHooks[errorHooks.length - 1]
  }

  return merged
}

/**
 * 执行钩子数组
 *
 * 钩子按注册顺序依次执行（非并行）
 * 对于有返回值的钩子，如果返回 'handled' 或 'exit'，停止执行后续钩子
 *
 * @param hooks - 钩子函数数组（统一为数组格式）
 * @param args - 钩子函数参数
 * @returns 钩子返回值或 undefined
 *
 * @example
 * ```typescript
 * const result = await executeHookArray(
 *   [hook1, hook2, hook3],
 *   [message, stream, context]
 * )
 * // 如果 hook2 返回 'handled'，则不执行 hook3
 * ```
 */
export const executeHookArray = async <T extends (...args: any[]) => Promise<any>>(hooks: T[] | undefined, args: Parameters<T>): Promise<ReturnType<T> | undefined> => {
  if (!hooks) return undefined

  for (const hook of hooks) {
    const result = await hook(...args)

    // 短路机制：返回 'handled' 或 'exit' 时停止执行后续钩子
    if (result === 'handled' || result === 'exit') {
      return result
    }
  }

  return undefined
}

/**
 * 执行 AgentCard 钩子链
 *
 * 多个钩子依次处理 AgentCard，形成处理管道
 * 每个钩子接收上一个钩子处理后的 AgentCard
 *
 * @param hooks - AgentCard 钩子函数数组（统一为数组格式）
 * @param initialCard - 初始 AgentCard
 * @param context - 上下文信息
 * @returns 处理后的 AgentCard
 *
 * @example
 * ```typescript
 * const card = executeAgentCardHooks(
 *   [addSkillsHook, filterSkillsHook],
 *   initialCard,
 *   { agentId: 'host-agent' }
 * )
 * // initialCard -> addSkillsHook -> filterSkillsHook -> finalCard
 * ```
 */
export const executeAgentCardHooks = (hooks: OnGetAgentCardHook[] | undefined, initialCard: AgentCard, context: { agentId: string }): AgentCard => {
  if (!hooks) return initialCard

  let currentCard = initialCard
  for (const hook of hooks) {
    currentCard = hook(currentCard, context)
  }

  return currentCard
}

/**
 * 执行 beforeHandler 钩子链
 *
 * 特殊行为：
 * - 如果某个钩子调用 ctx.abort()，signal.aborted 变为 true，立即停止执行后续钩子
 * - 如果某个钩子返回 { stream }，后续钩子收到的是包装后的 stream
 * - 最终返回：{ stream }
 *
 * @param hooks - beforeHandler 钩子函数数组
 * @param initialStream - 初始 stream
 * @param context - Handler 上下文（包含 signal 和 abort()）
 * @returns 执行结果（包含可能被包装的 stream）
 *
 * @example
 * ```typescript
 * const result = await executeBeforeHandlerHooks(
 *   [preCallCheckHook, inputMetricsHook],
 *   stream,
 *   handlerContext
 * )
 *
 * // 框架检查 signal.aborted 决定是否执行 handler
 * if (context.signal.aborted) {
 *   return  // 钩子已通过 stream.send() 发送错误消息
 * }
 *
 * // 使用可能被包装的 stream 调用 handler
 * await handler(params, { ...ctx, stream: result.stream })
 * ```
 */
export const executeBeforeHandlerHooks = async (
  hooks: BeforeHandlerHook[] | undefined,
  initialStream: BidirectionalStream,
  context: HandlerContext,
): Promise<{ stream: BidirectionalStream }> => {
  if (!hooks) {
    return { stream: initialStream }
  }

  let currentStream = initialStream

  // 遍历执行所有的 beforeHandler 钩子函数
  for (const hook of hooks) {
    const result = await hook(currentStream, context)

    // 如果钩子调用了 ctx.abort()，立即停止执行后续钩子
    if (context.signal.aborted) {
      break
    }

    // 如果返回包装后的 stream，传递给下一个钩子
    if (result?.stream) {
      currentStream = result.stream
    }
  }

  return { stream: currentStream }
}

/**
 * 执行 afterHandler 钩子链
 *
 * 所有钩子依次执行，不支持短路
 * 异步执行，不阻塞主流程
 *
 * @param hooks - afterHandler 钩子函数数组
 * @param stream - 原始 stream（用于 IO 计量插件读取收集的输出）
 * @param context - Handler 上下文
 * @param result - Handler 执行结果
 *
 * @example
 * ```typescript
 * // 异步执行，不阻塞响应
 * executeAfterHandlerHooks(
 *   hooks,
 *   stream,
 *   handlerContext,
 *   { success: true, duration: 1234 }
 * ).catch(err => console.error('afterHandler hook error:', err))
 * ```
 */
export const executeAfterHandlerHooks = async (hooks: AfterHandlerHook[] | undefined, stream: BidirectionalStream, context: HandlerContext, result: AfterHandlerResultInfo): Promise<void> => {
  if (!hooks) return

  for (const hook of hooks) {
    try {
      await hook(stream, context, result)
    } catch (error) {
      // 单个钩子失败不影响其他钩子执行
      console.error('[Hooks] afterHandler hook error:', error)
    }
  }
}
