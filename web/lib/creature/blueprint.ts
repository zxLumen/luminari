/**
 * Creature Blueprint —— LLM 现场生成的「骨架 + DNA」原始产物与编译契约。
 *
 * 与 `species/*.ts`(手写 rig)的区别:那份是**我**写死的解剖数据;这份是**模型**按提示词
 * 现写的。两者最终都编译成同一份 `Rig`(部件树 + pose),所以 `RigCreature` 不需要知道
 * 骨架是谁写的。
 *
 * 为什么 JSON 里不能直接放函数:
 *   - 模型只能输出 JSON,输出不了闭包;
 *   - 所以 `grow`/`appear` 用**数字区间** `[startDay, endDay]` 表示,
 *     `pose` 用**运动族 + 参数**表示,由 `compileBlueprint` 展开成渲染器要的函数。
 *
 * 安全边界:`normalizeBlueprint` 是唯一入口 —— 白名单 role、夹数字、限部件数/路径长度、
 * 校验 `parent` 存在。之后渲染器里不存在任何可注入内容(与 `normalizeDna` 同一思路)。
 *
 * 零依赖,可在 Node 与浏览器两端运行。
 */

import {
  ARCHETYPES,
  TRAIT_AXES,
  normalizeDna,
  type Archetype,
  type CreatureDna,
  type TraitAxis,
} from './spec.js'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 部件配色角色(与渲染器 `roleColors` 对应) */
export const BP_ROLES = [
  'body',
  'bodyDark',
  'bodyLight',
  'accent',
  'accentDark',
  'accentLight',
  'glow',
  'eye',
  'white',
  'black',
  'nose',
  'line',
] as const
export type BpRole = (typeof BP_ROLES)[number]

/** 运动族:决定 pose 怎么展开 */
export const MOTION_FAMILIES = ['flap', 'walk', 'hop', 'swim', 'idle', 'glide', 'breathe'] as const
export type MotionFamily = (typeof MOTION_FAMILIES)[number]

export interface BpPart {
  id: string
  parent?: string
  /** SVG 路径串,原点是该部件的**附着点/旋转中心** */
  d: string
  role: BpRole
  z: number
  x?: number
  y?: number
  rot?: number
  mirror?: boolean
  /** >0 改为描边(线宽) */
  stroke?: number
  fixed?: boolean
  /** 生长:尺寸从 `from` 天的 `a` 倍长到 `to` 天的 `b` 倍 */
  grow?: { from: number; to: number; a: number; b: number }
  /** 显现:`start` 天开始出现,`end` 天完全显现 */
  appear?: { start: number; end: number }
}

/** 某部件的运动参数(缺省时按角色/位置自动推导) */
export interface BpPoseRule {
  /** 旋转幅度(度) */
  amp?: number
  /** 相位偏移(弧度) */
  phase?: number
  /** 周期倍率:1 = 基准周期 */
  periodScale?: number
  /** 平移幅度(局部单位) */
  dx?: number
  dy?: number
}

export interface BpMotion {
  family: MotionFamily
  /** 基准周期(秒) */
  period: number
  /** 全局幅度倍率 */
  amplitude: number
  /** 按部件名指定;未指定的按启发式推导 */
  rules?: Record<string, BpPoseRule>
}

export interface CreatureBlueprint {
  v: 1
  dna: {
    name: string
    archetype: Archetype
    palette: { body: string; accent: string; glow: string }
    traits: Record<TraitAxis, number>
    motion: {
      flapHz: number
      driftAmp: number
      bobPx: number
      trail: number
      spin: number
    }
  }
  /** 成熟期半宽(局部单位,渲染器据此归一缩放) */
  span: number
  /** 成熟天数(整体尺寸长到这个天数基本定型) */
  matureDay: number
  parts: BpPart[]
  motionCfg: BpMotion
}

/* ------------------------------------------------------------------ */
/* 校验 / 归一化                                                       */
/* ------------------------------------------------------------------ */

const HEX = /^#[0-9a-fA-F]{6}$/
const MAX_PARTS = 64
const MAX_PATH = 1200
const MAX_ID = 24

type Range = [number, number]

function num(v: unknown, dflt: number, [lo, hi]: Range): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

function str(v: unknown, max: number, dflt = ''): string {
  if (typeof v !== 'string') return dflt
  return v.trim().slice(0, max)
}

