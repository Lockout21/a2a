import { defineConfig } from 'tsup'

export default defineConfig([
  // Node.js 版本（完整功能：Server + Client）
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    shims: false,
    minify: true,
    sourcemap: false,

    // 打包策略：external 运行时依赖
    external: ['@grpc/grpc-js', '@grpc/proto-loader', 'ws'],

    // 输出配置
    outDir: 'dist',

    // 保留注释（包含 JSDoc）
    keepNames: true,

    // 兼容性
    target: 'es2022',
    platform: 'node',

    // 移除 console.log（生产环境启用）
    esbuildOptions(options) {
      options.drop = ['console']
    },

  },

  // 浏览器版本（只包含 Client）
  {
    entry: {
      browser: 'src/browser-entry.ts'
    },
    format: ['esm'],
    dts: true,
    shims: false,
    minify: true,
    sourcemap: false,

    // 浏览器环境：external 所有 Node.js 依赖和内置模块
    external: ['@grpc/grpc-js', '@grpc/proto-loader', 'ws', 'path', 'fs'],
    noExternal: [],

    // 输出配置
    outDir: 'dist',

    // 保留注释
    keepNames: true,

    // 兼容性
    target: 'es2020',
    platform: 'browser',

    // 移除 console.log（生产环境启用）
    esbuildOptions(options) {
      options.drop = ['console']
    },
  }
])