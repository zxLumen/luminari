/**
 * 评分校准 —— 把「机器打的分」和「我的评价」放一起,算出**每一维**各自有多少可信度。
 *
 * ## 为什么必须逐维算
 *
 * 原来页面只报一个总分一致度。那个数字有个致命的毛病:**它可以是正的,而里面好几维
 * 其实是纯噪声**。举例:总分的名次由权重高的几维(`fidelity` 20 + `structure` 15)
 * 主导,于是哪怕 `narrative`(权重 8)完全在瞎报,总分相关照样漂亮 —— 高权重的
 * 维度把低权重的噪声**掩盖**掉了。看到「一致度 78%」就以为七个维度都在工作,
 * 是这个指标最常见的误读。
 *
 * 逐维相关就是为了拆掉这层掩盖:每一维单独对人工评价算一次相关,谁在干活、谁在划水
 * 一目了然。**权重大不代表这一维有信息量**,只有 ρ 能说明。
 *
 * ## 为什么用 Spearman 而不是 Pearson
 *
 * 人工评价是**有序三档**(棒 / 还行 / 差),不是等距的连续量 —— 「棒到还行」和「还行到差」
 * 未必是同样的一步。Pearson 假设线性等距,在这里会给出偏乐观的相关。Spearman 只看
 * 名次,对档位的间距完全不敏感,是评价这种有序标注的标准选择。
 *
 * ## 样本量的诚实说明
 *
 * ρ 的置信区间随 n 急剧变宽:n=6 时 ρ=0.9 也可能纯属噪声。所以 `rhoOf()` 在 n < 8 时
 * 返回 `null` 而不是硬给一个数字 —— **宁可不报,也不报一个会被当成结论的假数字**。
 * 页面据此显示「样本不足」,并提示至少评满 8 只。
 *
 * 全部确定性、零成本:只需要已经算好的分数和人工评价,不额外调模型。
 */

import { AXIS_OF, CRAFT_WEIGHTS, APPEAL_WEIGHTS, type ScoreBreakdown, type ScoreKey } from './score.js'

/** 少于这个数不给 ρ —— n=3~7 的相关系数波动大到没有参考价值 */
export const MIN_N_FOR_RHO = 8

/**
 * 评分维度键,按轴分组(页面展示顺序)。
 *
 * ⚠ 拆成 craft/appeal 两轴后,`WEIGHTS[key]` 不再是单一数字 —— 一维的权重只在
 * **它所属的轴内**有意义。所以这里改成存 `{ axis, weight }`,页面要分开显示,
 * 别把两轴的权重加到一起(那正是这一版要拆掉的东西)。
 */
export const DIM_KEYS = [
  'fidelity',
  'structure',
  'palette',
  'motion',
  'narrative',
  'match',
  'traits',
  'silhouette',
  'face',
  'colorPop',
  'motionRich',
] as const
export type DimKey = (typeof DIM_KEYS)[number]

/** 平均秩(并列取平均),Spearman 的第一步 */
function ranksOf(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const)
  idx.sort((a, b) => a[0] - b[0])
  const out = new Array<number>(xs.length)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++
    // 并列段 [i, j] 共享同一个平均秩
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[idx[k]![1]] = avg
    i = j + 1
  }
  return out
}

/**
 * Spearman 秩相关 ρ,范围 -1..1。
 *
 * 返回 `null` 的三种情况,都有明确理由,**不要**把它们当成 0:
 *  - 样本少于 `minN`:小样本的 ρ 方差太大,报出来会被误读成结论;
 *  - 任一侧全为同一个值(没有方差):分母为 0,数学上无定义 —— 例如全批都被打了「棒」,
 *    此时「和评价的相关」这个问题本身就没有答案;
 *  - 含非有限值:脏数据,宁可不算。
 */
export function rhoOf(
  xs: readonly number[],
  ys: readonly number[],
  minN = MIN_N_FOR_RHO,
): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < minN) return null
  const a = xs.slice(0, n)
  const b = ys.slice(0, n)
  if (a.some((v) => !Number.isFinite(v)) || b.some((v) => !Number.isFinite(v))) return null

  const rx = ranksOf(a)
  const ry = ranksOf(b)
  const mx = rx.reduce((s, v) => s + v, 0) / n
  const my = ry.reduce((s, v) => s + v, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const u = rx[i]! - mx
    const v = ry[i]! - my
    num += u * v
    dx += u * u
    dy += v * v
  }
  // 某一侧完全没有方差 → 分母 0
  if (dx <= 0 || dy <= 0) return null
  return Math.max(-1, Math.min(1, num / Math.sqrt(dx * dy)))
}

