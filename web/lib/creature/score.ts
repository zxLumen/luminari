/**
 * 确定性打分(`heur`):对 DNA 本身做客观工艺检查,免费、可复现、零抖动。
 *
 * 为什么要它:LLM 评判(`judge`)必然有噪声、有压缩偏差、会抽风。这条管线在**不调模型**
 * 的前提下给出一个稳定的下界,并且和 `judge` 互补 ——
 *  - `heur` 擅长「配色是不是一坨」「动效参数是不是没动/乱闪」「三段成长是不是雷同」
 *    这些**可计算**的问题;
 *  - `judge` 擅长「像不像访客要的那个东西」「独特吗」「成长叙事有无看头」这些
 *    必须理解语义的问题。
 *
 * 所有分项与权重都导出,便于日后调参;排名在读取时算,原始分入库,所以改权重零成本。
 */

import { TRAIT_AXES, TRAIT_LABELS, type CreatureDna } from './spec.js'
import { ARCHETYPE_WORDS, TRAIT_WORDS } from './fallback.js'

/**
 * 权重。
 *
 * 重新分配的依据是 `/lab/score` 上实测的「丰富度提升」(同原型三档,rich 减 sparse):
 * 原来 5 维里 `palette/traits/motion` 三维(共 65 分)**只看 DNA、不看描述**,
 * 所以它们对「描述写得细不细」没有任何反应 —— 实测提升分别是 −0.1 / +0.6 / +0.4,
 * 基本是噪声。把权重往「看得见描述」的方向挪:
 *
 *  - `fidelity`(新,20):唯一直接回答「你有没有听我说话」的一维,而且只在描述
 *    真的点了某类特征时才计入那类,不会被描述长度灌水。
 *  - `structure`(新,15):实测 12 部件和 27 部件的生物分数几乎一样 ——
 *    原来没有一维在看「搭得认不认真」。
 *  - `narrative` 20 → 8:实测它把三段雷同和完全不同的 note 都打 0.63,
 *    区分不出任何东西,**降权但保留**(它对非 blueprint 的 DNA 路径仍然有效)。
 *  - `match` 15 → 8:它有长度效应(描述越长关键词越多越容易命中),
 *    在 rich 档天然占便宜;职责交给 `fidelity` 后降为辅助信号。
 *  - `palette/traits` 是纯确定性工艺检查(真色彩数学、熵与退化检测),
 *    换任何模型都不会失效,保留较高权重。
 */
/**
 * 权重 —— **两个轴,各 100 分**,不再是一张 94 分的平表。
 *
 * ## 为什么要拆
 *
 * 原来七维挤在一张表里,于是「工艺」和「好看」被迫用同一个数字表达。而实测证明
 * 这两件事在真实数据里**高度同向**:它们都被「模型这次发挥好不好」这一个因素
 * 拉动,于是在 log 空间的方差份额里长成这样(6000 条实测):
 *
 * ```
 * traits(权 12) 57.5% · match(权 8) 20.4% · fidelity(权 20) 17.8%
 * structure(15) 2.4% · palette(18) 1.2% · motion(13) 0.3% · narrative(8) 0.3%
 * ```
 *
 * 43/94 的权重扛下 96% 的区分度,剩下 51/94 在陪跑 —— **38% 的权重完全不产生
 * 区分度**。更致命的是那三个真正在动的维度都在看「有没有听话」,同涨同落,批内
 * 相对差异被抹平,于是所有生物挤在 60~85。
 *
 * 拆成两轴之后:
 *  - `craft` 只问「做得对不对」—— 有没有照做、搭得认不认真、会不会抽搐;
 *  - `appeal` 只问「想不想看」—— 有没有性格、有没有脸、剪影有没有意思、动得够不够层次。
 *
 * 两轴各自做几何平均,再相乘。**仍然保留「短板会被等比拉低」这个性质**(任一轴差
 * 都压总分),但 `appeal` 终于有了独立杠杆 —— 好看不再需要「其它都做对」才能拿分。
 *
 * ## 两轴内部各自 100,而不是沿用旧的 82
 *
 * 只改刻度不改比例:craft 沿用旧权重 ×1.22(20:15:18:13:8:8 → 24:18:22:16:10:10),
 * 这样「同轴内谁更重要」的判断完全保留,只是不再跨轴比较绝对数。
 * ⚠ 这是**又一次分数语义变更**,历史分数不可比。
 */
export const CRAFT_WEIGHTS = {
  /** 描述点名的,有没有真长在身上 */
  fidelity: 24,
  /** 搭得认不认真(部件数、角色分工、主体占比) */
  structure: 18,
  /** 配色是不是「设计过」(和谐 + 可读) */
  palette: 22,
  /** 会不会抽搐、通道自不自洽 —— 只管**缺陷规避** */
  motion: 16,
  /** 三段成长有没有分阶段 */
  narrative: 10,
  /** 词面重合(辅助信号,有长度效应) */
  match: 10,
} as const

export const APPEAL_WEIGHTS = {
  /** 有没有性格。重写前的版本在奖励「八根轴全点亮」,见 scoreTraits */
  traits: 24,
  /** 剪影有没有意思(占据范围 + 体量层次) */
  silhouette: 20,
  /** 有没有「脸」—— 生物和色块的分界 */
  face: 18,
  /** 有没有一处在视觉上跳出来的强调色 */
  colorPop: 18,
  /** 是不是多个不同频率的通道在动,而不是整体一起晃 */
  motionRich: 20,
} as const

/** 两个轴。顺序即展示顺序 */
export const SCORE_AXES = ['craft', 'appeal'] as const
export type ScoreAxis = (typeof SCORE_AXES)[number]

export const CRAFT_TOTAL = Object.values(CRAFT_WEIGHTS).reduce((a, b) => a + b, 0)
export const APPEAL_TOTAL = Object.values(APPEAL_WEIGHTS).reduce((a, b) => a + b, 0)

/** 兼容旧调用点:七维时代的那张平表。两轴合并的权重(仅供旧代码 / 对照用) */
export const WEIGHTS = {
  ...CRAFT_WEIGHTS,
  ...APPEAL_WEIGHTS,
} as const

export const WEIGHT_TOTAL = CRAFT_TOTAL + APPEAL_TOTAL

/**
 * 打分版本号。**任何影响分数的改动都必须递增它**(权重、维度算法、地板、AXIS_MIX…)。
 *
 * 为什么需要:榜单是**跨批次**的 —— 访客在不同时间创建生物,分数必须同一把尺子。
 * 一旦打分算法变了,旧分与新分不再可比,拿它们一起排名会把「算法变了」误读成
 * 「生物变好了」。榜单查询一律按 `score_version = SCORE_VERSION` 过滤,旧版本
 * 自然退出榜单(需要时代价是重算,读时算分零迁移)。
 *
 * 版本命名:`<主>.<次>-<改动摘要>`。主号 = 不可比的两轴/算法结构变更。
 */
export const SCORE_VERSION = '2.0-two-axis'

/**
 * 单维地板。
 *
 * 几何平均里任何一维趋 0 都会把整个乘积拖到 0(`traits` 全 0、`match` 完全不命中
 * 都会这样),于是「一项不及格」变成「整只归零」,比线性平均严苛得多、也更容易
 * 变成噪声。实测约 16% 的样本存在某维 < 0.05,不设地板会被这批样本整体压死。
 *
 * 0.08 的含义:一维可以明确地差(拿到 0.08),但不足以单独宣判整只生物的死刑。
 * 取值不能更高 —— 地板定 0.15 时实测 `match`(权重仅 10)有 **44%** 的样本被
 * 抬到同一个值,等于把这一维重新变成常数、抵消几何平均的区分度。地板只该保护
 * 高权重维度不被一击归零:fidelity 归零时总分降到 58%,而 match 归零
 * 只降到 96%,和它的权重相称。
 */
export const SCORE_DIM_FLOOR = 0.08

