import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * 核心模块列表
 *
 * 这些模块的完整性会被验证，防止篡改
 */
const CORE_MODULES = ['commitment.js', 'tokenizer.js', 'stream-collector.js']

/**
 * 计算 SDK 核心模块的哈希
 *
 * 用于验证 SDK 是否被篡改
 *
 * @returns 核心模块的合并哈希
 */
export const calculateSdkHash = (): string => {
  const hashes: string[] = []

  // 获取当前模块所在目录
  let moduleDir: string
  try {
    // ESM 环境
    const __filename = fileURLToPath(import.meta.url)
    moduleDir = dirname(__filename)
  } catch {
    // CJS 环境
    moduleDir = __dirname
  }

  for (const module of CORE_MODULES) {
    try {
      const modulePath = join(moduleDir, module)
      const content = readFileSync(modulePath, 'utf-8')
      hashes.push(createHash('sha256').update(content).digest('hex'))
    } catch {
      // 模块不存在时使用空哈希（开发环境可能是 .ts 文件）
      hashes.push('')
    }
  }

  // 合并所有模块哈希
  return createHash('sha256').update(hashes.join('')).digest('hex')
}

/**
 * 获取 SDK 版本
 *
 * @returns SDK 版本号
 */
export const getSdkVersion = (): string => {
  try {
    // 尝试读取 package.json
    const pkgPath = join(__dirname, '..', '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
}
