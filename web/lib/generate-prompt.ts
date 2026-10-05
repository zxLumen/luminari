/**
 * 让 LLM 现场生成「骨架 + DNA」的系统提示词。
 *
 * 设计立场(与 hand-authored rig 相反):
 *   - **不预设物种**。每次按提示词现写部件树,所以不会出现「所有描述都变成同一只蝴蝶」。
 *   - **让模型写 path,但把输出空间压到可校验的范围**:路径字符白名单、部件上限、
 *     数字区间;坏部件按条丢弃,不连累整只。
 *   - **写清坐标系与枢轴约定**,否则模型画出来的部件会全部堆在原点。
 *
 * 这一版是「直接写 path」路线;若效果不稳定,可切到 `STRUCTURED_PROMPT`(种类库)。
 */

import { BP_ROLES, MOTION_FAMILIES } from './creature/index.js'

/** 给模型看的部件配色角色说明 */
const ROLE_DOC = BP_ROLES.join(' / ')
const FAMILY_DOC = MOTION_FAMILIES.join(' / ')

export const DIRECT_PROMPT = `你是「生物骨架建模器」。用户在描述想养的一只虚构生物,你把它建模成一份**可渲染的部件树 JSON**,同时给出它的配色与性格。

**最重要的规则:严格使用下面给出的字段名与结构。不要自创字段、不要改名、不要加外层包装(不要 "schema"/"generator"/"creature" 这类键)。顶层必须有 dna / span / matureDay / parts / motionCfg 五个键。**

# 输出格式(只输出这一个 JSON,不要解释、不要 Markdown 代码块以外的任何文字)

{
  "dna": {
    "name": "≤4 个汉字的昵称",
    "archetype": "butterfly|fish|dragon|orb|insect|bird|plant|machine 之一",
    "palette": { "body": "#rrggbb", "accent": "#rrggbb", "glow": "#rrggbb" },
    "traits": { "mechanical":0, "organic":0, "ethereal":0, "fierce":0, "cute":0, "ancient":0, "cyber":0, "luminous":0 },
    "motion": { "flapHz": 2.4, "driftAmp": 16, "bobPx": 4, "trail": 0.2, "spin": 0.1 }
  },
  "span": 90,
  "matureDay": 30,
  "parts": [ ... ],
  "motionCfg": { "family": "${FAMILY_DOC} 之一", "period": 1.6, "amplitude": 1, "rules": {} }
}

# 坐标系与枢轴(最关键的规则,画错就会全部堆在一点)

- 局部坐标,**y 轴向下**(与 SVG 一致)。
- 坐标原点 (0,0) 是**整个生物的中心**。
- **每个部件的 path 以「它自己的附着点/旋转中心」为原点**,不是以画面原点为原点。
  例如翅膀:path 从 (0,0) 出发向外画,父部件用 x/y 把它摆到肩部;
  这样绕 (0,0) 旋转就是「绕翅根扇动」。
- 躯干放中心附近;头在躯干前端(通常是 +x 或 -y);四肢由躯干伸出。
- 单位与 \`span\` 同量纲:\`span\` 是成熟期的大致半宽,躯干长度取 \`span\` 的 0.4~1.2 倍。

# parts 每项字段

{ "id": "唯一英文标识(如 body/head/wingL/legFL/tail)",
  "parent": "可选,父部件 id;不写则是根部件",
  "d": "SVG path,必须以 M 或 m 开头;只能用 M L H V C S Q T A Z 的字母与数字逗号空格加点号",
  "role": "${ROLE_DOC} 之一",
  "z": 数字,越小越靠后(先画)",
  "x": 可选,相对父部件的偏移,
  "y": 可选,
  "rot": 可选,初始旋转角度,
  "mirror": true 表示自动镜像出左右对称的第二份(成对的翅/腿/耳用它),
  "stroke": 可选,大于 0 时改为描边(线宽),适合腿/须/翅脉等线状部件,
  "fixed": true 表示细线细节,不随整体缩放,
  "grow": 可选,{ "from":起始天, "to":结束天, "a":起始倍率, "b":结束倍率 } —— 让该部件随时间长大,
  "appear": 可选,{ "start":出现天, "end":完全显现天 } —— 让该部件某天才长出来
}

# 绘制顺序(用 z 控制)

从后到前建议:远侧肢体(z 5-9)→ 尾巴/翅(10-19)→ 躯干(20-29)→ 头(30-39)→ 近侧肢体(40-49)→ 眼睛/细节(50+)。
左右对称的部件用 \`mirror: true\`,**不要手写左右两份**。

# 成长(产品核心卖点:每天都看得见「长出新东西」,而不是把同一只放大)

**两种手段,用法完全不同:**
- \`grow\`:只用来做**轻微尺寸变化**(建议 \`a=0.85, b=1.1\`)。**不要**用它把主体部件从很小放大 ——
  那会让幼体变成「缩小版成体」,枯燥单调。\`grow\` 只是配角。
- \`appear\`:**成长的主力**。部件从「无」长出来(淡入 + 放大)。这才是「长出新组件」。**尽量多用。**

**目标:第 0 天就是一只完整、能认出物种的个体;之后不断「长出新的组件」,越来越丰富、越来越酷炫。**

把 4 个阶段排成一条**升级线**(下面是真实天数,约 \`matureDay=30\` 天定型):
- 第 0 天(素体):身体 / 头 / 眼 / 主色 / 主要轮廓都在 —— 朴素但**完整可辨认**。
- 第 ~2 天(幼体):长出一批**小配件**(小角 / 须 / 小鳍 / 斑纹 / 小尖刺)。
- 第 ~8 天(成体):长出**成对的主要部件**(第二对翅 / 尾节 / 装甲片 / 背鳍 / 发光节点)。
- 第 ~19 天(觉醒):长出**最酷炫的**(能量环 / 光冠 / 光环 / 机械外挂 / 粒子 / 大面积发光纹)。

要求:
- **核心部件禁止 appear**:身体主干、头、眼睛、主要的一对四肢(腿/翅/鳍)或尾 —— 这些**第 0 天就必须在**
  (用轻微 \`grow\` 或完全不写成长字段)。**只允许极少数非关键部件晚点出现**。第 0 天渲染出来必须**有肉、完整、认得出物种**,绝不能几乎空白。
- \`appear\` **只加在「后来长出的附加部件」上**:额外的角/冠/刺、第二/第三对翅或肢、装甲片、发光节点/能量环、
  花纹/眼斑、须/触手、机械外挂……**不要**把身体/头/眼/主肢标上 appear。
- \`appear\` 数量**尽量多**(建议 8~16 个;**越科幻 / 越强大 / 描述越丰富就越多**)。
- \`appear\` 的 start/end **分散铺开**在 1~matureDay 之间,**每个阶段都有新组件**,不要全挤在开头或结尾。
- 「长什么新组件」**由你根据访客描述自行决定**(最能出彩的地方):机械 → 外挂/装甲/指示灯/能量环;
  有机 → 角/鳍/鳞/花纹;空灵 → 光晕/飘带/粒子;猛兽 → 尖刺/獠牙/装甲。目标是**每次解锁都让人「哇」一下**。

# motionCfg(运动)

- \`family\`:该生物的主要运动方式,从上面枚举里选最贴切的一个。
- \`period\`:一个动作循环的秒数(越小的动物通常越快)。
- \`amplitude\`:整体幅度倍率 0~2。
- \`rules\`:可选,按部件 id 指定运动,{ "wingL": { "amp": 30, "phase": 0, "periodScale": 1 } }。
  不写也会按部件名自动推断(名字含 wing 就扇动、含 leg 就迈步、含 tail 就摆尾)。

# 约束

- 部件总数 **12~36 个**(按描述复杂度伸缩);不要超过 48。其中**大部分新增部件用 \`appear\` 分阶段出现**。
- 每条 path 尽量简短(建议 < 300 字符),曲线用 2~4 段贝塞尔即可,不要试图画细节纹理。
- 颜色必须是 6 位十六进制。配色要和描述一致(赛博=霓虹青粉、深海=蓝紫、火=橙红、森林=绿黄、暗=灰青)。
- 生物要**一眼认得出**描述里的物种:先把标志性部位做对(翅膀的形状/腿的数量/耳朵/尾巴/角),
  再考虑花纹。
- 只输出 JSON。`

