# A2A 通信协议框架

[![npm version](https://img.shields.io/npm/v/@multi-agent/a2a.svg)](https://www.npmjs.com/package/@multi-agent/a2a)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**A2A 通信协议框架** — Agent-to-Agent 通信协议的 TypeScript 实现

> 突破虚拟边界，让思考触达现实

**完整文档**: [https://docs.llong.me](https://docs.llong.me)

---

## 特性

- **能力发现** — AgentCard 自描述机制，让 Agent 在网络中被发现、被选择、被调用
- **双向流通信** — 基于 gRPC 的实时双向流，支持流式输出、进度反馈、中途取消
- **Human in the Loop** — 支持问答交互，人类作为特殊 Agent 参与协作
- **跨平台** — 浏览器与 Node.js 统一 API，Server 同时暴露 gRPC 和 WebSocket 端口
- **插件系统** — 丰富的 Hooks 扩展点，支持自定义插件开发；开箱即用，内置了 Tracing、Parasite、MCP 等生产级插件

---

## 安装

```bash
npm install @multi-agent/a2a
# or
bun add @multi-agent/a2a
```

---

## 快速开始

### Server

```typescript
import { createAgentServer } from '@multi-agent/a2a'

const server = createAgentServer({
  agentId: 'my-agent',
  name: 'My Agent',
  version: '1.0.0',
  address: 'a2a://0.0.0.0:50061',
  skills: [{
    name: 'greet',
    description: '问候用户',
    handler: async (params, ctx) => {
      ctx.stream.send({ type: 'progress', text: '处理中...' })
      ctx.stream.send({ type: 'done', text: '完成', data: { message: `Hello, ${params.name}!` } })
    },
  }],
})

await server.start()
console.log('Agent started on port 50061')
```

### Client

```typescript
import { createAgentClient } from '@multi-agent/a2a'

const client = createAgentClient({
  agentId: 'my-agent',
  address: 'a2a://localhost:50061',
})

// 获取 Agent 能力描述
const agentCard = await client.getAgentCard()
console.log('Skills:', agentCard.skills.map(s => s.name))

// 调用技能
const stream = await client.call('greet', { name: 'World' })

for await (const msg of stream) {
  console.log(`[${msg.type}] ${msg.text}`)
  if (msg.type === 'done') {
    console.log('Result:', msg.data)  // { message: 'Hello, World!' }
  }
}
```

---

## 核心概念

### Message

所有通信使用统一的消息结构：

```typescript
interface Message {
  type: string     // 消息类型: progress, question, answer, done, error, ...
  text: string     // 人类可读内容
  data?: any       // 结构化数据
  from?: AgentCard // 发送方身份（框架自动注入）
}
```

### AgentCard

Agent 的身份卡片，描述其能力：

```typescript
interface AgentCard {
  agentId: string
  name: string
  version: string
  description: string
  skills: SkillInfo[]
  endpoint: { host: string; port: number }
}
```

### Bidirectional Stream

支持双向实时通信：

```typescript
// Server 向 Client 提问
ctx.stream.send({ type: 'question', text: '请选择语言', data: { options: ['中文', 'English'] } })

for await (const msg of ctx.stream) {
  if (msg.type === 'answer') {
    console.log('用户选择:', msg.data.value)
    break
  }
}
```

---

## 浏览器支持

```typescript
import { createAgentClient } from '@multi-agent/a2a/browser'

const client = createAgentClient({
  agentId: 'my-agent',
  address: 'a2a://localhost:50061',
})

const stream = await client.call('greet', { name: 'Browser' })
```

---

## 取消请求

支持中途取消请求：

```typescript
const controller = new AbortController()
const stream = await client.call('longTask', params, { signal: controller.signal })

// 取消请求
controller.abort()

// Server 端通过 ctx.signal 感知取消
async function handler(params, ctx) {
  for (const item of items) {
    if (ctx.signal.aborted) return  // 检查取消信号
    await processItem(item)
  }
}
```

---

## 插件

通过 `.use()` 注册插件：

```typescript
import { createAgentServer, createTracingPlugin } from '@multi-agent/a2a'

const server = createAgentServer(config)
  .use(createTracingPlugin({
    provider: {
      reportTrace: async (record) => {
        // 上报调用链追踪数据
      }
    }
  }))

await server.start()
```

内置插件：

| Plugin | Description |
|--------|-------------|
| `createTracingPlugin` | 调用链追踪，记录 spanId/parentSpanId |
| `createParasitePlugin` | NAT 穿透，本地 Agent 寄生到云端 |
| `createMCPPlugin` | MCP 协议集成 |

---

## TLS 支持

生产环境启用 TLS：

```typescript
const server = createAgentServer({
  address: 'a2as://0.0.0.0:50061',  // a2as:// 启用 TLS
  tls: {
    cert: '/path/to/cert.pem',
    key: '/path/to/key.pem',
  },
  // ...
})
```

---

## 相关包

| Package | Description |
|---------|-------------|
| [@multi-agent/agent-kit](https://www.npmjs.com/package/@multi-agent/agent-kit) | LLM 工具集成 |

---