/**
 * 结构化随机描述 —— 给「校验打分系统」当样本源。
 *
 * **为什么不直接扔随机字符串**:那样 30 只的分数会全挤在一条窄带里,排出来的名次
 * 没有任何信息量。这里按「描述丰富度」分三档批量出题:
 *
 *  - `sparse` 只有主体(「一只深海发光水母」)—— 模型没料可发挥;
 *  - `medium` 加配色与一个动态;
 *  - `rich` 再叠质感、双色、辉光、双特质、动态、怪癖。
 *
 * 于是「丰富度 → 总分」应该呈上升趋势。**这条趋势就是校验点**:如果三档平均分
 * 挤在一起,说明评分在吃噪声,而不是在认描述质量。
 *
 * 词表刻意覆盖 `heuristicScore` 的五个分项:配色对比(双色 + 辉光)、特质分散
 * (两个不同轴)、动效参数(明确的动作词)、叙事(怪癖带来的性格)、词面契合
 * (用词与 archetype 的对应关系)。
 *
 * **带种子且确定性**:同一个 seed 必出同一批描述,调评分权重时能拿同一批样本
 * 复跑对比,不会因为换了一批题就说「分数变了」。
 */

/** mulberry32:小、快、无依赖,同 seed 同序列 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------ 词表 ------------------------------ */

const ARCHETYPES = [
  '深海发光水母',
  '六足节甲虫',
  '圆滚滚的小狐狸',
  '长着金属鳞片的幼龙',
  '会呼吸的光球',
  '钢铁浇铸的甲虫机器人',
  '长着鹿角的雪豹',
  '玻璃质外壳的浮空水母',
  '藤蔓缠身的石兽',
  '半透明翼的飞蛾',
  '背壳里嵌满齿轮的陆龟',
  '珊瑚枝一样分叉的浮游生物',
] as const

/** 两两搭配,保证每条都有「主色 + 辅色」的对比,喂 palette 分项 */
const COLORS = [
  '靛蓝渐变到珊瑚粉',
  '琥珀色镶着青铜',
  '墨绿的壳配血橙的内衬',
  '霜白点缀极光紫',
  '炭黑配荧光绿的纹路',
  '赭石里透着孔雀蓝',
  '烟灰底子上撒着金斑',
  '青柠绿缠着深紫',
] as const

const TEXTURES = [
  '半透明',
  '覆满苔藓与蘑菇的',
  '由金属碎屑焊成的',
  '绒毛蓬松的',
  '表面刻着古老纹路的',
  '外壳布满裂纹的',
  '湿漉漉、泛着水光的',
  '纸一样薄的',
] as const

const GLOWS = [
  '翅脉里流淌着蓝光',
  '腹下透出暖黄的辉光',
  '完全没有辉光',
  '触须尖端闪着冷白的光',
  '体表浮动着细碎的光点',
  '角尖亮起一小团橙火',
] as const

/** 成对抽,尽量落在不同特质轴上,喂 traits 分项 */
const TRAITS = [
  '六条腿',
  '一对鹿角',
  '长满吸盘的触手',
  '背后拖着一条金属尾链',
  '头顶一簇会开合的鳍',
  '两片半透明的翼',
  '颈上套着一圈珊瑚',
  '尾巴分成三股',
  '背上生着一丛菌盖',
  '腹面裂开一道会呼吸的缝',
] as const

const MOTIONS = [
  '移动时关节会依次亮起',
  '游动时身体像果冻一样颤',
  '悬停时会缓慢自转',
  '尾鳍摆动带动前进',
  '静止时几乎一动不动',
  '每一步落地都溅起细小光点',
  '呼吸时整体明暗起伏',
  '转向靠身体先歪再跟上',
] as const

const QUIRKS = [
  '饥饿时会慢慢变暗',
  '靠近时会发出很轻的哼鸣',
  '每隔几秒换一次主色',
  '走路永远走 S 弯',
  '睡觉时把自己缩成一个球',
  '被盯着看会慢慢变色',
  '喜欢把石子藏在身下',
  '雨天会张开背上那层壳',
] as const

/* ------------------------------ 出题 ------------------------------ */

/** 描述丰富度。**它是这批样本的自变量** —— 校验就看它与总分的关系 */
export type Density = 'sparse' | 'medium' | 'rich'

export interface RandomItem {
  /** 批次内序号(从 1 起),用作 React key */
  id: number
  descr: string
  density: Density
}

export interface RandomBatch {
  seed: number
  items: RandomItem[]
}

const DENSITY_CYCLE: readonly Density[] = ['sparse', 'medium', 'rich']

/**
 * 不放回取样:洗一次牌顺序取,取完再洗。
 *
 * 「校验 30 只」时**重复描述等于浪费一个槽位**,而 `/api/creature/generate` 的
 * 缓存已去掉,重复题会真的再烧一次 token。所以同一档内靠它保证原型不重复。
 */
function shuffled(r: () => number, xs: readonly unknown[]): unknown[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * 出 `n` 条描述。
 *
 * **按三连一组的实验设计铺开**:`sparse → medium → rich` 循环,同一组三档**共用
 * 同一个原型**,只改描述的丰富度。这样「丰富度」成了唯一自变量,可以直接对比
 * 同一种动物在稀疏 / 中等 / 丰富描述下的得分 —— 这才是校验评分系统想要的那个
 * 对照组(同原型控制了「动物本身好不好看」这个混淆变量)。
 *
 * 数量上取整到 3 的倍数;余数按 `sparse → medium → rich` 的顺序截断。
 */
export function randomBatch(n: number, seed = Date.now() >>> 0): RandomBatch {
  const r = rng(seed)
  const archetypes = shuffled(r, ARCHETYPES) as string[]
  const textures = shuffled(r, TEXTURES) as string[]
  const colors = shuffled(r, COLORS) as string[]
  const glows = shuffled(r, GLOWS) as string[]
  const traitPool = shuffled(r, TRAITS) as string[]
  const motions = shuffled(r, MOTIONS) as string[]
  const quirks = shuffled(r, QUIRKS) as string[]

  const items: RandomItem[] = []
  for (let i = 0; i < n; i++) {
    const density = DENSITY_CYCLE[i % DENSITY_CYCLE.length]!
    // 组内共用同一原型(每 3 条换一次)
    const g = Math.floor(i / DENSITY_CYCLE.length)
    const arch = archetypes[g % archetypes.length]!
    const color = colors[g % colors.length]!
    const motion = motions[g % motions.length]!
    const quirk = quirks[g % quirks.length]!
    const glow = glows[g % glows.length]!
    const tex = textures[g % textures.length]!
    // 两个特质在打乱的池子里按序取,保证同组三档里拿到的还是那对
    const t1 = traitPool[(g * 2) % traitPool.length]!
    const t2 = traitPool[(g * 2 + 1) % traitPool.length]!

    let descr: string
    if (density === 'sparse') {
      descr = `一只${arch}`
    } else if (density === 'medium') {
      descr = `一只${color}的${arch},${motion}`
    } else {
      descr = `一只${tex}、${color}的${arch},${t1},${t2};${glow};${motion};${quirk}`
    }
    items.push({ id: i + 1, descr, density })
  }
  return { seed, items }
}

export const DENSITY_LABEL: Record<Density, string> = {
  sparse: '稀疏',
  medium: '中等',
  rich: '丰富',
}
