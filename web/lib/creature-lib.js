import { randomUUID } from 'node:crypto'
import {
  normalizeBlueprint,
  compileBlueprint,
  heuristicScore,
  fallbackDna,
  SCORE_VERSION,
} from '../server-dist/creature/index.js'
import { buildGenerateMessages, GENERATE_BUDGETS } from '../server-dist/generate-prompt.js'
import { extractJson } from '../server-dist/json.js'
import { completeChat } from './llm.js'

/**
 * 生灵业务逻辑:生成骨架 + 打分 + 出生名/灵魂 + 对话/记忆。
 * 纯逻辑与 IO 分离,便于测试。
 */

export { SCORE_VERSION }

/** 对一份 blueprint 打分,返回 ScoreBreakdown(逐维取 ctx 需要的字段) */
export function scoreBlueprint(norm, descr) {
  const cc = compileBlueprint(norm)
  const score = heuristicScore(cc.dna, descr, {
    parts: norm.parts,
    motionFamily: norm.motionCfg?.family,
    span: norm.span,
    motionRules: Object.values(norm.motionCfg?.rules ?? {}),
  })
  return { cc, score }
}

/** 成长编排护栏:appear / 部件数落在区间外(太少、太碎、太杂)就带提示重试一次 */
const MIN_APPEAR = 4
const MAX_APPEAR = 10
const MIN_BASE = 4
const MAX_PARTS_SOFT = 22

/** 生成一只生物的骨架:调 LLM + 解析 + 校验。失败抛错。 */
export async function generateBlueprint(aiConfig, descr, retryHint) {
  const budget = [...GENERATE_BUDGETS, 8000]
  let lastErr = '生成失败'
  let hint = retryHint
  let best = null
  for (const maxTokens of budget) {
    const res = await completeChat(aiConfig, {
      messages: buildGenerateMessages(descr, hint),
      maxTokens,
      temperature: 0.8,
      noThinking: false,
    })
    if (res.finishReason === 'length') {
      lastErr = '输出被截断'
      continue
    }
    const raw = extractJson(res.text)
    const norm = normalizeBlueprint(raw)
    if (!norm) {
      lastErr = '骨架不可用'
      continue
    }
    // 成长编排护栏:太少 / 太碎 / 太杂 → 带提示再试一次(保留最后一份兜底)
    const appears = norm.parts.filter((p) => p.appear).length
    const base = norm.parts.filter((p) => !p.appear).length
    const tooMany = appears > MAX_APPEAR || norm.parts.length > MAX_PARTS_SOFT
    if (appears >= MIN_APPEAR && base >= MIN_BASE && !tooMany) return norm
    best = norm
    lastErr = `成长编排不合格(appear=${appears}, parts=${norm.parts.length})`
    hint = tooMany
      ? `${retryHint ? retryHint + ';' : ''}上次部件太多太杂(parts=${norm.parts.length}, appear=${appears})。请**精简**:总部件 ≤20、appear 4~8;只保留**有名字、有意义**的进化件(如一对巨翼、肩甲、王冠),删掉重复的小尖刺 / 小圆环 / 相似小翼,保持剪影干净可读。`
      : `${retryHint ? retryHint + ';' : ''}上次:appear=${appears}(目标 4~8)、第 0 天就在的部件=${base}(要 ≥${MIN_BASE})。请让**身体/头/眼/主要肢体第 0 天就在(禁止给它们 appear,只用轻微 grow a≈0.9,b≈1.1)**,appear 只加在**有名字**的进化件上,分散到各阶段。`
  }
  if (best) return best
  throw new Error(lastErr)
}

/** 兜底 DNA(完全没有 LLM 时,仍能创建一只可渲染的生物;同名占位) */
export function fallbackBlueprint(descr) {
  return { dna: fallbackDna(descr), via: 'fallback' }
}

/**
 * 出生时生成 { name, personality }。
 * 名字:规则从描述抽(取描述里的名词性片段),保证一定有;
 * personality:调 LLM 生成一句灵魂设定,失败留空(不阻断创建)。
 */
const STOP = new Set(['一只', '一', '个', '的', '和', '与', '、', '，', ',', '。', ' ', '有', '是'])
export function defaultNameFromDescr(descr) {
  const s = String(descr || '').replace(/^一只/, '').trim()
  // 取第一段(到第一个标点/顿号为止),再砍到 ≤6 字
  const head = s.split(/[，,;；、:：。.\s]/)[0] || s
  const cleaned = [...head].filter((ch) => !STOP.has(ch)).join('').slice(0, 6)
  return cleaned || '无名'
}

