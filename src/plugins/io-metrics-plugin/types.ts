/**
 * IO 计量模块类型定义
 *
 * 提供基于输入输出的 Token 计量和计费功能
 */

/**
 * IO 承诺（由协议层生成，使用平台签名密钥）
 *
 * 承诺包含内容哈希和 Token 数量，由平台签名确保不可伪造
 */
export interface IOCommitment {
  /** 承诺唯一 ID */
  commitmentId: string

  /** 关联的调用链 ID */
  traceId: string

  /** 内容哈希（SHA-256，不含原文，保护隐私） */
  contentHash: string

  /** Token 数量 */
  tokens: number

  /** 时间戳 */
  timestamp: number

  /** 平台签名（证明这是协议层计算的，非伪造） */
  signature: string
}

/**
 * 已验证的 IO 指标
 *
 * 包含输入和输出的承诺，由协议层自动生成和上报
 *
 */
export interface VerifiedIOMetrics {
  /** 指标唯一 ID */
  metricsId: string

  /** 关联的调用链 ID（整个请求链共用） */
  traceId: string

  /** Agent ID */
  agentId: string

  /** 调用的技能名称 */
  skill: string

  /** 调用开始时间（ISO 8601 格式） */
  startedAt: string

  /** 输入承诺 */
  inputCommitment: IOCommitment

  /** 输出承诺 */
  outputCommitment: IOCommitment

  /** 处理耗时（毫秒） */
  duration: number

  /** 调用者用户 ID（可选，由 Auth 插件解析 token 获得） */
  userId?: string
}

/**
 * Agent 定价配置
 */
export interface AgentPricing {
  /** 输入单价（分 / 1K tokens） */
  inputTokenPrice: number

  /** 输出单价（分 / 1K tokens） */
  outputTokenPrice: number
}

/**
 * IO 计量提供者接口
 *
 * 平台方实现此接口，提供计量服务
 *
 * @example
 * ```typescript
 * const provider: IOMetricsProvider = {
 *   verifyIntegrity: async (params) => {
 *     // 验证 SDK 完整性，返回签名密钥
 *     return { valid: true, signingKey: 'xxx' }
 *   },
 *   reportMetrics: async (metrics) => {
 *     // 上报指标到平台
 *     await fetch('/api/metrics/report', { body: JSON.stringify(metrics) })
 *   },
 * }
 * ```
 */
export interface IOMetricsProvider {
  /**
   * 验证 SDK 完整性，获取签名密钥
   *
   * @param params 验证参数
   * @returns 验证结果和签名密钥
   */
  verifyIntegrity(params: {
    /** SDK 版本 */
    sdkVersion: string
    /** SDK 核心模块哈希 */
    sdkHash: string
    /** Agent ID */
    agentId: string
  }): Promise<{
    /** 验证是否通过 */
    valid: boolean
    /** 签名密钥（验证通过时返回） */
    signingKey?: string
    /** 错误信息（验证失败时返回） */
    error?: string
  }>

  /**
   * 上报已验证的 IO 指标
   *
   * @param metrics 指标数据
   */
  reportMetrics(metrics: VerifiedIOMetrics): Promise<void>

  /**
   * 获取 Agent 定价（可选）
   *
   * @param agentId Agent ID
   * @param skill 技能名称
   * @returns 定价配置
   */
  getPricing?(agentId: string, skill: string): Promise<AgentPricing>

  /**
   * 预调用检查（在 LLM 调用前验证用户身份和余额）
   *
   * 这是计费安全的关键：在执行任何 LLM 调用之前先验证用户有足够余额
   * 如果不实现此方法，将跳过预调用检查（向后兼容）
   *
   * @param params 检查参数
   * @returns 检查结果
   */
  preCallCheck?(params: {
    /** 用户 ID（从 x-user-id metadata 获取） */
    userId?: string
    /** Agent ID */
    agentId: string
    /** 调用的技能名称 */
    skill: string
    /** 调用链 ID */
    traceId: string
  }): Promise<{
    /** 是否允许调用 */
    allowed: boolean
    /** 拒绝原因（allowed=false 时返回） */
    reason?: string
    /** 错误代码（allowed=false 时返回） */
    code?: 'UNAUTHORIZED' | 'INSUFFICIENT_BALANCE' | 'USER_NOT_FOUND' | 'RATE_LIMITED' | string
  }>
}
