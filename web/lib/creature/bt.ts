/**
 * Davidson Bradley–Terry:把**成对偏好**聚合成每个对象的强度分。
 *
 * 为什么需要它、而不是「让裁判直接掷一个 0~100」:
 *
 *  视觉/语言模型直接打点分(pointwise)天生**向中间塌缩** —— 一堆样本全挤在
 *  6~8 分,排序信息几乎为零(这正是本仓库 `heur` 一路在打的那场仗)。而**成对比较**
 *  只问「A 和 B 哪个好」,模型答这个的稳定性远高于答「这值几分」;研究也反复显示
 *  「成对偏好 + BT 聚合」在弱裁判下比直接打分稳健得多(CapArena / Correct Looks
 *  Better 等)。
 *
 *  所以 `/lab/judge` 的裁判协议是**成对**的,这个文件负责把「谁赢谁」聚合成分数。
 *
 * ## 模型
 *
 * Bradley–Terry 假设 P(i 胜 j) = πᵢ / (πᵢ + πⱼ),π 是待估强度。基础版**不建模平局**,
 * 但跟 A/B 一样好的「平局」是真会出现的、且信息量为零,丢掉可惜、当胜负又错。
 * 用 Davidson 扩展显式建模:
 *
 *     P(i 胜 j) ∝ πᵢ
 *     P(j 胜 i) ∝ πⱼ
 *     P(平局)   ∝ ν·√(πᵢ·πⱼ)
 *
 * ν 是「平局倾向」参数(ν 越大越容易判平)。用 MM(Minorization–Maximization)迭代
 * 估 π ——这是 BT 系列的标准解法,单调收敛,不需要任何依赖。
 *
 * ## 为什么不用 Elo
 *
 * Elo 是在线(逐场更新、对顺序敏感)的;我们是**离线一批**一次性算,BT 的
 * 极大似然更合适,也天然给出「相对强度」而非「历史积分」。上线的「锚定」版本
 * 才需要把锚点池的 BT 分与增量样本对齐,那是后续阶段。
 *
 * 全部为纯函数、确定性:同样的输入必然同样的输出,可单测。
 */

/** 一场比较的结局(站在 `a` 的角度) */
export type PairOutcome = 'a' | 'b' | 'tie'

export interface PairResult {
  a: string
  b: string
  outcome: PairOutcome
}

export interface BtOptions {
  /** MM 迭代轮数。默认 300,够到收敛;确定性,不依赖随机初值 */
  iters?: number
  /** 平局倾向 ν 的初始值。越大越倾向解释成平局。默认 1 */
  nu?: number
  /**
   * ν 是否也参与估计。默认 true。
   * 固定成 false 时 ν 恒为初值 —— 用于「我已经知道这批平局率该多高」的对照。
   */
  fitNu?: boolean
}

export interface BtResult {
  /** 每个 id 的强度分,已归一到 `[0,1]`(最高=1,最低=0)。个数不足或全平时为 {id:0.5} */
  score: Record<string, number>
  /**
   * 未归一化的对数强度 θ=log π(BT 的规范输出)。
   * 为什么两个都给:`score` 的 min-max 在「接近全序」时会因强度指数级拉开而挤成
   * 0/0/0/1 的样子,看着刺眼;ρ 是**秩相关**、只看名次,用哪个都一样。
   * θ 保留真实间距,做图/诊断更合适。
   */
  theta: Record<string, number>
  /** Davidson 的平局倾向参数(拟合后) */
  nu: number
  /** 参与比较的 id(按出现顺序去重) */
  ids: string[]
  /** 每只的胜/负/平计数,用于诊断「是不是判得太随机」 */
  record: Record<string, { win: number; loss: number; tie: number }>
  /** 每次迭代的对数似然,末项是最终值。用于判断是否收敛 */
  logLik: number[]
}

/**
 * 拟合 Davidson BT。
 *
 * `ids` 显式传入是为了把**没赢过/没出场**的样本也纳入(否则它们会被漏掉、
 * 在结果里显示成默认值)。不在 `pairs` 里出现的 id 拿中性 0.5。
 */
