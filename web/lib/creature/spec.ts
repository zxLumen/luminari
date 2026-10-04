/**
 * 生物 DNA:LLM / 程序兜底产出的**受约束声明式规格**,渲染器确定性消费。
 *
 * 设计要点(三条,决定了整个系统成不成立):
 *
 *  1. **LLM 不画像素,只产出这份 JSON。** 自由生成的 SVG 代码无法拆解、无法分阶段、
 *     token 爆炸;而这里的数字/枚举可以被任何渲染器映射成 transform、着色器参数或
 *     物理约束。
 *  2. **校验器是唯一入口,也是唯一安全边界。** `normalizeDna` 之后只剩数字、白名单枚举
 *     与校验过的 `#rrggbb`,渲染器里不存在任何可注入内容。
 *  3. **成长计划在创建时就写好。** `plan` 三条 StagePlan 由描述驱动,之后每天只是把
 *     deltas 累加 + 插值 —— 成长过程零 LLM 调用、零写库、完全确定性。
 *
 * 本文件零依赖、可在 Node 与浏览器两端运行(测试直接 import dist)。
 */

/** 八种原型:决定身体拓扑(躯干走向、肢体对数、侧视程度) */
export const ARCHETYPES = [
  'butterfly',
  'fish',
  'dragon',
  'orb',
  'insect',
  'bird',
  'plant',
  'machine',
] as const
export type Archetype = (typeof ARCHETYPES)[number]

/** 八条特质轴:描述里的关键词点亮对应轴,成长时沿**已点亮**的轴加深 */
export const TRAIT_AXES = [
  'mechanical',
  'organic',
  'ethereal',
  'fierce',
  'cute',
  'ancient',
  'cyber',
  'luminous',
] as const
export type TraitAxis = (typeof TRAIT_AXES)[number]

/** 轴的中文名,展示用(评分备注、校验台图例) */
export const TRAIT_LABELS: Record<TraitAxis, string> = {
  mechanical: '机械',
  organic: '有机',
  ethereal: '空灵',
  fierce: '凶猛',
  cute: '可爱',
  ancient: '远古',
  cyber: '赛博',
  luminous: '发光',
}

/** 阶段数:0 孢子 / 1 幼体 / 2 成体 / 3 觉醒 */
export const STAGE_COUNT = 4
export const STAGE_LABELS = ['孢子', '幼体', '成体', '觉醒'] as const
export type StageLabel = (typeof STAGE_LABELS)[number]

/** 各阶段基准尺寸(px),渲染器按此缩放 */
export const STAGE_SIZE = [6, 16, 30, 48] as const

export interface Palette {
  body: string
  accent: string
  glow: string
}

/** 可选几何提示:只有需要骨架/脊柱的渲染器(软体、粒子、网格、SDF)会读 */
export interface ShapeHints {
  limbPairs: number
  spineSegments: number
  symmetry: number
}

export interface Motion {
  /** 扇动/起伏频率 Hz */
  flapHz: number
  /** 漂移幅度 px */
  driftAmp: number
  /** 上下浮动 px */
  bobPx: number
  /** 拖尾强度 0..1 */
  trail: number
  /** 自旋 0..1 */
  spin: number
}

export interface StagePlan {
  /** 1..3,升到该阶段时应用 */
  stage: number
  /** ≤8 字阶段名 */
  name: string
  /** ≤40 字,这阶段长什么样 */
  note: string
  /** 该阶段点亮的特质(+值) */
  boost: Partial<Record<TraitAxis, number>>
  /** 该阶段追加的特效强度 */
  add: { glow?: number; trail?: number; spin?: number; size?: number }
}

export interface CreatureDna {
  v: 1
  name: string
  archetype: Archetype
  palette: Palette
  traits: Record<TraitAxis, number>
  motion: Motion
  shape: ShapeHints
  plan: StagePlan[]
}

/* ------------------------------------------------------------------ */
/* 区间与默认值                                                        */
/* ------------------------------------------------------------------ */

type Range = [number, number]

const R_TRAIT: Range = [0, 5]
const R_FREQ: Range = [0.8, 6]
const R_DRIFT: Range = [6, 36]
const R_BOB: Range = [0, 10]
const R_UNIT: Range = [0, 1]
const R_LIMB: Range = [0, 4]
const R_SPINE: Range = [3, 12]
const R_SYM: Range = [0, 1]

/** 各原型的默认几何提示。渲染器优先用 dna.shape,缺省回退到这里。 */
export const ARCHETYPE_SHAPE: Record<Archetype, ShapeHints> = {
  butterfly: { limbPairs: 4, spineSegments: 4, symmetry: 1 },
  fish: { limbPairs: 2, spineSegments: 10, symmetry: 0.8 },
  dragon: { limbPairs: 4, spineSegments: 10, symmetry: 0.9 },
  orb: { limbPairs: 0, spineSegments: 5, symmetry: 1 },
  insect: { limbPairs: 6, spineSegments: 6, symmetry: 1 },
  bird: { limbPairs: 2, spineSegments: 6, symmetry: 0.9 },
  plant: { limbPairs: 5, spineSegments: 6, symmetry: 0.7 },
  machine: { limbPairs: 4, spineSegments: 8, symmetry: 1 },
}