/**
 * 加权几何平均,返回 0..1。给定权重表(各轴内部用,总和 100)。
 *
 * 为什么不用加权算术平均:**算术平均会让「单项灾难」被其余六维平均掉**。
 * 一只配色糟糕、结构潦草、动效抽搐的生物,只要 traits/narrative 还在线,
 * 算术平均照样能拿 70+ —— 这正是实测「所有生物都挤在 70~90」的成因。
 *
 * 几何平均在 log 空间是线性的,等价于「任一维掉下去都会等比地拉低总分」,
 * 短板无法被掩盖。
 *
 * 配 `SCORE_DIM_FLOOR` 一起用:地板保证不会归零,几何平均保证短板不被掩盖。
 */
export function weightedGeometricMean(
  parts: Record<string, number>,
  weights: Record<string, number>,
): number {
  const keys = Object.keys(weights) as ScoreKey[]
  const total = keys.reduce((a, k) => a + weights[k]!, 0)
  if (total <= 0) return 0
  let sum = 0
  for (const k of keys) {
    const w = weights[k]! / total
    sum += w * Math.log(Math.max(parts[k] ?? 0, SCORE_DIM_FLOOR))
  }
  return clamp01(Math.exp(sum))
}

/**
 * 两轴相乘合成总分。
 *
 * 用**相乘**而不是加权平均:相乘保留了「任一轴差就等比压低总分」的性质
 * —— 一只极其好看但完全没照描述做的生物,`appeal` 0.9 × `craft` 0.45 仍然上不去;
 * 而加权平均会让好看把「没做对」平均掉,那正是「好看却低分」的另一种形式。
 *
 * 指数 0.6 / 0.4 表示 `craft` 略主导(它更客观、更可复现,`appeal` 里有几维还
 * 缺人工验证),但**远不到**「必须两边都好才好看」的程度。
 */
export const AXIS_MIX = { craft: 0.6, appeal: 0.4 } as const

export function combineAxes(craft: number, appeal: number): number {
  const c = clamp01(craft)
  const a = clamp01(appeal)
  return clamp01(Math.pow(c, AXIS_MIX.craft) * Math.pow(a, AXIS_MIX.appeal))
}

/* ---------------------------- 颜色工具 ---------------------------- */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16)
  if (!Number.isFinite(n)) return [128, 128, 128]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return [h * 360, s, l]
}

const hsl = (hex: string) => {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHsl(r, g, b)
}

/** 相对亮度(WCAG) */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度 1..21 */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** 色相夹角距离 0..180 */
function hueDist(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2) % 360
  return d > 180 ? 360 - d : d
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const norm = (n: number) => clamp01(n)

/* ---------------------------- 五项检查 ---------------------------- */

/**
 * 配色**工艺** 0..1 —— 属于 `craft` 轴:和谐 + 可读,不评冲击力。
 *
 * ⚠ 它**故意不评「好看」**。「好不好看」里很大一部分是张力 / 记忆点,那是
 * `scoreColorPop`(appeal 轴)的活。这一维只问两件 objectively 可判的事:
 * 配色是不是设计过的(和谐),以及看不看得清(分离度、主体亮度)。
 *
 * ## 收紧的三个地方(实测 72% 的样本 ≥0.80,p10 只有 0.66 —— 平台区太宽)
 *
 *  1. **和谐带宽 45° → 28°**。原来 45° 的容差太宽,随便两色都算「成谱」,于是
 *     这一项几乎恒为满分,是 palette 拉不开差距的主因。
 *  2. **饱和度不再用单峰**。原来打「离 0.7 有多远」,等于把「稍微淡一点」和
 *     「死灰」判成同一种罪。改成**区间**:太低(死灰)扣、太高(塑料)扣、中间给满分。
 *  3. **主体亮度改成双峰**。原来单峰在 L=0.6,于是一张刻意做暗的设计(L≈0.25,
 *     在深色主题里非常出彩)会被判成「太暗」。真正难看清的是**中等亮度的灰调**
 *     —— 暗和亮都看得见,灰蒙蒙的才看不见。所以暗、亮各给一个甜点。
 */
function scorePalette(dna: CreatureDna): number {
  const { body, accent, glow } = dna.palette
  const [bh, bs, bl] = hsl(body)
  const [ah, as_, al] = hsl(accent)
  const [gh, gs, gl] = hsl(glow)

  // 色相和谐:三色中若存在一组落在类比(<28°)/三角(~120°)/互补(~180°)带内即算「成谱」
  const hues = [bh, ah, gh]
  let harmony = 0.2
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const d = hueDist(hues[i]!, hues[j]!)
      const near = Math.min(Math.abs(d - 180), Math.abs(d - 120), Math.min(d, 45))
      const fit = Math.max(0, 1 - near / 28)
      harmony = Math.max(harmony, fit)
    }
  }
  // 三色同 hue 不同明度也算「单色系」,是合法的设计选择,给一个中位分
  const allSame = hues.every((h) => hueDist(h, bh) < 14)
  if (allSame) harmony = Math.max(harmony, 0.55)

  // 饱和度:区间而非单峰。全 0 是死灰,全 1 是塑料,0.45~0.85 之间都算好
  const sats = [bs, as_, gs]
  const satSpread = Math.max(...sats) - Math.min(...sats)
  const notGrey = norm((Math.min(...sats) - 0.18) / 0.22)
  const notPlastic = norm((0.98 - Math.max(...sats)) / 0.18)
  const satScore = 0.45 * norm(satSpread / 0.3) + 0.55 * notGrey * notPlastic

  // 主体与辉光/点缀要分得开(否则糊成一坨)。这是可读性下限。
  // ⚠ 除数必须够大:WCAG 对比度实际能到 3~10,除数给 1.15 会让**几乎所有配色都
  //   顶到 1.0**,这一项就废了(实测 palette 方差份额只有 3.8%)。这里给 3.5 / 2.4,
  //   对应「对比度 4.75 / 3.6 才算充分分离」。
  const sepGlow = norm((contrast(body, glow) - 1.25) / 3.5)
  const sepAccent = norm((contrast(body, accent) - 1.2) / 2.4)
  const sepScore = 0.5 * sepGlow + 0.5 * sepAccent

  // 主体亮度:双峰(暗 ≈0.28 / 亮 ≈0.74)。中间灰调最扣分 —— 那才是真的看不清
  const dark = 1 - clamp01(Math.abs(bl - 0.28) / 0.3)
  const bright = 1 - clamp01(Math.abs(bl - 0.74) / 0.3)
  const bodyLevel = Math.max(dark, bright)

  return clamp01(0.36 * harmony + 0.2 * satScore + 0.28 * sepScore + 0.16 * bodyLevel)
}

/**
 * 特质**性格鲜明度** 0..1
 *
 * 这一维重写过两次,两次都是因为它**判反了「好看」**。
 *
 * ## 第一次错:均匀 = 满分
 *
 * 原实现是「熵 + 非零轴数 + 退化惩罚」,`hNorm` 和 `nonzero/4` 都由「八轴铺开」
 * 拉满,所以八轴全 3(彻底没性格)和 cyber=5+luminous=4(明确的赛博朋克)放在一起比,
 * 前者反而更高。
 *
 * ## 第二次错:改成了「很多条中强度轴」= 满分
 *
 * 改成「主导轴明确 + 有支撑 + 量级够」之后,它不再奖励完全均匀,但**换了个方式
 * 继续犯同一个错**。受控实验(描述固定、只改 traits,其余六维完全相同):
 *
 * ```
 * traits 设定                  总和  主导占比  特质分   总分
 * 克制·单一主张 cyber=3         3    1.00     0.09    49.9
 * 克制·双轴 cyber=3+fierce=1    4    0.75     0.27    57.9
 * 平庸·八轴各 1                 8    0.13     0.39    61.8
 * 全开·八轴各 3                24    0.13     0.66    71.9
 * 全开·八轴各 5                40    0.13     0.66    71.9
 * ```
 *
 * **最克制、最有主张的设计比「八根轴全拉满」低 22 分**,而且 3→5 完全饱和。
 * 根因是三个子项**同时**惩罚「少而明确」:
 *  - `distinct` 甜点在主导占比 0.25~0.45 → 单一主张(占比 1.0)拿 **0**;
 *  - `support = norm(second/2)` 要求次轴 ≥2 → 单独一根轴拿 **0**;
 *  - `intensity = norm(total/12)` 要求八轴总和 12 → 模型典型只给 3~6,拿 **0.25**。
 *
 * 三个加起来等于在说「你得把八根轴都点亮到中等强度」。而那在视觉上恰恰是**最平庸**
 * 的那一类 —— 就像一把调色板上八种颜色都放了,等于没配色。
 *
 * ## 现在:峰值 + 对比度
 *
 * 「有性格」的正确判据是**有没有一个明确的主张**,不是有多少个弱主张:
 *  - **峰值高度** `peak`:最强轴到 3 就满分。这一维**完全不看总量** —— 一根轴
 *    拉到位,和八根轴各拉一点,是同等量级的「有主张」,但前者显然更抓人。
 *  - **对比度** `contrast`:最强轴与次强轴的差距。差距小 = 全都差不多 = 没重点;
 *    差距大 = 有主次。**这是把「均匀」从奖励改成扣分的关键一项**。
 *  - **双主角** `support`:次强轴也够量(≥2)时给加成 —— 「两个都强」比「一个强
 *    另一个是零」更完整,但它不再是拿分的**必要**条件(上一版把它当必要项,直接
 *    把单一主张判死)。
 *  - **真塌缩** `lonelyPeak`:一根轴到顶、其余全 0。这才是「没搭起来」,保留重罚,
 *    但阈值收紧成 `second === 0` 附近 —— 双轴设计(cyber=5 + luminous=4)必须是安全的。
 */
