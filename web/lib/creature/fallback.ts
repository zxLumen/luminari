/**
 * 程序化兜底:**描述 → DNA 的确定性推导**,不调任何模型。
 *
 * 两个用途,都是硬需求:
 *  1. 生产兜底 —— LLM 超时/抽风/返回非法 JSON 时,创建接口不能失败,改走这里;
 *  2. demo 离线数据 —— `/lab/creature` 不依赖模型就能跑起来,判定渲染器时不被
 *     「模型今天有没有抽风」干扰。
 *
 * 同一段描述永远得到同一份 DNA(哈希播种),所以 demo 里切描述看到的变化是可复现的。
 */

import {
  ARCHETYPES,
  TRAIT_AXES,
  ARCHETYPE_SHAPE,
  normalizeDna,
  type Archetype,
  type CreatureDna,
  type TraitAxis,
} from './spec.js'

/* ---------------------------- 随机 ---------------------------- */

/** 字符串 → 32 位种子(FNV-1a) */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32:小、快、确定性足够 */
function rngOf(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pickOf = <T>(rng: () => number, list: readonly T[]): T =>
  list[Math.floor(rng() * list.length) % list.length]

/* ---------------------------- 颜色 ---------------------------- */

function hslHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = l - c / 2
  const seg = Math.floor(hh / 60) % 6
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg] as [number, number, number]
  const hex = rgb
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
  return `#${hex}`
}

/* ---------------------------- 词表 ---------------------------- */

/**
 * 原型词表。**导出**是因为 `score.ts` 的原型契合维要用它 —— 它原先是模块私有的,
 * 于是评分侧要么复制一份(必然走偏)要么只能靠 `keywordMatch` 这条已经发现有
 * 「奖励点亮更多轴」偏差的路径。
 */
export const ARCHETYPE_WORDS: Record<Archetype, string[]> = {
  butterfly: ['蝴蝶', '蝶', '凤蝶', '蛾', '彩蝶'],
  fish: ['鱼', '鲸', '鲨', '水母', '章鱼', '鳐', '游鱼'],
  dragon: ['龙', '蛟', '蛇', '蜥', '龙兽', '飞龙'],
  orb: ['光球', '球', '灵体', '幽灵', '光团', '泡', '星核', '泡泡'],
  insect: ['虫', '甲虫', '蚂蚁', '蜜蜂', '蜻蜓', '蝉', '甲壳', '萤火虫'],
  bird: ['鸟', '鹰', '凤', '雀', '鸽', '鹤', '飞禽', '翠鸟'],
  plant: ['花', '草', '树', '藤', '叶', '植物', '芽', '蘑菇', '苔'],
  machine: ['机器', '机械', '机甲', '机器人', '电路', '数码', '装置', '齿轮', '电子'],
}

/**
 * 每条特质轴的描述词表。
 *
 * 导出给 `score.ts` 的落实度检查复用 —— 必须是**同一份**词表,否则「描述点了赛博」
 * 和「模型有没有点亮 cyber 轴」就会用两套标准,检查出来的结果是假的。
 */
export const TRAIT_WORDS: Record<TraitAxis, string[]> = {
  mechanical: ['机械', '金属', '齿轮', '钢铁', '机油', '铆钉'],
  organic: ['有机', '血肉', '生物', '肉', '藤蔓', '活着'],
  ethereal: ['空灵', '幽灵', '虚', '缥缈', '仙', '雾', '轻'],
  fierce: ['凶', '猛', '暴', '利爪', '獠牙', '狂', '噬'],
  cute: ['可爱', '萌', '圆', '呆', '小', '温柔', '软'],
  ancient: ['古', '远古', '上古', '年迈', '沧桑', '古旧', '遗迹'],
  cyber: ['赛博', '霓虹', '未来', '科幻', '电子', '数字', '全息', '代码'],
  luminous: ['发光', '亮', '光', '辉', '荧', '闪烁', '电光', '耀'],
}

