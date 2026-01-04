/**
 * Agent信息工具函数
 * 提供Agent信息格式化和提示词生成功能
 */

import type { AgentCard } from '../types'

/**
 * 生成Agent简历提示词（用于 Sub-Agent 的 systemPrompt）
 * 基于 AgentCard 的 name 和 description 生成第一人称的角色定义
 *
 * @param agentCard Agent卡片信息
 * @returns 格式化的 Agent 简历文本
 *
 * @example
 * ```typescript
 * const agentCard = ctx.getAgentCard()
 * // agentCard.name = 'Backend Agent'
 * // agentCard.description = '后端开发专家，精通Node.js/Python/Java...'
 *
 * const resumePrompt = generateAgentResumePrompt(agentCard)
 * // 返回：
 * // 你是一名专业的Backend Agent，后端开发专家，精通Node.js/Python/Java，专注于API设计和数据库架构
 * ```
 */
export const generateAgentResumePrompt = (agentCard: AgentCard): string => {
  return `你是一名专业的${agentCard.name}，${agentCard.description}`
}

/**
 * 生成Agent信息提示词（用于 Host Agent 选择场景）
 * 基于AgentCard生成用于LLM的Agent角色描述，包含完整的元数据和能力信息
 *
 * @param agentCard Agent卡片信息
 * @returns 格式化的Agent角色定义提示词
 *
 * @example
 * ```typescript
 * // Host Agent 需要选择合适的 Sub-Agent
 * const backendCard = await backendClient.getAgentCard()
 * const frontendCard = await frontendClient.getAgentCard()
 * const prompt = `
 *   用户需求：${requirement}
 *   可用Agents：
 *   ${generateAgentInfoPrompt(backendCard)}
 *   ${generateAgentInfoPrompt(frontendCard)}
 *   请选择最合适的Agent。
 * `
 * ```
 */
export const generateAgentInfoPrompt = (agentCard: AgentCard): string => {
  // 从skills生成可用技能描述
  const skillsDescription = agentCard.skills
    .map(skill => {
      return `- **${skill.name}**: ${skill.description || '无描述'}`
    })
    .join('\n')

  return `
## Agent角色信息

**Agent ID**: ${agentCard.agentId}
**名称**: ${agentCard.name}
**描述**: ${agentCard.description}

## 专业能力

${skillsDescription || '暂无可用技能'}

## 职责说明

该Agent负责其专业领域内的任务规划与执行，应严格遵守能力边界，不处理超出职责范围的任务。
`.trim()
}
