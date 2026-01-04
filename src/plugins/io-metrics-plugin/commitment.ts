import { createHash, createHmac } from 'crypto'
import { tokenize } from './tokenizer'
import type { IOCommitment } from './types'

/**
 * 计算 SHA-256 哈希
 */
const sha256 = (content: string): string => {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * HMAC 签名
 */
const hmacSign = (payload: string, key: string): string => {
  return createHmac('sha256', key).update(payload).digest('hex')
}

/**
 * 生成唯一 ID
 */
const generateId = (): string => {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 创建 IO 承诺
 *
 * 承诺包含内容哈希和 Token 数量，由签名密钥签名确保不可伪造
 * userId 纳入签名保护，防止恶意 Agent 伪造用户身份
 *
 * @param content 原始内容
 * @param traceId 调用链 ID
 * @param type 类型（input/output）
 * @param signingKey 签名密钥
 * @param userId 用户 ID（可选，来自上游传递的 x-user-id）
 * @returns IO 承诺
 *
 * @example
 * ```typescript
 * const commitment = createIOCommitment(
 *   JSON.stringify(params),
 *   'tr_abc123',
 *   'input',
 *   'signing-key',
 *   'user_123'
 * )
 * ```
 */
export const createIOCommitment = (content: string, traceId: string, type: 'input' | 'output', signingKey: string, userId?: string): IOCommitment => {
  const contentHash = sha256(content)
  const tokens = tokenize(content)
  const timestamp = Date.now()

  // 签名 payload（userId 纳入签名，防止伪造）
  const payload = JSON.stringify({
    traceId,
    type,
    contentHash,
    tokens,
    timestamp,
    userId,
  })

  const signature = hmacSign(payload, signingKey)

  return {
    commitmentId: generateId(),
    traceId,
    contentHash,
    tokens,
    timestamp,
    signature,
  }
}

/**
 * 验证 IO 承诺
 *
 * @param commitment 承诺数据
 * @param type 类型（input/output）
 * @param signingKey 签名密钥
 * @param userId 用户 ID（需与创建时一致）
 * @returns 验证是否通过
 */
export const verifyIOCommitment = (commitment: IOCommitment, type: 'input' | 'output', signingKey: string, userId?: string): boolean => {
  const payload = JSON.stringify({
    traceId: commitment.traceId,
    type,
    contentHash: commitment.contentHash,
    tokens: commitment.tokens,
    timestamp: commitment.timestamp,
    userId,
  })

  const expectedSignature = hmacSign(payload, signingKey)
  return commitment.signature === expectedSignature
}