function scoreTraits(dna: CreatureDna): number {
  const vals = TRAIT_AXES.map((a) => dna.traits[a])
  const total = vals.reduce((a, b) => a + b, 0)
  if (total <= 0) return 0

  const sorted = [...vals].sort((a, b) => b - a)
  const lead = sorted[0]!
  const second = sorted[1] ?? 0

  // 1) 峰值高度。⚠ 分母是 `(lead-1)/3` 而不是 `lead/3`:轴值量程是 0~5,而
  //    「轴=1」几乎等同于没表达任何性格(生成端随便点一下就有 1)。从 1 起算才能
  //    把「有性格」和「有数值」分开,否则一堆 lead=2 的 DNA 全顶在 0.67 上。
  const peak = norm((lead - 1) / 3)

  // 2) 对比度:最强与次强的相对差距。全平均 → 0,一枝独秀 → 1
  const gap = (lead - second) / lead
  const contrast = norm(gap / 0.6)

  // 3) 双主角加成(不是必要条件,只是加分)
  const support = norm(second / 2)

  const base = 0.42 * peak + 0.36 * contrast + 0.22 * support

  // 4) 真塌缩:一根轴到顶、其余全 0。阈值收紧 —— cyber=5 + luminous=4 必须安全
  const lonelyPeak = lead >= 4 && second <= 0.5
  if (lonelyPeak) return clamp01(base * 0.45)
  return clamp01(base)
}

/**
 * 动效**缺陷规避** 0..1 —— 属于 `craft` 轴:只问「有没有做错」。
 *
 * 这一维原来把两件事混在一起:**别抽搐**(缺陷,craft)和**动得有意思**(吸引力,
 * appeal)。混在一起的代价是实测出来的:6000 条样本里 **85% 都 ≥0.80**,p10~p90
 * 跨度只有 0.11,log 方差份额 **0.3%** —— 一个占 13/94 权重的维度几乎完全不产生
 * 区分度。根因是四个子项里三个是常数:`activity` 已被移到 appeal 侧的 `motionRich`;
 * `frantic` 只在 `flapHz≥5.5 且 driftAmp≥30` 那个角落才罚;`coherence` 默认分支
 * 就是 1;`familyFit` 没有 family 时白送 0.8。最后还无条件 `×1.06` 整体抬高。
 *
 * 现在只保留真正的缺陷项,并把每项的触发区间放宽到**真实数据会经过的范围**。
 * 「动得有没有层次」交给 `scoreMotionRich`。
 */
function scoreMotion(dna: CreatureDna, ctx: ScoreContext = {}): number {
  const m = dna.motion

  // 1) 不抽搐:高频 **且** 大幅同时发生才是视觉噪声 / 频闪风险。
  //    单看频率会冤枉慢节奏的小摆动,单看振幅会冤枉快节奏的小抖动,所以要相乘。
  const busy = m.flapHz >= 3 ? norm((m.flapHz - 3) / 3.5) : 0
  const frantic = 1 - busy * norm(m.driftAmp / 28) * 0.8

  // 2) 通道自洽:整体在大幅摆动却几乎不上下浮动(或反之)说明参数是分别乱填的。
  //    幅度差得越多越可疑。
  const swing = Math.max(m.flapHz / 6, m.driftAmp / 40)
  const bob = m.bobPx / 12
  const coherence = 1 - clamp01(Math.abs(swing - bob) / 0.7) * 0.5

  // 3) 拖尾要跟得上速度:动得快却没有拖尾 = 糊;动得慢却拖尾很长 = 脏
  const trailFit =
    m.trail <= 0
      ? 0.5
      : 1 - clamp01(Math.abs(m.trail - (0.15 + m.driftAmp / 90)) / 0.35) * 0.8

  // 4) motion family 与振幅矛盾(idle/breathe 配大幅摆动是自相矛盾)。
  //    ⚠ 没有 family 时给**中性 0.6**,不再白送 0.8 —— 缺上下文不该被当成做对了。
  let familyFit = 0.6
  const fam = ctx.motionFamily
  if (fam) {
    const still = fam === 'idle' || fam === 'breathe'
    familyFit = still && (m.driftAmp >= 20 || m.flapHz >= 5) ? 0.3 : 1
  }

  // 5) 不能完全静止 —— 三个通道里至少要有一处在明显动,这是缺陷不是风格。
  //    ⚠ 这是**下限守卫**,不是质量分:绝大多数正常生物都该拿满。所以权重压到 0.12,
  //    不让一个「人人满分」的项把这一维整体抬成常数(旧权重 0.2,是这一维方差被
  //    压平的原因之一)。
  const alive = norm(Math.max(m.flapHz / 4.5, m.driftAmp / 30, m.bobPx / 8))

  // 6) 旋转要与「有结构」相称:spin 是全局自转,转得太快会盖过部件级动作、显得廉价。
  //    spin 早就生成出来了,但没有任何一维在用 —— 白扔一路信号。
  const spinFit = 1 - norm((m.spin - 0.35) / 0.5)

  // 权重向**真正有分辨力**的项倾斜:coherence / trailFit 随参数连续变化,
  // frantic / alive 在常见区间会封顶(实测 p50 就是 1.0),给高权重等于稀释这一维。
  return clamp01(
    0.16 * frantic +
      0.26 * coherence +
      0.24 * trailFit +
      0.14 * familyFit +
      0.12 * alive +
      0.08 * spinFit,
  )
}

/**
 * 动效**层次** 0..1 —— 属于 `appeal` 轴:问「动得有没有意思」。
 *
 * 和 `scoreMotion` 的区别是这一维**完全不含惩罚项**,所以它不会因为「没做错」就
 * 自动拿高分。一只完全不动的东西在这里拿 0,不管它在 craft 侧拿得多干净。
 *
 * 两个信号:
 *  1. **复合运动**:有 ≥2 个不同 `periodScale` 的通道 = 多个不同频率在动
 *     (主轴一个节奏、附肢另一个节奏),这是「活」和「整体一起晃」的分界线。
 *     只有一个节奏的生物看起来像贴了一张循环图。
 *  2. **幅度有层次**:不同通道的振幅拉开差距。全是同一个振幅 = 机械同步 = 呆板。
 *
 * 数据来自 `motionCfg.rules`(每个部件的 `periodScale` / `amp`);没有 blueprint
 * 配置时退回 DNA 的三个整体参数,这时只能判断「动没动」,给一个偏保守的分数。
 */
