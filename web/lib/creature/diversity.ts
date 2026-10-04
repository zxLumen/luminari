/**
 * 批次多样性 / 新颖度 —— 对齐 PCG Benchmark 的 `quality / diversity / controllability`
 * 三件套里缺的 `diversity`,以及 novelty search 那套「最近邻距离」口径。
 *
 * 为什么单独一个文件、而不是给 `score.ts` 加第八维:
 *
 * **新颖度本质是批次相对量。**「这只够不够独特」只有放进同一批里问才有意义 ——
 * 一只考拉放进 30 只考拉里毫无特色,放进 30 只外星生物里就是最突出的那只。
 * `heuristicScore(dna, descr)` 是**单只**函数,被首页、`/lab/species`、榜单和入库
 * 路径共用;往里塞一个依赖「同批其它个体」的项,会让同一个分数在不同上下文里
 * 含义不同,还直接把那条管线搞成 O(n²)。所以这里独立算,页面把它当**批级参照**
 * 展示,不进 `ScoreBreakdown.total`。
 *
 * 三个口径,各管一件事:
 *
 *  1. `novelty`  —— 每只到**最近邻**的距离(PCG / novelty search 标准做法)。
 *     只看最近邻是关键:它回答「有没有和它撞的」,而不是「和平均差多远」。
 *     一批里两小簇互不干扰时均值会好看,但每只的最近邻都很近 —— 用均值就会骗人。
 *  2. `diversity` —— **两两**距离达标的比例。它对「一小撮 + 一堆孤点」是稳健的,
 *     正好补上一条的盲区。
 *  3. `coverage`  —— 特征空间占用率(原型 × 色相桶的格子)。回答「这批用掉了几种
 *     可能性」,比距离类指标更接近人说的「不像都从一个模子刻的」。
 *
 * 额外给 `dims`(各特征组的批内离散度)。距离类指标只告诉你「不够多样」,
 * 不告诉你**哪一维没在变** —— 实践中动效参数最容易整批雷同,而这个字段能直接指出来。
 *
 * 全部确定性、零成本、可复现:算的是 DNA 本身,不需要模型也不需要人评。
 */

/* ---------------------------- 特征向量 ---------------------------- */

import { TRAIT_AXES, ARCHETYPES, type CreatureDna } from './spec.js'

/** 动效参数的取值区间(与 spec.ts 的 R_* 一致),归一到 0..1 用 */
const M_RANGE = {
  flapHz: [0.8, 6],
  driftAmp: [6, 36],
  bobPx: [0, 10],
  trail: [0, 1],
  spin: [0, 1],
} as const
const TRAIT_MAX = 5
const SHAPE_RANGE = {
  limbPairs: [0, 4],
  spineSegments: [3, 12],
  symmetry: [0, 1],
} as const

const unit = (v: number, [lo, hi]: readonly [number, number]) =>
  Math.min(1, Math.max(0, (Number(v) - lo) / (hi - lo)))

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16)
  if (!Number.isFinite(n)) return [128, 128, 128]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 只取色相(度)与平均饱和度 —— 色相决定「像不像一家人」,饱和度次要 */
function hueSat(hex: string): [number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    // ⚠ `/6` 必须**包住整个分子**。写成 `(b - r) / d + 2 / 6` 会让绿色主色的色相
    // 跑到 -0.67~1.17(而不是 0.167~0.5),蓝色主色同理 —— 结果是负色相与 >360 的
    // 色相流进直方图与覆盖率分桶,把「色相离散度」抬到 1 以上(理论上界是 1)。
    // `score.ts` 的 `rgbToHsl` 三支都是对的,这里是照抄时漏了括号。
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  const l = (max + min) / 2
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min)
  // 兜底夹到 [0,360):分母 d 是浮点,边界色(#00ff00 之类)可能被推出区间一点点
  return [Math.min(359.999, Math.max(0, h * 360)), s]
}

/** 环形色相距离 0..180(0° 与 360° 是同一个颜色,不能当差 360) */
function hueDist(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2) % 360
  return d > 180 ? 360 - d : d
}

interface Feat {
  archetype: string
  hue: [number, number, number]
  sat: number
  traits: number[]
  motion: number[]
  shape: number[]
}

