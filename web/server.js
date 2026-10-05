import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 必须先于读 env 的模块(\`scope.js\` 的 DATA_DIR 是模块级常量)。见 lib/env.js。
import './lib/env.js'

import { DATA_DIR, resolveScope, cookieHeader, ownerToken, cidCookieHeader } from './lib/scope.js'
import { loadSettings, saveSettings, saveKey, publicSettings, aiConfig } from './lib/settings.js'
import { PROVIDERS } from './lib/providers.js'
import { writeJson } from './lib/store.js'
import {
  MAX_CREATURES_PER_CID,
  DAILY_CREATE_PER_CID,
  loadState,
  saveState,
  findById,
  addCreature,
  replaceCreature,
  renameCreature,
  setSelected,
  setSelectedMany,
  removeCreature,
  createCountToday,
  bumpCreateCount,
} from './lib/creature-store.js'
import { computeRank, readRank, writeRank, RANK_TTL_MS, listMine, leaderboard } from './lib/rank.js'
import {
  SCORE_VERSION,
  scoreBlueprint,
  generateBlueprint,
  birthNameAndSoul,
  converseRound,
  chatterRound,
} from './lib/creature-lib.js'
import { rerankTop } from './lib/judge.js'
import { normalizeBlueprint } from './server-dist/creature/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, 'dist')
const PORT = Number(process.env.LUMINARI_PORT || 8790)
const HOST = process.env.LUMINARI_HOST || '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

const rateBuckets = new Map()
function rateLimited(key, max, windowMs) {
  const now = Date.now()
  const b = rateBuckets.get(key)
  if (!b || now - b.at > windowMs) {
    rateBuckets.set(key, { at: now, n: 1 })
    return false
  }
  b.n += 1
  return b.n > max
}

const PNG_RE = /^data:image\/png;base64,/i
const MAX_PNG = 6_000_000

function decodePng(dataUrl) {
  if (!PNG_RE.test(dataUrl || '')) return null
  try {
    const buf = Buffer.from(dataUrl.replace(PNG_RE, ''), 'base64')
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
    return buf
  } catch {
    return null
  }
}

/** 生灵图落盘目录(容器里 LUMINARI_DATA_DIR/creatures-png;由 server 直接静态服务) */
const PNG_DIR = path.join(DATA_DIR, 'creatures-png')
const pngName = (id) => `${id}.png`
async function readPngDataUrl(id) {
  try {
    const buf = await fsp.readFile(path.join(PNG_DIR, pngName(id)))
    return 'data:image/png;base64,' + buf.toString('base64')
  } catch {
    return ''
  }
}

/* ============================ 路由 ============================ */

const routes = []
const route = (method, pattern, handler) => routes.push({ method, pattern, handler })

/* ---- 配置 / 状态 ---- */

route('GET', /^\/api\/status$/, async () => {
  return {
    scoreVersion: SCORE_VERSION,
    maxCreatures: MAX_CREATURES_PER_CID,
    dailyCreate: DAILY_CREATE_PER_CID,
  }
})

route('GET', /^\/api\/settings$/, async () => publicSettings(DATA_DIR))

route('POST', /^\/api\/settings$/, async (ctx) => {
  if (!ctx.scope.isOwner) throw new HttpError(403, '仅站长可改配置')
  const body = await readBody(ctx.req)
  await saveSettings(DATA_DIR, body)
  return publicSettings(DATA_DIR)
})

route('POST', /^\/api\/settings\/key$/, async (ctx) => {
  if (!ctx.scope.isOwner) throw new HttpError(403, '仅站长可改配置')
  const body = await readBody(ctx.req)
  const provider = String(body.provider || '')
  if (!PROVIDERS.some((p) => p.id === provider)) throw new HttpError(400, '未知服务商')
  await saveKey(DATA_DIR, provider, String(body.key || ''))
  return publicSettings(DATA_DIR)
})

/* ---- 我的生灵 ---- */

route('GET', /^\/api\/creature\/mine$/, async (ctx) => {
  const items = await listMine(DATA_DIR, ctx.scope.scopeKey)
  // owner 无 5 只上限,面板按「只展示参与排行的」呈现(见前端);max 回传 calc 后仍给 5 供普通访客用
  return {
    count: items.length,
    max: MAX_CREATURES_PER_CID,
    isOwner: ctx.scope.isOwner,
    selectedCount: items.filter((i) => i.selected).length,
    items: items.map(publicCreature),
  }
})

/** 生成(不落库)—— 返回骨架,前端出图后再 commit */
route('POST', /^\/api\/creature\/generate$/, async (ctx) => {
  const body = await readBody(ctx.req)
  const descr = String(body.descr || '').trim().slice(0, 300)
  if (!descr) throw new HttpError(400, '描述不能为空')

  if (!ctx.scope.isOwner) {
    if (rateLimited(`gen:${ctx.scope.cid}`, 20, 60_000)) throw new HttpError(429, '生成太频繁,稍等一下')
    const used = await createCountToday(DATA_DIR, ctx.scope.scopeKey)
    if (used >= DAILY_CREATE_PER_CID) throw new HttpError(429, `今天已经生成 ${used} 只了,明天再来(每人每天 ${DAILY_CREATE_PER_CID} 只)`)
  }

  const cfg = await aiConfig(DATA_DIR)
  if (!cfg.apiKey) throw new HttpError(503, '未配置模型 API Key(站长在设置里配)')
  const norm = await generateBlueprint(cfg, descr, String(body.retryHint || ''))
  const { score } = scoreBlueprint(norm, descr)
  return { blueprint: norm, score: pickScore(score) }
})

/** 提交(落库 + 落图 + 出生名/灵魂) */
route('POST', /^\/api\/creature\/commit$/, async (ctx) => {
  const body = await readBody(ctx.req)
  const descr = String(body.descr || '').trim().slice(0, 300)
  if (!descr) throw new HttpError(400, '描述不能为空')
  const norm = normalizeBlueprint(body.blueprint)
  if (!norm) throw new HttpError(400, '骨架不可用')
  const buf = decodePng(body.png)
  if (!buf) throw new HttpError(400, '图片格式不支持(需 PNG data URL)')

  const scopeKey = ctx.scope.scopeKey
  const state = await loadState(DATA_DIR, scopeKey)
  const replaceId = typeof body.replaceId === 'string' ? body.replaceId : ''

  if (!replaceId && !ctx.scope.isOwner) {
    if (state.items.length >= MAX_CREATURES_PER_CID) {
      return { error: `你已经有 ${MAX_CREATURES_PER_CID} 只了,再创建需要选择覆盖一只`, needReplace: true, limit: MAX_CREATURES_PER_CID, _status: 409 }
    }
    const used = await createCountToday(DATA_DIR, scopeKey)
    if (used >= DAILY_CREATE_PER_CID) throw new HttpError(429, `今天已经生成 ${used} 只了,明天再来`)
  }

  const { cc, score } = scoreBlueprint(norm, descr)
  const cfg = await aiConfig(DATA_DIR)
  // 出生名 + 灵魂:LLM 失败则规则兜底,不阻断创建
  const { name, personality } = await birthNameAndSoul(cfg, descr, score)

  const base = {
    descr,
    name,
    personality,
    blueprint: norm,
    dna: cc.dna,
    craft: score.craft,
    appeal: score.appeal,
    total: score.total,
    scoreVersion: SCORE_VERSION,
    birthdayDay: Number(body.birthdayDay) || 0,
  }

  let row
  if (replaceId) {
    row = replaceCreature(state, replaceId, base)
    if (!row) throw new HttpError(404, '要覆盖的生灵不存在或不属于你')
  } else {
    row = addCreature(state, base, ctx.scope.isOwner ? Infinity : MAX_CREATURES_PER_CID)
  }
  await saveState(DATA_DIR, scopeKey, state)
  await fsp.mkdir(PNG_DIR, { recursive: true })
  await fsp.writeFile(path.join(PNG_DIR, pngName(row.id)), buf)
  if (!replaceId && !ctx.scope.isOwner) await bumpCreateCount(DATA_DIR, scopeKey)
  await invalidateRank(DATA_DIR)

  return { creature: publicCreature(row), name, personality }
})

/** 改名 / 选择参与排行 */
route('PATCH', /^\/api\/creature\/([^/]+)$/, async (ctx) => {
  const id = ctx.params[0]
  const body = await readBody(ctx.req)
  const state = await loadState(DATA_DIR, ctx.scope.scopeKey)
  let row = null
  if (typeof body.name === 'string') {
    row = renameCreature(state, id, body.name)
    if (!row) throw new HttpError(404, '生灵不存在')
  }
  if (typeof body.selected === 'boolean') {
    row = setSelected(state, id, body.selected)
    if (!row) throw new HttpError(404, '生灵不存在')
  }
  await saveState(DATA_DIR, ctx.scope.scopeKey, state)
  await invalidateRank(DATA_DIR)
  return { creature: publicCreature(row) }
})

/* ---- 批量设置参与排行(站长整批选 Top5 用) ---- */

route('POST', /^\/api\/creature\/selected$/, async (ctx) => {
  const body = await readBody(ctx.req)
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : null
  if (!ids) throw new HttpError(400, '缺少 ids 数组')
  const state = await loadState(DATA_DIR, ctx.scope.scopeKey)
  const hit = setSelectedMany(state, ids)
  await saveState(DATA_DIR, ctx.scope.scopeKey, state)
  await invalidateRank(DATA_DIR)
  return { selected: hit }
})

route('DELETE', /^\/api\/creature\/([^/]+)$/, async (ctx) => {
  const state = await loadState(DATA_DIR, ctx.scope.scopeKey)
  const ok = removeCreature(state, ctx.params[0])
  if (!ok) throw new HttpError(404, '生灵不存在')
  await saveState(DATA_DIR, ctx.scope.scopeKey, state)
  await invalidateRank(DATA_DIR)
  return { ok: true }
})

/* ---- 榜单(公开) ---- */

route('GET', /^\/api\/creatures\/top$/, async (ctx) => {
  const n = Math.max(1, Math.min(50, Number(ctx.url.searchParams.get('n')) || 5))
  const fresh = ctx.url.searchParams.get('fresh') === '1' || ctx.scope.isOwner
  const rank = await ensureRank(DATA_DIR, fresh)
  const items = rank.ids.slice(0, n).map((id) => rank.byId[id]).filter(Boolean)
  return { scoreVersion: SCORE_VERSION, reranked: rank.reranked, at: rank.at, items }
})

/* ---- 主页四周生灵层(公开:Top + 我的 selected) ---- */

async function fieldList(scopeKey) {
  // 用「实时按分排序」的榜(纯函数,无 LLM、无缓存)取 Top5:
  // 避免旧榜缓存(stale-while-revalidate)导致主页显示错的生灵(如已不参排的却还在)。
  const rows = await leaderboard(DATA_DIR, SCORE_VERSION, 5)
  const says = (await readRank(DATA_DIR))?.says || {}
  const mine = await listMine(DATA_DIR, scopeKey)
  const visible = []
  const seen = new Set()
  for (const c of mine) {
    if (c.selected && !seen.has(c.id)) {
      seen.add(c.id)
      visible.push({ ...publicCreature(c), mine: true })
    }
  }
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    visible.push({
      id: r.id,
      descr: r.descr,
      name: r.name,
      total: r.total,
      craft: r.craft,
      appeal: r.appeal,
      blueprint: r.blueprint,
      createdAt: r.createdAt,
      img: `/creatures-png/${pngName(r.id)}`,
      say: says[r.id]?.text || '',
      pos: says[r.id]?.pos || null,
      mine: false,
    })
  }
  return visible
}

route('GET', /^\/api\/creatures\/field$/, async (ctx) => {
  return { items: await fieldList(ctx.scope.scopeKey) }
})

/* ---- 生灵互相之间的对话(公开;短缓存 + 防重复) ---- */

let chatterCache = { at: 0, turns: [] }
const CHATTER_TTL_MS = 120 * 1000

route('GET', /^\/api\/creatures\/chatter$/, async (ctx) => {
  if (Date.now() - chatterCache.at < CHATTER_TTL_MS && chatterCache.turns.length) {
    return { turns: chatterCache.turns }
  }
  try {
    const items = await fieldList(ctx.scope.scopeKey)
    const creatures = items.map((c) => ({
      id: c.id,
      name: c.name,
      personality: c.personality,
      descr: c.descr,
    }))
    const cfg = await aiConfig(DATA_DIR)
    if (cfg.apiKey && creatures.length) {
      const prev = chatterCache.turns.map((t) => t.text)
      const { turns } = await chatterRound(cfg, creatures, prev)
      if (turns.length) chatterCache = { at: Date.now(), turns }
    }
  } catch {
    /* 生成失败:返回旧缓存(可能为空),前端回退到各自 say */
  }
  return { turns: chatterCache.turns }
})

/* ---- 排行榜(公开,Top100) ---- */

route('GET', /^\/api\/creatures\/leaderboard$/, async (ctx) => {
  const n = Math.max(1, Math.min(100, Number(ctx.url.searchParams.get('n')) || 100))
  const rows = await leaderboard(DATA_DIR, SCORE_VERSION, n)
  return {
    scoreVersion: SCORE_VERSION,
    count: rows.length,
    items: rows.map((c) => ({
      rank: c.rank,
      id: c.id,
      name: c.name,
      author: c.author,
      descr: c.descr,
      craft: c.craft,
      appeal: c.appeal,
      total: c.total,
      blueprint: c.blueprint,
      img: `/creatures-png/${pngName(c.id)}`,
      createdAt: c.createdAt,
    })),
  }
})

/** 触发一轮对话(榜缓存过期时;站长可手动 fresh) */
route('POST', /^\/api\/creatures\/converse$/, async (ctx) => {
  const rank = await ensureRank(DATA_DIR, ctx.scope.isOwner)
  return { round: rank.round, says: rank.says }
})

/* ---- 静态 PNG(生灵图)在主循环里直接处理,见 servePng ---- */

/* ============================ 榜单缓存 + 精排 ============================ */

async function invalidateRank(dataDir) {
  // 只标 stale,保留旧 ids/byId/says —— 重算期间 field / Top 仍能先用旧榜,避免“更新后空窗”
  const cur = await readRank(dataDir)
  await writeJson(path.join(dataDir, 'rank.json'), {
    ...(cur || {}),
    ids: Array.isArray(cur?.ids) ? cur.ids : [],
    byId: cur?.byId && typeof cur.byId === 'object' ? cur.byId : {},
    says: cur?.says && typeof cur.says === 'object' ? cur.says : {},
    reranked: cur?.reranked ?? false,
    round: cur?.round ?? 0,
    stale: true,
  })
}

/**
 * 取榜单:缓存有效直接返回;否则重算 heur 顺序 + VLM 精排 + 对话轮,并写缓存。
 * 注意并发:同一时刻多请求可能都触发重算 —— 用进程内单飞锁串行化。
 */
let rankInflight = null
async function ensureRank(dataDir, fresh) {
  const cached = await readRank(dataDir)
  const valid = cached && !cached.stale && cached.at && Date.now() - cached.at < RANK_TTL_MS
  if (valid && !fresh) return cached

  const kick = () => {
    if (!rankInflight) {
      rankInflight = (async () => {
        try {
          return await recomputeRank(dataDir)
        } finally {
          rankInflight = null
        }
      })()
    }
    return rankInflight
  }

  // 有旧榜:先返回旧数据,后台重算(stale-while-revalidate),避免更新后出现“空窗期”
  if (!fresh && cached && Array.isArray(cached.ids) && cached.ids.length) {
    kick().catch(() => {})
    return cached
  }
  return kick()
}

async function recomputeRank(dataDir) {
  const pool = await computeRank(dataDir, SCORE_VERSION, 30)
  const cfg = await aiConfig(dataDir)
  let reranked = false
  let ids = pool.map((c) => c.id)

  if (cfg.apiKey && pool.length >= 2) {
    const withPng = await Promise.all(pool.map(async (c) => ({ id: c.id, png: await readPngDataUrl(c.id) })))
    try {
      const res = await rerankTop(cfg, withPng)
      if (res.applied) {
        ids = res.order
        reranked = true
      }
    } catch {
      /* 精排失败退回 heur */
    }
  }

  // 对话轮:只对 Top(前若干) + 榜上所有生灵,生成"想说的话 + 位置"
  let says = {}
  let round = 0
  if (cfg.apiKey && pool.length) {
    try {
      const r = await converseRound(cfg, pool.slice(0, 12))
      for (const s of r.says) says[s.id] = { text: s.text, pos: s.pos }
      round = (await readRank(dataDir))?.round ? 0 : 0
      round = Date.now()
    } catch {
      /* 对话失败不影响榜单 */
    }
  }

  const byId = {}
  for (const c of pool) {
    byId[c.id] = {
      id: c.id,
      descr: c.descr,
      name: c.name,
      total: c.total,
      craft: c.craft,
      appeal: c.appeal,
      blueprint: c.blueprint,
      img: `/creatures-png/${pngName(c.id)}`,
      say: says[c.id]?.text || '',
      pos: says[c.id]?.pos || null,
      createdAt: c.createdAt,
    }
  }
  const payload = { ids, byId, reranked, round, says, stale: false }
  await writeRank(dataDir, payload)
  return { ...payload, at: Date.now() }
}

/* ============================ 静态资源 ============================ */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.join(DIST, rel)
  if (!target.startsWith(DIST)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  let stat = null
  try {
    stat = await fsp.stat(target)
  } catch {
    stat = null
  }
  if (!stat || stat.isDirectory()) {
    const html = await fsp.readFile(path.join(DIST, 'index.html')).catch(() => null)
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('未构建前端:先执行 npm run build')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
    res.end(html)
    return
  }
  const ext = path.extname(target).toLowerCase()
  const immutable = rel.startsWith('assets/')
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  fs.createReadStream(target).pipe(res)
}

async function servePng(res, file) {
  try {
    const buf = await fsp.readFile(file)
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  }
}

/* ============================ 主循环 ============================ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname

  // 站长兜底:/?owner=<token> 换 luminari_owner cookie
  const ownerParam = url.searchParams.get('owner')
  if (ownerParam && ownerParam !== ownerToken()) {
    sendJson(res, 403, { error: '站长 token 不对' })
    return
  }
  if (ownerParam && !pathname.startsWith('/api/')) {
    url.searchParams.delete('owner')
    res.writeHead(302, {
      Location: `${url.pathname}${url.search}`,
      'Set-Cookie': cookieHeader('luminari_owner', ownerToken()),
    })
    res.end()
    return
  }

  if (!pathname.startsWith('/api/')) {
    // 生灵图:直接读文件(不走 routes,避免与 SPA 回退冲突)
    const png = pathname.match(/^\/creatures-png\/([^/]+)$/)
    if (png) {
      const name = png[1]
      if (!/^c[0-9a-f]{6,40}\.png$/.test(name)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      await servePng(res, path.join(PNG_DIR, name))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    await serveStatic(req, res, pathname)
    return
  }

  const scope = resolveScope(req)
  const headers = {}
  if (scope.needsCidCookie) headers['Set-Cookie'] = cidCookieHeader(scope.rawCid)

  try {
    const hit = routes.find((r) => r.method === req.method && r.pattern.test(pathname))
    if (!hit) {
      sendJson(res, 404, { error: 'not found' }, headers)
      return
    }
    const m = pathname.match(hit.pattern)
    const body = await hit.handler({ req, res, url, scope, headers, params: m ? m.slice(1) : [] })
    if (body === undefined) return
    if (body && body._raw) {
      await servePng(res, body._raw)
      return
    }
    if (body && body._status) {
      const { _status, ...rest } = body
      sendJson(res, _status, rest, headers)
      return
    }
    sendJson(res, 200, body, headers)
  } catch (err) {
    if (res.headersSent) {
      res.end()
      return
    }
    const status = err instanceof HttpError ? err.status : 502
    const message = err instanceof Error ? err.message : '服务端错误'
    sendJson(res, status, { error: message }, headers)
  }
})

function publicCreature(c) {
  return {
    id: c.id,
    descr: c.descr,
    name: c.name,
    personality: c.personality,
    craft: c.craft,
    appeal: c.appeal,
    total: c.total,
    selected: c.selected,
    birthdayDay: c.birthdayDay,
    say: c.say,
    pos: c.pos,
    memories: c.memories,
    createdAt: c.createdAt,
    // 中央大预览需要骨架(活体 RigCreature 渲染);列表只用 img
    blueprint: c.blueprint,
    img: `/creatures-png/${pngName(c.id)}`,
  }
}

function pickScore(score) {
  return { craft: score.craft, appeal: score.appeal, total: score.total }
}

server.listen(PORT, HOST, () => {
  console.log(`[luminari] listening on http://${HOST}:${PORT}`)
  console.log(`[luminari] data dir: ${DATA_DIR}`)
})

export { server }