function scoreMotionRich(dna: CreatureDna, ctx: ScoreContext = {}): number {
  const rules = ctx.motionRules
  const m = dna.motion

  let channels = 0
  let periods: number[] = []
  let amps: number[] = []
  if (rules?.length) {
    for (const r of rules) {
      const amp = Math.abs(r.amp ?? 0)
      if (amp < 0.5) continue // 几乎不动的通道不算
      channels++
      periods.push(r.periodScale ?? 1)
      amps.push(amp)
    }
  }

  // 1) 复合运动:不同频率的通道数
  let layered: number
  if (periods.length >= 2) {
    // 相邻周期差 ≥0.15 才算「不同节奏」;1.0 / 1.0 这种同步不算
    const uniq = new Set(periods.map((p) => Math.round(p * 10) / 10)).size
    const spread = Math.max(...periods) - Math.min(...periods)
    layered = norm(channels / 6) * (0.5 * norm(uniq / 3) + 0.5 * norm(spread / 0.6))
  } else if (periods.length === 1) {
    layered = 0.35 // 只有单一节奏:能动,但没有层次
  } else {
    // 没有部件级配置:退回整体参数,只能看出「动没动」
    layered = 0.5 * norm(Math.max(m.flapHz / 4, m.driftAmp / 26, m.bobPx / 7)) + 0.1
  }

  // 2) 振幅有层次:最大/次大振幅的差距(全同步 → 0)
  const ampLayer = amps.length >= 2 ? norm((Math.max(...amps) - secondMax(amps)) / 18) : 0.3

  return clamp01(0.68 * layered + 0.32 * ampLayer)
}

/** 次大值(用于「最大振幅比其余大多少」) */
function secondMax(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => b - a)
  return s.length >= 2 ? s[1]! : 0
}

/** 归一化编辑距离(两字符串差异度 0..1) */
function editSim(a: string, b: string): number {
  if (!a || !b) return 0
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  const dist = dp[m][n]
  return 1 - dist / Math.max(m, n)
}

/**
 * 成长叙事 0..1
 *
 * 三段成长必须「看得出是三个阶段」。全同的 note / 雷同的 boost / 不递增的尺寸
 * 会让 19 天的成长变成「什么都没发生」,这是最该被抓出来的失败模式。
 *
 * **blueprint 路径的 plan 是空的**(`compileBlueprint` 只把成长放在每个 part 的
 * `appear`/`grow` 上),所以走 parts 分支:直接看「出场窗口是否分阶段」。
 * 否则这一维在所有 blueprint 上都恒为同一个值,等于 8 分权重全在测噪声。
 */
function scoreNarrative(dna: CreatureDna, ctx: ScoreContext = {}): number {
  const parts = ctx.parts
  if (parts?.length) return scoreNarrativeFromParts(parts)

  const notes = dna.plan.map((p) => p.note)
  const names = dna.plan.map((p) => p.name)

  // 相邻两段 note 的差异度,取最小值(最雷同的那一对说了算)
  let minNoteSim = 1
  for (let i = 0; i + 1 < notes.length; i++) {
    minNoteSim = Math.min(minNoteSim, editSim(notes[i], notes[i + 1]))
  }
  const noteScore = norm((0.62 - minNoteSim) / 0.5)

  // 三段 boost 的键集合要分化
  const keySets = dna.plan.map((p) => Object.keys(p.boost).sort().join('|'))
  const distinct = new Set(keySets).size
  const boostScore = norm((distinct - 1) / 2)

  // 尺寸必须单调不减且末段大于 0(真的有变大)
  let mono = true
  for (let i = 0; i < dna.plan.length; i++) {
    const s = dna.plan[i].add.size ?? 0
    if (s < 0) mono = false
    if (i > 0 && s < (dna.plan[i - 1].add.size ?? 0)) mono = false
  }
  const grew = (dna.plan[dna.plan.length - 1]?.add.size ?? 0) > 0
  const sizeScore = mono && grew ? 1 : mono ? 0.5 : 0

  const nameScore = new Set(names).size === names.length ? 1 : 0.4

  return 0.36 * noteScore + 0.24 * boostScore + 0.26 * sizeScore + 0.14 * nameScore
}

/**
 * blueprint 的成长叙事:看 parts 的出场/生长窗口有没有真的分阶段。
 *
 * 原来 blueprint 路径下 plan 为空,这里恒等于 0.49(占 8/94 ≈ 8.5% 权重),
 * 是「分数全挤在 70~90」的直接成因之一。现在评三件真实的事:
 *  1. **出场有先后**:部件的出场时点要拉开,不是所有零件同一帧冒出来;
 *  2. **有东西在长大**:至少一部分带 `grow` 窗口(不然 19 天里它根本不变大);
 *  3. **节奏铺得开**:成长窗口不能全挤在头几天,要一直长到后面。
 */
function scoreNarrativeFromParts(parts: readonly { role?: string; grow?: unknown; appear?: unknown }[]): number {
  const starts: number[] = []
  const ends: number[] = []
  let growing = 0

  for (const p of parts) {
    const ap = p.appear as { start?: number; end?: number } | undefined
    if (ap && typeof ap.start === 'number') {
      starts.push(ap.start)
      if (typeof ap.end === 'number') ends.push(ap.end)
    }
    const g = p.grow as { from?: number; to?: number } | undefined
    if (g && typeof g.from === 'number') {
      starts.push(g.from)
      if (typeof g.to === 'number') ends.push(g.to)
    }
    if (g) growing++
  }

  // 没有时间信息就无从评成长叙事,给中性分而不是编一个
  if (starts.length < 2) return 0.5

  const sMin = Math.min(...starts)
  const sMax = Math.max(...starts)
  const eMax = Math.max(...ends, sMax)

  // 1) 出场时点要拉开:全部同帧冒出来 = 0
  //    ⚠ 分母 25 → 35。实测 70.5% 的样本这一维顶到 1.00,原来的甜点太容易够到。
  const span = sMax - sMin
  const staged = norm(span / 35)

  // 2) 得真的有东西在长大,而且要**成比例**:一个 30 部件的生物只让 4 个带
  //    `grow` 就该扣分 —— 那意味着 26 个零件从头到尾不动,19 天白过。
  //    分母从 `max(4, n×0.35)` 提到 `max(6, n×0.55)`。
  const growScore = norm(growing / Math.max(6, parts.length * 0.55))

  // 3) 成长要铺得开:最晚的那个窗口不能太早结束(20 天内一直在变)
  //    分母 40 → 60,理由同上
  const reachScore = norm(eMax / 60)

  return 0.4 * staged + 0.32 * growScore + 0.28 * reachScore
}

/**
 * 原型契合 0..1 —— 描述与 DNA 是否对得上。
 *
 * ⚠ **不复用 `fallback.keywordMatch`**,那一版有个和 `scoreTraits` 同向的偏差,
 * 两者叠加起来正是「好看却低分」的直接机制。
 *
 * `keywordMatch` 的特质项是 `traitHit.length / 4`:数的是「**命中了几根轴**」。
 * 于是点亮越多轴的 DNA 越容易拿高分 —— 一个八轴全亮的平庸生物,只要描述里有
 * 四个气质词,就能拿满这一项;而一个 `cyber=3` 的克制设计只点亮一根轴,最多拿
 * 0.25。**旧版 `scoreTraits` 用 `intensity = total/12` 奖励同样的行为**,所以
 * 「把所有轴都点亮」被算了两遍,而有明确主张的设计被扣了两遍。
 *
 * 改成**精确率**而不是召回率:「你**真正点亮**的那些轴里,有几个是描述点名的」。
 *  - cyber=3 + 描述「赛博朋克」→ 1/1 = **1.0**(照做了)
 *  - 八轴全亮 + 描述只说「赛博朋克」→ 1/8 = **0.125**(没在听)
 *
 * 这样这一维问的是「有没有听对话」,和「有没有把每根轴都拧上去」彻底解耦。
 * 描述长度效应也一并消失:分母是 DNA 自己点亮的轴数,与描述长短无关。
 *
 * 代价:它不再评「描述里的原型词有没有被用上」—— 那部分交给 `scoreFidelity`
 * 的配色/动作检查,以及这里的原型项(原型项的分母是**描述长度**,天生带长度效应,
 * 所以权重压到 0.18 并且做了长度归一)。
 */
