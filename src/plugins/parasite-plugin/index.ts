/**
 * Parasite Plugin - Agent 寄生插件
 *
 * 提供远程 Agent 寄生和请求代理转发能力，解决 NAT 穿透问题。
 *
 * 核心概念：
 * - ParasitePlugin: 本地 Agent（寄生体）主动连接云端 Host Agent（宿主）
 * - ParasiteHostPlugin: 云端 Host Agent 接收寄生请求，管理已寄生的 Agent
 *
 * @module parasite-plugin
 */

export * from './server'
export * from './client'
