import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 加载 web/.env(若存在)。**必须作为 server.js 的第一个 import**,因为 `scope.js` 的
 * `DATA_DIR` 是模块级常量,依赖 import 时就已读好的 env。
 *
 * 为什么不能只靠 npm 脚本的 `--env-file-if-exists`:本地经常有人直接 `node server.js`
 * 调试,那条路径不加载 .env → 拿不到 `SESSION_SECRET` → 验不了博客下发的 `zx_admin`
 * cookie → 明明登录了博客,进 luminari 却被当成普通访客、看不到自己的生灵。
 *
 * Node 22+ 原生 `process.loadEnvFile`;旧 Node 或文件不存在时静默跳过。
 */
try {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath)
} catch {
  /* 静默:无 .env 属正常;真需要变量时由 npm 脚本的 --env-file-if-exists 兜底 */
}