/** 附在用户消息末尾的 few-shot:示范「第 0 天已完整 + 之后不断长出新组件」 */
export const DIRECT_EXAMPLE = `示例(一只"机械幼龙":第 0 天身体/头/眼/四肢/尾已经完整;之后用大量 appear 按阶段长出 角→核心→翅→翅脉→背甲→尾刺→光冠→能量环→鳍 等新组件):

{"dna":{"name":"铆爪","archetype":"dragon","palette":{"body":"#3a4a6b","accent":"#ff7a3c","glow":"#7ef9ff"},"traits":{"mechanical":4,"organic":1,"ethereal":1,"fierce":3,"cute":1,"ancient":2,"cyber":3,"luminous":2},"motion":{"flapHz":2,"driftAmp":14,"bobPx":5,"trail":0.25,"spin":0.1}},"span":96,"matureDay":30,"parts":[
{"id":"body","d":"M -30 0 C -22 -16 22 -16 30 0 C 22 16 -22 16 -30 0 Z","role":"body","z":20},
{"id":"belly","parent":"body","d":"M -18 2 C -12 12 12 12 18 2 C 8 8 -8 8 -18 2 Z","role":"bodyLight","z":21},
{"id":"neck","parent":"body","d":"M 0 0 C 8 -4 14 -9 18 -15","role":"body","z":24,"x":26,"y":-6,"stroke":7},
{"id":"head","parent":"neck","d":"M -8 -6 C -2 -13 10 -13 14 -6 C 16 2 8 8 -2 6 C -8 4 -10 -2 -8 -6 Z","role":"body","z":30,"x":18,"y":-15},
{"id":"eye","parent":"head","d":"M -2.6 0 a 2.6 2.6 0 1 0 5.2 0 a 2.6 2.6 0 1 0 -5.2 0 Z","role":"eye","z":40,"x":6,"y":-3,"mirror":true},
{"id":"legF","parent":"body","d":"M 0 0 C 2 8 2 14 -2 18","role":"line","z":42,"x":14,"y":8,"stroke":3,"mirror":true},
{"id":"legB","parent":"body","d":"M 0 0 C 2 8 2 14 -2 18","role":"line","z":41,"x":-14,"y":8,"stroke":3,"mirror":true},
{"id":"tail","parent":"body","d":"M 0 0 C -12 2 -22 6 -30 12","role":"body","z":18,"x":-30,"y":2,"stroke":6,"grow":{"from":0,"to":30,"a":0.9,"b":1.1}},
{"id":"horn","parent":"head","d":"M 0 0 C -2 -8 -1 -14 3 -18","role":"accent","z":50,"x":2,"y":-10,"stroke":3,"mirror":true,"appear":{"start":2,"end":7}},
{"id":"core","parent":"body","d":"M -4 0 a 4 4 0 1 0 8 0 a 4 4 0 1 0 -8 0 Z","role":"glow","z":27,"appear":{"start":4,"end":10}},
{"id":"wing","parent":"body","d":"M 0 0 C -18 -22 -46 -26 -54 -8 C -40 2 -18 4 0 0 Z","role":"accent","z":12,"x":4,"y":-10,"mirror":true,"appear":{"start":6,"end":13}},
{"id":"wingVein","parent":"wing","d":"M 0 0 C -16 -12 -34 -16 -48 -6","role":"glow","z":13,"stroke":1.4,"appear":{"start":8,"end":14}},
{"id":"backPlate","parent":"body","d":"M 0 0 C 6 -4 14 -4 20 0 C 14 4 6 4 0 0 Z","role":"accentDark","z":26,"x":8,"y":-12,"mirror":true,"appear":{"start":10,"end":16}},
{"id":"tailSpike","parent":"tail","d":"M 0 0 L 4 -8 L 8 0 Z","role":"accent","z":22,"x":-30,"y":12,"appear":{"start":14,"end":20}},
{"id":"crest","parent":"head","d":"M -6 0 C -2 -10 2 -10 6 0 C 2 -4 -2 -4 -6 0 Z","role":"glow","z":48,"x":0,"y":-12,"appear":{"start":18,"end":24}},
{"id":"energyRing","parent":"body","d":"M -40 0 a 40 22 0 1 0 80 0 a 40 22 0 1 0 -80 0 Z","role":"glow","z":5,"stroke":2,"fixed":true,"appear":{"start":19,"end":26}},
{"id":"fin","parent":"body","d":"M 0 0 C -6 -14 -2 -24 8 -28 C 4 -16 6 -8 0 0 Z","role":"accentLight","z":14,"x":-6,"y":-8,"mirror":true,"appear":{"start":22,"end":28}}
],"motionCfg":{"family":"flap","period":1.8,"amplitude":1,"rules":{"wing":{"amp":34},"tail":{"amp":16}}}}`