function scoreMatch(dna: CreatureDna, descr: string): number {
  const text = descr.trim()
  if (!text) return 0

  // 1) 原型:描述里原型词的命中字符数,按描述长度归一(长描述天然词多)
  const archHit = countHits(text, ARCHETYPE_WORDS[dna.archetype] ?? [])
  const archScore = norm(archHit / Math.max(3, Math.min(8, text.length * 0.1)))

  // 2) 特质:**精确率** —— 点亮的轴里,有几个是描述点名的那几根
  const lit = TRAIT_AXES.filter((a) => (dna.traits[a] ?? 0) >= 2)
  const matched = lit.filter((a) => countHits(text, TRAIT_WORDS[a] ?? []) > 0).length
  const traitScore = lit.length ? matched / lit.length : 0

  // 3) 描述点名了颜色 → 配色里是否真的带上了(与 fidelity 的配色项同源,但这里
  //    只当弱信号:它不区分「带上了」和「带得准」)
  const colorHit = COLOR_WORDS.some((w) => text.includes(w)) && paletteEchoesColor(dna, text)

  return clamp01(0.18 * archScore + 0.62 * traitScore + 0.2 * (colorHit ? 1 : 0))
}

/** 词表命中字符数 */
function countHits(text: string, words: readonly string[]): number {
  let n = 0
  for (const w of words) if (w && text.includes(w)) n += w.length
  return n
}

/** 描述里出现过的颜色词(与 `fallback.ts` 的 COLOR_WORDS 同表,评分侧独立一份) */
const COLOR_WORDS = ['蓝', '红', '绿', '金', '银', '紫', '青', '橙', '白', '黑', '粉', '霓虹'] as const

/* ---------------------------- 新增:结构 ---------------------------- */

/**
 * **结构复杂度**:这只东西搭得认不认真。
 *
 * 为什么单列一维:原来 5 维全在评「材质与参数」(配色/特质/动效/文案/关键词),
 * **没有一维在看搭得像不像回事**。实测里 12 部件和 27 部件的生物分数几乎一样
 * —— 也就是说「随便给个圆身子加两条线」和「认真搭了 27 个零件」在评分里等价。
 *
 * 有 `parts` 时(走 blueprint 管线)看真实部件;没有就退回 DNA 的 `shape.plan`,
 * 信息少但不为 0,不会因为老调用点缺上下文而整体掉分。
 */
function scoreStructure(dna: CreatureDna, ctx: ScoreContext): number {
  const parts = ctx.parts
  if (parts?.length) {
    const n = parts.length
    // 部件数:12~26 是「认真搭了」的区间,过少潦草、过多堆料。
    // 用平滑曲线而非硬阈值,免得 12 和 13 差出一个悬崖。
    // ⚠ 分母 26 → 20:原来 n=10 和 n=30 只差 0.15,这一项几乎不区分,收紧后
    //   n=10 → 0.60、n=18 → 1.00、n=30 → 0.40。
    const ideal = 18
    const countScore = n >= 10 && n <= 30 ? norm(1 - Math.abs(n - ideal) / 20) : norm(n / 10) * 0.5

    // 角色多样性:光靠 body 堆 20 个零件没有意义,得有眼/嘴/纹样等分工
    const roles = new Set(parts.map((p) => p.role ?? ''))
    const roleScore = norm(Math.min(roles.size, 7) / 7)

    // 可动部件占比:全静态的生物再好看也是一张图
    const movable = parts.filter((p) => p.role === 'accent' || p.role === 'accentLight' || p.role === 'line').length
    const motionScore = norm(movable / Math.max(4, n * 0.22))

    // 骨架完整度:不能全是 body —— 主体占比过高压
    const bodyRatio = parts.filter((p) => p.role === 'body').length / n
    const balanceScore = bodyRatio > 0.75 ? 1 - (bodyRatio - 0.75) * 3 : 1

    return clamp01(0.4 * countScore + 0.28 * roleScore + 0.18 * motionScore + 0.14 * balanceScore)
  }

  // 无 parts:退回 DNA 的形状提示(老调用点)。
  // shape 只有 limbPairs / spineSegments / symmetry 三项,信息远少于真实部件树,
  // 所以这里只判「有没有把身体结构说清楚」,给一个窄区间、不制造虚假区分度。
  const s = dna.shape
  const hinted = s ? s.limbPairs * 2 + s.spineSegments : 0
  if (!hinted) return 0.55
  const segScore = norm(s!.spineSegments / 8)
  const limbScore = norm(s!.limbPairs / 4)
  const symScore = norm(1 - Math.abs(s!.symmetry - 0.9) / 0.9)
  return clamp01(0.4 + 0.25 * (0.4 * segScore + 0.35 * limbScore + 0.25 * symScore))
}

/* ------------------- appeal 轴:新增的三个维度 ------------------- */

/**
 * 剪影辨识度 0..1 —— 「这只的轮廓有没有意思」。
 *
 * ## 它和 `scoreStructure` 的区别
 *
 * `structure` 问的是**搭得认不认真**(数量、分工、骨架),全部是计数。这一个问的是
 * **摆得好不好看**:同样的 18 个零件,摊满整个画布 vs 挤在中心一小团,视觉结果
 * 完全不同,而计数完全看不出这个差别。
 *
 * ## 两个信号
 *
 *  1. **占据范围**。部件重心到整体重心的 RMS 距离,按 `span`(成熟期半宽)归一。
 *     全挤在中心 = 糊成一坨的小点;散出画布 = 碎成一堆看不懂的碎片。
 *  2. **体量层次**。用 SVG 路径 `d` 的长度当体积代理(不需要真的解析路径),
 *     看**最大部件占了总体量多少**:一个巨无霸 + 几个小点 = 没有细节可读;
 *     十几个大小有别的部件 = 剪影有层次。
 *
 * ⚠ **这一维是假设驱动的**(「剪影有层次更好看」是设计经验,没有人工标签验证过)。
 * 它被放在 appeal 轴且刻意不做成惩罚项(缺数据时给中性 0.55),并且 `/lab/score`
 * 会用 `leverageOf()` 把它的实测杠杆份额摆出来 —— 如果它其实没在干活,一眼就能
 * 看到,而不是靠猜。
 */
function scoreSilhouette(parts: readonly ScorePart[] | undefined, span: number | undefined): number {
  const pts = (parts ?? []).filter((p) => typeof p.x === 'number' && typeof p.y === 'number')
  // 位置数据不够就无从评构图,给中性而不是编一个
  if (pts.length < 5) return 0.55

  const cx = pts.reduce((a, p) => a + p.x!, 0) / pts.length
  const cy = pts.reduce((a, p) => a + p.y!, 0) / pts.length
  // `span` 是成熟期半宽,没给就按 blueprint 的默认 90
  const S = Math.max(12, span ?? 90)

  const radii = pts.map((p) => Math.hypot(p.x! - cx, p.y! - cy) / S)
  const rms = Math.sqrt(radii.reduce((a, r) => a + r * r, 0) / radii.length)
  const far = Math.max(...radii)

  // 1) 占据范围:太聚(rms→0)扣,散出画布(far>1)扣,中间给满分
  const spread = norm(rms / 0.5) * norm(1 - clamp01((far - 0.95) / 0.55))

  // 2) 体量层次。⚠ **不能只看最大部件占比**:部件越多,最大占比天然越小
  //    (n=10 时约 0.1,n=30 时约 0.03),那一项几乎只反映「部件数」,不反映层次 ——
  //    实测它的方差份额只有 1.2%。改用**体量分布的归一化熵** + 最大占比惩罚:
  //    熵低 = 一两个巨无霸带一堆碎点;熵高 = 大小有别。两者一起才有层次。
  const sizes = (parts ?? []).map((p) => Math.max(1, p.d?.length ?? 0))
  const sizeTotal = sizes.reduce((a, b) => a + b, 0)
  let layering = 0.5
  if (sizeTotal > 0 && sizes.length >= 3) {
    const ps = sizes.map((v) => v / sizeTotal)
    const H = -ps.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0) / Math.log(sizes.length)
    const largest = Math.max(...sizes) / sizeTotal
    layering = 0.6 * norm(H / 0.82) + 0.4 * norm(1 - largest / 0.5)
  }

  return clamp01(0.55 * spread + 0.45 * layering)
}

