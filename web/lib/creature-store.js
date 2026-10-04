import path from 'node:path'
import crypto from 'node:crypto'
import { readJsonWithBak, writeJson } from './store.js'

/**
 * 生灵数据层(JSON 文件,按数据域分文件)。
 *
 * 为什么用 JSON 而不是 SQLite:与 StockApp / yijing64 保持同一套子应用形态 ——
 * 单机单文件、量级小(每访客最多 5 只)、写入极轻。每个数据域(访客 cid / owner)
 * 一个文件,天然隔离,不需要事务。
 *
 * 数据域键:访客 = 其 cid;站长 = 'owner'。见 scope.js 的 resolveScope。
 */

export const MAX_CREATURES_PER_CID = 5
/** 每访客每天最多"创建"(生成)次数 —— 与"榜上最多 5 只"是两回事 */
export const DAILY_CREATE_PER_CID = 5

const MAX_NAME = 24
const MAX_DESCR = 300
const MAX_SAY = 120

const creaturesFile = (dataDir, scopeKey) => path.join(dataDir, 'creatures', `${scopeKey}.json`)
const createLogFile = (dataDir) => path.join(dataDir, 'create-log.json')

/** 一个数据域的生灵集合 */
const emptyState = () => ({ v: 1, items: [], round: 0, updatedAt: null })

const str = (value, max) => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s.length > max ? s.slice(0, max) : s
}

const clampScore = (n) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0
}

/**
 * 规范化一只生灵(读旧文件 / 写入前统一走它,防脏数据)。
 * 缺 id 直接丢弃(无法归属)。
 */
function normalizeOne(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = str(raw.id, 40)
  if (!id) return null
  const dna = raw.dna && typeof raw.dna === 'object' ? raw.dna : null
  const blueprint = raw.blueprint && typeof raw.blueprint === 'object' ? raw.blueprint : null
  if (!dna || !blueprint) return null
  return {
    id,
    descr: str(raw.descr, MAX_DESCR),
    name: str(raw.name, MAX_NAME),
    personality: str(raw.personality, 200),
    blueprint,
    dna,
    craft: clampScore(raw.craft),
    appeal: clampScore(raw.appeal),
    total: clampScore(raw.total),
    scoreVersion: str(raw.scoreVersion, 40),
    // 是否参与排行(单选:同域内最多一只为 true)
    selected: raw.selected === true,
    // 出生时刻的成长天(用于面板/游走按"现在第几天"渲染)
    birthdayDay: Number.isFinite(raw.birthdayDay) ? Math.max(0, Math.floor(raw.birthdayDay)) : 0,
    // 记忆:事件流,{kind, text, at}
    memories: Array.isArray(raw.memories)
      ? raw.memories
          .filter((m) => m && typeof m === 'object')
          .map((m) => ({ kind: str(m.kind, 20) || 'note', text: str(m.text, 200), at: str(m.at, 32) }))
          .slice(-40)
      : [],
    // 当前这轮"想说的话" + 它自己选的位置(归一化 0..1,前端按视口映射)
    say: str(raw.say, MAX_SAY),
    pos: normalizePos(raw.pos),
    createdAt: str(raw.createdAt, 32) || new Date().toISOString(),
    updatedAt: str(raw.updatedAt, 32) || new Date().toISOString(),
  }
}

function normalizePos(p) {
  if (!p || typeof p !== 'object') return null
  const x = Number(p.x)
  const y = Number(p.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}

function normalizeState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const items = Array.isArray(r.items) ? r.items.map(normalizeOne).filter(Boolean) : []
  // 保证 selected 单选:至多保留第一只 selected
  let seen = false
  for (const it of items) {
    if (it.selected) {
      if (seen) it.selected = false
      else seen = true
    }
  }
  return {
    v: 1,
    items,
    round: Number.isFinite(r.round) ? Math.floor(r.round) : 0,
    updatedAt: str(r.updatedAt, 32) || null,
  }
}

export async function loadState(dataDir, scopeKey) {
  return normalizeState(await readJsonWithBak(creaturesFile(dataDir, scopeKey), null))
}

export async function saveState(dataDir, scopeKey, state) {
  const next = { ...state, updatedAt: new Date().toISOString() }
  await writeJson(creaturesFile(dataDir, scopeKey), next)
  return next
}

export const findById = (state, id) => state.items.find((i) => i.id === id) || null

/** 新增一只,返回新行。超出上限或 id 冲突时抛错(调用方先查 countByScope)。 */
export function addCreature(state, input) {
  if (state.items.length >= MAX_CREATURES_PER_CID) {
    const e = new Error(`你已经有 ${MAX_CREATURES_PER_CID} 只了,再创建需要选择覆盖一只`)
    e.code = 'LIMIT'
    throw e
  }
  const id = `c${crypto.randomBytes(6).toString('hex')}`
  const now = new Date().toISOString()
  const row = normalizeOne({
    ...input,
    id,
    createdAt: now,
    updatedAt: now,
    selected: false,
  })
  state.items.push(row)
  return row
}

/** 覆盖一只(保留 id)。不存在返回 null。 */
export function replaceCreature(state, id, input) {
  const i = state.items.findIndex((x) => x.id === id)
  if (i < 0) return null
  const prev = state.items[i]
  const row = normalizeOne({
    ...prev,
    ...input,
    id: prev.id,
    createdAt: prev.createdAt,
    selected: prev.selected,
    updatedAt: new Date().toISOString(),
  })
  state.items[i] = row
  return row
}

/** 改名。不存在返回 null。 */
export function renameCreature(state, id, name) {
  const row = state.items.find((x) => x.id === id)
  if (!row) return null
  row.name = str(name, MAX_NAME)
  row.updatedAt = new Date().toISOString()
  return row
}

/** 单选:该只置 selected=true,同域其余全部 false。不存在返回 null。 */
export function setSelected(state, id, on) {
  const row = state.items.find((x) => x.id === id)
  if (!row) return null
  if (on) for (const it of state.items) it.selected = it.id === id
  else row.selected = false
  return row
}

export function removeCreature(state, id) {
  const i = state.items.findIndex((x) => x.id === id)
  if (i < 0) return false
  state.items.splice(i, 1)
  return true
}

const dayKey = (now = new Date()) => now.toISOString().slice(0, 10)

/** 今天这个域创建了几只(生成次数闸门,站长/owner 不受限由调用方豁免)。 */
export async function createCountToday(dataDir, scopeKey) {
  const log = await readJsonWithBak(createLogFile(dataDir), {})
  const day = dayKey()
  return log && log[day] && Number.isFinite(log[day][scopeKey]) ? log[day][scopeKey] : 0
}

export async function bumpCreateCount(dataDir, scopeKey) {
  const file = createLogFile(dataDir)
  const log = (await readJsonWithBak(file, {})) || {}
  const day = dayKey()
  if (!log[day]) log[day] = {}
  log[day][scopeKey] = (log[day][scopeKey] || 0) + 1
  // 只保留最近 7 天,防文件无限增长
  const days = Object.keys(log).sort()
  for (const d of days.slice(0, Math.max(0, days.length - 7))) delete log[d]
  await writeJson(file, log)
  return log[day][scopeKey]
}