/** 分位数(线性插值),用于「分布」而不是只有一个均值 */
function quantileOf(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/** 一组数的分布摘要。只报均值会把「一半 90 一半 40」和「全 65」混为一谈。 */
export interface Dist {
  n: number
  min: number
  p25: number
  median: number
  p75: number
  max: number
  avg: number
}

export function distOf(xs: readonly number[]): Dist | null {
  const s = xs.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (!s.length) return null
  return {
    n: s.length,
    min: s[0]!,
    p25: quantileOf(s, 0.25),
    median: quantileOf(s, 0.5),
    p75: quantileOf(s, 0.75),
    max: s[s.length - 1]!,
    avg: s.reduce((a, b) => a + b, 0) / s.length,
  }
}

/** 一维的校准结果 */
export interface DimCalib {
  key: DimKey
  /** 该维属于哪个轴 —— 权重只在轴内可比 */
  axis: 'craft' | 'appeal'
  /** 该维在**所属轴内**的权重(仅供对照:权重 ≠ 可信度) */
  weight: number
  /** 与人工评价的秩相关;null = 样本不足或无方差 */
  rho: number | null
  /** 这一维分数本身的分布 */
  dist: Dist | null
}

export interface Calibration {
  /** 参与计算的有效样本数(已评价且有分数) */
  n: number
  /** 是否已够 `MIN_N_FOR_RHO` —— 页面据此提示还差几只 */
  enough: boolean
  /**
   * 本批的「与 0 不可区分」判定线(|ρ| 小于它才算死重),≈ `1.96/√(n-3)`。
   * 必须显示出来 —— 一个随样本量漂移的门限,不说明来源就会被当成随手拍的常数。
   */
  cut: number
  perDim: DimCalib[]
  /** 总分与人工评价的相关。放在 perDim 之外:它是**加权合成**的结果,不是某一维 */
  total: { rho: number | null; dist: Dist | null }
  /** 两轴各自与人工评价的相关。合成之前先看轴,才知道问题出在哪一侧 */
  axes: { craft: { rho: number | null }; appeal: { rho: number | null } }
  /**
   * 「权重大但 ρ≈0」的维 —— **这些维正在稀释总分**。
   * 把它们降权或删掉,总分才会开始反映真实观感。这是逐维分析唯一真正可执行的动作。
   */
  deadWeight: DimCalib[]
}

export interface RatedRow {
  score: ScoreBreakdown
  /** 人工评价,越大越好(棒=2 / 还行=1 / 差=0),**有序** */
  rating: number
}

/** 取某一维的分数(兼容嵌套 `dims`) */
function dimOf(row: ScoreBreakdown, key: ScoreKey): number {
  return row.dims?.[key] ?? 0
}

/** 某一维的权重(在它所属的轴内) */
function weightOf(key: ScoreKey): number {
  return (AXIS_OF[key] === 'craft' ? CRAFT_WEIGHTS : APPEAL_WEIGHTS)[key as never] ?? 0
}

/**
 * 「这一维测不出信号」的判定线 —— 随样本量变,不是固定常数。
 *
 * 原来写死 `|ρ| < 0.2` 就报「死重」,是**站不住的**:零相关的 95% 置信半宽约
 * `1.96 / √(n-3)`,n=30 时是 **0.36** —— 也就是说 0.2 这个线**落在噪声带里面**,
 * 会把真有微弱信号的维度一并冤枉;n=10 时该线高达 0.68,又几乎什么都测不出来。
 * 一个阈值不能同时在两端都错,除非它跟着 n 走。
 *
 * 所以这里直接用那个半宽本身当线:|ρ| 小到「与 0 无法区分」才算死重。
 * 这是**保守**方向 —— 宁可少标几个死重,不要冤枉还在干活的维度。
 */
export function deadThreshold(n: number): number {
  if (n < 4) return 1
  return Math.min(1, 1.96 / Math.sqrt(n - 3))
}

export function calibrate(rows: readonly RatedRow[]): Calibration {
  const my = rows.map((r) => r.rating)
  const cut = deadThreshold(rows.length)
  const perDim: DimCalib[] = DIM_KEYS.map((key) => {
    const xs = rows.map((r) => dimOf(r.score, key))
    return {
      key,
      axis: AXIS_OF[key],
      weight: weightOf(key),
      rho: rhoOf(xs, my),
      dist: distOf(xs),
    }
  })

  const total = {
    rho: rhoOf(rows.map((r) => r.score.total), my),
    dist: distOf(rows.map((r) => r.score.total)),
  }

  return {
    n: rows.length,
    enough: rows.length >= MIN_N_FOR_RHO,
    /** 本批的「与 0 不可区分」判定线,页面要显示出来,否则 0.36 看着像个奇怪的门限 */
    cut,
    perDim,
    total,
    axes: {
      craft: { rho: rhoOf(rows.map((r) => r.score.craft), my) },
      appeal: { rho: rhoOf(rows.map((r) => r.score.appeal), my) },
    },
    deadWeight: perDim.filter((d) => d.rho !== null && Math.abs(d.rho) < cut),
  }
}