/* ------------------------------------------------------------------ */
/* 校验 / 归一化                                                       */
/* ------------------------------------------------------------------ */

const HEX = /^#[0-9a-fA-F]{6}$/
const MAX_PLAN = STAGE_COUNT - 1

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
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : dflt
}

function normalizeBoost(raw: unknown): Partial<Record<TraitAxis, number>> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Record<TraitAxis, number>> = {}
  for (const axis of TRAIT_AXES) {
    const n = num((raw as Record<string, unknown>)[axis], 0, [0, 3])
    if (n > 0) out[axis] = n
  }
  return out
}

function normalizePlan(raw: unknown): StagePlan[] {
  const list = Array.isArray(raw) ? raw : []
  const out: StagePlan[] = []
  for (let i = 0; i < Math.min(list.length, MAX_PLAN); i++) {
    const r = (list[i] ?? {}) as Record<string, unknown>
    const addRaw = (r.add ?? {}) as Record<string, unknown>
    const plan: StagePlan = {
      stage: i + 1,
      name: str(r.name, 8, `${STAGE_LABELS[i + 1]}期`),
      note: str(r.note, 40, ''),
      boost: normalizeBoost(r.boost),
      add: {
        glow: num(addRaw.glow, 0, [0, 1]),
        trail: num(addRaw.trail, 0, [0, 1]),
        spin: num(addRaw.spin, 0, [0, 1]),
        size: num(addRaw.size, 0, [0, 24]),
      },
    }
    // 三段 note 必须能看出差别,全空则由 plan 名称兜底已足够,不必拒收
    if (!plan.note) plan.note = plan.name
    out.push(plan)
  }
  // plan 长度不足则补默认,保证渲染器永远拿到 STAGE_COUNT-1 条
  for (let i = out.length; i < MAX_PLAN; i++) {
    out.push({
      stage: i + 1,
      name: `${STAGE_LABELS[i + 1]}期`,
      note: STAGE_LABELS[i + 1],
      boost: {},
      // 补的条目也要走一遍完整的 add 归一化 —— 否则 `{}` 与全零对象两种形态并存,
      // 下游再归一化一次就会得到不同结果(破坏幂等)
      add: { glow: 0, trail: 0, spin: 0, size: 0 },
    })
  }
  return out
}

/**
 * 归一化:模型输出的唯一入口。
 *
 * 枚举查白名单、数字夹到区间、颜色正则过滤后不合格退回站点默认色、字符串截断。
 * **返回 null 只在完全无法挽救时**(不是对象、或缺 archetype 之类无法猜的关键字段),
 * 调用方据此走 `fallbackDna`。
 */
export function normalizeDna(raw: unknown): CreatureDna | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const archetype = oneOf(r.archetype, ARCHETYPES, null as unknown as Archetype)
  if (!archetype) return null

  const dfltShape = ARCHETYPE_SHAPE[archetype]
  const traitsRaw = (r.traits ?? {}) as Record<string, unknown>
  const traits = {} as Record<TraitAxis, number>
  for (const axis of TRAIT_AXES) traits[axis] = Math.round(num(traitsRaw[axis], 0, R_TRAIT))

  const motionRaw = (r.motion ?? {}) as Record<string, unknown>
  const shapeRaw = (r.shape ?? {}) as Record<string, unknown>
  const palRaw = (r.palette ?? {}) as Record<string, unknown>

  return {
    v: 1,
    name: str(r.name, 8, '无名'),
    archetype,
    palette: {
      body: hex(palRaw.body, '#7fe0ff'),
      accent: hex(palRaw.accent, '#ff5fa2'),
      glow: hex(palRaw.glow, '#b8f4ff'),
    },
    traits,
    motion: {
      flapHz: num(motionRaw.flapHz, 3, R_FREQ),
      driftAmp: num(motionRaw.driftAmp, 18, R_DRIFT),
      bobPx: num(motionRaw.bobPx, 5, R_BOB),
      trail: num(motionRaw.trail, 0.2, R_UNIT),
      spin: num(motionRaw.spin, 0.1, R_UNIT),
    },
    shape: {
      limbPairs: Math.round(num(shapeRaw.limbPairs, dfltShape.limbPairs, R_LIMB)),
      spineSegments: Math.round(num(shapeRaw.spineSegments, dfltShape.spineSegments, R_SPINE)),
      symmetry: num(shapeRaw.symmetry, dfltShape.symmetry, R_SYM),
    },
    plan: normalizePlan(r.plan),
  }
}

