/**
 * A2A v7 Framework - TypeScript Types
 *
 * 设计理念：
 * 1. 协议层+业务层分离：协议消息固定3种，业务消息完全开放
 * 2. 扁平化消息结构：所有字段直接在Message级别
 * 3. 类型安全：使用Discriminated Union提供完美的类型推断
 */

import type * as grpc from '@grpc/grpc-js'
import type { IOMetricsProvider } from '../plugins/io-metrics-plugin/types'

// ============================================
// Error Codes
// ============================================

/**
 * A2A 框架错误码
 *
 * 用于标识框架层面的错误类型，便于客户端根据错误码进行处理
 */
export const ErrorCode = {
  /** Handler 被 beforeHandler 钩子中止 */
  HANDLER_ABORTED: 'HANDLER_ABORTED',
  /** Handler 执行过程中抛出异常 */
  HANDLER_ERROR: 'HANDLER_ERROR',
  /** 请求的 Skill 不存在 */
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  /** call 消息格式无效（如缺少 skill 字段） */
  INVALID_CALL_MESSAGE: 'INVALID_CALL_MESSAGE',
  /** 服务器内部错误 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

// ============================================
// Message Types (Unified Structure)
// ============================================

/**
 * Message - 统一消息结构
 *
 * 所有消息（协议消息 + 业务消息）都使用相同的数据结构
 *
 * 设计理念：
 * - 协议消息和业务消息结构完全一致
 * - 通过 type 字段区分消息类型
 * - text 提供人类可读描述
 * - data 提供结构化数据（JSON序列化）
 * - from 标识消息来源 Agent（协议层自动注入）
 *
 * 框架自动管理字段：
 * - messageId: 消息唯一ID（每条消息自动生成）
 * - timestamp: Unix 时间戳毫秒
 * - from: 消息来源 Agent 的 AgentCard（协议层自动注入）
 *
 * gRPC Metadata 传递字段（单一数据源，通过 ctx.metadata 访问）：
 * - x-trace-id: 链路追踪ID，格式: tr_{timestamp}_{random}
 * - x-session-id: 会话ID（用于跟踪对话历史）
 * - x-user-id: 用户ID（用于计费归属）
 * - x-span-id: 调用链 Span ID
 *
 * 协议消息类型（框架保留）：
 * - 'call': 调用Agent方法
 * - 'cancel': 取消执行
 * - 'agent-mount': 挂载请求（Tool Agent 挂载到 Host Agent）
 * - 'agent-unmount': 卸载请求（Tool Agent 从 Host Agent 卸载）
 *
 * 业务消息类型（应用自定义）：
 * - 'error': 错误消息
 * - 'question': 问题
 * - 'answer': 回答
 * - 'progress': 进度
 * - 'todolist': 任务列表
 * - 'plan': 计划
 * - 'done': Agent 工作流完成（携带总结信息和关键数据）
 * - ... 其他自定义类型
 */
export interface Message {
  messageId?: string // 可选，框架自动生成
  timestamp?: number // 可选，框架自动生成
  type: string // 消息类型（协议或业务）
  text: string // 人类可读内容（Markdown/纯文本）
  data?: any // 结构化数据（任意JSON可序列化对象），框架自动编解码
  from?: AgentCard // 消息来源 Agent（协议层自动注入，用于 UI 显示发送者信息）
}

// ============================================
// Agent Config
// ============================================

/**
 * TLS 证书配置
 *
 * 当 address 使用 a2as:// 协议时必须提供
 */
export interface TLSConfig {
  /**
   * 证书文件路径（PEM 格式）
   *
   * @example '/path/to/cert.pem'
   */
  cert: string

  /**
   * 私钥文件路径（PEM 格式）
   *
   * @example '/path/to/key.pem'
   */
  key: string

  /**
   * CA 证书文件路径（可选，用于客户端证书验证）
   *
   * @example '/path/to/ca.pem'
   */
  ca?: string
}

// Agent 配置（内部使用，包含实现）
export interface AgentConfig {
  agentId: string
  name: string
  version: string
  description: string

  /**
   * Agent 的网络地址
   *
   * 格式: a2a[s]://host:port
   *
   * - a2a://  - 无 TLS
   * - a2as:// - TLS 加密（需要配置 tls 选项）
   *
   * @example
   * // 监听所有网络接口（无 TLS）
   * address: 'a2a://0.0.0.0:50054'
   *
   * // 只监听本地（无 TLS）
   * address: 'a2a://127.0.0.1:50054'
   *
   * // TLS 加密（需要配置 tls）
   * address: 'a2as://0.0.0.0:50054'
   */
  address: string

  /**
   * TLS 证书配置
   *
   * 当 address 使用 a2as:// 协议时必须提供
   *
   * @example
   * ```typescript
   * const server = createAgentServer({
   *   address: 'a2as://0.0.0.0:50054',
   *   tls: {
   *     cert: '/path/to/cert.pem',
   *     key: '/path/to/key.pem',
   *   },
   *   // ...
   * })
   * ```
   */
  tls?: TLSConfig

  skills: SkillDefinition[]

  /**
   * 默认技能名称
   *
   * 必须是 skills 中某个技能的 name
   */
  defaultSkill: string

  /**
   * IO 计量提供者（可选）
   *
   * 配置后启用协议层 IO 计量功能：
   * - 自动计算输入/输出 Token 数量
   * - 自动生成带签名的 IO 承诺
   * - 自动上报指标到平台
   *
   * 不配置则不启用计费功能
   *
   * @example
   * ```typescript
   * import { createMetricsProvider } from '@agent-zhipin/metrics-provider'
   *
   * const server = createAgentServer({
   *   agentId: 'my-agent',
   *   // ...
   *   metricsProvider: createMetricsProvider({
   *     platformUrl: 'https://agent-zhipin.com/api',
   *     developerApiKey: 'YOUR_API_KEY'
   *   }),
   * })
   * ```
   */
  metricsProvider?: IOMetricsProvider
}

export interface SkillInfo {
  name: string
  description?: string

  /**
   * JSON Schema 格式的输入参数定义（用于 LangChain Tools）
   *
   * 当提供此字段时，该技能可以被其他 Agent 作为 LangChain Tool 调用
   *
   * @example
   * inputSchema: {
   *   type: 'object',
   *   properties: {
   *     path: {
   *       type: 'string',
   *       description: '文件路径（相对或绝对）'
   *     },
   *     content: {
   *       type: 'string',
   *       description: '文件内容'
   *     }
   *   },
   *   required: ['path', 'content']
   * }
   */
  inputSchema?: {
    type: 'object'
    properties: Record<
      string,
      {
        type: string
        description?: string
        enum?: any[]
        default?: any
        items?: any // for array type
        minimum?: number // for number type
        maximum?: number // for number type
      }
    >
    required?: string[]
  }

  /**
   * JSON Schema 格式的输出结果定义（可选）
   *
   * 用于描述技能的返回值结构
   */
  outputSchema?: {
    type: 'object' | 'string' | 'number' | 'boolean' | 'array'
    properties?: Record<
      string,
      {
        type: string
        description?: string
      }
    >
    items?: any // for array type
    description?: string
  }
}

// Agent 卡片（外部接口，纯数据）
export interface AgentCard {
  agentId: string
  name: string
  version: string
  description: string
  skills: SkillInfo[]

  /**
   * 默认技能名称
   *
   * 指向 skills 中的某个技能，作为 Agent 的默认入口。
   * 该技能通常包含标准工作流：澄清需求 → 生成 TodoList → 执行任务 → 返回结果
   *
   * Host Agent 在编排时会优先调用此技能。
   *
   * 注意：defaultSkill 必须存在于 skills 数组中。
   *
   * 示例：'execute', 'process', 'handle'
   */
  defaultSkill: string

  /**
   * Agent 的访问端点
   *
   * 由 getAgentCard() RPC 自动填充，基于客户端连接时使用的地址（:authority 头）
   *
   * 示例：
   * - 单机：{ host: 'localhost', port: 50059 }
   * - Docker：{ host: 'frontend-agent', port: 50059 }
   * - K8s：{ host: 'frontend-agent.default.svc.cluster.local', port: 50059 }
   * - 代理注册：{ host: 'localhost', port: 50050, namespace: 'tool-agent' }
   */
  endpoint: {
    host: string
    port: number
    /**
     * 命名空间（可选）
     *
     * 当 Agent 通过 ParasiteHostPlugin 寄生到另一个 Agent 时，
     * namespace 用于标识该 Agent，使调用方能够正确路由请求。
     *
     * @example
     * - undefined: 原生 Agent（直接监听端口）
     * - 'tool-agent@user123': 通过 Host Agent 寄生的 Tool Agent
     */
    namespace?: string
    /**
     * 预构建的 A2A 地址（方便直接使用）
     *
     * 格式：a2a://host:port[/namespace]
     *
     * @example
     * - 'a2a://localhost:50059'
     * - 'a2a://localhost:50050/tool-agent@user123'
     */
    address: string
  }
}

// ============================================
// Stream Types (方案C：双向流模式)
// ============================================

/**
 * 双向流接口
 *
 * 使用方式：
 * - 发送消息：stream.send(message)
 * - 接收消息：for await (const message of stream) { ... }
 * - 监听特定消息：stream.onError(handler).onCancel(handler)
 */
export interface BidirectionalStream {
  /**
   * 发送消息到对端
   */
  send: (message: Message) => void

  /**
   * 实现 async iterator，用于接收消息
   */
  [Symbol.asyncIterator]: () => AsyncIterator<Message>

  /**
   * 结束发送（half-close）
   */
  end: () => void

  /**
   * 取消流并清理资源
   */
  cancel: (reason?: string) => void

  /**
   * 监听特定类型的消息（可选）
   * @param type 消息类型
   * @param handler 处理函数
   * @returns 返回自身，支持链式调用
   */
  on?: (type: string, handler: (message: Message) => void) => BidirectionalStream
}

// ============================================
// Handler Types (函数式)
// ============================================

export interface Context {
  readonly streamId: string

  /**
   * 双向流
   *
   * @example
   * // 发送业务消息（发送问题）
   * ctx.stream.send({
   *   messageId: generateId(),
   *   timestamp: Date.now(),
   *   type: 'question',
   *   text: '请选择框架：\n1. React\n2. Vue',
   *   data: encodeJSON({ questionId: 'q1', options: ['React', 'Vue'] })
   * })
   *
   * // 接收业务消息（接收回答）
   * for await (const message of ctx.stream) {
   *   if (message.type === 'answer') {
   *     const answerData = decodeJSON(message.data)
   *     console.log('用户回答:', message.text)
   *     console.log('关联问题:', answerData.questionId)
   *   }
   * }
   */
  readonly stream: BidirectionalStream

  /**
   * gRPC metadata（原始访问）
   *
   * 开发者可以从 metadata 中获取任何自定义信息，例如：
   * - 认证 token
   * - 请求追踪 ID
   * - 会话 ID
   * - 任意自定义字段
   *
   * @example
   * // 获取认证 token
   * const authToken = ctx.metadata.get('auth-token')?.[0]?.toString('utf-8')
   *
   * // 获取会话 ID
   * const sessionId = ctx.metadata.get('session-id')?.[0]?.toString('utf-8')
   */
  readonly metadata: grpc.Metadata

  /**
   * gRPC 原始调用对象（仅 gRPC 连接可用）
   *
   * 暴露底层 gRPC 调用，提供最大灵活性。常用方法：
   * - call.getHost(): 获取客户端请求的目标地址（如 "8.153.165.230:50054"）
   * - call.getPeer(): 获取客户端地址
   * - call.cancelled: 检查是否已取消
   *
   * 注意：WebSocket 连接时此字段为 undefined
   *
   * @example
   * // 获取客户端连接的目标地址
   * if (ctx.call) {
   *   const hostAddress = ctx.call.getHost() // "8.153.165.230:50054"
   * }
   */
  readonly call?: grpc.ServerDuplexStream<any, any>

  /**
   * 获取自身的 AgentCard
   */
  getAgentCard: () => AgentCard

  /**
   * 从 gRPC metadata 中获取并反序列化 JSON 数据
   *
   * @param key - metadata key
   * @returns 反序列化后的对象，如果不存在或解析失败则返回 undefined
   *
   * @example
   * // 获取自定义数据
   * const customData = ctx.getMetadata<{ userId: string }>('custom-data-bin')
   * if (customData) {
   *   console.log('Custom data:', customData)
   * }
   */
  getMetadata: <T = any>(key: string) => T | undefined

  /**
   * 触发当前 handler 的 call 消息
   *
   * 包含消息基本信息：
   * - messageId: 消息唯一ID
   * - timestamp: 消息时间戳
   * - type: 消息类型
   * - text: 消息文本
   * - data: 结构化数据
   *
   * 注意：traceId/sessionId 等追踪字段通过 gRPC Metadata 传递，使用 ctx.metadata 访问
   *
   * @example
   * // 获取 traceId 用于日志追踪（从 gRPC Metadata，内联获取）
   * logger.info('收到请求', { traceId: ctx.metadata.get('x-trace-id') })
   *
   * // 调用其他 Agent 时传递 metadata
   * const stream = await client.call('execute', params, {
   *   metadata: ctx.metadata.getMap()
   * })
   */
  readonly message: Message

  /**
   * 取消信号（框架自动管理）
   *
   * 当 Client 发送 cancel 消息时，框架会自动触发此 signal 的 abort。
   * Handler 可以直接将此 signal 传递给支持 AbortSignal 的 API：
   * - LLM 调用（LangChain）
   * - fetch 请求
   * - A2A client.call()
   *
   * @example
   * const handler = async (params, ctx) => {
   *   // 直接使用 ctx.signal，无需手动创建 AbortController
   *   const response = await llm.invoke(messages, {
   *     signal: ctx.signal
   *   })
   *
   *   // 循环中检查取消状态
   *   while (hasMore) {
   *     if (ctx.signal.aborted) return
   *     await doSomething()
   *   }
   * }
   */
  readonly signal: AbortSignal
}

/**
 * 技能 Handler 类型
 *
 * 纯函数：接收参数和上下文，返回结果
 */
export type SkillHandler<TParams = any, TResult = any> = (params: TParams, ctx: Context) => Promise<TResult>

/**
 * Handler 钩子配置
 *
 * 传递给 createHandler 工厂函数，用于将钩子与原始 handler 组合
 */
export interface HandlerHooks {
  beforeHandler?: BeforeHandlerHook[]
  afterHandler?: AfterHandlerHook[]
}

/**
 * 技能定义
 *
 * 使用 handler 属性直接定义技能处理函数。
 * Server 内部会自动将 handler 包装为受保护版本，确保 beforeHandler/afterHandler 钩子被正确执行。
 *
 * @example
 * ```typescript
 * const config = {
 *   skills: [
 *     {
 *       name: 'execute',
 *       handler: async (params, ctx) => { ... },
 *       description: '执行任务',
 *     }
 *   ]
 * }
 * ```
 */
export interface SkillDefinition {
  /** 技能名称 */
  name: string

  /**
   * 技能处理函数
   *
   * Server 在启动时会将此 handler 包装为受保护版本，
   * 自动应用 beforeHandler/afterHandler 钩子。
   */
  handler: SkillHandler

  /** 技能描述 */
  description?: string

  /** 输入参数 JSON Schema */
  inputSchema?: SkillInfo['inputSchema']

  /** 输出结果 JSON Schema */
  outputSchema?: SkillInfo['outputSchema']
}

// ============================================
// Server Types
// ============================================

/**
 * 钩子返回类型
 *
 * - 'handled': 已处理，跳过默认处理器，继续下一个消息
 * - 'pass': 未处理，继续调用默认处理器
 * - 'exit': 已处理，退出消息循环
 * - void: 等同于 'pass'
 */
export type HookResult = 'handled' | 'pass' | 'exit' | void

/**
 * 消息上下文 - 在钩子间共享数据
 */
export interface MessageContext {
  /**
   * 用户自定义数据存储
   * 可以在 beforeMessage 中存储数据，在 afterMessage 中读取
   */
  metadata: Map<string, any>

  /**
   * gRPC 原始 metadata（只读）
   *
   * 用于访问客户端传递的认证信息、会话标识等
   *
   * @example
   * // 获取 authorization header
   * const authHeader = context.grpcMetadata.get('authorization')?.[0]?.toString()
   * // authHeader = 'Bearer <token>'
   *
   * // 获取自定义 header
   * const sessionId = context.grpcMetadata.get('x-session-id')?.[0]?.toString()
   */
  grpcMetadata: grpc.Metadata

  /**
   * Agent 基础信息
   */
  agentId: string
  agentName: string

  /**
   * 消息处理开始时间（毫秒时间戳）
   */
  startTime: number

  /**
   * 请求的目标命名空间（可选）
   *
   * 当客户端通过 ParasiteHostPlugin 调用寄生注册的 Agent 时，
   * 会在 gRPC metadata 中包含 x-agent-namespace 头，
   * 框架会自动解析并填充到此字段。
   *
   * @example
   * - undefined: 直接调用原生 Agent
   * - 'tool-agent@user123': 调用通过寄生注册的 Tool Agent
   */
  namespace?: string
}

/**
 * Before Message Hook
 * 在处理任何消息之前调用
 *
 * 支持短路：
 * - 返回 'handled': 消息已处理，跳过后续钩子和默认处理器
 * - 返回 'exit': 消息已处理，退出消息循环
 * - 返回 'pass' 或 void: 继续执行后续钩子和默认处理器
 */
export type BeforeMessageHook = (message: Message, stream: BidirectionalStream, context: MessageContext) => Promise<HookResult>

/**
 * After Message Hook
 * 在消息处理完成后调用
 */
export type AfterMessageHook = (message: Message, stream: BidirectionalStream, context: MessageContext, result: 'continue' | 'exit') => Promise<void>

/**
 * On Call Hook
 * 处理 call 消息
 */
export type OnCallHook = (skill: string, params: any, stream: BidirectionalStream, context: MessageContext) => Promise<HookResult>

/**
 * On Cancel Hook
 * 处理 cancel 消息
 */
export type OnCancelHook = (stream: BidirectionalStream, context: MessageContext) => Promise<void>

/**
 * On Error Hook
 * 处理错误
 */
export type OnErrorHook = (error: Error, message: Message, stream: BidirectionalStream, context: MessageContext) => Promise<void>

/**
 * On GetAgentCard Hook
 * 修改 AgentCard
 */
export type OnGetAgentCardHook = (agentCard: AgentCard, context: { agentId: string }) => AgentCard

/**
 * On Start Hook
 * Server 启动后触发
 *
 * 用于执行启动后的初始化逻辑（如主动挂载到远程 Agent）
 *
 * 注意：
 * - 此钩子在 Server 启动成功后立即调用
 * - 所有 onStart 钩子会并行执行（不阻塞）
 * - 如果钩子执行失败，会打印错误日志但不影响 Server 运行
 */
/**
 * SkillHandlers Map
 *
 * 技能处理函数集合，由 Server 在启动时创建
 * 这些 handler 已经组合了 beforeHandler/afterHandler 钩子
 *
 * @example
 * ```typescript
 * // 在插件中调用技能
 * const handler = skillHandlers.get('execute')
 * if (handler) {
 *   await handler(params, ctx)  // 钩子自动执行
 * }
 * ```
 */
export type SkillHandlers = Map<string, SkillHandler>

/**
 * On Start Hook
 * Server 启动后钩子
 *
 * @param agentConfig - Agent 配置
 * @param agentCard - Agent 卡片
 * @param skillHandlers - 技能处理函数集合
 */
export type OnStartHook = (agentConfig: AgentConfig, agentCard: AgentCard, skillHandlers: SkillHandlers) => Promise<void>

/**
 * On Message Hook
 * 通用消息处理钩子（在 beforeMessage 之后、onCall/onCancel 之前执行）
 *
 * 用于处理自定义消息类型（如 agent-mount、agent-unmount 等插件定义的消息）
 *
 * 执行顺序：
 * beforeMessage → onMessage → onCall/onCancel → 默认处理器 → afterMessage
 *
 * 返回值：
 * - 'handled': 消息已处理，跳过后续钩子和默认处理器，继续下一个消息
 * - 'pass': 消息未处理，继续执行后续钩子或默认处理器
 * - 'exit': 消息已处理，退出消息循环
 * - void: 等同于 'pass'
 */
export type OnMessageHook = (message: Message, stream: BidirectionalStream, context: MessageContext) => Promise<HookResult>

// ============================================
// Handler Lifecycle Hooks (用于 IO 计量等)
// ============================================

/**
 * Handler 上下文 - beforeHandler/afterHandler 钩子共享
 *
 * 提供 Handler 执行期间的上下文信息，支持钩子间数据传递
 */
export interface HandlerContext {
  /**
   * 技能名称
   */
  skill: string

  /**
   * 调用参数
   */
  params: any

  /**
   * 链路追踪 ID
   * 格式: tr_{timestamp}_{random}
   */
  traceId: string

  /**
   * 用户 ID（从 gRPC metadata x-user-id 提取）
   * 用于 IO 计量的用户归属
   */
  userId?: string

  /**
   * Agent ID
   */
  agentId: string

  /**
   * Handler 开始时间（毫秒时间戳）
   */
  startTime: number

  /**
   * 钩子间共享数据
   * beforeHandler 可存储数据，afterHandler 可读取
   */
  metadata: Map<string, any>

  /**
   * gRPC 原始 metadata（只读）
   *
   * 允许插件访问客户端传递的任意 metadata，如：
   * - x-parent-span-id: 父调用的 Span ID（调用链追踪）
   * - x-custom-header: 自定义字段
   *
   * @example
   * const parentSpanId = ctx.grpcMetadata?.get('x-parent-span-id')?.[0]?.toString()
   */
  grpcMetadata?: grpc.Metadata

  /**
   * 取消信号（框架自动管理）
   *
   * 当用户取消请求或插件调用 abort() 时，signal.aborted 变为 true。
   * 框架会在 signal.aborted 时跳过 handler 执行。
   *
   * @example
   * // 在 beforeHandler 中检查（通常不需要，框架自动处理）
   * if (ctx.signal.aborted) return
   */
  signal: AbortSignal

  /**
   * 中止当前调用
   *
   * 触发 signal.aborted = true，框架会跳过 handler 执行。
   * 调用前应先通过 stream.send() 发送错误消息。
   *
   * @example
   * // 认证失败时中止
   * stream.send({ type: 'error', text: '请先登录' })
   * ctx.abort()
   */
  abort: () => void
}

/**
 * beforeHandler 返回值
 *
 * 注意：中止调用请使用 ctx.abort()，不再通过返回值控制
 */
export interface BeforeHandlerResult {
  /**
   * 包装后的 stream
   * 用于 IO 计量收集输出
   */
  stream?: BidirectionalStream
}

/**
 * afterHandler 结果信息
 */
export interface AfterHandlerResultInfo {
  /**
   * Handler 是否执行成功
   */
  success: boolean

  /**
   * 错误信息（success=false 时存在）
   */
  error?: Error

  /**
   * Handler 执行耗时（毫秒）
   */
  duration: number
}

/**
 * Before Start Hook
 * Server 启动前钩子（可阻塞启动）
 *
 * 用途：
 * - 计费平台注册
 * - SDK 完整性验证
 * - 获取签名密钥
 *
 * 特性：
 * - 在 Server 绑定端口之前执行
 * - 抛出错误可阻止 Server 启动
 * - 按注册顺序依次执行
 */
export type BeforeStartHook = (agentConfig: AgentConfig) => Promise<void>

/**
 * Before Handler Hook
 * Handler 执行前钩子
 *
 * 用途：
 * - 预调用检查（余额验证）
 * - 输入计量
 * - 包装 stream 收集输出
 *
 * 特性：
 * - 可访问 skill、params、userId 等上下文
 * - 返回 { stream } 可包装 stream
 * - 调用 ctx.abort() 可中止调用（先发送错误消息，再调用 abort）
 */
export type BeforeHandlerHook = (stream: BidirectionalStream, context: HandlerContext) => Promise<BeforeHandlerResult | void>

/**
 * After Handler Hook
 * Handler 执行后钩子
 *
 * 用途：
 * - 输出计量
 * - 指标上报
 * - 调用日志
 *
 * 特性：
 * - 可访问 handler 执行结果和耗时
 * - 异步执行，不阻塞响应
 */
export type AfterHandlerHook = (stream: BidirectionalStream, context: HandlerContext, result: AfterHandlerResultInfo) => Promise<void>

/**
 * Server Hooks 配置
 *
 * 每个插件提供单个钩子函数，框架自动收集多个插件的钩子并按顺序执行
 *
 * @example
 * ```typescript
 * // 每个插件只提供单个钩子函数
 * const loggingPlugin: ServerPlugin = {
 *   hooks: {
 *     beforeMessage: async (msg, stream, ctx) => {
 *       console.log(msg.type)
 *     }
 *   }
 * }
 *
 * // 框架自动收集多个插件的钩子
 * server
 *   .use(loggingPlugin)   // beforeMessage: fn1
 *   .use(metricsPlugin)   // beforeMessage: fn2
 *   .use(authPlugin)      // beforeMessage: fn3
 * // 框架内部按顺序执行: [fn1, fn2, fn3]
 * ```
 */
export interface ServerHooks {
  /**
   * 生命周期钩子：Server 启动前
   * 用于验证配置、注册到外部服务等
   * 抛出错误可阻止 Server 启动
   */
  beforeStart?: BeforeStartHook

  /**
   * 生命周期钩子：消息处理前
   */
  beforeMessage?: BeforeMessageHook

  /**
   * 生命周期钩子：消息处理后
   */
  afterMessage?: AfterMessageHook

  /**
   * 通用消息处理钩子（支持短路）
   * 在 beforeMessage 之后、onCall/onCancel 之前执行
   */
  onMessage?: OnMessageHook

  /**
   * 消息类型钩子：call
   */
  onCall?: OnCallHook

  /**
   * 消息类型钩子：cancel
   */
  onCancel?: OnCancelHook

  /**
   * 错误钩子
   */
  onError?: OnErrorHook

  /**
   * AgentCard 钩子
   */
  onGetAgentCard?: OnGetAgentCardHook

  /**
   * 生命周期钩子：Server 启动后
   * 用于执行启动后的初始化逻辑（如主动挂载到远程 Agent）
   */
  onStart?: OnStartHook

  /**
   * Handler 生命周期钩子：Handler 执行前
   * 用于预调用检查、输入计量、包装 stream
   */
  beforeHandler?: BeforeHandlerHook

  /**
   * Handler 生命周期钩子：Handler 执行后
   * 用于输出计量、指标上报
   */
  afterHandler?: AfterHandlerHook
}

/**
 * Internal Server Hooks - 框架内部使用的合并后钩子配置
 *
 * 与 ServerHooks 的区别：
 * - ServerHooks: 用户定义时只能是单个函数（用户不应手动写数组）
 * - InternalServerHooks: 框架合并多个插件后统一为函数数组
 *
 * 设计决策：统一使用数组表示，即使只有一个钩子也用 [hook] 表示
 * - 0个插件：undefined
 * - 1个插件：[fn]
 * - 多个插件：[fn1, fn2, fn3]
 *
 * @internal 此类型仅供框架内部使用
 */
export interface InternalServerHooks {
  beforeStart?: BeforeStartHook[]
  beforeMessage?: BeforeMessageHook[]
  afterMessage?: AfterMessageHook[]
  onMessage?: OnMessageHook[]
  onCall?: OnCallHook[]
  onCancel?: OnCancelHook[]
  onError?: OnErrorHook
  onGetAgentCard?: OnGetAgentCardHook[]
  onStart?: OnStartHook[]
  beforeHandler?: BeforeHandlerHook[]
  afterHandler?: AfterHandlerHook[]
}

/**
 * Server Plugin - 中间件插件接口
 *
 * 插件可以提供钩子函数和额外的 API
 *
 * @example
 * const myPlugin: ServerPlugin = {
 *   hooks: {
 *     beforeMessage: async (msg, stream, ctx) => {
 *       console.log('Before:', msg.type)
 *     }
 *   },
 *   // 可选：插件提供的额外 API
 *   getMountedAgents: () => [...],
 *   getMountedSkills: () => [...]
 * }
 */
export interface ServerPlugin {
  /**
   * 插件提供的钩子配置
   */
  hooks: ServerHooks

  /**
   * 插件可以提供额外的 API（可选）
   * 使用索引签名允许任意方法
   */
  [key: string]: any
}

/**
 * Server Builder - 支持链式调用的服务器构建器
 */
export interface ServerBuilder {
  /**
   * 注册插件
   * 支持链式调用
   *
   * @example
   * const server = createAgentServer(config)
   *   .use(createMountManager())
   *   .use(loggingPlugin)
   */
  use: (plugin: ServerPlugin) => ServerBuilder

  /**
   * 启动服务器
   */
  start: () => Promise<number>

  /**
   * 关闭服务器
   */
  shutdown: () => Promise<void>

  /**
   * gRPC 服务器实例（只读）
   */
  readonly grpcServer: grpc.Server
}

export interface ServerInstance {
  readonly grpcServer: grpc.Server
  /**
   * 技能处理函数集合
   *
   * 包含所有技能的 handler，已组合 beforeHandler/afterHandler 钩子
   * 用于传递给 onStart 钩子，使插件（如 ParasitePlugin）能够调用技能
   */
  readonly skillHandlers: SkillHandlers
  start: () => Promise<number>
  shutdown: () => Promise<void>
}

// ============================================
// Client Types
// ============================================

export interface ClientConfig {
  agentId: string
  /**
   * A2A 地址
   *
   * 格式: a2a[s]://host:port[/namespace]
   *
   * - a2a://  - 无 TLS
   * - a2as:// - TLS 加密
   * - /namespace - 用于调用通过 ParasiteHostPlugin 寄生注册的 Agent
   *
   * @example
   * // 基础格式
   * address: 'a2a://localhost:50050'
   *
   * // TLS 加密
   * address: 'a2as://api.example.com:50050'
   *
   * // 调用通过 Host Agent 寄生的 Tool Agent
   * address: 'a2a://localhost:50050/tool-agent@user123'
   */
  address: string
  /**
   * 自定义 gRPC metadata
   *
   * 应用层传递字符串，框架自动转换为 Buffer 传递给 gRPC。
   *
   * @example
   * metadata: {
   *   'auth-token': 'abc123',
   *   'session-id': sessionId
   * }
   */
  metadata?: Record<string, string>
  timeout?: number
}

/**
 * CallOptions - 客户端调用选项
 *
 * 设计理念：
 * - 协议层只提供 metadata 字段，不关心具体业务字段
 * - 业务层自己负责设置具体的 x-* metadata
 * - 保持协议层的纯净和通用性
 *
 * 常见 metadata 约定（业务层设置）：
 * - 'x-trace-id': 链路追踪 ID
 * - 'x-session-id': 会话 ID
 * - 'x-user-id': 用户 ID
 *
 * @example
 * const stream = await client.call('execute', params, {
 *   metadata: {
 *     'x-trace-id': traceId,
 *     'x-session-id': sessionId,
 *     'x-user-id': userId,
 *   },
 * })
 */
export interface CallOptions {
  /**
   * gRPC metadata / WebSocket 消息元数据
   * 用于传递认证、追踪等上下文信息
   * 类型兼容 grpc.Metadata.getMap() 返回值
   */
  metadata?: { [key: string]: string | Buffer }

  /**
   * 取消信号
   * 当 signal 被 abort 时，框架自动调用 stream.cancel() 取消下游 Agent
   *
   * @example
   * // 在 Agent handler 中调用下游 Agent
   * const stream = await client.call('execute', params, {
   *   signal: ctx.signal,  // 框架自动处理取消传播
   *   metadata: ctx.metadata.getMap()
   * })
   */
  signal?: AbortSignal
}

export interface ClientInstance {
  /**
   * 调用 Agent 方法，返回双向流（异步版本）
   *
   * 设计理念：
   * - 明确的异步操作（返回 Promise）
   * - 清晰的错误处理路径
   * - 返回时连接已建立，可立即使用
   * - 避免竞态条件和资源泄漏
   *
   * @example
   * const stream = await client.call('execute', { requirement: '生成登录框' })
   *
   * for await (const message of stream) {
   *   // 协议消息由框架处理
   *   if (message.type === 'call' || message.type === 'cancel' || message.type === 'error') {
   *     continue
   *   }
   *
   *   // 业务消息由应用处理
   *   switch (message.type) {
   *     case 'question':
   *       const answer = await promptUser(message.text)
   *       stream.send({
   *         messageId: generateId(),
   *         timestamp: Date.now(),
   *         type: 'answer',
   *         text: answer,
   *         data: encodeJSON({ questionId: '...', value: answer })
   *       })
   *       break
   *     case 'todolist':
   *       console.log('TodoList:', message.text)
   *       break
   *   }
   * }
   *
   * @example
   * // 传递 metadata 实现请求追踪
   * const stream = await client.call('execute', params, {
   *   metadata: ctx.metadata.getMap(),
   * })
   */
  call: <TParams = any>(skill: string, params: TParams, options?: CallOptions) => Promise<BidirectionalStream>

  /**
   * 建立到 Agent 的原始双向流连接（不发送任何初始消息）
   *
   * 与 call() 的区别：
   * - call(skill, params)：自动发送初始 'call' 消息，适用于单次技能调用
   * - connect()：返回纯净的双向流，不发送任何消息，适用于完全透明的消息转发
   *
   * 主要用途：
   * - 透明代理和消息转发
   * - 需要完全控制消息流的场景
   *
   * @example
   * // Host Agent 作为透明代理，转发 Frontend 和 CLI 之间的所有消息
   * const cliStream = await cliClient.connect()
   *
   * // 双向转发（完全透明）
   * await Promise.all([
   *   // Frontend → CLI
   *   (async () => {
   *     for await (const msg of frontendStream) {
   *       cliStream.send(msg)
   *     }
   *   })(),
   *
   *   // CLI → Frontend
   *   (async () => {
   *     for await (const msg of cliStream) {
   *       frontendStream.send(msg)
   *     }
   *   })()
   * ])
   */
  connect: () => Promise<BidirectionalStream>

  getAgentCard: () => Promise<AgentCard>

  checkHealth: () => Promise<boolean>

  close: () => Promise<void>
}

// ============================================
// Client Hooks and Plugins
// ============================================

/**
 * 调用上下文 - 在 Client Hooks 间传递和修改数据
 *
 * beforeCall 钩子可以修改 metadata 来注入 CallTicket 等信息
 */
export interface CallContext {
  /**
   * 目标 Agent ID
   */
  agentId: string

  /**
   * 调用的技能名称
   */
  skill: string

  /**
   * 调用参数（可被钩子修改）
   */
  params: any

  /**
   * gRPC metadata（可被钩子修改）
   *
   * beforeCall 钩子可以向 metadata 中注入数据，
   * 这些数据会在建立 gRPC 连接时传递给 Server 端
   *
   * @example
   * // 在 beforeCall 中注入 CallTicket
   * context.metadata['x-call-ticket'] = JSON.stringify(ticket)
   */
  metadata: Record<string, string>
}

/**
 * Before Call Hook
 *
 * 在建立 gRPC 连接和发送 call 消息之前执行
 *
 * 主要用途：
 * - 添加认证信息
 * - 修改调用参数
 * - 记录日志
 * - 注入指标收集等
 *
 * 注意：
 * - 抛出错误可中断调用
 * - 可以修改 context.metadata 来注入数据
 *
 * @example
 * beforeCall: async (context) => {
 *   context.metadata['x-trace-id'] = traceId
 * }
 */
export type BeforeCallHook = (context: CallContext) => Promise<void>

/**
 * After Call Hook
 *
 * 在获得 stream 之后、返回给用户之前执行
 *
 * 主要用途：
 * - 包装或增强 stream
 * - 记录调用日志
 * - 监控和统计
 *
 * @example
 * afterCall: async (context, stream) => {
 *   console.log(`[${context.agentId}] 调用 ${context.skill} 成功`)
 *   return stream  // 可以返回包装后的 stream
 * }
 */
export type AfterCallHook = (context: CallContext, stream: BidirectionalStream) => Promise<BidirectionalStream>

/**
 * Client On Error Hook
 *
 * 调用过程中发生错误时执行
 *
 * 主要用途：
 * - 统一错误处理
 * - 错误日志记录
 * - 重试逻辑（通过重新抛出或不抛出来控制）
 *
 * @example
 * onError: async (error, context) => {
 *   console.error(`调用 ${context.skill} 失败:`, error.message)
 *   // 可以选择重新抛出或静默处理
 * }
 */
export type ClientOnErrorHook = (error: Error, context: CallContext) => Promise<void>

/**
 * Client Hooks 配置
 *
 * 与 Server Hooks 类似，每个插件提供单个钩子函数，
 * 框架自动收集多个插件的钩子并按顺序执行
 */
export interface ClientHooks {
  /**
   * 调用前钩子
   * 在建立连接和发送消息之前执行
   */
  beforeCall?: BeforeCallHook

  /**
   * 调用后钩子
   * 在获得 stream 之后、返回给用户之前执行
   */
  afterCall?: AfterCallHook

  /**
   * 错误处理钩子
   */
  onError?: ClientOnErrorHook
}

/**
 * Internal Client Hooks - 框架内部使用的合并后钩子配置
 *
 * @internal 此类型仅供框架内部使用
 */
export interface InternalClientHooks {
  beforeCall?: BeforeCallHook[]
  afterCall?: AfterCallHook[]
  onError?: ClientOnErrorHook[]
}

/**
 * Client Plugin - 客户端插件接口
 *
 * 插件可以提供钩子函数和额外的 API
 *
 * @example
 * const billingPlugin: ClientPlugin = {
 *   hooks: {
 *     beforeCall: async (context) => {
 *       const ticket = await getCallTicket(context.agentId, context.skill)
 *       context.metadata['x-call-ticket'] = JSON.stringify(ticket)
 *     }
 *   },
 *   // 可选：插件提供的额外 API
 *   getBalance: () => currentBalance
 * }
 */
export interface ClientPlugin {
  /**
   * 插件提供的钩子配置
   */
  hooks: ClientHooks

  /**
   * 插件可以提供额外的 API（可选）
   */
  [key: string]: any
}

/**
 * Client Builder - 支持链式调用的客户端构建器
 *
 * @example
 * const client = createAgentClient(config)
 *   .use(loggingPlugin)
 *   .use(metricsPlugin)
 *
 * const stream = await client.call('execute', { ... })
 */
export interface ClientBuilder extends ClientInstance {
  /**
   * 注册插件
   * 支持链式调用
   */
  use: (plugin: ClientPlugin) => ClientBuilder
}
