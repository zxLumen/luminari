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

# 成长(产品核心卖点:像「宝可梦 / 数码宝贝」那样进化 —— 每个阶段长成一个更明确的形态,而不是堆零件)

**先定「最终进化形态」,再倒推阶段。** 动手前先想清楚:这只生物**成年(约第 30 天)进化成什么样?那个「一看就记住」的标志性形态是什么?**
再拆成 0 / 2 / 8 / 19 天一步步长成它。**全程克制、清晰、可读**:每次进化后,整体仍是一只**干净、认得出**的生物。

**两种手段(都用来制造明显变化):**
- \`appear\`:**成长主力,而且必须用在「大件」上**。部件从「无」长出来(淡入 + 放大)。后期长出来的**必须是最显眼、最大、改变剪影的部件**(巨翼 / 大角 / 大冠 / 尾刃 / 外骨骼 / 光环),**不要**把 appear 浪费在小点 / 小环 / 小尖刺上(那样幼年和成年几乎看不出区别)。**6~10 个**。
- \`grow\`:让**标志性基础件明显长大**(如 翅 / 尾 / 肢 用 \`a≈0.4~0.6, b≈1.2~1.5\`);只有**小点缀件**才用轻微 \`0.9→1.1\`。

**进化节奏(真实天数,约 \`matureDay=30\` 天定型;要让「幼↔成」剪影差很多):**
- 第 0 天(幼体):只有**朴素、幼小的基础形态** —— 身体 / 头 / 眼 / 四肢 + **小**翅芽 / **短**尾。**最大的标志件此时要小、或还没有**。
- 第 ~2 天:长出 **1~2 个小件**(小角 / 尾尖)。
- 第 ~8 天:长出 **1~2 个成对主件**(一对翅 / 一对肩甲)—— 成对的用 \`mirror\`。
- 第 ~19 天起(觉醒):张开 / 长出 **最大的标志大件**(巨大能量翼、巨角、尾刃、外骨骼、光环)。

**每件新增都必须「有名字、有意义、贴合描述」,而且够大(最重要):**
- **尺寸硬要求:后期 \`appear\` / 长大的部件要「大」** —— 整体尺寸接近或超过本体的 0.5~1.0 倍,**明显改变剪影**。如果一件长出来「不仔细看都看不出」,就把它做大、或换成更大的部件。
- 先在心里给它起个名(「巨翼」「肩甲」「尾刃」「王冠」「反应堆」);**说不出名字、或作用重复的,就不要加**。
- **紧扣访客的描述**:每件都能从描述里找到依据(说"机械"就别长藤蔓;说"深海发光"就长生物荧光;说"火"就长炽翼 / 尾焰)。让最终形态**一眼看出是描述里那只长大后的样子**。
- **数量适中**:共 6~10 个进化件即可,但每一件都要有明确身份、不重复、且源自描述。
- **禁止同质**:同一功能只留一个;不要 3 片相似的鳍、5 根一样的刺。成对部件用 \`mirror\`,不手写多份。
- **有序、对称、贴合身体**,剪影干净;**禁止**散落在体外、看不出是什么的浮件(除非是明确且少量的粒子/光环)。
- **只围绕一个主题进化**(完全从访客描述延伸),别机械 + 有机 + 发光乱炖。

**正 / 反例:**
- 反例(不要):幼年已经长着大翅膀 / 大冠,成年只多几个小点小环 → 几乎看不出变化。
- 正例(要):小幼龙(**只有小翅芽**)→ 第 8 天长出一对翅 → 第 19 天张开【一对巨大能量翼】+【头顶巨冠】→ 剪影彻底变大变猛。

**硬规则:**
- **主体骨架禁止 appear**:身体主干 / 头 / 眼睛 / 四肢 —— 第 0 天就必须在(四肢可用较大 \`grow\` 慢慢长大)。**翅 / 尾 / 标志大件可以第 0 天很小、留到后面 appear 或长大**。第 0 天必须**有肉、完整、认得出物种**,绝不能空白。
- \`appear\` start/end 分散在 1~\`matureDay\`,**每个阶段都有新东西**,且**总数 6~10 个**;后期的大件要够大。

# motionCfg(运动)

- \`family\`:该生物的主要运动方式,从上面枚举里选最贴切的一个。
- \`period\`:一个动作循环的秒数(越小的动物通常越快)。
- \`amplitude\`:整体幅度倍率 0~2。
- \`rules\`:可选,按部件 id 指定运动,{ "wingL": { "amp": 30, "phase": 0, "periodScale": 1 } }。
  不写也会按部件名自动推断(名字含 wing 就扇动、含 leg 就迈步、含 tail 就摆尾)。

# 约束

- 部件总数 **12~20 个**;不要超过 22。**多而精**;其中 6~10 个「进化件」用 \`appear\` 分阶段出现。控制总量是为了保证生成够快。
- 每条 path 尽量简短(建议 < 300 字符);但**大型主件可放宽到 ~600 字符**(用 3~6 段贝塞尔),别为了省字符把大件画成小方块。
- **每个部件的 path 必须画在「靠近自己原点 (0,0)」处**;要挪位置就改父件的 \`x/y\`,**偏移量不要超过 \`span\` 的 0.5 倍**。**绝不要**把 path 画到离原点很远的地方 —— 那会变成悬空、和身体分家的碎片。
- 颜色必须是 6 位十六进制。配色要和描述一致(赛博=霓虹青粉、深海=蓝紫、火=橙红、森林=绿黄、暗=灰青)。
- 生物要**一眼认得出**描述里的物种:先把标志性部位做对(翅膀的形状/腿的数量/耳朵/尾巴/角),
  再考虑花纹。
- 只输出 JSON。`

