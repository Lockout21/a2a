/**
 * buildAgentTools - 将 AgentCard 转换为通用 Tool 格式
 *
 * 核心功能：
 * 1. 从 AgentCard 提取 skills（带 inputSchema）
 * 2. 创建通用 AgentTool，执行时通过 A2A 协议调用 Agent
 *
 * 返回的 AgentTool 可通过适配器转换为：
 * - OpenAI tools 格式
 * - Anthropic tools 格式
 * - LangChain DynamicStructuredTool
 */

import { createAgentClient } from '../core/client'
import type { AgentCard, SkillInfo, SkillDefinition, Context } from '../types'
import type { AgentTool, ToolInfo, BuildAgentToolsResult, BuildAgentToolsOptions, JSONSchema } from './types'

/**
 * 从 AgentCard 列表构建通用 Agent Tools
 *
 * @param agentCards - Agent 列表（从 teamContext.members 传入）
 * @param options - 配置选项
 * @returns { tools, toolInfoMap } - 通用工具列表和工具信息映射表
 *
 * @example
 * ```typescript
 * const { tools, toolInfoMap } = buildAgentTools(agentCards, {
 *   excludeAgentIds: ['chat-agent'],
 *   metadata: ctx.metadata.getMap(),
 * })
 *
 * // 转换为 OpenAI 格式
 * const openaiTools = toOpenAITools(tools)
 *
 * // 转换为 Anthropic 格式
 * const anthropicTools = toAnthropicTools(tools)
 * ```
 */
export const buildAgentTools = (agentCards: AgentCard[], options?: BuildAgentToolsOptions): BuildAgentToolsResult => {
  const { excludeAgentIds = [] } = options ?? {}

  const tools: AgentTool[] = []
  const toolInfoMap = new Map<string, ToolInfo>()

  for (const card of agentCards) {
    // 跳过排除的 Agent
    if (excludeAgentIds.includes(card.agentId)) {
      continue
    }

    for (const skill of card.skills) {
      // 只有定义了 inputSchema 的 skill 才能作为工具
      if (!skill.inputSchema) {
        continue
      }

      // 工具名称: agentId_skillName
      const toolName = `${card.agentId}_${skill.name}`

      // 保存工具信息
      toolInfoMap.set(toolName, {
        agentId: card.agentId,
        agentName: card.name,
        skillName: skill.name,
      })

      // 创建通用 AgentTool
      const tool: AgentTool = {
        name: toolName,
        description: `${card.name} - ${skill.description || skill.name}`,
        inputSchema: skill.inputSchema as JSONSchema,
        execute: createExecuteFunction(card, skill, agentCards, options),
      }

      tools.push(tool)
    }
  }

  return { tools, toolInfoMap }
}

/**
 * 创建工具执行函数
 */
const createExecuteFunction = (card: AgentCard, skill: SkillInfo, allAgentCards: AgentCard[], options?: BuildAgentToolsOptions) => {
  return async (input: unknown): Promise<string> => {
    // 检查是否已取消
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled')
    }

    // 转换 metadata
    const metadataAsString: Record<string, string> = {}
    if (options?.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        metadataAsString[key] = Buffer.isBuffer(value) ? value.toString('utf-8') : value
      }
    }

    // 创建 A2A 客户端
    const client = createAgentClient({
      agentId: card.agentId,
      address: card.endpoint.address,
      timeout: options?.timeout ?? 120000,
      metadata: metadataAsString,
    })

    try {
      // 构建参数（包含 teamContext）
      const params = {
        ...(input as object),
        teamContext: { members: allAgentCards },
      }

      // 调用 Agent
      const stream = await client.call(skill.name, params, {
        signal: options?.signal,
      })

      // 收集结果
      let result = ''
      const progressMessages: string[] = []

      for await (const msg of stream) {
        if (options?.signal?.aborted) {
          break
        }

        if (msg.type === 'call' || msg.type === 'cancel') {
          continue
        }

        if (msg.type === 'error') {
          throw new Error(msg.text)
        }

        if (msg.type === 'progress') {
          progressMessages.push(msg.text)
          // 如果有父级消息流，直接转发原始消息（保留 from、data 等所有字段）
          options?.parentStream?.send(msg)
        }

        if (msg.type === 'done') {
          result = msg.text
          break
        }

        if (msg.text) {
          result += msg.text + '\n'
        }
      }

      if (options?.signal?.aborted) {
        throw new Error('Operation cancelled')
      }

      await client.close()

      return result || progressMessages.join('\n') || '操作完成'
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      throw new Error(`${card.agentId}.${skill.name} 执行失败: ${errorMessage}`)
    } finally {
      try {
        await client.close()
      } catch {
        // ignore close errors
      }
    }
  }
}

// ==================== 本地 Skills 转换 ====================

/**
 * 将本地 SkillDefinition 列表转换为 AgentTool 列表
 *
 * 用于在 Agent 内部将自己的 skills 转换为可供 LLM 调用的工具格式。
 * 执行时直接调用本地 handler，无需 A2A 网络调用。
 *
 * @param skills - 本地技能定义列表
 * @param ctx - Context 对象，用于 handler 执行
 * @returns AgentTool[] - 通用工具列表
 *
 * @example
 * ```typescript
 * import { skillsToAgentTools, toLangChainTools } from '@multi-agent/a2a'
 *
 * // 将本地 skills 转换为 AgentTool
 * const agentTools = skillsToAgentTools(allSkills, ctx)
 *
 * // 转换为 LangChain 格式
 * const langchainTools = toLangChainTools(agentTools)
 *
 * // 绑定到 LLM
 * const llmWithTools = llm.bindTools(langchainTools)
 * ```
 */
export const skillsToAgentTools = (skills: SkillDefinition[], ctx: Context): AgentTool[] => {
  return skills
    .filter(skill => skill.inputSchema)
    .map(skill => ({
      name: skill.name,
      description: skill.description || skill.name,
      inputSchema: skill.inputSchema as JSONSchema,
      execute: async (params: unknown): Promise<string> => {
        try {
          const result = await skill.handler(params, ctx)
          return typeof result === 'string' ? result : JSON.stringify(result)
        } catch (error) {
          return `执行失败: ${error}`
        }
      },
    }))
}