/**
 * 神韵 / 有没有「脸」 0..1。
 *
 * 为什么单列:「生物」和「色块」的分界几乎全在这只眼睛上。一坨配色漂亮、动效流畅
 * 的东西,长了眼睛和没长眼睛是两种东西 —— 而**现有七维没有一维在看它**
 * (`scoreFidelity` 只在描述点名「眼」时才检查,没点名就完全不参与评分)。
 *
 * 判据:
 *  - **2 只** = 对称的一对,是绝大多数生物的正确解,满分;
 *  - **1 只** = 独眼,可以是刻意设计,给中上;
 *  - **0 只** = 色块,给很低(但不给 0:纯装饰性纹样确实可以没眼睛);
 *  - **3~4 只** = 开始难辨,给中;**>4 只** = 挤成一团,扣。
 *
 * 另有一项:多只眼如果**坐标几乎重合**,那多半是同一个位置复制了几份,也算没长好。
 */
function scoreFace(parts: readonly ScorePart[] | undefined): number {
  if (!parts?.length) return 0.55
  const eyes = parts.filter((p) => p.role === 'eye' || /眼|eye|pupil/i.test(`${p.id ?? ''}`))
  const n = eyes.length

  let base: number
  if (n === 0) base = 0.18
  else if (n === 1) base = 0.62
  else if (n === 2) base = 1
  else if (n <= 4) base = 0.72
  else base = 0.4

  // 坐标重合的「多眼」= 同一个位置复制了几份,不算真的多眼
  if (n >= 2) {
    const pos = eyes.map((p) => `${Math.round(p.x ?? 0)}:${Math.round(p.y ?? 0)}`)
    const uniq = new Set(pos).size
    base *= norm((uniq - 1) / Math.max(1, n - 1)) * 0.4 + 0.6
  }

  return clamp01(base)
}

/**
 * 色彩**记忆点** 0..1 —— 「有没有一处在视觉上跳出来的颜色」。
 *
 * ## 为什么必须和 `scorePalette` 分开
 *
 * `scorePalette`(craft)只奖**和谐**:色相落在类比/三角/互补带内、饱和度在中间段、
 * 主体与点缀分得开。这套判据系统性地**贬低张力** —— 而真实视觉设计里,冲击力
 * 常常正来自「不和谐」:霓虹粉配湖蓝、大红配青绿。旧结构里没有任何一维为它说话,
 * 于是这类配色只能靠「勉强算和谐」拿分,好看的被压掉。
 *
 * 拆出这一维之后,`palette` 和 `colorPop` 是**正交**的:单色系 designs 可以在
 * `palette` 拿满分而在 `colorPop` 拿低分,撞色 designs 反之。两者都要,才能覆盖
 * 「协调耐看」和「跳眼有冲击」这两种都成立的好看。
 *
 * 判据:某色相对主体的**色相距离**够大(≥55° 算「另一族颜色」),且它的饱和度或
 * 亮度与主体有明显落差 —— 两个条件都满足才算「跳出来」。纯黑主体配任何颜色都跳,
 * 但那不算配色,所以要求**色相**也拉开。
 *
 * ⚠ 同 `scoreSilhouette`:这是设计经验,没有人工标签验证。刻意给了 0.2 的地板 ——
 * 单色系是合法且常常很好看的设计,不该因为「没有记忆点」就被判成差。
 */
function scoreColorPop(dna: CreatureDna): number {
  const { body, accent, glow } = dna.palette
  const [bh, bs, bl] = hsl(body)

  let best = 0
  let both = 0
  for (const hex of [accent, glow]) {
    const [h, s, l] = hsl(hex)
    // 两条**互替**的「跳出来」路线 —— ⚠ 不能相乘。相乘等于要求两条同时成立,
    // 而最跳的三色配色恰恰是「三个都很饱和、色相各差 140°」:它的饱和度**差为零**,
    // 一相乘就被判成 0(实测亮丽三色与全灰同分,这一维直接失效)。
    // 色相跳开本身就够了;明度/饱和度落差是给「色相相邻」的情况准备的另一条路。
    // 阈值(30/70)要够大:除数给 35 时,只要色相间距≥60° 就封顶,于是绝大多数
    // 三色配色(间距常在 90~270°)全部顶到 1.0,中位数就是满分 —— 那一维照样失效。
    const hueJump = norm((hueDist(bh, h) - 30) / 70)
    const sep = Math.max(
      norm((Math.abs(s - bs) - 0.08) / 0.28),
      norm((Math.abs(l - bl) - 0.1) / 0.28),
    )
    // ⚠ sep 只作**次要**路线(系数 0.45),不是与色相等权。理由:明度/饱和度的
    //   分离度已经由 `palette` 的 sepGlow/sepAccent 在评了,这里再等权计一遍等于
    //   重复奖励,而且会让**单色系**(色相不动、只靠明暗分层)也拿满「撞色」分,
    //   colorPop 又变回近似常数。撞色说的就是「色相跳开」。
    const q = Math.max(hueJump, 0.45 * sep)
    if (q > best) best = q
    if (q >= 0.5) both++
  }

  // 单色系也有 0.2 的地板:「没有记忆点」不等于「难看」
  return clamp01(0.2 + 0.6 * best + 0.2 * (both >= 2 ? 1 : 0))
}

/* ---------------------------- 新增:落实度 ---------------------------- */

/**
 * **描述落实度**:描述里点名的东西,有多少真的**长在身上**。
 *
 * 这是整个评分里唯一直接回答「你有没有听我说话」的一维,也是补 `match` 缺口的正解。
 *
 * 与 `keywordMatch` 的关键区别 —— 别把这两个混为一谈:
 *  - `keywordMatch` 问「描述里的词,DNA 里有对应属性吗」,于是**描述越长命中越多**,
 *    稀疏描述天然吃亏。它拿 +2.1/2.9 的「丰富度提升」,几乎全是这个长度效应。
 *  - 这一维问「描述里点名的**每类特征**,生成了对应的部件/动效吗」,并且
 *    **只在描述真的点了某类特征时才计那类**。没提触须不会因为没长触须而扣分;
 *    提了三类特征就按三类算命中率。所以它既不会被长度灌水,也能分辨「照做了」与「没照做」。
 */
