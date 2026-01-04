/**
 * 构建脚本：将 proto 文件转换为 JSON 格式嵌入到 TypeScript 代码中
 *
 * 使用 protobufjs 解析 .proto 文件并生成 JSON，
 * 运行时使用 @grpc/proto-loader 的 fromJSON() 加载，
 * 完全不需要文件系统访问。
 */

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import protobuf from 'protobufjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(__dirname, '..')

// 使用 protobufjs 解析 proto 文件
const protoPath = join(ROOT_DIR, 'proto/agent.proto')
const root = protobuf.loadSync(protoPath)
const protoJson = root.toJSON()

// 生成 TypeScript 文件
const outputPath = join(ROOT_DIR, 'src/generated/proto-json.ts')
const tsContent = `/**
 * 自动生成的文件 - 请勿手动修改
 *
 * 此文件由 scripts/generate-proto-content.mjs 生成
 * 包含 agent.proto 的 JSON 表示，用于 @grpc/proto-loader 的 fromJSON() 加载
 */

/**
 * 使用 Record 类型避免 protobufjs 的 INamespace 类型约束问题
 * IMethod 要求 comment 是必需字段，但 protobufjs.toJSON() 不生成该字段
 */
export const PROTO_JSON: Record<string, unknown> = ${JSON.stringify(protoJson, null, 2)}
`

writeFileSync(outputPath, tsContent, 'utf-8')

console.log('✅ Generated src/generated/proto-json.ts')