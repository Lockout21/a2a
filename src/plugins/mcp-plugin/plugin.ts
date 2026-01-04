/**
 * MCP Plugin 实现
 *
 * 将 MCP Tools 集成到 A2A Agent 中，作为 Skills 暴露给 LLM
 */

import type { SkillDefinition, Context, SkillInfo } from '../../types'
import { defineSkill } from '../../core/agent-card'
import type {
  MCPPluginConfig,
  MCPPlugin,
  MCPConnectionState,
  MCPToolDefinition,
  MCPClientWrapper,
} from './types'
import { createMCPClient } from './client'

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Required<Omit<MCPPluginConfig, 'servers'>> = {
  skillPrefix: 'mcp',
  connectTimeout: 30000,
  callTimeout: 60000,
  autoReconnect: true,
  reconnectInterval: 5000,
}

/**
 * 创建 MCP Plugin
 *
 * @example
 * ```typescript
 * const mcpPlugin = createMCPPlugin({
 *   servers: [
 *     {
 *       name: 'github',
 *       transport: 'stdio',
 *       command: 'npx',
 *       args: ['-y', '@modelcontextprotocol/server-github'],
 *       env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
 *     },
 *     {
 *       name: 'filesystem',
 *       transport: 'stdio',
 *       command: 'npx',
 *       args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
 *     },
 *   ],
 * })
 *
 * const server = createAgentServer(config)
 *   .use(mcpPlugin)
 *
 * // MCP tools 自动合并到 AgentCard.skills
 * // 调用时自动路由到对应的 MCP Server
 * ```
 */
