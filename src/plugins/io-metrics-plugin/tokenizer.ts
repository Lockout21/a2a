/**
 * 通用 Tokenizer
 *
 * 使用简化算法计算文本的 Token 数量，与具体 LLM 无关
 *
 * 算法规则：
 * - 中文字符：约 1 字 = 2 tokens
 * - 英文/数字：约 4 字符 = 1 token
 * - 空白字符：约 4 字符 = 1 token
 * - 其他符号：1 符号 = 1 token
 */
export const tokenize = (text: string): number => {
  if (!text) return 0

  let tokens = 0

  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      // 中文字符
      tokens += 2
    } else if (/[a-zA-Z0-9]/.test(char)) {
      // 英文字母和数字
      tokens += 0.25
    } else if (/\s/.test(char)) {
      // 空白字符
      tokens += 0.25
    } else {
      // 其他符号
      tokens += 1
    }
  }

  return Math.ceil(tokens)
}

/**
 * 计算费用（分）
 *
 * @param tokens Token 数量
 * @param pricePerKToken 每 1K tokens 的价格（分）
 * @returns 费用（分），向上取整
 */
export const calculateCost = (tokens: number, pricePerKToken: number): number => {
  return Math.ceil((tokens / 1000) * pricePerKToken)
}