/** 词表命中权重 → 配色(赛博/深海/火/森林/冰/暗) */
const MOOD_PALETTES: { words: string[]; pal: [string, string, string] }[] = [
  {
    words: ['赛博', '霓虹', '电子', '代码', '未来', '全息', '数码', '机械'],
    pal: ['#0affc8', '#ff2e88', '#7ef9ff'],
  },
  { words: ['深海', '海', '水', '水母', '鱼', '鲸', '冰', '雪', '霜'], pal: ['#4fd6ff', '#b06fe8', '#d8f6ff'] },
  { words: ['火', '炎', '日', '阳', '红', '熔'], pal: ['#ff8a3d', '#ffd54d', '#fff0c2'] },
  { words: ['草', '叶', '藤', '森林', '树', '苔', '花'], pal: ['#7fe08a', '#e8d44d', '#d8ffd8'] },
  { words: ['暗', '夜', '黑', '影', '幽'], pal: ['#9aa4b2', '#6fe8c8', '#d8e0e8'] },
]

/** 每个特质轴的取名字素与阶段后缀 */
const TRAIT_MORPH: Record<TraitAxis, { char: string; word: string }> = {
  mechanical: { char: '铁', word: '金属' },
  organic: { char: '藤', word: '血肉' },
  ethereal: { char: '灵', word: '虚影' },
  fierce: { char: '獠', word: '利爪' },
  cute: { char: '绒', word: '绒毛' },
  ancient: { char: '遗', word: '古纹' },
  cyber: { char: '零', word: '数据流' },
  luminous: { char: '曜', word: '辉光' },
}

const ARCHETYPE_MORPH: Record<Archetype, { char: string; body: string }> = {
  butterfly: { char: '蝶', body: '翅' },
  fish: { char: '鳞', body: '鳍' },
  dragon: { char: '蛟', body: '鳞甲' },
  orb: { char: '核', body: '光壳' },
  insect: { char: '甲', body: '外骨骼' },
  bird: { char: '翎', body: '翎羽' },
  plant: { char: '芽', body: '叶脉' },
  machine: { char: '枢', body: '关节' },
}

/* ---------------------------- 推导 ---------------------------- */

const count = (text: string, words: readonly string[]): number =>
  words.reduce((n, w) => (text.includes(w) ? n + w.length : n), 0)

function archetypeOf(text: string, rng: () => number): Archetype {
  let best: Archetype = 'orb'
  let bestScore = -1
  for (const a of ARCHETYPES) {
    const s = count(text, ARCHETYPE_WORDS[a]) + rng() * 0.5
    if (s > bestScore) {
      bestScore = s
      best = a
    }
  }
  return best
}

function traitsOf(text: string, rng: () => number): Record<TraitAxis, number> {
  const raw = {} as Record<TraitAxis, number>
  let any = false
  for (const axis of TRAIT_AXES) {
    const s = count(text, TRAIT_WORDS[axis])
    raw[axis] = Math.min(5, Math.round(s * 0.8))
    if (raw[axis] > 0) any = true
  }
  if (!any) {
    // 描述里没有命中任何特质词:给两条随机但稳定的轴,别产出全零的「无趣生物」
    const a = pickOf(rng, TRAIT_AXES)
    const b = pickOf(rng, TRAIT_AXES)
    raw[a] = 2 + Math.floor(rng() * 3)
    raw[b] = 1 + Math.floor(rng() * 2)
  }
  // 保底给 luminous / organic 一点量,否则任何描述都会渲染成一坨死黑
  if (raw.luminous === 0) raw.luminous = 1
  return raw
}

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * 描述 → 三色配色(确定性)。
 *
 * ⚠ 这里**必须让明度与饱和度也真的变化**。旧实现只随机**色相**:主体固定
 * `(s0.7, l0.62)`、点缀 `(0.75, 0.60)`、辉光 `(0.9, 0.80)`,色相间距只从
 * `[30,150,180]` 里挑,辉光永远是 `h+30`。于是整批配色只在色相环上转,
 * **明度/饱和度的「分离度」近似常数** —— `palette` 维量的正是它,实测方差份额只有
 * 1.4%,那一维等于在测常数(而且会误伤真正做了明暗分层的好配色)。
 * 现在整体调子从「暗身亮辉」到「亮身暗辉」铺开,亮暗两种方向都合法。
 */