export const createMCPPlugin = (config: MCPPluginConfig): MCPPlugin => {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }

  // 状态
  const clients = new Map<string, MCPClientWrapper>()
  const skillToServer = new Map<string, { serverName: string; toolName: string }>()

  /**
   * 生成 skill 名称
   * 格式: {prefix}_{serverName}_{toolName}
   */
  const generateSkillName = (serverName: string, toolName: string): string => {
    return `${fullConfig.skillPrefix}_${serverName}_${toolName}`
  }

  /**
   * 解析 skill 名称
   */
  const parseSkillName = (skillName: string): { serverName: string; toolName: string } | null => {
    const mapping = skillToServer.get(skillName)
    return mapping || null
  }

  /**
   * 连接所有 MCP Servers
   */
  const connectAllServers = async (): Promise<void> => {
    const connectPromises = fullConfig.servers.map(async (serverConfig) => {
      try {
        const client = createMCPClient(serverConfig)
        await client.connect()
        clients.set(serverConfig.name, client)

        // 注册 skill 到 server 的映射
        for (const tool of client.tools) {
          const skillName = generateSkillName(serverConfig.name, tool.name)
          skillToServer.set(skillName, {
            serverName: serverConfig.name,
            toolName: tool.name,
          })
        }
      } catch (error) {
        console.error(`[MCPPlugin] 连接 ${serverConfig.name} 失败:`, error)
        // 不抛出错误，允许部分连接失败
      }
    })

    await Promise.all(connectPromises)
  }

  /**
   * 获取已连接的 Servers
   */
  const getConnectedServers = (): MCPConnectionState[] => {
    return Array.from(clients.entries()).map(([name, client]) => ({
      serverName: name,
      connected: client.connected,
      connectedAt: client.connectedAt,
      toolCount: client.tools.length,
    }))
  }

  /**
   * 将 MCP inputSchema 转换为 A2A SkillInfo.inputSchema 格式
   */
  const convertInputSchema = (
    mcpSchema: MCPToolDefinition['inputSchema']
  ): SkillInfo['inputSchema'] => {
    if (!mcpSchema.properties) {
      return {
        type: 'object',
        properties: {},
        required: mcpSchema.required,
      }
    }

    // 转换 properties 格式
    const properties: Record<string, any> = {}
    for (const [key, value] of Object.entries(mcpSchema.properties)) {
      properties[key] = {
        type: value.type || 'string',
        description: value.description,
        enum: value.enum,
        default: value.default,
        items: value.items,
        minimum: value.minimum,
        maximum: value.maximum,
      }
    }

    return {
      type: 'object',
      properties,
      required: mcpSchema.required,
    }
  }

  /**
   * 获取所有 MCP Skills（A2A 格式）
   *
   * 使用 defineSkill 创建技能定义，确保：
   * - handler 被闭包封存，通过 createHandler 工厂函数暴露
   * - 调用时会正确执行 beforeHandler/afterHandler 钩子
   */
  const getMCPSkills = (): SkillDefinition[] => {
    const skills: SkillDefinition[] = []

    for (const [serverName, client] of clients) {
      if (!client.connected) continue

      for (const tool of client.tools) {
        const skillName = generateSkillName(serverName, tool.name)

        // 使用 defineSkill 创建技能定义
        // 这样 MCP Tool 调用也会正确执行 beforeHandler/afterHandler 钩子
        skills.push(
          defineSkill(
            skillName,
            createMCPToolHandler(serverName, tool.name),
            {
              description: tool.description || `MCP Tool: ${serverName}/${tool.name}`,
              inputSchema: convertInputSchema(tool.inputSchema),
            },
          ),
        )
      }
    }

    return skills
  }

  /**
   * 获取指定 Server 的工具列表
   */
  const getServerTools = (serverName: string): MCPToolDefinition[] => {
    const client = clients.get(serverName)
    return client?.tools || []
  }

  /**
   * 手动连接指定 Server
   */
  const connectServer = async (serverName: string): Promise<void> => {
    const serverConfig = fullConfig.servers.find((s) => s.name === serverName)
    if (!serverConfig) {
      throw new Error(`[MCPPlugin] Server ${serverName} 未配置`)
    }

    const existingClient = clients.get(serverName)
    if (existingClient?.connected) {
      return
    }

    const client = createMCPClient(serverConfig)
    await client.connect()
    clients.set(serverName, client)

    // 注册 skill 映射
    for (const tool of client.tools) {
      const skillName = generateSkillName(serverName, tool.name)
      skillToServer.set(skillName, {
        serverName,
        toolName: tool.name,
      })
    }
  }

  /**
   * 断开指定 Server
   */
  const disconnectServer = async (serverName: string): Promise<void> => {
    const client = clients.get(serverName)
    if (client) {
      await client.disconnect()
      clients.delete(serverName)

      // 移除 skill 映射
      for (const [skillName, mapping] of skillToServer) {
        if (mapping.serverName === serverName) {
          skillToServer.delete(skillName)
        }
      }
    }
  }

  /**
   * 断开所有 Servers
   */
  const disconnectAll = async (): Promise<void> => {
    const disconnectPromises = Array.from(clients.values()).map((client) =>
      client.disconnect()
    )
    await Promise.all(disconnectPromises)
    clients.clear()
    skillToServer.clear()
  }

  /**
   * 检查 skill 是否为 MCP Tool
   */
  const isMCPSkill = (skillName: string): boolean => {
    return skillToServer.has(skillName)
  }

  /**
   * 创建 MCP Tool Handler
   */
  const createMCPToolHandler = (serverName: string, toolName: string) => {
    return async (params: Record<string, any>, ctx: Context): Promise<any> => {
      const client = clients.get(serverName)
      if (!client || !client.connected) {
        throw new Error(`[MCPPlugin] Server ${serverName} 未连接`)
      }

      // 发送进度消息
      ctx.stream.send({
        type: 'progress',
        text: `正在调用 MCP 工具: ${serverName}/${toolName}`,
      })

      try {
        const result = await client.callTool(toolName, params)

        // 提取文本结果
        const textContent = result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n')

        if (result.isError) {
          ctx.stream.send({
            type: 'error',
            text: `MCP 工具调用失败: ${textContent}`,
            data: result,
          })
          throw new Error(textContent)
        }

        // 返回结果
        return {
          success: true,
          content: textContent,
          raw: result,
        }
      } catch (error) {
        const errorMessage = (error as Error).message
        ctx.stream.send({
          type: 'error',
          text: `MCP 工具调用失败: ${errorMessage}`,
        })
        throw error
      }
    }
  }

  // 返回 Plugin 实例
  return {
    hooks: {
      /**
       * Server 启动时连接所有 MCP Servers
       */
      onStart: async (agentConfig, agentCard) => {
        console.log('[MCPPlugin] 正在连接 MCP Servers...')
        await connectAllServers()

        const connectedCount = Array.from(clients.values()).filter((c) => c.connected).length
        const totalTools = Array.from(clients.values()).reduce(
          (sum, c) => sum + c.tools.length,
          0
        )

        console.log(
          `[MCPPlugin] 已连接 ${connectedCount}/${fullConfig.servers.length} 个 Server，共 ${totalTools} 个工具`
        )
      },

      /**
       * 修改 AgentCard，添加 MCP Tools 作为 Skills
       */
      onGetAgentCard: (card, ctx) => {
        const mcpSkills = getMCPSkills()

        // 转换为 SkillInfo 格式（不含 handler）
        const mcpSkillInfos = mcpSkills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          inputSchema: skill.inputSchema,
        }))

        return {
          ...card,
          skills: [...card.skills, ...mcpSkillInfos],
        }
      },

      /**
       * 拦截 call 消息，路由 MCP Skills
       */
      onCall: async (skillName, params, stream, ctx) => {

        // 检查是否为 MCP Skill
        const mapping = parseSkillName(skillName)
        if (!mapping) {
          return 'pass' // 交给原生 skill 处理
        }

        const { serverName, toolName } = mapping
        const client = clients.get(serverName)

        if (!client || !client.connected) {
          stream.send({
            type: 'error',
            text: `MCP Server ${serverName} 未连接`,
          })
          return 'handled'
        }

        try {
          // 发送进度消息
          stream.send({
            type: 'progress',
            text: `正在调用 MCP 工具: ${serverName}/${toolName}`,
          })

          // 调用 MCP Tool
          const result = await client.callTool(toolName, params)

          // 提取文本结果
          const textContent = result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n')

          if (result.isError) {
            stream.send({
              type: 'error',
              text: `MCP 工具调用失败: ${textContent}`,
              data: result,
            })
          } else {
            stream.send({
              type: 'done',
              text: textContent,
              data: {
                success: true,
                content: textContent,
                raw: result,
              },
            })
          }

          return 'handled'
        } catch (error) {
          stream.send({
            type: 'error',
            text: `MCP 工具调用失败: ${(error as Error).message}`,
          })
          return 'handled'
        }
      },
    },

    // 插件 API
    getConnectedServers,
    getMCPSkills,
    getServerTools,
    connectServer,
    disconnectServer,
    disconnectAll,
    isMCPSkill,
  }
}
