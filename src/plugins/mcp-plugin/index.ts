/**
 * MCP Plugin - Model Context Protocol 集成
 *
 * 将 MCP 生态的工具集成到 A2A Agent 中
 *
 * @example
 * ```typescript
 * import { createAgentServer, createMCPPlugin } from '@multi-agent/a2a'
 *
 * const mcpPlugin = createMCPPlugin({
 *   servers: [
 *     {
 *       name: 'github',
 *       transport: 'stdio',
 *       command: 'npx',
 *       args: ['-y', '@modelcontextprotocol/server-github'],
 *       env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
 *     },
 *   ],
 * })
 *
 * const server = createAgentServer(config)
 *   .use(mcpPlugin)
 *
 * await server.start()
 *
 * // MCP tools 现在作为 A2A Skills 可用
 * // 例如: mcp_github_create_issue, mcp_github_list_repos
 * ```
 */

export { createMCPPlugin } from './plugin'
export type {
  MCPPluginConfig,
  MCPPlugin,
  MCPServerConfig,
  MCPServerConfigStdio,
  MCPServerConfigHttp,
  MCPToolDefinition,
  MCPToolResult,
  MCPConnectionState,
} from './types'