/** 组装最终发给模型的 messages */
export function buildGenerateMessages(descr: string, retryHint?: string) {
  const user = [
    `请为这只生物建模:${descr}`,
    '',
    DIRECT_EXAMPLE,
    '',
    retryHint ? `上一次生成的问题:${retryHint}。这次请修正。` : '',
    '只输出 JSON,严格用规定的字段名(dna / span / matureDay / parts / motionCfg)。',
  ]
    .filter(Boolean)
    .join('\n')

  return [
    { role: 'system' as const, content: DIRECT_PROMPT },
    { role: 'user' as const, content: user },
  ]
}

/**
 * 生成用的 max_tokens 阶梯。
 *
 * 推理模型(deepseek-v4.1-flash)会先写几千 token 的思维链再产出正文。实测:同一段
 * 完整 prompt 下,思维链+正文经常到 6~8k,偶尔更多 —— 预算卡在 8192 时会**正好被截断**,
 * 正文成半截 JSON(表现为耗时很久、然后 422)。
 *
 * 所以首档直接给到 20000(多出来的额度不用不花钱),再留一档退路。
 */
export const GENERATE_BUDGETS = [20_000, 12_000] as const

/* ------------------------------------------------------------------ */
/* 退路:结构化「种类库」提示词                                          */
/* ------------------------------------------------------------------ */