function hex(v: unknown, dflt: string): string {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : dflt
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
}

function idOf(v: unknown, i: number): string {
  const s = str(v, MAX_ID).replace(/[^a-zA-Z0-9_~-]/g, '')
  return s || `p${i}`
}

/**
 * 路径串清洗。
 *
 * 只允许 SVG path 的合法字符(命令字母、数字、正负号、小数点、逗号、空格、指数)。
 * **不接受任何花括号/引号/尖括号/分号** —— 这些是注入 `setAttribute` 或绕过解析的
 * 常见载体。长度也夹住,防止一个部件把整棵树的渲染拖垮。
 */
const PATH_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/

function pathOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const d = v.trim().slice(0, MAX_PATH)
  if (!d || !PATH_OK.test(d)) return null
  // 必须真的含有子路径起点,否则渲染出来是空的
  if (!/[Mm]/.test(d)) return null
  return d
}

function normalizeGrow(raw: unknown): BpPart['grow'] {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const from = num(r.from, 0, [0, 120])
  const to = num(r.to, 20, [0, 120])
  if (to <= from) return undefined
  return {
    from,
    to,
    a: num(r.a, 0.5, [0.05, 2]),
    b: num(r.b, 1, [0.05, 2]),
  }
}

function normalizeAppear(raw: unknown): BpPart['appear'] {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const start = num(r.start, 0, [0, 120])
  const end = num(r.end, Math.min(120, start + 8), [0, 120])
  if (end <= start) return undefined
  return { start, end }
}

function traitsOf(raw: unknown): Record<TraitAxis, number> {
  const r = (raw ?? {}) as Record<string, unknown>
  const out = {} as Record<TraitAxis, number>
  for (const axis of TRAIT_AXES) out[axis] = Math.round(num(r[axis], 0, [0, 5]))
  return out
}

function motionRuleOf(raw: unknown): BpPoseRule {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: BpPoseRule = {}
  if (r.amp !== undefined) out.amp = num(r.amp, 0, [-120, 120])
  if (r.phase !== undefined) out.phase = num(r.phase, 0, [-12, 12])
  if (r.periodScale !== undefined) out.periodScale = num(r.periodScale, 1, [0.1, 8])
  if (r.dx !== undefined) out.dx = num(r.dx, 0, [-200, 200])
  if (r.dy !== undefined) out.dy = num(r.dy, 0, [-200, 200])
  return out
}

/**
 * 归一化:模型输出的唯一入口。
 *
 * 返回 null 只在**完全无法挽救**时(不是对象、没有一条合法路径)。部件层面的问题
 * (非法 role / 坏路径 / 悬空 parent)按条丢弃,不连累整只生物 —— 宁可少几个细节,
 * 也不要让一次生成整体失败。
 */
