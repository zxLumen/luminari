import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 让 `.js` 后缀的 import 能解析到同名的 `.ts` / `.tsx` 源文件。
 *
 * 为什么需要:服务端(Node ESM)必须写显式 `.js` 后缀;而这里的前端源文件是 `.ts`/`.tsx`。
 * 两边共用同一批相对导入(如 `../lib/creature/index.js`)时,Vite 默认不会把 `.js`
 * 映射回 `.ts`,会直接报 "Could not resolve"。这个插件补上这层映射。
 */
function jsToTs() {
  return {
    name: 'js-to-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.endsWith('.js') || !source.startsWith('.')) return null
      const base = path.resolve(path.dirname(importer), source)
      for (const ext of ['.ts', '.tsx']) {
        const cand = base.slice(0, -3) + ext
        if (existsSync(cand)) return cand
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [jsToTs(), react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8790',
      '/creatures-png': 'http://127.0.0.1:8790',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // render.html 离屏出图入口(生成缩略图 / 榜单静态 PNG)
      input: { main: 'index.html', render: 'render.html' },
    },
  },
})
