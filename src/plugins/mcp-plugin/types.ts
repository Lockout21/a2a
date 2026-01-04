/**
 * MCP Plugin 类型定义
 *
 * 定义 MCP (Model Context Protocol) 集成所需的类型
 */

import type { ServerPlugin, SkillDefinition } from '../../types'

/**
 * MCP Server 传输方式
 */
export type MCPTransport = 'stdio' | 'http'

/**
 * MCP Server 配置 - stdio 传输
 */
export interface MCPServerConfigStdio {
  /** Server 名称（用于生成 skill 前缀） */
  name: string
  /** 传输方式 */
  transport: 'stdio'
  /** 启动命令 */
  command: string
  /** 命令参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
  /** 工作目录 */
  cwd?: string
}

/**
 * MCP Server 配置 - HTTP 传输
 */
export interface MCPServerConfigHttp {
  /** Server 名称（用于生成 skill 前缀） */
  name: string
  /** 传输方式 */
  transport: 'http'
  /** Server URL */
  url: string
  /** 请求头 */
  headers?: Record<string, string>
}

/**
 * MCP Server 配置（联合类型）
 */
export type MCPServerConfig = MCPServerConfigStdio | MCPServerConfigHttp

/**
 * MCP Tool 定义（来自 MCP Server）
 */
export interface MCPToolDefinition {
  /** 工具名称 */
  name: string
  /** 工具描述 */
  description?: string
  /** 输入参数 JSON Schema */
  inputSchema: {
    type: 'object'
    properties?: Record<string, any>
    required?: string[]
  }
}

/**
 * MCP Tool 调用结果
 */
export interface MCPToolResult {
  /** 结果内容 */
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
  }>
  /** 是否出错 */
  isError?: boolean
}

/**
 * MCP 连接状态
 */
export interface MCPConnectionState {
  /** Server 名称 */
  serverName: string
  /** 是否已连接 */
  connected: boolean
  /** 连接时间 */
  connectedAt?: number
  /** 可用工具数量 */
  toolCount: number
  /** 错误信息 */
  error?: string
}

/**
 * MCP Plugin 配置
 */
export interface MCPPluginConfig {
  /** MCP Server 列表 */
  servers: MCPServerConfig[]
  /**
   * Skill 名称前缀
   * 默认: 'mcp'
   * 生成格式: {prefix}_{serverName}_{toolName}
   * 例如: mcp_github_create_issue
   */
  skillPrefix?: string
  /**
   * 连接超时（毫秒）
   * 默认: 30000
   */
  connectTimeout?: number
  /**
   * 工具调用超时（毫秒）
   * 默认: 60000
   */
  callTimeout?: number
  /**
   * 自动重连
   * 默认: true
   */
  autoReconnect?: boolean
  /**
   * 重连间隔（毫秒）
   * 默认: 5000
   */
  reconnectInterval?: number
}

/**
 * MCP Plugin 实例
 */
export interface MCPPlugin extends ServerPlugin {
  /**
   * 获取所有已连接的 MCP Server
   */
  getConnectedServers: () => MCPConnectionState[]

  /**
   * 获取所有 MCP Tools（已转换为 A2A Skill 格式）
   */
  getMCPSkills: () => SkillDefinition[]

  /**
   * 获取指定 Server 的工具列表
   */
  getServerTools: (serverName: string) => MCPToolDefinition[]

  /**
   * 手动连接指定 Server
   */
  connectServer: (serverName: string) => Promise<void>

  /**
   * 断开指定 Server
   */
  disconnectServer: (serverName: string) => Promise<void>

  /**
   * 断开所有 Server
   */
  disconnectAll: () => Promise<void>

  /**
   * 检查 skill 是否为 MCP Tool
   */
  isMCPSkill: (skillName: string) => boolean
}

/**
 * 内部：MCP Client 包装器
 */
export interface MCPClientWrapper {
  /** Server 配置 */
  config: MCPServerConfig
  /** 是否已连接 */
  connected: boolean
  /** 连接时间 */
  connectedAt?: number
  /** 可用工具 */
  tools: MCPToolDefinition[]
  /** 连接方法 */
  connect: () => Promise<void>
  /** 断开方法 */
  disconnect: () => Promise<void>
  /** 调用工具 */
  callTool: (toolName: string, args: Record<string, any>) => Promise<MCPToolResult>
  /** 列出工具 */
  listTools: () => Promise<MCPToolDefinition[]>
}