function featOf(dna: CreatureDna): Feat {
  const pal = [dna.palette.body, dna.palette.accent, dna.palette.glow]
  const hs = pal.map(hueSat)
  return {
    archetype: dna.archetype,
    hue: [hs[0]![0], hs[1]![0], hs[2]![0]],
    sat: (hs[0]![1] + hs[1]![1] + hs[2]![1]) / 3,
    traits: TRAIT_AXES.map((a) => unit(dna.traits[a], [0, TRAIT_MAX])),
    motion: [
      unit(dna.motion.flapHz, M_RANGE.flapHz),
      unit(dna.motion.driftAmp, M_RANGE.driftAmp),
      unit(dna.motion.bobPx, M_RANGE.bobPx),
      unit(dna.motion.trail, M_RANGE.trail),
      unit(dna.motion.spin, M_RANGE.spin),
    ],
    shape: [
      unit(dna.shape.limbPairs, SHAPE_RANGE.limbPairs),
      unit(dna.shape.spineSegments, SHAPE_RANGE.spineSegments),
      unit(dna.shape.symmetry, SHAPE_RANGE.symmetry),
    ],
  }
}

/**
 * 各特征组的权重。
 *
 * 视觉上「像不像同一批货」主要由原型 + 色相决定,其次是躯体质感(特质/形状),
 * 动效最弱。数值是拍的,但量级关系有依据:换原型是最大的跳变,色相次之,
 * 动效参数即使全不同、渲染出来往往也还是同一只生物在动。
 */
const W_ARCH = 1.0
const W_HUE = 1.0
const W_SAT = 0.4
const W_TRAITS = 1.2
const W_MOTION = 0.8
const W_SHAPE = 0.9

const meanSqDiff = (a: readonly number[], b: readonly number[]) => {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!
    s += d * d
  }
  return s / Math.max(1, a.length)
}

/** 两只的特征距离(相对量纲,典型落在 0..1.5) */
function featDist(a: Feat, b: Feat): number {
  const arch = a.archetype === b.archetype ? 0 : 1
  let hue = 0
  for (let i = 0; i < 3; i++) hue += (hueDist(a.hue[i]!, b.hue[i]!) / 180) ** 2
  hue /= 3
  const sat = a.sat - b.sat
  return Math.sqrt(
    W_ARCH * arch * arch +
      W_HUE * hue +
      W_SAT * sat * sat +
      W_TRAITS * meanSqDiff(a.traits, b.traits) +
      W_MOTION * meanSqDiff(a.motion, b.motion) +
      W_SHAPE * meanSqDiff(a.shape, b.shape),
  )
}

/* ---------------------------- 阈值 ---------------------------- */

/**
 * 绝对新颖度的归一化基准。
 *
 * 用固定值而不是「批内最大距离」:后者会让一批**整体雷同**的样本看起来很新颖
 * —— 全都挤在一起时,离最远那个的距离也会变大。绝对基准才有「这批到底够不够散」
 * 这个跨批可比的含义。
 */
const NOVELTY_REF = 0.55

/** 两两距离超过它就算「这一对有区别」 */
const PAIR_OK = 0.4

/** 归一化色相桶数(覆盖率的格子粒度) */
const HUE_BINS = 6

/* ---------------------------- 对外 ---------------------------- */

export interface DiversityPerItem {
  /** 到最近邻的距离(与输入同下标;批次只有 1 只时为 null) */
  nn: number | null
  /** 到次近邻的距离。用来区分「孤点」与「一小簇里的一只」 */
  nn2: number | null
  /** 最近邻在批次里的下标;批次只有 1 只时为 -1 */
  nnIdx: number
  /** 0..1 的绝对新颖度 = `nn / NOVELTY_REF` 截断 */
  novelty: number
}

export interface DimSpread {
  key: string
  label: string
  /** 0..1:该特征组在批内的标准差(已按 0..1 归一前的量纲) */
  spread: number
}

export interface DiversityReport {
  perItem: DiversityPerItem[]
  /** 批次平均新颖度 0..1 */
  meanNovelty: number
  /** 0..1:两两距离达标的比例 */
  diversity: number
  /** 0..1:占用的(原型 × 色相桶)格子数 / 可用格子数 */
  coverage: number
  occupied: number
  cells: number
  /** 最挤的一对 —— 「多样性低」时先看这里,能直接看出是撞了什么 */
  closest: { a: number; b: number; dist: number } | null
  /** 各特征组的批内离散度:哪一维其实整批没在变 */
  dims: DimSpread[]
  /** 12 桶色相直方图(按主体色),看配色是不是全挤在一侧 */
  hueHistogram: number[]
}

function stdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((acc, v) => acc + (v - m) ** 2, 0) / xs.length)
}