function paletteOf(text: string, rng: () => number): [string, string, string] {
  for (const m of MOOD_PALETTES) {
    if (count(text, m.words) > 0) return m.pal
  }
  const h = Math.floor(rng() * 360)
  // 色相间距:包含 0(单色系,靠明暗分层)到 270(近互补)。**必须含小间距/单色**,
  // 否则整批都是「色相大跳」的配色,`colorPop` 会全部顶到满分(实测中位 1.0),
  // 那一维照样失效 —— 只是从「全 0.2」换成了「全 1.0」。
  const spread = pickOf(rng, [0, 15, 25, 40, 90, 150, 180, 210, 270])
  // 主体:明度从夜行(暗)到高明调(亮)整段铺开;饱和度从近灰到高饱和
  const bodyL = 0.2 + rng() * 0.62
  const bodyS = 0.15 + rng() * 0.8
  // 辉光:多数比主体亮(光感),少数更暗(暗辉);把明度差拉开才有层次
  const glowL = clampN(
    rng() < 0.72 ? bodyL + 0.14 + rng() * 0.24 : bodyL - 0.12 - rng() * 0.2,
    0.1,
    0.94,
  )
  const glowS = clampN(bodyS + (rng() - 0.25) * 0.4, 0.2, 1)
  // 点缀:明度与主体反向偏、饱和度偏高,做「跳色」
  const accentL = clampN(bodyL + (rng() < 0.5 ? -1 : 1) * (0.08 + rng() * 0.28), 0.08, 0.92)
  const accentS = clampN(bodyS + (rng() - 0.1) * 0.45, 0.25, 1)
  // 辉光色相:多数给个偏移(顺/逆都可),少数同色系(只靠明度分层)
  const glowShift = rng() < 0.72 ? spread * (rng() < 0.5 ? 1 : -1) : 0
  return [
    hslHex(h, bodyS, bodyL),
    hslHex(h + spread, accentS, accentL),
    hslHex(h + glowShift + 25, glowS, glowL),
  ]
}

function topAxes(traits: Record<TraitAxis, number>, n: number): TraitAxis[] {
  return [...TRAIT_AXES].sort((a, b) => traits[b] - traits[a]).slice(0, n)
}

/**
 * 描述 → DNA(确定性)。结果一定过得了 `normalizeDna`,所以调用方可直接入库。
 */
export function fallbackDna(descr: string, salt = ''): CreatureDna {
  const text = `${descr ?? ''}`.trim()
  const rng = rngOf(hash(`${text}|${salt}`))
  const archetype = archetypeOf(text, rng)
  const traits = traitsOf(text, rng)
  const [body, accent, glow] = paletteOf(text, rng)
  const shape = ARCHETYPE_SHAPE[archetype]
  const top = topAxes(traits, 3)
  const [t1, t2, t3] = top as [TraitAxis, TraitAxis, TraitAxis]
  const am = ARCHETYPE_MORPH[archetype]

  const sizeHint = text.includes('小') || text.includes('迷你') ? -2 : text.includes('巨大') ? 4 : 0
  const fastHint = count(text, ['快', '疾', '迅', '闪电']) > 0 ? 1 : 0

  const name = `${am.char}${TRAIT_MORPH[t1].char}`

  const dna = {
    v: 1 as const,
    name,
    archetype,
    palette: { body, accent, glow },
    traits,
    motion: {
      // ⚠ 合法区间很宽(见 spec.ts 的 R_FREQ/R_DRIFT/R_BOB/R_UNIT),旧实现却只用了一半
      //   —— flapHz 1.4~4.0、driftAmp 10~28、trail 0.10~0.35、spin 0~0.25。于是
      //   `motion` 维在整批上几乎恒定(方差份额 0.8%),「抽搐」「拖尾配不配」这些判据
      //   根本没有样本可判。这里铺开到接近整个合法区间。
      flapHz: 0.8 + rng() * 4.4 + fastHint,
      driftAmp: 6 + rng() * 26,
      bobPx: rng() * 9,
      trail: Math.min(1, 0.05 + rng() * 0.55 + traits.ethereal * 0.08),
      spin: Math.min(1, rng() * 0.4 + traits.cyber * 0.06),
    },
    shape: {
      limbPairs: Math.min(4, Math.max(0, shape.limbPairs + (rng() < 0.3 ? 1 : 0))),
      spineSegments: Math.min(12, Math.max(3, shape.spineSegments + Math.round((rng() - 0.5) * 3))),
      symmetry: shape.symmetry,
    },
    plan: [
      {
        stage: 1,
        name: `${am.char}幼体`,
        note: `${am.body}刚刚展开,轮廓还很单薄`,
        boost: { [t1]: 2 },
        add: { size: 4 + sizeHint, glow: 0.1 },
      },
      {
        stage: 2,
        name: `${TRAIT_MORPH[t1].char}${am.char}`,
        note: `${am.body}上浮出${TRAIT_MORPH[t1].word},开始有了辨识度`,
        boost: { [t1]: 1, [t2]: 2 },
        add: { size: 8, glow: 0.22, trail: 0.12 },
      },
      {
        stage: 3,
        name: `${TRAIT_MORPH[t1].char}极·${am.char}`,
        note: `${TRAIT_MORPH[t2].word}与${TRAIT_MORPH[t3].word}同时显现,完全体`,
        boost: { [t2]: 1, [t3]: 2 },
        add: { size: 12, glow: 0.32, trail: 0.28, spin: 0.12 },
      },
    ],
  }

  // 自检:推导逻辑若与 spec 约束脱节,宁可返回兜底骨架也不产出非法 DNA
  return normalizeDna(dna) ?? normalizeDna(DEFAULT_DNA)!
}

