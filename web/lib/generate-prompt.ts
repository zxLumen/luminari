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

# 成长(这是产品的核心卖点:每天都看得见变化)

- 用 \`grow\` 让主要部件在 \`matureDay\` 天内持续变大。
- 用 \`appear\` 排一些**解锁**:斑纹、尾尖、耳尖、第二对翅等,分散在不同天数出现。
- 至少安排 4 个不同天数的 \`appear\`,让第 3 天、第 8 天、第 15 天、第 25 天各有新东西长出来。

# motionCfg(运动)

- \`family\`:该生物的主要运动方式,从上面枚举里选最贴切的一个。
- \`period\`:一个动作循环的秒数(越小的动物通常越快)。
- \`amplitude\`:整体幅度倍率 0~2。
- \`rules\`:可选,按部件 id 指定运动,{ "wingL": { "amp": 30, "phase": 0, "periodScale": 1 } }。
  不写也会按部件名自动推断(名字含 wing 就扇动、含 leg 就迈步、含 tail 就摆尾)。

# 约束

- 部件总数 **8~28 个**;不要超过 40。
- 每条 path 尽量简短(建议 < 300 字符),曲线用 2~4 段贝塞尔即可,不要试图画细节纹理。
- 颜色必须是 6 位十六进制。配色要和描述一致(赛博=霓虹青粉、深海=蓝紫、火=橙红、森林=绿黄、暗=灰青)。
- 生物要**一眼认得出**描述里的物种:先把标志性部位做对(翅膀的形状/腿的数量/耳朵/尾巴/角),
  再考虑花纹。
- 只输出 JSON。`

/** 附在用户消息末尾的少量 few-shot,压住最常见的两种错(忘坐标、部件太少) */
export const DIRECT_EXAMPLE = `示例(一只"深海发光水母",注意翅膀式的伞盖与下垂触手,以及分散的 appear 排期):

{"dna":{"name":"幽伞","archetype":"fish","palette":{"body":"#4fd6ff","accent":"#b06fe8","glow":"#d8f6ff"},"traits":{"mechanical":0,"organic":2,"ethereal":4,"fierce":1,"cute":1,"ancient":1,"cyber":0,"luminous":4},"motion":{"flapHz":1.8,"driftAmp":14,"bobPx":6,"trail":0.35,"spin":0.05}},"span":84,"matureDay":28,"parts":[
{"id":"bell","d":"M -34 0 C -34 -26 34 -26 34 0 C 34 16 -34 16 -34 0 Z","role":"accent","z":20},
{"id":"bellGlow","parent":"bell","d":"M -22 -4 C -22 -18 22 -18 22 -4 C 22 6 -22 6 -22 -4 Z","role":"glow","z":21,"appear":{"start":6,"end":14}},
{"id":"core","parent":"bell","d":"M -8 0 a 8 10 0 1 0 16 0 a 8 10 0 1 0 -16 0 Z","role":"bodyLight","z":22},
{"id":"tentacle","parent":"bell","d":"M 0 8 C -4 26 -2 40 3 52","role":"line","z":10,"stroke":2.4,"mirror":true,"x":-10,"y":6,"grow":{"from":0,"to":24,"a":0.5,"b":1}},
{"id":"tentacle2","parent":"bell","d":"M 0 10 C 4 24 2 36 -2 46","role":"line","z":11,"stroke":1.8,"mirror":true,"x":8,"y":8,"appear":{"start":8,"end":18}},
{"id":"frill","parent":"bell","d":"M 0 0 C 10 -6 22 -4 28 4 C 16 2 6 2 0 0 Z","role":"glow","z":19,"mirror":true,"x":-30,"y":2,"stroke":1.4,"appear":{"start":15,"end":24}}
],"motionCfg":{"family":"swim","period":2.6,"amplitude":1,"rules":{"tentacle":{"amp":11,"phase":0,"periodScale":1.4},"bell":{"amp":6}}}}`

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