export function normalizeBlueprint(raw: unknown): CreatureBlueprint | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const dn = (r.dna ?? {}) as Record<string, unknown>
  const pal = (dn.palette ?? {}) as Record<string, unknown>
  const mot = (dn.motion ?? {}) as Record<string, unknown>

  const archetype = oneOf(dn.archetype, ARCHETYPES, 'orb')

  const list = Array.isArray(r.parts) ? r.parts : []
  const parts: BpPart[] = []
  const seen = new Set<string>()

  for (let i = 0; i < list.length && parts.length < MAX_PARTS; i++) {
    const p = (list[i] ?? {}) as Record<string, unknown>
    const d = pathOf(p.d)
    if (!d) continue
    let id = idOf(p.id, i)
    // 去重:同名部件会让 pose 的 rules 指错对象
    if (seen.has(id)) id = `${id}_${i}`
    seen.add(id)
    const role = oneOf(p.role, BP_ROLES, 'body')
    parts.push({
      id,
      parent: typeof p.parent === 'string' ? idOf(p.parent, 0) : undefined,
      d,
      role,
      z: Math.round(num(p.z, i, [-999, 999])),
      x: p.x === undefined ? undefined : num(p.x, 0, [-500, 500]),
      y: p.y === undefined ? undefined : num(p.y, 0, [-500, 500]),
      rot: p.rot === undefined ? undefined : num(p.rot, 0, [-360, 360]),
      mirror: p.mirror === true,
      stroke: p.stroke === undefined ? undefined : num(p.stroke, 0, [0, 40]),
      fixed: p.fixed === true,
      grow: normalizeGrow(p.grow),
      appear: normalizeAppear(p.appear),
    })
  }

  if (!parts.length) return null

  // 悬空 parent 会让渲染器算不出世界变换 → 提升为根
  const ids = new Set(parts.map((p) => p.id))
  for (const p of parts) {
    if (p.parent && (!ids.has(p.parent) || p.parent === p.id)) p.parent = undefined
  }

  const cfg = (r.motionCfg ?? r.motion ?? {}) as Record<string, unknown>
  const rulesRaw = (cfg.rules ?? {}) as Record<string, unknown>
  const rules: Record<string, BpPoseRule> = {}
  for (const key of Object.keys(rulesRaw).slice(0, MAX_PARTS)) {
    const rule = motionRuleOf(rulesRaw[key])
    if (Object.keys(rule).length) rules[idOf(key, 0)] = rule
  }

  const span = num(r.span, 90, [12, 400])

  return {
    v: 1,
    dna: {
      name: str(dn.name, 8, '未名'),
      archetype,
      palette: {
        body: hex(pal.body, '#7fe0ff'),
        accent: hex(pal.accent, '#ff5fa2'),
        glow: hex(pal.glow, '#b8f4ff'),
      },
      traits: traitsOf(dn.traits),
      motion: {
        flapHz: num(mot.flapHz, 2.4, [0.3, 8]),
        driftAmp: num(mot.driftAmp, 16, [0, 80]),
        bobPx: num(mot.bobPx, 4, [0, 40]),
        trail: num(mot.trail, 0.2, [0, 1]),
        spin: num(mot.spin, 0.1, [0, 1]),
      },
    },
    span,
    matureDay: num(r.matureDay, 30, [5, 90]),
    parts,
    motionCfg: {
      family: oneOf(cfg.family, MOTION_FAMILIES, 'idle'),
      period: num(cfg.period, 1.6, [0.2, 12]),
      amplitude: num(cfg.amplitude, 1, [0, 4]),
      rules,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 编译:Blueprint → CreatureDna + Rig(渲染器消费的形状)                */
/* ------------------------------------------------------------------ */

/** 与 apps 侧 `species/types.ts` 的 Rig/Part 同构(此处用结构类型,避免反向依赖) */
export interface CompiledOverride {
  x?: number
  y?: number
  rot?: number
  sx?: number
  sy?: number
  opacity?: number
}

export interface CompiledPart {
  id: string
  parent?: string
  d: string
  role: BpRole
  z: number
  x?: number
  y?: number
  rot?: number
  mirror?: boolean
  stroke?: number
  fixed?: boolean
  grow?: (day: number) => number
  appear?: (day: number) => number
}

export interface CompiledRig {
  id: string
  label: string
  hint: string
  span: number
  parts: CompiledPart[]
  pose: (form: { flapHz: number }, ts: number, day: number) => Record<string, CompiledOverride>
}

export interface CompiledBlueprint {
  dna: CreatureDna
  rig: CompiledRig
  matureDay: number
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const norm = (day: number, a: number, b: number) => clamp01((day - a) / Math.max(1e-6, b - a))

function wordish(id: string): string {
  return id.toLowerCase()
}

/**
 * 把「运动族 + 参数」展开成每帧的部件覆盖量。
 *
 * 这是个**启发式展开器**:按部件名的词根猜测它在动什么 —— 名字里有 `wing`/`arm` 就扇动,
 * `leg`/`foot` 就迈步,`tail` 就摆动,`antenna` 就抖。模型也可以通过 `motionCfg.rules`
 * 显式指定某个部件的幅度/相位,显式优先于猜测。
 *
 * 之所以用猜测而不是要求模型逐个写参数:模型漏写是常态,而「翅膀会扇」这种常识
 * 由代码补上比让模型每次重复一遍可靠得多。
 */
function makePose(cfg: BpMotion): CompiledRig['pose'] {
  const fam = cfg.family
  const basePeriod = cfg.period
  const A = cfg.amplitude

  /** 各族的基础「振幅词表」:按部件词根给默认幅度(度) */
  const familyAmp: Record<MotionFamily, { wing: number; leg: number; tail: number; antenna: number; body: number }> = {
    flap: { wing: 26, leg: 0, tail: 6, antenna: 8, body: 3 },
    glide: { wing: 7, leg: 0, tail: 5, antenna: 5, body: 1.5 },
    walk: { wing: 3, leg: 22, tail: 10, antenna: 4, body: 2 },
    hop: { wing: 5, leg: 28, tail: 16, antenna: 6, body: 4 },
    swim: { wing: 10, leg: 14, tail: 22, antenna: 3, body: 3 },
    breathe: { wing: 0, leg: 0, tail: 0, antenna: 2, body: 2 },
    idle: { wing: 4, leg: 3, tail: 8, antenna: 6, body: 2 },
  }
  const amp = familyAmp[fam]

  return (form, ts, day) => {
    void day
    // 频率:运动族给个基准,再被 DNA 的 flapHz 轻微调制(不然同一族永远一个节奏)
    const hzBoost = fam === 'flap' || fam === 'glide' ? 0.4 : 0.1
    const f = (1 / Math.max(0.2, basePeriod)) * (1 + (form.flapHz - 2.4) * hzBoost)
    const w = ts * f * Math.PI * 2
    const out: Record<string, CompiledOverride> = { body: { rot: Math.sin(w) * amp.body * A } }

    for (const [id, rule] of Object.entries(cfg.rules ?? {})) {
      const k = wordish(id)
      const wAmp = amp.wing * A
      const lAmp = amp.leg * A
      const tAmp = amp.tail * A
      const aAmp = amp.antenna * A
      let a = 0
      if (/wing|arm|fin|blade/.test(k)) a = rule.amp ?? wAmp
      else if (/leg|foot|paw|claw|hoof/.test(k)) a = rule.amp ?? lAmp
      else if (/tail|abdomen|flush|plume/.test(k)) a = rule.amp ?? tAmp
      else if (/antenna|whisker|barb|feeler/.test(k)) a = rule.amp ?? aAmp
      else a = rule.amp ?? 0
      const ps = rule.periodScale ?? 1
      const ph = rule.phase ?? 0
      out[id] = {
        rot: Math.sin((w / ps) + ph) * a,
        x: rule.dx !== undefined ? Math.cos(w / ps + ph) * rule.dx * A : undefined,
        y: rule.dy !== undefined ? Math.sin(w / ps + ph) * rule.dy * A : undefined,
      }
    }
    return out
  }
}

/**
 * 编译:把校验过的 blueprint 变成渲染器直接消费的 DNA + Rig。
 *
 * **确定性**:同一份 blueprint 永远编译出同一份 rig(不掺随机),所以缓存/对比/
 * 视觉回归都是可复现的。
 */
export function compileBlueprint(bp: CreatureBlueprint): CompiledBlueprint {
  const dna = normalizeDna({
    name: bp.dna.name,
    archetype: bp.dna.archetype,
    palette: bp.dna.palette,
    traits: bp.dna.traits,
    motion: bp.dna.motion,
    shape: undefined, // blueprint 不走 shape 提示,拓扑全在 parts 里
    plan: [], // blueprint 的成长由每个 part 的 grow/appear 承担
  })
  // normalizeDna 只在缺 archetype 时失败,而这里已经填了合法值 → 理论上必成功;
  // 真失败就退到 DEFAULT 骨架,绝不让渲染层拿到 null。
  const safe = dna ?? normalizeDna({ archetype: 'orb' })!

  const parts: CompiledPart[] = bp.parts.map((p) => {
    const g = p.grow
    const ap = p.appear
    return {
      id: p.id,
      parent: p.parent,
      d: p.d,
      role: p.role,
      z: p.z,
      x: p.x,
      y: p.y,
      rot: p.rot,
      mirror: p.mirror,
      stroke: p.stroke,
      fixed: p.fixed,
      grow: g ? (day: number) => g.a + (g.b - g.a) * norm(day, g.from, g.to) : undefined,
      appear: ap ? (day: number) => norm(day, ap.start, ap.end) : undefined,
    }
  })

  return {
    dna: safe,
    matureDay: bp.matureDay,
    rig: {
      id: `bp:${safe.name}`,
      label: safe.name || '生物',
      hint: `${bp.motionCfg.family} · ${parts.length} 部件 · ${bp.matureDay} 天定型`,
      span: bp.span,
      parts,
      pose: makePose(bp.motionCfg),
    },
  }
}