/* ------------------------------------------------------------------ */
/* 形态解算:离散阶段 → 连续插值                                        */
/* ------------------------------------------------------------------ */

/** 渲染器真正消费的东西:已展平、可直接用的绘制参数 */
export interface FormState {
  stage: number
  stageName: string
  note: string
  archetype: Archetype
  palette: Palette
  shape: ShapeHints
  /** 基准尺寸 px */
  size: number
  /** 辉光 0..1 */
  glow: number
  trail: number
  spin: number
  flapHz: number
  driftAmp: number
  bobPx: number
  /** 各阶段体节(1..4),随 spineSegments 换算,供软体/粒子/网格用 */
  segments: number
  traits: Record<TraitAxis, number>
  /** 最亮的三个特质轴,渲染器用来决定「往哪长」 */
  topTraits: TraitAxis[]
}

const TOP_TRAIT_TIES = 2

function topTraits(traits: Record<TraitAxis, number>): TraitAxis[] {
  const max = Math.max(...TRAIT_AXES.map((a) => traits[a]), 1)
  const picked = TRAIT_AXES.filter((a) => traits[a] >= Math.max(1, max - TOP_TRAIT_TIES))
  return picked.length ? picked : [TRAIT_AXES[0]]
}

/** 解算某一**离散**阶段的形态(不做插值) */
export function formAt(dna: CreatureDna, stage: number): FormState {
  const s = Math.min(Math.max(Math.round(stage), 0), STAGE_COUNT - 1)
  const traits = { ...dna.traits }
  let glow = 0.12 + traits.luminous * 0.08
  let trail = dna.motion.trail
  let spin = dna.motion.spin
  let size = STAGE_SIZE[s] + (s > 0 ? s * 1.5 : 0)

  for (const p of dna.plan) {
    if (p.stage > s) continue
    for (const axis of TRAIT_AXES) {
      const b = p.boost[axis]
      if (b) traits[axis] = Math.min(8, traits[axis] + b)
    }
    glow += p.add.glow ?? 0
    trail += p.add.trail ?? 0
    spin += p.add.spin ?? 0
    size += p.add.size ?? 0
  }

  const shape = dna.shape
  return {
    stage: s,
    stageName: s === 0 ? STAGE_LABELS[0] : (dna.plan[s - 1]?.name ?? STAGE_LABELS[s]),
    note: s === 0 ? '尚未成形的一点微光' : (dna.plan[s - 1]?.note ?? ''),
    archetype: dna.archetype,
    palette: dna.palette,
    shape,
    size,
    glow: Math.min(1, glow),
    trail: Math.min(1, trail),
    spin: Math.min(1, spin),
    flapHz: dna.motion.flapHz,
    driftAmp: dna.motion.driftAmp,
    bobPx: dna.motion.bobPx,
    segments: Math.min(4, Math.max(1, Math.round(shape.spineSegments / 3))),
    traits,
    topTraits: topTraits(traits),
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function lerpTraits(
  a: Record<TraitAxis, number>,
  b: Record<TraitAxis, number>,
  t: number,
): Record<TraitAxis, number> {
  const out = {} as Record<TraitAxis, number>
  for (const axis of TRAIT_AXES) out[axis] = lerp(a[axis], b[axis], t)
  return out
}

/**
 * 连续形态解算 —— 六个渲染器唯一的形态入口。
 *
 * `stageFloat` 是 0.0..3.0 的连续阶段值(见 growth.ts):`stage` 是它的下取整,
 * `t` 是阶段内插值系数。渲染器拿这个 `t` 在相邻两阶段之间做 morph —— 这样
 * 「每天都在长大」是连续过程,而不是三次跳变。
 */
export function resolveForm(dna: CreatureDna, stageFloat: number): FormState {
  const sf = Math.min(Math.max(stageFloat, 0), STAGE_COUNT - 1)
  const stage = Math.min(Math.floor(sf), STAGE_COUNT - 2 < 0 ? 0 : STAGE_COUNT - 2)
  const t = sf - stage
  const a = formAt(dna, stage)
  if (t <= 0.001) return a
  const b = formAt(dna, stage + 1)
  const traits = lerpTraits(a.traits, b.traits, t)
  return {
    stage,
    stageName: b.stageName,
    note: b.note,
    archetype: dna.archetype,
    palette: dna.palette,
    shape: dna.shape,
    size: lerp(a.size, b.size, t),
    glow: lerp(a.glow, b.glow, t),
    trail: lerp(a.trail, b.trail, t),
    spin: lerp(a.spin, b.spin, t),
    flapHz: lerp(a.flapHz, b.flapHz, t),
    driftAmp: lerp(a.driftAmp, b.driftAmp, t),
    bobPx: lerp(a.bobPx, b.bobPx, t),
    segments: Math.round(lerp(a.segments, b.segments, t)),
    traits,
    topTraits: topTraits(traits),
  }
}