function scoreFidelity(
  dna: CreatureDna,
  descr: string,
  ctx: ScoreContext,
): { v: number; notes: string[] } {
  const text = descr.trim()
  if (!text) return { v: 0.5, notes: [] }

  /**
   * 各类特征:描述里出现了才进入分母,避免「没提」被算成「没做到」。
   * `w` 是达成度 0..1(不是布尔):「气质轴半亮」这种中间态要能表达。
   */
  const checks: { w: number; note: string }[] = []
  const hit = (ok: boolean, note: string) => checks.push({ w: ok ? 1 : 0, note })

  // 1) 触须/触手/角/鳍 —— 有没有细长末梢部件
  if (/触须|触手|触角|鹿角|龙角|触|须/.test(text)) {
    const has = ctx.parts?.some(
      (p) => /触|须|角|antenna|tentacle|horn|fin/i.test(`${p.id ?? ''}${p.role ?? ''}`),
    )
    hit(has ?? false, '触须/角')
  }
  // 2) 腿/足 —— 腿的条数是否与描述一致(「六条腿」这种硬要求必须能验)
  if (/条腿|腿|足|爪|蹄/.test(text)) {
    const legs = countLimbs(ctx, LIMB_RE)
    const want = NUM_CN_TO_N[text.match(/([一二三四五六七八九十两\d]+)\s*(?:条腿|只脚|只足|条足|对足)/)?.[1] ?? '']
    // 描述给了具体条数就精确比对,只说「有腿」则只看存不存在。
    // 差一条不算失败(模型数错很正常),差一半才算没照做。
    const legHit = want ? legs === want || Math.abs(legs - want) === 1 : legs > 0
    hit(legHit, `腿(${legs}${want ? `/${want}` : ''})`)
  }
  // 3) 眼 —— 有没有眼部件
  if (/眼|睛|瞳/.test(text)) {
    hit(
      (ctx.parts?.some((p) => /眼|eye/i.test(`${p.id ?? ''}${p.role ?? ''}`)) ?? false) || dna.traits.luminous > 0,
      '眼',
    )
  }
  // 4) 发光/辉光 —— 要么有 glow 部件,要么 luminous 特质够高
  if (/发光|辉光|光|亮|荧|闪/.test(text)) {
    const glowPart = ctx.parts?.some((p) => p.role === 'glow' || /glow|光/i.test(p.id ?? ''))
    hit(!!glowPart || dna.traits.luminous >= 3, '发光')
  }
  // 5) 翼/翅 —— 飞行动效或翼部件
  if (/翼|翅|飞/.test(text)) {
    const wing = ctx.parts?.some((p) => /翼|翅|wing/i.test(`${p.id ?? ''}${p.role ?? ''}`))
    hit(!!wing || ctx.motionFamily === 'flap' || ctx.motionFamily === 'glide', '翼')
  }
  // 6) 尾 —— 尾巴部件
  if (/尾/.test(text)) {
    hit(ctx.parts?.some((p) => /尾|tail/i.test(`${p.id ?? ''}${p.role ?? ''}`)) ?? false, '尾')
  }
  // 7) 描述点名了颜色 —— 配色里是否真的带上了那个色相
  if (/[青蓝绿金银紫橙白黑粉红霓虹]/.test(text)) {
    hit(paletteEchoesColor(dna, text), '配色')
  }
  // 8) 描述给了动作(游/爬/跳/飞/摆) —— 动效 family 是否对得上
  const fam = ctx.motionFamily
  if (fam) {
    const wantSwim = /游|泳|滑/.test(text)
    const wantCrawl = /爬|走|行|迈|步/.test(text)
    const wantHop = /跳|跃|蹦/.test(text)
    if (wantSwim) hit(fam === 'swim', '游')
    if (wantCrawl) hit(fam === 'walk', '走')
    if (wantHop) hit(fam === 'hop', '跳')
  }

  /* 9) **气质轴**:描述点名的性格词,对应的特质轴有没有真的被点亮。
   *
   * 补的是上面 1~8 全都盖不住的洞:它们逐项查的都是**看得见的物理特征**(有触须吗、
   * 腿数对吗、发光吗),而「赛博朋克 / 可爱 / 凶猛 / 远古」这类**气质词**既不长在
   * 部件上也不体现在动作里 —— 它唯一的载体就是那八条特质轴。
   *
   * ⚠ 别把这当成「VQA」自我评价:模型没被问到「你觉得自己赛博吗」,所以不存在
   * 循环论证。检查的是**词表 → 轴**这条确定性映射有没有被兑现 —— 描述点了 cyber,
   * 模型却把 cyber 轴留在 0,是真实且高频的失败模式(模型理解到了氛围,但没落到
   * 任何一个可渲染的字段上)。
   *
   * 真正的「看图说话」得让视觉模型看渲染结果,那是另一条更贵的管线;这一维是
   * 免费、确定性、可复现的下界,并且能直接指出是哪根轴没亮。
   *
   * `luminous` 排除在外:它已经被第 4 项(发光部件/glow)覆盖,重复计入会让
   * 「发光」在分母里占两票。
   */
  for (const axis of TRAIT_AXES) {
    if (axis === 'luminous') continue
    const words = VIBE_WORDS[axis]
    if (!words?.some((w) => text.includes(w))) continue
    const v = dna.traits[axis] ?? 0
    // 轴值 0..5:≥2 算照做(占量程 40%),=1 算半亮,=0 是彻底没兑现
    const w = v >= 2 ? 1 : v === 1 ? 0.5 : 0
    checks.push({ w, note: `${TRAIT_LABELS[axis]}(${v})` })
  }

  // 描述里没点到任何可验证的特征 —— 不奖不罚,给中性
  if (!checks.length) return { v: 0.55, notes: [] }

  /**
   * ⚠ 这里有个**长度效应的镜像坑**,踩过一次:
   * 分母 = 「描述点了哪几类可验特征」。于是描述越具体,可验项越多、越容易漏,
   * 稀疏描述反而占便宜 —— 这是 `match` 那个长度效应的翻版,只是方向相反。
   * 实测就撞上过:稀疏档「一只深海发光水母」只命中「发光」1 项,轻松拿满分;
   * 丰富档点了「翼/尾/配色/走」4 项,漏一项就掉到 0.78。
   *
   * 解法不是把分母改成常数(那等于放弃「有没有照做」这个判断),而是**只在描述
   * 点到 ≥2 类时才严格计数**:单一要求做到就是满分,不足以说明模型偷工减料;
   * 而当描述提了多项要求时,漏掉就该扣 —— 那正是 rich 档该被认出来的地方。
   */
  if (checks.length === 1) {
    const only = checks[0]!
    return { v: only.w >= 0.5 ? 1 : 0.4, notes: [noteOf(only)] }
  }

  const got = checks.reduce((a, c) => a + c.w, 0)
  // 全中给满分;漏一半给 0.5(不是线性惩罚,漏一两条不至于致命)
  const v = clamp01(0.35 + 0.65 * (got / checks.length))
  return { v, notes: checks.map(noteOf) }
}

/** 一项落实检查的可读备注:✓ 照做 / ~ 半亮 / ✗ 没做到 */
function noteOf(c: { w: number; note: string }): string {
  return `${c.w >= 1 ? '✓' : c.w > 0 ? '~' : '✗'}${c.note}`
}

/**
 * 每条特质轴的**气质词** —— 用于「描述点名的性格,轴有没有亮」这项落实检查。
 *
 * ⚠ 为什么不能用 `fallback.ts` 的 `TRAIT_WORDS`:那份词表是为**生成**服务的,
 * 追求「宁可多点亮一根轴」,所以收得很宽(`cute` 含 `小`/`圆`,`organic` 含 `肉`/`生物`,
 * `luminous` 含 `光`/`亮`)。生成时点亮 `cute` 没坏处,评分时就全是坏处:
 * 「一只**小**东西」也会被判成「点名了可爱」,然后因为 cute 轴没到 2 而扣分 ——
 * 这不是扣分,这是**造出来的**扣分。
 *
 * 所以这里另立一份**高精度**词表:只收本身就明确在表达某种气质的词(多为双字以上),
 * 不收任何单独出现也常见于中性描述的通用字。
 *
 * `luminous` 不在此列 —— 「发光」已经由上面第 4 项按 glow 部件判过了,重复计票。
 */
const VIBE_WORDS: Record<string, string[]> = {
  mechanical: ['机械', '齿轮', '铆钉', '钢铁', '机油', '装甲', '铰链', '蒸汽朋克'],
  organic: ['血肉', '藤蔓', '有机体', '腐肉', '孢子'],
  ethereal: ['空灵', '幽灵', '缥缈', '虚影', '仙气', '半透明'],
  fierce: ['凶猛', '暴戾', '利爪', '獠牙', '狂怒', '狰狞', '杀戮'],
  cute: ['可爱', '萌', '呆萌', '圆头', '软糯', '毛茸茸', '奶乎乎'],
  ancient: ['远古', '上古', '年迈', '沧桑', '古旧', '遗迹', '苍老'],
  cyber: ['赛博', '霓虹', '科幻', '全息', '代码', '数码', '电子', '未来感'],
}

/** 中文/阿拉伯数字 → 数值,用于「六条腿」这种硬要求 */
const NUM_CN_TO_N: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10,
}

/** 腿/足类部件的 id 特征 —— 同时用于「描述点名腿」与「数腿」两处 */
const LIMB_RE = /腿|足|爪|蹄|肢|leg|foot|paw|claw|limb/i

/**
 * 数一数腿/足类部件。
 *
 * ⚠ 曾经的 bug:把 `leg-1`/`leg-2`/`leg-3` 的**末尾序号**当数量求和,
 * 于是 3 条腿算出 6、6 条腿算出 21 ——「六条腿」永远判不中,fidelity 卡在 0.35。
 * 序号只是命名,不是数量。正确做法是**数部件个数**。
 * 例外:`legs-3` 这种带复数前缀的表示「一组 3 条」,才读末尾数字。
 */
function countLimbs(ctx: ScoreContext, re: RegExp): number {
  const parts = ctx.parts
  if (!parts?.length) return 0
  let n = 0
  for (const p of parts) {
    const id = `${p.id ?? ''}`
    if (!re.test(id) && !re.test(`${p.role ?? ''}`)) continue
    // `legs-3` / `feet-2`:复数前缀 + 数字 = 一组的数量
    const group = id.match(/(?:legs|feet|limbs|paws|claws)[-_](\d+)/i)
    n += group ? Number(group[1]) : 1
  }
  return n
}