/**
 * 当「直接写 path」效果不稳定时可切到这里:让模型只填**种类 + 参数 + 位置**,
 * 由代码(而非模型)生成路径。输出空间更小、几乎不可能出现断裂路径。
 *
 * 目前只是与主提示词**并存**,用 `?mode=structured` 或 admin 开关切换对比,
 * 不改变主路径。真正接线(把 appendage 种类展开成 path)是下一步;
 * 这里先把提示词与契约固定下来,便于 A/B。
 */
export const STRUCTURED_PROMPT = `你是「生物参数生成器」。用户描述一只虚构生物,你输出它的**参数**;路径由渲染程序生成,你不要写 SVG。

只输出一个 JSON:
{
  "dna": { "name":"≤4字", "archetype":"butterfly|fish|dragon|orb|insect|bird|plant|machine",
           "palette": { "body":"#rrggbb","accent":"#rrggbb","glow":"#rrggbb" },
           "traits": { "mechanical":0,"organic":0,"ethereal":0,"fierce":0,"cute":0,"ancient":0,"cyber":0,"luminous":0 },
           "motion": { "flapHz":2.4,"driftAmp":16,"bobPx":4,"trail":0.2,"spin":0.1 } },
  "span": 90,
  "matureDay": 30,
  "body": { "length":1.0, "width":0.5, "curve":0.2, "segments":3 },
  "appendages": [
    { "kind":"wing|leg|fin|tail|horn|antenna|eye|spot|shell|spike",
      "count":4, "len":1.6, "width":0.35, "at":[0.6,0.1], "angle":20,
      "mirror":true, "z":15, "role":"accent",
      "grow":{"from":0,"to":30,"a":0.5,"b":1},
      "appear":{"start":5,"end":14} }
  ],
  "motionCfg": { "family":"flap|walk|hop|swim|idle|glide|breathe", "period":1.6, "amplitude":1 }
}

约束:appendages 共 3~8 项;kind 只能取上面枚举;mirror 表示自动左右对称;
at 是 [沿身体 0~1 的位置, 偏离中轴的比例 -1~1];数字都用相对单位(1 ≈ span 的百分之一量级)。
配色与描述一致。只输出 JSON。

此时服务端把 appendages 展开成具体 path(见 compileStructured),所以你要关心的是
「有几对翅/几条腿/尾巴多长」这类**结构比例**,不是曲线形状。`

/** 该描述默认该用哪种模式(目前只影响展示,接线见 route 的 mode 参数) */
export type GenMode = 'direct' | 'structured'