export function fitBradleyTerry(
  ids: readonly string[],
  pairs: readonly PairResult[],
  opts: BtOptions = {},
): BtResult {
  const uniq = [...new Set(ids)]
  const iters = Math.max(1, Math.floor(opts.iters ?? 300))
  let nu = Math.max(1e-6, opts.nu ?? 1)
  const fitNu = opts.fitNu ?? true

  const record: Record<string, { win: number; loss: number; tie: number }> = {}
  for (const id of uniq) record[id] = { win: 0, loss: 0, tie: 0 }

  // 只保留两端都在样本里的比较
  const valid = pairs.filter((p) => p.a !== p.b && record[p.a] && record[p.b])
  for (const p of valid) {
    if (p.outcome === 'a') {
      record[p.a]!.win++
      record[p.b]!.loss++
    } else if (p.outcome === 'b') {
      record[p.b]!.win++
      record[p.a]!.loss++
    } else {
      record[p.a]!.tie++
      record[p.b]!.tie++
    }
  }

  // 强度初值:全 1。用 **log 参数化** θ=log π,再对对数似然做梯度上升 —— 相比
  // Davidson 的 MM 更新,这个更直接、且便于保证「似然不降」(小步长 + 保底不后退)。
  // 只识别相对强度,每步后把 θ 中心化到均值 0。
  const theta: Record<string, number> = {}
  for (const id of uniq) theta[id] = 0

  const logLik: number[] = []
  const eps = 1e-12
  const step = 0.5

  for (let it = 0; it < iters; it++) {
    const pi = (id: string) => Math.exp(theta[id]!)

    // 梯度 ∂LL/∂θ 与 ν 的 MM 分子,全部基于**当前** θ
    const grad: Record<string, number> = {}
    for (const id of uniq) grad[id] = 0
    let sumSqrtWeight = 0
    let nTie = 0

    for (const p of valid) {
      const pai = pi(p.a)
      const pbj = pi(p.b)
      const s = Math.sqrt(pai * pbj)
      const d = Math.max(eps, pai + pbj + nu * s)
      // 对 πᵢ 的有效强度项(平局时 ν 贡献一半)
      const ci = pai + 0.5 * nu * s
      const cj = pbj + 0.5 * nu * s
      if (p.outcome === 'a') {
        grad[p.a]! += 1 - ci / d
        grad[p.b]! += -cj / d
      } else if (p.outcome === 'b') {
        grad[p.b]! += 1 - cj / d
        grad[p.a]! += -ci / d
      } else {
        grad[p.a]! += 0.5 - ci / d
        grad[p.b]! += 0.5 - cj / d
        sumSqrtWeight += s / d
        nTie++
      }
    }
    // ν 的更新是标准 MM 步(与 π 的梯度解耦,基于同一份旧 π)
    const nextNu = fitNu && nTie > 0 ? Math.max(1e-6, sumSqrtWeight / nTie) : nu

    // 保底不后退:试走一步(含 ν 更新),似然不升就缩步长;缩到很小仍不升则认为已收敛
    const before = logLikelihood(uniq, valid, mapPi(uniq, theta), nu)
    let eta = step
    let accepted = false
    for (let tryN = 0; tryN < 12; tryN++) {
      const trial: Record<string, number> = {}
      for (const id of uniq) trial[id] = theta[id]! + eta * grad[id]!
      center(uniq, trial)
      const ll = logLikelihood(uniq, valid, mapPi(uniq, trial), nextNu)
      if (ll >= before - 1e-12) {
        for (const id of uniq) theta[id] = trial[id]!
        nu = nextNu
        accepted = true
        break
      }
      eta *= 0.5
    }
    logLik.push(logLikelihood(uniq, valid, mapPi(uniq, theta), nu))
    if (!accepted) break
  }
  const pi: Record<string, number> = mapPi(uniq, theta)

  // 归一到 0..1(最高 1 最低 0)。全等时给 0.5,避免除零。
  // ⚠ **完全没出场**的样本单独给 0.5:min-max 会把它们随意落在中间某处,
  //   那不是「中性」,是「碰巧」—— 而我们明确承诺过没比较过的拿中性。
  const appeared = new Set<string>()
  for (const p of valid) {
    appeared.add(p.a)
    appeared.add(p.b)
  }
  const vals = uniq.filter((id) => appeared.has(id)).map((id) => pi[id]!)
  const lo = vals.length ? Math.min(...vals) : 0
  const hi = vals.length ? Math.max(...vals) : 0
  const score: Record<string, number> = {}
  for (const id of uniq) {
    score[id] = !appeared.has(id)
      ? 0.5
      : hi - lo < 1e-9
        ? 0.5
        : (pi[id]! - lo) / (hi - lo)
  }

  return { score, theta, nu, ids: uniq, record, logLik }
}

function mapPi(ids: readonly string[], theta: Record<string, number>): Record<string, number> {
  const pi: Record<string, number> = {}
  for (const id of ids) pi[id] = Math.exp(theta[id] ?? 0)
  return pi
}

/** 把 log 强度中心化到均值 0(消掉 BT 的自由平移) */
function center(ids: readonly string[], theta: Record<string, number>): void {
  if (!ids.length) return
  const mean = ids.reduce((a, id) => a + (theta[id] ?? 0), 0) / ids.length
  for (const id of ids) theta[id] = (theta[id] ?? 0) - mean
}

function logLikelihood(
  _ids: readonly string[],
  pairs: readonly PairResult[],
  pi: Record<string, number>,
  nu: number,
): number {
  const eps = 1e-12
  let ll = 0
  for (const p of pairs) {
    const sp = Math.sqrt(pi[p.a]! * pi[p.b]!)
    const d = Math.max(eps, pi[p.a]! + pi[p.b]! + nu * sp)
    if (p.outcome === 'a') ll += Math.log(Math.max(eps, pi[p.a]! / d))
    else if (p.outcome === 'b') ll += Math.log(Math.max(eps, pi[p.b]! / d))
    else ll += Math.log(Math.max(eps, (nu * sp) / d))
  }
  return ll
}

/**
 * 把一个「双向都问过」的成对裁决合并成一条。
 *
 * 位置偏差(模型总偏好第一个)是 VLM 裁判的头号偏差。做法:同一个 pair 按
 * (A,B) 和 (B,A) 各问一次,**只采信两次一致的结论**;不一致 = 这只 pair 判不动,
 * 记为 `tie`(信息量最低,但至少不引入方向性的假信号),并把分歧计数报出来。
 *
 * @returns outcome 站在 `a` 的角度;`disagreed` 标记两次不一致
 */
export function reconcilePair(a: string, b: string, ab: PairOutcome, ba: PairOutcome): {
  outcome: PairOutcome
  disagreed: boolean
} {
  // (A,B) 问出 'a' 且 (B,A) 问出 'b' → 两次都指向 a(因为第二次的 'b' 就是 a)
  const first = ab
  const secondAsA: PairOutcome = ba === 'a' ? 'b' : ba === 'b' ? 'a' : 'tie'
  if (first === secondAsA) return { outcome: first, disagreed: false }
  // 任一次判平、或两次指向相反 → 退化为平局
  return { outcome: 'tie', disagreed: true }
}
