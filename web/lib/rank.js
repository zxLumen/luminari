import fs from 'node:fs/promises'
import path from 'node:path'
import { loadState, MAX_CREATURES_PER_CID } from './creature-store.js'
import { readJsonWithBak, writeJson } from './store.js'

/**
 * 全站榜单:跨所有访客数据域,取当前评分版本、且 `selected` 的生灵,按 total 降序。
 *
 * 为什么只收 `selected`:访客从自己 5 只里选 1 只参与排行,其余不参与、不展示。
 * 见需求:每人 5 只,选中一只上榜。
 *
 * 榜单缓存 + 精排结果落 `data/rank.json`,由生成端在缓存过期时重算(避免每次访问都算/VLM)。
 */

const RANK_FILE = (dataDir) => path.join(dataDir, 'rank.json')
const CREATURE_DIR = (dataDir) => path.join(dataDir, 'creatures')

export async function listScopeKeys(dataDir) {
  try {
    const files = await fs.readdir(CREATURE_DIR(dataDir))
    return files.filter((f) => f.endsWith('.json') && !f.endsWith('.bak')).map((f) => f.slice(0, -5))
  } catch {
    return []
  }
}

/** 汇总所有数据域里"参与排行"的生灵(附带归属 scopeKey)。 */
export async function collectSelected(dataDir) {
  const keys = await listScopeKeys(dataDir)
  const out = []
  for (const key of keys) {
    const state = await loadState(dataDir, key)
    for (const it of state.items) {
      if (it.selected) out.push({ scopeKey: key, ...it })
    }
  }
  return out
}

/** 某访客自己的全部生灵(不筛 selected) */
export async function listMine(dataDir, scopeKey) {
  const state = await loadState(dataDir, scopeKey)
  return state.items
}

export const RANK_TTL_MS = 30 * 60 * 1000

export async function readRank(dataDir) {
  const r = await readJsonWithBak(RANK_FILE(dataDir), null)
  return r && typeof r === 'object' ? r : null
}

export async function writeRank(dataDir, payload) {
  await writeJson(RANK_FILE(dataDir), { ...payload, at: Date.now() })
}

/**
 * 计算榜单(不写缓存,纯算)。
 * @param {string} scoreVersion 只收当前版本的生灵
 * @param {number} pool 候选池大小(精排要多取几只)
 */
export async function computeRank(dataDir, scoreVersion, pool = 30) {
  const all = await collectSelected(dataDir)
  const eligible = all
    .filter((c) => c.scoreVersion === scoreVersion)
    .sort((a, b) => b.total - a.total)
  return eligible.slice(0, pool)
}

/**
 * 全站排行榜(Top100):所有参与排行(selected)的生灵,按分降序。
 *
 * 与 `/api/creatures/top`(Top5 + VLM 精排 + 缓存)不同 —— 排行榜要的是**完整且稳定**的
 * 全量名次,所以不走精排(精排只值 Top 边界那几只),直接按确定性分排序,每次读实时算。
 * 规模小(每访客 1 只),无需缓存。
 *
 * 作者名:owner → 站长;访客 → 匿名短 id(`访客 · a1b2c3`)。luminari 不做访客昵称。
 */
export async function leaderboard(dataDir, scoreVersion, limit = 100) {
  const all = await collectSelected(dataDir)
  return all
    .filter((c) => c.scoreVersion === scoreVersion)
    .sort((a, b) => b.total - a.total || a.scopeKey.localeCompare(b.scopeKey))
    .slice(0, limit)
    .map((c, i) => ({ rank: i + 1, author: authorLabel(c.scopeKey), ...c }))
}

/** 数据域键 → 展示作者名 */
export function authorLabel(scopeKey) {
  if (scopeKey === 'owner') return 'Admin'
  const short = String(scopeKey).slice(0, 6)
  return `访客 · ${short}`
}

export { MAX_CREATURES_PER_CID }