/** 附在用户消息末尾的 few-shot:示范「完整个体 → 少而精、贴合描述的进化件(宝可梦 / 数码宝贝式)」 */
export const DIRECT_EXAMPLE = `示例(小火龙 → 火焰进化;每件都紧扣"火/龙"、有名字、不重复。第 0 天身体/头/眼/四肢/尾已完整;第 2 天尾焰+小角;第 8 天一对肩甲;第 19 天张开【一对巨大炽翼】;第 23 天【火冠】):

{"dna":{"name":"炎角","archetype":"dragon","palette":{"body":"#c9542a","accent":"#ffb03a","glow":"#ffe08a"},"traits":{"mechanical":0,"organic":3,"ethereal":1,"fierce":3,"cute":2,"ancient":1,"cyber":0,"luminous":3},"motion":{"flapHz":1.9,"driftAmp":13,"bobPx":5,"trail":0.3,"spin":0.1}},"span":92,"matureDay":30,"parts":[
{"id":"body","d":"M -28 0 C -22 -16 22 -16 28 0 C 22 16 -22 16 -28 0 Z","role":"body","z":20},
{"id":"belly","parent":"body","d":"M -16 3 C -10 11 10 11 16 3 C 8 8 -8 8 -16 3 Z","role":"bodyLight","z":21},
{"id":"neck","parent":"body","d":"M 0 0 C 6 -6 12 -11 17 -16","role":"body","z":24,"x":24,"y":-4,"stroke":7},
{"id":"head","parent":"neck","d":"M -8 -6 C -2 -12 10 -12 14 -6 C 15 2 7 8 -2 6 C -8 4 -10 -2 -8 -6 Z","role":"body","z":30,"x":17,"y":-16},
{"id":"jaw","parent":"head","d":"M -2 3 C 3 7 11 6 15 2 C 9 5 3 5 -2 3 Z","role":"bodyDark","z":32,"x":2,"y":1},
{"id":"eye","parent":"head","d":"M -2.4 0 a 2.4 2.4 0 1 0 4.8 0 a 2.4 2.4 0 1 0 -4.8 0 Z","role":"eye","z":40,"x":7,"y":-3,"mirror":true},
{"id":"legF","parent":"body","d":"M 0 0 C 2 8 2 14 -2 18","role":"line","z":42,"x":13,"y":8,"stroke":3,"mirror":true},
{"id":"legB","parent":"body","d":"M 0 0 C 2 8 2 14 -2 18","role":"line","z":41,"x":-13,"y":8,"stroke":3,"mirror":true},
{"id":"tail","parent":"body","d":"M 0 0 C -12 3 -22 8 -30 15","role":"body","z":18,"x":-28,"y":1,"stroke":6,"grow":{"from":0,"to":30,"a":0.9,"b":1.1}},
{"id":"tailFlame","parent":"tail","d":"M 0 0 C -6 -5 -5 -15 1 -20 C 0 -12 2 -5 0 0 Z","role":"glow","z":22,"x":-30,"y":13,"appear":{"start":2,"end":7}},
{"id":"horn","parent":"head","d":"M 0 0 C -2 -7 -1 -13 3 -17","role":"accent","z":50,"x":3,"y":-10,"stroke":3,"mirror":true,"appear":{"start":3,"end":8}},
{"id":"shoulderGuard","parent":"body","d":"M 0 0 C 4 -10 14 -13 22 -9 C 13 -5 7 -2 0 0 Z","role":"accentDark","z":33,"x":4,"y":-10,"mirror":true,"appear":{"start":8,"end":14}},
{"id":"greatWing","parent":"body","d":"M 0 0 C -22 -30 -62 -40 -86 -18 C -70 0 -34 8 -6 4 Z","role":"accent","z":11,"x":2,"y":-12,"mirror":true,"appear":{"start":19,"end":26}},
{"id":"crown","parent":"head","d":"M -10 0 C -8 -14 -2 -20 6 -24 C 6 -14 10 -8 14 0 C 6 -3 -2 -3 -10 0 Z","role":"accentLight","z":48,"x":-1,"y":-11,"appear":{"start":23,"end":29}}
],"motionCfg":{"family":"flap","period":1.7,"amplitude":1,"rules":{"greatWing":{"amp":38},"tail":{"amp":16}}}}`

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