/** 描述里点名的色相,配色三色里是否真的用上了(按色相距离判定) */
function paletteEchoesColor(dna: CreatureDna, text: string): boolean {
  const named: [RegExp, number][] = [
    [/青|蓝/, 210], [/绿/, 130], [/金/, 45], [/银|白/, 0], [/紫/, 280],
    [/橙/, 30], [/黑/, 0], [/粉/, 330], [/红/, 0], [/霓虹/, 0],
  ]
  const wants = named.filter(([re]) => re.test(text)).map(([, h]) => h)
  if (!wants.length) return true
  const have = [dna.palette.body, dna.palette.accent, dna.palette.glow].map(hsl)
  return wants.some((w) => have.some((c) => hueDist(c[0], w) < 40))
}

/* ---------------------------- 对外 ---------------------------- */

/** 打分的维度键。`craft` 轴在前,`appeal` 轴在后 */
export type ScoreKey = keyof typeof WEIGHTS

/** 各维按轴分组,顺序即 `CRAFT_WEIGHTS` / `APPEAL_WEIGHTS` 的声明顺序 */
export const CRAFT_KEYS = Object.keys(CRAFT_WEIGHTS) as readonly (keyof typeof CRAFT_WEIGHTS)[]
export const APPEAL_KEYS = Object.keys(APPEAL_WEIGHTS) as readonly (keyof typeof APPEAL_WEIGHTS)[]
export const SCORE_KEYS = [...CRAFT_KEYS, ...APPEAL_KEYS] as readonly ScoreKey[]

/** 某一维属于哪个轴 */
export const AXIS_OF: Record<ScoreKey, ScoreAxis> = Object.fromEntries([
  ...CRAFT_KEYS.map((k) => [k, 'craft' as const]),
  ...APPEAL_KEYS.map((k) => [k, 'appeal' as const]),
]) as Record<ScoreKey, ScoreAxis>

/** 评分需要的最小部件信息。字段全可选,所以老调用点只传 `{ id, role }` 也合法 */
export interface ScorePart {
  role?: string
  id?: string
  /** 附着点(局部单位) */
  x?: number
  y?: number
  /** SVG 路径串。用长度当体积代理,不解析 */
  d?: string
  grow?: unknown
  appear?: unknown
}

/** 部件级运动规则(`motionCfg.rules` 的值) */
export interface ScoreMotionRule {
  amp?: number
  periodScale?: number
}

export interface ScoreBreakdown {
  /** 工艺轴 0..100:做得对不对 */
  craft: number
  /** 吸引力轴 0..100:想不想看 */
  appeal: number
  /** 0..100,两轴相乘合成 */
  total: number
  /** 逐维 0..1。键见 `SCORE_KEYS` */
  dims: Record<ScoreKey, number>
  /**
   * 调试用:这维到底在比什么。空字符串 = 这只没点到任何可验证的特征,拿的是中性分。
   * 页面上把它打出来,免得出现「0.35 分」却不知道在扣什么。
   */
  fidelityNotes?: string[]
}

/**
 * 打分的可选上下文。
 *
 * 为什么需要:只看 `dna` 的话,「部件到底有几个」「用的哪个 motion family」
 * 「有没有触须」「摆在哪」这些信息全都不在 DNA 里 —— 而它们恰恰是判断
 * 「描述有没有被落实」「看起来好不好看」的主要依据。所以允许把编译产物传进来;
 * 不传时相关维度退回**只看 DNA** 的弱版本,保持 `heuristicScore(dna)` 老调用点
 * 全部可用、结果不崩。
 */
export interface ScoreContext {
  parts?: readonly ScorePart[]
  motionFamily?: string
  /** 部件级运动规则,给 `motionRich` 判断「有没有多个不同节奏」 */
  motionRules?: readonly ScoreMotionRule[]
  /** 成熟期半宽,给 `silhouette` 归一化用 */
  span?: number
  /** 描述里点名的特征词,用于 fidelity(目前由 fidelity 自己从描述解析,保留给扩展) */
  mentioned?: readonly string[]
}

/** 对一份合法 DNA 打分;逐维均为 0..1 */
export function heuristicScore(
  dna: CreatureDna,
  descr = '',
  ctx: ScoreContext = {},
): ScoreBreakdown {
  const hasDescr = !!descr.trim()

  /* ---- craft 轴:做得对不对 ---- */
  const fid = hasDescr ? scoreFidelity(dna, descr, ctx) : { v: 0.5, notes: [] as string[] }
  const craftDims: Record<string, number> = {
    fidelity: fid.v,
    structure: scoreStructure(dna, ctx),
    palette: scorePalette(dna),
    motion: scoreMotion(dna, ctx),
    narrative: scoreNarrative(dna, ctx),
    match: hasDescr ? scoreMatch(dna, descr) : 0.5,
  }
  const craft = weightedGeometricMean(craftDims, CRAFT_WEIGHTS)

  /* ---- appeal 轴:想不想看 ---- */
  const appealDims: Record<string, number> = {
    traits: scoreTraits(dna),
    silhouette: scoreSilhouette(ctx.parts, ctx.span),
    face: scoreFace(ctx.parts),
    colorPop: scoreColorPop(dna),
    motionRich: scoreMotionRich(dna, ctx),
  }
  const appeal = weightedGeometricMean(appealDims, APPEAL_WEIGHTS)

  const total = combineAxes(craft, appeal)

  const dims = {} as Record<ScoreKey, number>
  for (const k of CRAFT_KEYS) dims[k as ScoreKey] = round3(craftDims[k]!)
  for (const k of APPEAL_KEYS) dims[k as ScoreKey] = round3(appealDims[k]!)

  return {
    craft: round3(craft * 100),
    appeal: round3(appeal * 100),
    total: round3(total * 100),
    dims,
    fidelityNotes: fid.notes,
  }
}

/**
 * 作品分 `craft` = 0.45×heur + 0.55×judge,两者都在 0..100。
 *
 * `judgeSample` 为空(judge 未开启 / 调用失败)时退化为纯 heur —— **打分链路绝不
 * 因为模型不可用而阻塞创建**。
 */
export function craftScore(heur: number, judgeSamples: readonly number[]): number {
  const h = clamp01((Number(heur) || 0) / 100)
  if (!judgeSamples.length) return round3(h * 100)
  const j = clamp01(judgeSamples.reduce((a, b) => a + b, 0) / judgeSamples.length / 100)
  return round3((0.45 * h + 0.55 * j) * 100)
}

/* ---------------------------- 排名 ---------------------------- */

/** 人气分 0..1。饱和曲线:刷曝光上不去,只有「不同的人真的停下来」才推分。 */
export function heatOf(uniqViewers: number, uniqHovers: number, uniqClicks: number): number {
  const v = Math.max(0, uniqViewers | 0)
  const h = Math.max(0, uniqHovers | 0)
  const c = Math.max(0, uniqClicks | 0)
  return round3(1 - Math.exp(-(2 * v + 3 * h + 6 * c) / 20))
}

/**
 * 排名分(读取时算,不落库)。
 *
 * 作品分主导但不能一票否决(系数区间 0.55~1.0),人气分次之,时间衰减让新生物
 * 有机会上位 —— 榜单会轮换,但不会因为「今天新鲜」就把丑的顶上去。
 */
export function rankScore(craft: number, heat: number, ageDays: number): number {
  const c = clamp01((Number(craft) || 0) / 100)
  const h = clamp01(Number(heat) || 0)
  const age = Math.max(0, Number(ageDays) || 0)
  const quality = 0.55 + 0.45 * c
  const popularity = 0.55 + 0.45 * h
  const decay = (1 + age / 10) ** 0.35
  return round3((quality * popularity) / decay)
}

/** 排名项:读出来即可排序的最小集合 */
export interface RankedCreature {
  id: string
  craft: number
  heat: number
  ageDays: number
  rank: number
}

export function rankOf(
  rows: readonly { id: string; craft: number; ageDays: number; uniqViewers: number; uniqHovers: number; uniqClicks: number }[],
): RankedCreature[] {
  return rows
    .map((r) => {
      const heat = heatOf(r.uniqViewers, r.uniqHovers, r.uniqClicks)
      return { id: r.id, craft: r.craft, heat, ageDays: r.ageDays, rank: rankScore(r.craft, heat, r.ageDays) }
    })
    .sort((a, b) => b.rank - a.rank)
}

function round3(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0
}
