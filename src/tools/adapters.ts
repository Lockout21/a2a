/**
 * Tool 适配器 - 将通用 AgentTool 转换为各 LLM SDK 格式
 *
 * 支持的格式：
 * - OpenAI tools 格式
 * - Anthropic tools 格式
 * - LangChain DynamicStructuredTool
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { AgentTool, OpenAITool, AnthropicTool } from './types'

// ==================== OpenAI 适配器 ====================

/**
 * 将 AgentTool 转换为 OpenAI tools 格式
 *
 * @example
 * ```typescript
 * import OpenAI from 'openai'
 * import { buildAgentTools, toOpenAITools } from '@multi-agent/a2a'
 *
 * const { tools } = buildAgentTools(agentCards)
 * const openaiTools = toOpenAITools(tools)
 *
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4',
 *   messages,
 *   tools: openaiTools,
 * })
 * ```
 */
export const toOpenAITools = (tools: AgentTool[]): OpenAITool[] => {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

/**
 * 执行 OpenAI tool call
 *
 * @example
 * ```typescript
 * const toolCall = response.choices[0].message.tool_calls[0]
 * const result = await executeOpenAIToolCall(tools, toolCall)
 * ```
 */
export const executeOpenAIToolCall = async (tools: AgentTool[], toolCall: { function: { name: string; arguments: string } }): Promise<string> => {
  const tool = tools.find(t => t.name === toolCall.function.name)
  if (!tool) {
    throw new Error(`Tool not found: ${toolCall.function.name}`)
  }

  const args = JSON.parse(toolCall.function.arguments)
  return tool.execute(args)
}

// ==================== Anthropic 适配器 ====================

/**
 * 将 AgentTool 转换为 Anthropic tools 格式
 *
 * @example
 * ```typescript
 * import Anthropic from '@anthropic-ai/sdk'
 * import { buildAgentTools, toAnthropicTools } from '@multi-agent/a2a'
 *
 * const { tools } = buildAgentTools(agentCards)
 * const anthropicTools = toAnthropicTools(tools)
 *
 * const response = await anthropic.messages.create({
 *   model: 'claude-3-opus-20240229',
 *   messages,
 *   tools: anthropicTools,
 * })
 * ```
 */
export const toAnthropicTools = (tools: AgentTool[]): AnthropicTool[] => {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

/**
 * 执行 Anthropic tool use
 *
 * @example
 * ```typescript
 * const toolUse = response.content.find(c => c.type === 'tool_use')
 * const result = await executeAnthropicToolUse(tools, toolUse)
 * ```
 */
export const executeAnthropicToolUse = async (tools: AgentTool[], toolUse: { name: string; input: unknown }): Promise<string> => {
  const tool = tools.find(t => t.name === toolUse.name)
  if (!tool) {
    throw new Error(`Tool not found: ${toolUse.name}`)
  }

  return tool.execute(toolUse.input)
}

// ==================== LangChain 适配器 ====================

/**
 * 将 AgentTool 转换为 LangChain DynamicStructuredTool
 *
 * @example
 * ```typescript
 * import { ChatOpenAI } from '@langchain/openai'
 * import { buildAgentTools, toLangChainTools } from '@multi-agent/a2a'
 *
 * const { tools } = buildAgentTools(agentCards)
 * const langchainTools = toLangChainTools(tools)
 *
 * const llmWithTools = llm.bindTools(langchainTools)
 * ```
 */
export const toLangChainTools = (tools: AgentTool[]): DynamicStructuredTool[] => {
  return tools.map(
    tool =>
      new DynamicStructuredTool({
        name: tool.name,
        description: tool.description,
        schema: z.fromJSONSchema(tool.inputSchema as any),
        func: async (input: unknown) => tool.execute(input),
      }),
  )
}
