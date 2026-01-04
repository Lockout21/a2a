/**
 * Agent 定义工厂函数（纯函数）
 *
 * 核心设计理念：
 * 1. 函数式编程 - 无 class，使用工厂函数和闭包
 * 2. Handler 安全 - Server 内部自动包装 handler，确保钩子被执行
 * 3. 类型安全 - 使用泛型约束确保 defaultSkill 是有效技能名
 */

import type { AgentConfig, SkillDefinition, SkillHandler } from '../types'

// ============================================
// CreateAgentConfig - Agent 配置工厂
// ============================================

/**
 * CreateAgent 选项（带类型约束）
 *
 * @template Skills - 技能定义数组类型
 */
export interface CreateAgentOptions<Skills extends readonly SkillDefinition[] = SkillDefinition[]> {
  agentId: string
  name: string
  version: string
  description?: string
  /**
   * Agent 的网络地址
   *
   * 格式：a2a[s]://host:port
   * - a2a://  表示无 TLS
   * - a2as:// 表示使用 TLS
   *
   * @example 'a2a://0.0.0.0:50050'
   * @example 'a2as://api.example.com:50050'
   */
  address: string
  skills: Skills
  /**
   * 默认技能名称
   *
   * 必填，必须是 skills 中某个技能的 name
   */
  defaultSkill: Skills[number]['name']
  /**
   * Agent 角色能力声明
   *
   * - 'primary': 只能作为 primaryAgent（具备 LLM 推理能力，可协调其他 Agent）
   * - 'tool': 只能作为 team 成员（纯工具层，不具备 LLM 推理能力）
   * - 'both': 两者皆可（默认值）
   *
   * @default 'both'
   */
  role?: 'primary' | 'tool' | 'both'
}

/**
 * 创建 Agent 配置（对象参数风格）
 *
 * 使用泛型约束确保 defaultSkill 必须是 skills 中某个技能的 name
 *
 * @param options Agent 配置和技能
 * @returns AgentConfig - Agent 完整配置
 *
 * @example
 * ```typescript
 * const agentConfig = createAgentConfig({
 *   agentId: 'my-agent',
 *   name: 'My Agent',
 *   version: '1.0.0',
 *   address: 'a2a://0.0.0.0:50051',
 *   skills: [
 *     defineSkill('execute', handler1),
 *     defineSkill('generate', handler2),
 *   ],
 *   defaultSkill: 'execute', // 类型安全：必须是 skills 中某个技能的 name
 * })
 * ```
 */
export const createAgentConfig = <Skills extends readonly SkillDefinition[]>(options: CreateAgentOptions<Skills>): AgentConfig => ({
  ...options,
  description: options.description || '',
  skills: [...options.skills] as SkillDefinition[],
})

// ============================================
// defineSkill - 技能定义工厂
// ============================================

/**
 * 定义技能（简化配置模式）
 *
 * 核心安全机制：
 * - Server 在启动时自动将 handler 包装为受保护版本
 * - 受保护版本自动执行 beforeHandler/afterHandler 钩子
 * - 插件无法绕过钩子直接调用原始 handler
 *
 * 工作原理：
 * ```
 * defineSkill('execute', rawHandler)
 *     ↓
 * SkillDefinition {
 *   name: 'execute',
 *   handler: rawHandler  // 原始 handler
 * }
 *     ↓
 * Server.start() 调用 createProtectedHandler(name, handler, hooks, agentId)
 *     ↓
 * protectedHandler 被注册到 skillHandlers Map
 * ```
 *
 * 安全性保证：
 * - 插件只能从 skillHandlers Map 获取 handler
 * - skillHandlers 中的 handler 已被 Server 包装
 * - 包装后的 handler 自动执行钩子，无法绕过
 *
 * @param name 技能名（使用字面量类型）
 * @param handler 原始处理函数
 * @param options 可选配置（description, inputSchema, outputSchema）
 * @returns SkillDefinition
 *
 * @example
 * ```typescript
 * const skill = defineSkill(
 *   'mySkill',
 *   async (params, ctx) => {
 *     ctx.stream.send({ type: 'progress', text: '处理中...' })
 *     return { result: 'done' }
 *   },
 *   {
 *     description: 'My skill description',
 *     inputSchema: { type: 'object', properties: { ... } },
 *   }
 * )
 * ```
 */
export const defineSkill = <TName extends string, TParams = any, TResult = any>(
  name: TName,
  handler: SkillHandler<TParams, TResult>,
  options?: {
    description?: string
    inputSchema?: SkillDefinition['inputSchema']
    outputSchema?: SkillDefinition['outputSchema']
  },
): SkillDefinition & { name: TName } => ({
  name,
  handler: handler as SkillHandler,
  description: options?.description,
  inputSchema: options?.inputSchema,
  outputSchema: options?.outputSchema,
})