/** 兜底的兜底:连推导都失败时的最小合法 DNA */
export const DEFAULT_DNA: CreatureDna = {
  v: 1,
  name: '灵光',
  archetype: 'orb',
  palette: { body: '#7fe0ff', accent: '#ff5fa2', glow: '#b8f4ff' },
  traits: {
    mechanical: 0,
    organic: 1,
    ethereal: 3,
    fierce: 0,
    cute: 1,
    ancient: 0,
    cyber: 1,
    luminous: 3,
  },
  motion: { flapHz: 2.6, driftAmp: 16, bobPx: 5, trail: 0.3, spin: 0.1 },
  shape: { ...ARCHETYPE_SHAPE.orb },
  plan: [
    { stage: 1, name: '灵光幼体', note: '光点聚成一小团', boost: { luminous: 2 }, add: { size: 4, glow: 0.1 } },
    { stage: 2, name: '辉光体', note: '外层出现流动的光壳', boost: { ethereal: 2 }, add: { size: 8, glow: 0.2, trail: 0.12 } },
    { stage: 3, name: '曜极灵光', note: '周围环绕着碎裂的光尘', boost: { cyber: 2 }, add: { size: 12, glow: 0.3, trail: 0.3, spin: 0.1 } },
  ],
}

/** 供 demo / 预置用的一组描述 */
export const PRESET_DESCRIPTIONS = [
  '一只赛博朋克风格的机械蝴蝶,翅脉里流淌着蓝光',
  '深海中发光的巨型水母,触手像数据流一样飘动',
  '远古森林里一只长着金属鳞片的幼龙',
  '可爱的圆滚滚小狐狸,尾巴上有星尘',
  '一团会呼吸的光球,表面有古老的纹路',
  '钢铁浇铸的甲虫机器人,六条腿闪着橙色指示灯',
] as const

/**
 * 描述与 DNA 的词面契合度 0..1。
 *
 * `score.ts` 的「原型契合」分项用它,词表与 `fallbackDna` 共用 —— 所以程序推导出的
 * DNA 天然高分,而 LLM 生成的高分说明它真把描述里的词用上了。抓的是「原型选错」
 * 这类硬伤,不做语义理解。
 */
export function keywordMatch(descr: string, dna: CreatureDna): number {
  const text = (descr ?? '').trim()
  if (!text) return 0

  // 原型命中:命中描述里总字数的比例(不是命中词数,避免长描述被稀释)
  const archHit = count(text, ARCHETYPE_WORDS[dna.archetype])
  const archScore = normHit(archHit, Math.max(4, text.length * 0.12))

  // 特质命中:命中的轴越多越像
  const traitHit = TRAIT_AXES.filter((a) => dna.traits[a] > 0 && count(text, TRAIT_WORDS[a]) > 0)
  const traitScore = traitHit.length / 4

  // 三色里若描述直接点名了某个色相词,算加分(灯下钳/银/金…)
  const colorHit = COLOR_WORDS.some((w) => text.includes(w)) ? 1 : 0

  return Math.min(1, 0.5 * archScore + 0.38 * Math.min(1, traitScore) + 0.12 * colorHit)
}

const COLOR_WORDS = ['蓝', '红', '绿', '金', '银', '紫', '青', '橙', '白', '黑', '粉', '霓虹']

/** 把「命中字符数」折算成 0..1 的命中强度,`cap` 约等于「多长才算描述清楚了」 */
function normHit(hit: number, cap: number): number {
  if (cap <= 0) return 0
  return Math.min(1, hit / cap)
}
