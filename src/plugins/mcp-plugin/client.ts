/**
 * MCP Client 封装
 *
 * 封装 @modelcontextprotocol/sdk 的 Client，提供统一的接口
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
// import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  MCPServerConfig,
  MCPServerConfigStdio,
  MCPClientWrapper,
  MCPToolDefinition,
  MCPToolResult,
} from './types'

/**
 * 创建 MCP Client 包装器
 */
export const createMCPClient = (config: MCPServerConfig): MCPClientWrapper => {
  let client: Client | null = null
  let transport: StdioClientTransport | null = null
  let connected = false
  let connectedAt: number | undefined
  let tools: MCPToolDefinition[] = []

  /**
   * 连接到 MCP Server
   */
  const connect = async (): Promise<void> => {
    if (connected) {
      console.log(`[MCP] ${config.name} 已连接，跳过`)
      return
    }

    try {
      console.log(`[MCP] 正在连接 ${config.name}...`)

      // 创建 Client
      client = new Client(
        {
          name: `a2a-mcp-client-${config.name}`,
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      )

      // 根据传输方式创建 transport
      if (config.transport === 'stdio') {
        transport = createStdioTransport(config)
      } else {
        // HTTP 传输暂不支持，后续实现
        throw new Error(`HTTP 传输暂不支持，请使用 stdio`)
      }

      // 连接
      await client.connect(transport)
      connected = true
      connectedAt = Date.now()

      // 获取工具列表
      tools = await listTools()

      console.log(`[MCP] ${config.name} 连接成功，发现 ${tools.length} 个工具`)
    } catch (error) {
      connected = false
      client = null
      transport = null
      throw new Error(`[MCP] ${config.name} 连接失败: ${(error as Error).message}`)
    }
  }

  /**
   * 断开连接
   */
  const disconnect = async (): Promise<void> => {
    if (!connected || !client) {
      return
    }

    try {
      console.log(`[MCP] 正在断开 ${config.name}...`)
      await client.close()
    } catch (error) {
      console.error(`[MCP] ${config.name} 断开时出错:`, error)
    } finally {
      connected = false
      client = null
      transport = null
      tools = []
      connectedAt = undefined
    }
  }

  /**
   * 列出可用工具
   */
  const listTools = async (): Promise<MCPToolDefinition[]> => {
    if (!client || !connected) {
      throw new Error(`[MCP] ${config.name} 未连接`)
    }

    const response = await client.listTools()

    return (response.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as MCPToolDefinition['inputSchema'],
    }))
  }

  /**
   * 调用工具
   */
  const callTool = async (
    toolName: string,
    args: Record<string, any>
  ): Promise<MCPToolResult> => {
    if (!client || !connected) {
      throw new Error(`[MCP] ${config.name} 未连接`)
    }

    console.log(`[MCP] 调用 ${config.name}.${toolName}`, args)

    const response = await client.callTool({
      name: toolName,
      arguments: args,
    })

    const contentArray = Array.isArray(response.content) ? response.content : []

    return {
      content: contentArray.map((item: any) => {
        if (item.type === 'text') {
          return { type: 'text' as const, text: item.text }
        } else if (item.type === 'image') {
          return {
            type: 'image' as const,
            data: item.data,
            mimeType: item.mimeType,
          }
        } else {
          return { type: 'resource' as const, text: JSON.stringify(item) }
        }
      }),
      isError: response.isError === true,
    }
  }

  return {
    config,
    get connected() {
      return connected
    },
    get connectedAt() {
      return connectedAt
    },
    get tools() {
      return tools
    },
    connect,
    disconnect,
    listTools,
    callTool,
  }
}

/**
 * 创建 stdio 传输
 */
const createStdioTransport = (config: MCPServerConfigStdio): StdioClientTransport => {
  // 过滤掉 undefined 值，确保 env 类型正确
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (config.env) {
    Object.assign(env, config.env)
  }

  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    cwd: config.cwd,
  })
}

/**
 * 创建 HTTP 传输（预留）
 */
// const createHttpTransport = (config: MCPServerConfigHttp) => {
//   return new StreamableHTTPClientTransport(new URL(config.url), {
//     requestInit: {
//       headers: config.headers,
//     },
//   })
// }
