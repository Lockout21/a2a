/**
 * Tools 模块 - 通用 Agent Tools 构建与转换
 *
 * 提供与 LLM SDK 无关的通用工具格式，支持转换为：
 * - OpenAI tools 格式
 * - Anthropic tools 格式
 * - LangChain DynamicStructuredTool
 */

// 类型导出
export type { JSONSchema, AgentTool, ToolInfo, BuildAgentToolsResult, BuildAgentToolsOptions, MessageStream, OpenAIFunction, OpenAITool, AnthropicTool } from './types'

// 核心函数
export { buildAgentTools, skillsToAgentTools } from './build-agent-tools'

// 适配器
export {
  // OpenAI
  toOpenAITools,
  executeOpenAIToolCall,
  // Anthropic
  toAnthropicTools,
  executeAnthropicToolUse,
  // LangChain
  toLangChainTools,
} from './adapters'