/**
 * 算一批 DNA 的多样性 / 新颖度。
 *
 * 空批返回各项为 0 的报告;单只时 `nn` 为 `null`、`closest` 为 `null`
 * (没有邻居可比),但 `diversity` 会按「无可比较的对」记为 0。
 */
export function diversityOf(dnas: readonly CreatureDna[]): DiversityReport {
  const n = dnas.length
  const empty: DiversityReport = {
    perItem: [],
    meanNovelty: 0,
    diversity: 0,
    coverage: 0,
    occupied: 0,
    cells: 0,
    closest: null,
    dims: [],
    hueHistogram: [],
  }
  if (!n) return empty

  const feats = dnas.map(featOf)

  /* 1) 全距离矩阵(批级比较,O(n²) 但 n 只有几十) */
  const dist: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = featDist(feats[i]!, feats[j]!)
      dist[i]![j] = d
      dist[j]![i] = d
    }
  }

  /* 2) 每只的最近邻与次近邻 */
  const perItem: DiversityPerItem[] = []
  let nnSum = 0
  for (let i = 0; i < n; i++) {
    if (n < 2) {
      perItem.push({ nn: null, nn2: null, nnIdx: -1, novelty: 0 })
      continue
    }
    let b1 = Infinity
    let b2 = Infinity
    let b1i = -1
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const d = dist[i]![j]!
      if (d < b1) {
        b2 = b1
        b1 = d
        b1i = j
      } else if (d < b2) {
        b2 = d
      }
    }
    const novelty = Math.min(1, b1 / NOVELTY_REF)
    nnSum += novelty
    perItem.push({ nn: b1, nn2: n < 3 ? null : b2, nnIdx: b1i, novelty })
  }

  /* 3) 两两达标比例 */
  let pairs = 0
  let okPairs = 0
  let closest: DiversityReport['closest'] = null
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs++
      const d = dist[i]![j]!
      if (d >= PAIR_OK) okPairs++
      if (!closest || d < closest.dist) closest = { a: i, b: j, dist: d }
    }
  }

  /* 4) 覆盖率:原型 × 主体色相桶 */
  const cells = ARCHETYPES.length * HUE_BINS
  const used = new Set<string>()
  const hueHistogram = new Array<number>(12).fill(0)
  for (let i = 0; i < n; i++) {
    const h = feats[i]!.hue[0]!
    const bin = Math.min(HUE_BINS - 1, Math.max(0, Math.floor((h / 360) * HUE_BINS)))
    used.add(`${feats[i]!.archetype}#${bin}`)
    hueHistogram[Math.min(11, Math.max(0, Math.floor((h / 360) * 12)))]++
  }

  /* 5) 各维离散度:直接指出「哪一维整批没在变」 */
  const dims: DimSpread[] = [
    { key: 'archetype', label: '原型', spread: archetypeSpread(feats) },
    { key: 'hue', label: '色相', spread: stdDev(feats.map((f) => f.hue[0]! / 180)) },
    { key: 'sat', label: '饱和', spread: stdDev(feats.map((f) => f.sat)) },
    { key: 'traits', label: '特质', spread: avgSpread(feats.map((f) => f.traits)) },
    { key: 'motion', label: '动效', spread: avgSpread(feats.map((f) => f.motion)) },
    { key: 'shape', label: '形状', spread: avgSpread(feats.map((f) => f.shape)) },
  ]

  return {
    perItem,
    meanNovelty: n < 2 ? 0 : nnSum / n,
    diversity: pairs ? okPairs / pairs : 0,
    coverage: Math.min(1, used.size / cells),
    occupied: used.size,
    cells,
    closest,
    dims,
    hueHistogram,
  }
}

/** 原型是分类变量,用「归一化香农熵」当离散度(1 = 八种原型均匀铺开) */
function archetypeSpread(feats: readonly Feat[]): number {
  const counts = new Map<string, number>()
  for (const f of feats) counts.set(f.archetype, (counts.get(f.archetype) ?? 0) + 1)
  const total = feats.length
  let h = 0
  for (const c of counts.values()) {
    const p = c / total
    h += p * Math.log(p)
  }
  return Math.min(1, -h / Math.log(ARCHETYPES.length))
}

/** 一个特征组内部各维标准差的平均 */
function avgSpread(groups: readonly number[][]): number {
  if (!groups.length) return 0
  const width = groups[0]!.length
  let s = 0
  for (let k = 0; k < width; k++) s += stdDev(groups.map((g) => g[k]!))
  return s / Math.max(1, width)
}
