/**
 * 维度杠杆分析 —— 「哪一维在真的决定排名,哪一维在白拿权重」。
 *
 * ## 为什么需要它
 *
 * 权重表是**先验判断**,实测表现是**事实**,两者会长期背离。一次真实调参里量到过
 * 这样的分布(6000 条样本,几何平均):
 *
 * ```
 * 维度        权重   权重占比   log 方差份额
 * traits      12    12.8%      57.5%   ← 唯一在猛动
 * match        8     8.5%      20.4%
 * fidelity    20    21.3%      17.8%
 * structure   15    16.0%       2.4%
 * palette     18    19.1%       1.2%
 * motion      13    13.8%       0.3%
 * narrative    8     8.5%       0.3%
 * ```
 *
 * 43/94 的权重扛下了 96% 的区分度,另外 51/94 基本在陪跑。更糟的是**同向性**:
 * 真正在动的 `traits/match/fidelity` 都在看「模型这次有没有听话」,它们同涨同落,
 * 于是批内相对差异被抹平 —— 这正是「所有生物都挤在 60~85」的成因。
 *
 * 只看权重表永远发现不了这件事:每一维单看都「挺合理」,合起来才是死重。
 *
 * ## 为什么能在 log 空间算方差份额
 *
 * 聚合是**加权几何平均**,而几何平均在 log 空间就是加权和:
 *
 * ```
 * ln(total) = Σ (w_k / W) × ln(max(score_k, FLOOR))
 * ```
 *
 * 所以「这一维贡献了多少区分度」有一个精确的答案 —— 它在该式里的加权方差
 * `w_k × Var(ln score_k)`,占总方差的比例就是它的**杠杆份额**。这不是近似,
 * 是同一份公式换个空间读。拿它和**权重份额**对比,就能一眼看出谁在白拿权重。
 *
 * 全部确定性、零成本:只需要已经算好的分数,不额外调模型也不需要人评。
 */

import {
  APPEAL_WEIGHTS,
  CRAFT_WEIGHTS,
  SCORE_DIM_FLOOR,
  type ScoreAxis,
  type ScoreBreakdown,
  type ScoreKey,
} from './score.js'

/** 取某一维的分数(兼容嵌套 `dims` 与旧的扁平结构) */
function dimOf(row: ScoreBreakdown, key: ScoreKey): number {
  const v = (row.dims as Record<string, number> | undefined)?.[key] ?? (row as unknown as Record<string, number>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : SCORE_DIM_FLOOR
}

/** 样本方差(n−1) */
function varianceOf(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
}

function quantileOf(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

export interface LeverageRow {
  key: ScoreKey
  axis: ScoreAxis
  /** 该维在所属轴里的权重 */
  weight: number
  /** 权重占该轴的百分比(0..1) */
  weightShare: number
  /** 杠杆份额:该维占 log 总方差的百分比(0..1) */
  varShare: number
  /**
   * `varShare / weightShare`。**1 = 名副其实**(拿多少权重、给多少区分度);
   * 远小于 1 = 白拿权重(死重);远大于 1 = 权重给少了,它在替别人干活。
   */
  ratio: number
  /** 白拿权重:权重占比够大,却几乎不产生区分度 */
  dead: boolean
  /** p90 − p10。这一维自己的离散度;跨度小 = 平台区 = 挤在一起 */
  spread: number
  /** 该维自己的中位数 */
  median: number
}

/**
 * 死重判定线。
 *
 * ⚠ 这**不是**「这一维没信息」,而是「它拿的权重配不上它的贡献」。两个条件都要满足:
 *  - 权重占比够大(>12%),值得去管;
 *  - 杠杆份额不到同权重应有份额的 **1/3** —— 留 3 倍余量,免得把还在干活的
 *    维度误判成死重(实测里方差份额本身有采样噪声,卡太紧会误伤)。
 */
export const DEAD_WEIGHT_SHARE = 0.12
export const DEAD_WEIGHT_RATIO = 1 / 3

export interface LeverageReport {
  n: number
  perDim: LeverageRow[]
  /** 拿权重却不出活的维。**先降权或砍掉它们,总分才会开始反映真实差异** */
  dead: LeverageRow[]
  /** 杠杆份额最高的一维 —— 批内区分度实际由它主导 */
  top: LeverageRow | null
  /** 各维杠杆份额之和(恒为 1,留作自检) */
  varShareSum: number
}

/**
 * 量一批分数的维度杠杆。
 *
 * ⚠ **结论只在这批样本上成立**。方差份额是**相对**量:如果喂进来一批全都长一个样
 * 的 DNA,那么「所有维度都没区分度」是正确结论,而不是工具坏了。所以它必须搭配
 * 一批**有变化**的样本(真实生成结果,或刻意覆盖参数空间的合成样本)才有意义。
 */
export function leverageOf(rows: readonly ScoreBreakdown[]): LeverageReport | null {
  if (rows.length < 2) return null

  const axes: ScoreAxis[] = ['craft', 'appeal']
  const rowsOut: LeverageRow[] = []

  for (const axis of axes) {
    // 两轴的权重表类型不同(各自的 `as const` 字面量),这里统一按字符串索引读
    const weights: Record<string, number> =
      axis === 'craft' ? CRAFT_WEIGHTS : APPEAL_WEIGHTS
    const keys = Object.keys(weights) as ScoreKey[]
    const wTotal = keys.reduce((a, k) => a + weights[k]!, 0)

    // 该轴的 log 方差:Σ (w_k/W)·Var(ln s_k)
    const terms = keys.map((k) => {
      const logs = rows.map((r) => Math.log(Math.max(dimOf(r, k), SCORE_DIM_FLOOR)))
      const v = varianceOf(logs)
      const share = (weights[k] / wTotal) * v
      const vals = rows.map((r) => dimOf(r, k)).sort((a, b) => a - b)
      return {
        key: k,
        axis,
        weight: weights[k],
        weightShare: weights[k] / wTotal,
        term: share,
        median: quantileOf(vals, 0.5),
        spread: quantileOf(vals, 0.9) - quantileOf(vals, 0.1),
      }
    })

    const denom = terms.reduce((a, t) => a + t.term, 0)
    for (const t of terms) {
      const varShare = denom > 0 ? t.term / denom : 0
      const ratio = t.weightShare > 0 ? varShare / t.weightShare : 0
      rowsOut.push({
        key: t.key,
        axis: t.axis,
        weight: t.weight,
        weightShare: t.weightShare,
        varShare,
        ratio,
        dead: t.weightShare > DEAD_WEIGHT_SHARE && ratio < DEAD_WEIGHT_RATIO,
        spread: t.spread,
        median: t.median,
      })
    }
  }

  const perDim = rowsOut.sort((a, b) => b.varShare - a.varShare)
  return {
    n: rows.length,
    perDim,
    dead: perDim.filter((r) => r.dead),
    top: perDim[0] ?? null,
    varShareSum: perDim.reduce((a, r) => a + r.varShare, 0),
  }
}