export async function birthNameAndSoul(aiConfig, descr, score) {
  const fallbackName = defaultNameFromDescr(descr)
  const facets = `craft ${score.craft.toFixed(0)} / appeal ${score.appeal.toFixed(0)}`
  const sys = '你在为一只虚拟生灵命名并写一句灵魂设定。只输出一个 JSON,不要解释。'
  const user = `这只生灵被描述为:${descr}
它的评分是 ${facets}。
请给它一个 ≤4 个汉字的名字(name),并写一句 ≤40 字、有性格的第一人称「灵魂设定」(personality,像它自己说的)。
输出:{"name":"...","personality":"..."}`
  try {
    const res = await completeChat(aiConfig, {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      maxTokens: 400,
      temperature: 0.9,
      noThinking: true,
    })
    const raw = extractJson(res.text) || {}
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 4) : fallbackName
    const personality = typeof raw.personality === 'string' ? raw.personality.trim().slice(0, 60) : ''
    return { name, personality }
  } catch {
    return { name: fallbackName, personality: '' }
  }
}

/**
 * 生成一轮"生灵想说的话 + 它选择的位置 + 记忆"。
 * 输入:一组生灵(自己的 selected + 榜上);输出:每只的 say/pos + 可选记忆。
 *
 * 位置 px/py 是归一化 0..1(前端按视口四周映射);要求模型让它们**沿四周分布**。
 */
export async function converseRound(aiConfig, creatures) {
  if (!creatures.length) return { says: [] }
  const roster = creatures
    .map((c) => `- id=${c.id}; 名字=${c.name || '无名'}; 描述=${c.descr}; 灵魂=${c.personality || '（无）'}`)
    .join('\n')
  const sys = `你是这些虚拟生灵们的旁白。它们住在同一个星球上,会彼此打招呼、怀念离开的同伴、欢迎新来的。
你只输出一个 JSON 数组,每项对应一只生灵"此刻想说的话",以及它想在画面四周待的位置。不要解释。`
  const user = `生灵们:
${roster}

请为每只输出一句 ≤50 字、第一人称、有记忆感的话(text),以及一个位置(pos:归一化 x/y,0=左/上,1=右/下;让它们沿画面四周分散,不要都挤中间)。
可选:若这轮发生了值得记住的事(遇见/怀念/欢迎),加一条 memory(≤30 字)。
输出:[{"id":"...","text":"...","pos":{"x":0.1,"y":0.2},"memory":"..."}]`
  const res = await completeChat(aiConfig, {
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    maxTokens: 2000,
    temperature: 0.95,
    noThinking: true,
  })
  const arr = extractJson(res.text)
  const list = Array.isArray(arr) ? arr : Array.isArray(arr?.says) ? arr.says : []
  const byId = new Map(creatures.map((c) => [c.id, c]))
  const says = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.id || '')
    if (!byId.has(id)) continue
    const pos = item.pos && typeof item.pos === 'object' ? item.pos : null
    says.push({
      id,
      text: typeof item.text === 'string' ? item.text.trim().slice(0, 80) : '',
      pos: pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))
        ? { x: clamp01(Number(pos.x)), y: clamp01(Number(pos.y)) }
        : null,
      memory: typeof item.memory === 'string' ? item.memory.trim().slice(0, 60) : '',
    })
  }
  return { says }
}

/**
 * 生成一段生灵**彼此之间**的短对话(来回接话,不是各自独白)。
 * `prev` 是上一轮已说过的话,塞进提示词让它别重复/改写。
 * 返回 [{ id, text }]。
 */
export async function chatterRound(aiConfig, creatures, prev = []) {
  if (!creatures.length) return { turns: [] }
  const roster = creatures
    .map((c) => `- id=${c.id}; 名字=${c.name || '无名'}; 性格=${c.personality || c.descr || '（无）'}`)
    .join('\n')
  const prevText = prev.length
    ? `\n已说过、**不要再重复或改写**的话:\n${prev.map((t) => `- ${t}`).join('\n')}\n`
    : ''
  const sys = `你是这些虚拟生灵的旁白兼编剧。它们住在同一颗星球,会互相打招呼、斗嘴、怀念离开的同伴、欢迎新来的。
写一段它们**彼此之间**的短对话(来回接话,不是各自独白),每句属于其中一只。只输出 JSON 数组,不要解释。`
  const user = `生灵名单:
${roster}
${prevText}
写一段它们此刻的对话,6~10 句,每句 ≤30 字、口语、有性格、**互相称呼对方名字**、像真的在聊天。输出:
[{"id":"<名单里的 id>","text":"..."}]`
  const res = await completeChat(aiConfig, {
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    maxTokens: 1200,
    temperature: 1.0,
    noThinking: true,
  })
  const arr = extractJson(res.text)
  const ids = new Set(creatures.map((c) => c.id))
  const turns = []
  if (Array.isArray(arr)) {
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const id = String(item.id || '')
      if (!ids.has(id)) continue
      const text = typeof item.text === 'string' ? item.text.trim().slice(0, 60) : ''
      if (text) turns.push({ id, text })
    }
  }
  return { turns }
}

const clamp01 = (n) => Math.min(1, Math.max(0, n))

export const newId = () => `c${randomUUID().replace(/-/g, '').slice(0, 12)}`
