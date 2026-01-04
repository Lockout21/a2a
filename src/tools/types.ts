/**
 * 通用 Tool 类型定义
 *
 * 提供与 LLM SDK 无关的通用工具格式
 */

import type { Message } from '../types'

/**
 * JSON Schema 类型（简化版）
 */
export type JSONSchema = Record<string, unknown>

/**
 * 通用 Agent Tool 接口
 *
 * 与具体 LLM SDK 无关，可转换为 OpenAI/Anthropic/LangChain 等格式
 */
export interface AgentTool {
  /** 工具名称（格式：agentId_skillName） */
  name: string

  /** 工具描述（给 LLM 看） */
  description: string

  /** 输入参数的 JSON Schema */
  inputSchema: JSONSchema

  /** 执行工具（内部通过 A2A 调用 Agent） */
  execute: (params: unknown) => Promise<string>
}

/**
 * 工具元信息 - 用于显示友好的工具调用文本
 */
export interface ToolInfo {
  /** Agent ID (如 tool-agent) */
  agentId: string

  /** Agent 名称 (如 Tool Agent，来自 AgentCard.name) */
  agentName: string

  /** 技能名称 (如 Read) */
  skillName: string
}

/**
 * buildAgentTools 的返回结果
 */
export interface BuildAgentToolsResult {
  /** 通用工具列表 */
  tools: AgentTool[]

  /** 工具信息映射表 (key: "tool-agent_Read") */
  toolInfoMap: Map<string, ToolInfo>
}

/**
 * 消息流接口（用于实时转发子 Agent 的 progress 消息）
 */
export interface MessageStream {
  send: (message: Message) => void
}

/**
 * buildAgentTools 的配置选项
 */
export interface BuildAgentToolsOptions {
  /** 要排除的 Agent ID（通常是自己） */
  excludeAgentIds?: string[]

  /**
   * gRPC metadata（原始传递，不加工）
   *
   * 从 ctx.metadata.getMap() 获取，包含：
   * - x-trace-id: 链路追踪 ID
   * - x-session-id: 会话 ID
   * - x-user-id: 用户 ID（用于 IO 计费追踪）
   */
  metadata?: Record<string, string | Buffer>

  /**
   * 取消信号（用于中断下游 Agent 调用）
   */
  signal?: AbortSignal

  /** 调用超时时间（毫秒，默认 120000） */
  timeout?: number

  /**
   * 父级消息流（用于实时转发子 Agent 的 progress 消息）
   *
   * 传入 ctx.stream 可将子 Agent 的进度实时转发给用户
   */
  parentStream?: MessageStream
}

// ==================== OpenAI 格式 ====================

/**
 * OpenAI Function 定义
 */
export interface OpenAIFunction {
  name: string
  description: string
  parameters: JSONSchema
  strict?: boolean
}

/**
 * OpenAI Tool 定义
 */
export interface OpenAITool {
  type: 'function'
  function: OpenAIFunction
}

// ==================== Anthropic 格式 ====================

/**
 * Anthropic Tool 定义
 */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: JSONSchema
}