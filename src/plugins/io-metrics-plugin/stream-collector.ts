import { tokenize } from './tokenizer'

/**
 * 流式响应收集器
 *
 * 用于收集流式输出的所有文本，并计算总 Token 数
 *
 * @example
 * ```typescript
 * const collector = createStreamCollector()
 *
 * // 收集流式输出
 * collector.collect('Hello ')
 * collector.collect('World!')
 *
 * // 获取结果
 * console.log(collector.getText())   // 'Hello World!'
 * console.log(collector.getTokens()) // Token 数量
 * ```
 */
export const createStreamCollector = () => {
  let chunks: string[] = []

  return {
    /**
     * 收集一个文本块
     */
    collect: (chunk: string) => {
      if (chunk) {
        chunks.push(chunk)
      }
    },

    /**
     * 获取所有收集的文本
     */
    getText: (): string => {
      return chunks.join('')
    },

    /**
     * 获取总字符数
     */
    getChars: (): number => {
      return chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    },

    /**
     * 获取总 Token 数
     */
    getTokens: (): number => {
      return tokenize(chunks.join(''))
    },

    /**
     * 重置收集器
     */
    reset: () => {
      chunks = []
    },
  }
}

export type StreamCollector = ReturnType<typeof createStreamCollector>
