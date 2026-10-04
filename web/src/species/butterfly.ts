import { ellipseD, norm, type Override, type Part, type Rig } from './types'

/**
 * 蝴蝶(俯视,展翅飞行)。
 *
 * 一眼认得出的关键不是「身体」,而是**翅形**:前翅长、前缘斜、翅尖略尖;后翅圆而下坠。
 * 扇翅 = 左右翅各自绕翅根旋转(镜像份由引擎自动生成,旋转方向天然对称)。
 *
 * 成长排期(逐日可见,到第 ~34 天才基本定型):
 *   1–4   前翅冒头成形      2–6   后翅补上
 *   4–18  翅脉 / 前缘深边 / 内浅斑陆续出现
 *   8–20  翅斑(前 1、后 1)
 *   20–28 前翅翅尖出深色斑块
 *   26–36 后翅长出眼斑(外深内亮)
 *   30–38 前翅第三枚浅斑
 *   全程   展翅尺寸持续长大、触角变长
 */

const FORE_D = 'M 0 0 C 14 -30 40 -50 66 -52 C 70 -40 62 -26 46 -16 C 30 -6 14 0 0 0 Z'
const HIND_D = 'M 0 0 C 16 -6 40 -2 50 12 C 58 24 54 42 40 48 C 24 54 6 40 0 22 Z'

const wingGrow = (a: number, b: number) => (day: number) => 0.42 + 0.58 * norm(day, a, b)

/** 从翅根发散的翅脉(作为翅的子部件,继承翅的镜像) */
function veins(id: string, parent: string, z: number, ds: string[], from: number): Part[] {
  return ds.map((d, i) => ({
    id: `${id}${i}`,
    parent,
    role: 'accentDark' as const,
    z: z + i,
    d,
    stroke: 1.3,
    fixed: true,
    appear: (day) => norm(day, from + i * 2, from + 6 + i * 2),
  }))
}

export const butterfly: Rig = {
  id: 'butterfly',
  label: '蝴蝶',
  hint: '俯视展翅:翅根扇动 + 身体起伏;翅展/翅脉/翅斑/眼斑/触角逐日生长',
  span: 86,
  parts: [
    /* ---------------- 后翅(先画,压在前翅下) ---------------- */
    {
      id: 'hindwing',
      parent: 'thorax',
      role: 'accent',
      z: 10,
      x: 3,
      y: 8,
      d: HIND_D,
      mirror: true,
      appear: (day) => norm(day, 2, 6),
      grow: wingGrow(2, 30),
    },
    ...veins('hindVein', 'hindwing', 11, ['M 1 2 C 10 8 19 15 25 23', 'M 1 5 C 11 12 17 20 18 28'], 8),
    {
      id: 'hindInner',
      parent: 'hindwing',
      role: 'accentLight',
      z: 13,
      d: 'M 1 2 C 12 2 26 8 34 18 C 22 14 10 8 2 5 Z',
      appear: (day) => norm(day, 8, 18),
    },
    {
      id: 'hindEye',
      parent: 'hindwing',
      role: 'accentDark',
      z: 20,
      x: 30,
      y: 30,
      d: ellipseD(7.5, 7.5),
      appear: (day) => norm(day, 26, 34),
    },
    {
      id: 'hindEyeDot',
      parent: 'hindwing',
      role: 'glow',
      z: 21,
      x: 30,
      y: 30,
      d: ellipseD(3.6, 3.6),
      appear: (day) => norm(day, 28, 36),
    },

    /* ---------------- 前翅 ---------------- */
    {
      id: 'forewing',
      parent: 'thorax',
      role: 'accent',
      z: 16,
      x: 4,
      y: -8,
      d: FORE_D,
      mirror: true,
      appear: (day) => norm(day, 1, 4),
      grow: wingGrow(1, 28),
    },
    {
      id: 'foreEdge',
      parent: 'forewing',
      role: 'accentDark',
      z: 17,
      d: 'M 2 -3 C 16 -31 40 -49 64 -51 C 68 -42 64 -32 56 -26',
      stroke: 3.5,
      appear: (day) => norm(day, 4, 12),
    },
    ...veins('foreVein', 'forewing', 18, [
      'M 3 -1 C 16 -22 36 -38 56 -48',
      'M 3 0 C 22 -18 42 -28 60 -34',
      'M 3 1 C 26 -8 46 -14 62 -16',
    ], 5),
    {
      id: 'foreInner',
      parent: 'forewing',
      role: 'accentLight',
      z: 19,
      d: 'M 3 -2 C 12 -18 26 -32 40 -40 C 34 -24 22 -12 6 -2 Z',
      appear: (day) => norm(day, 6, 16),
    },
    {
      id: 'foreSpotA',
      parent: 'forewing',
      role: 'glow',
      z: 22,
      x: 43,
      y: -30,
      d: ellipseD(6, 6),
      appear: (day) => norm(day, 8, 16),
    },
    {
      id: 'foreSpotB',
      parent: 'forewing',
      role: 'bodyLight',
      z: 22,
      x: 62,
      y: -38,
      d: ellipseD(3.2, 3.2),
      appear: (day) => norm(day, 12, 20),
    },
    {
      id: 'foreApex',
      parent: 'forewing',
      role: 'accentDark',
      z: 23,
      d: 'M 44 -50 C 56 -50 66 -44 69 -34 C 61 -38 52 -44 42 -47 Z',
      appear: (day) => norm(day, 20, 28),
    },
    {
      id: 'foreSpotC',
      parent: 'forewing',
      role: 'bodyLight',
      z: 22,
      x: 28,
      y: -40,
      d: ellipseD(3.8, 3.8),
      appear: (day) => norm(day, 30, 38),
    },

    /* ---------------- 足:三对,向两侧张开 ---------------- */
    {
      id: 'legFront',
      parent: 'thorax',
      role: 'line',
      z: 6,
      x: 3,
      y: -14,
      d: 'M 0 0 C 4 2 7 5 9 9',
      stroke: 1.7,
      mirror: true,
      fixed: true,
      grow: (day) => 0.5 + 0.5 * norm(day, 0, 12),
    },
    {
      id: 'legMid',
      parent: 'thorax',
      role: 'line',
      z: 7,
      x: 4,
      y: -6,
      d: 'M 0 0 C 5 1 9 3 12 6',
      stroke: 1.7,
      mirror: true,
      fixed: true,
      grow: (day) => 0.5 + 0.5 * norm(day, 0, 12),
    },
    {
      id: 'legBack',
      parent: 'thorax',
      role: 'line',
      z: 8,
      x: 3,
      y: 2,
      d: 'M 0 0 C 4 3 8 6 10 11',
      stroke: 1.7,
      mirror: true,
      fixed: true,
      grow: (day) => 0.5 + 0.5 * norm(day, 0, 12),
    },

    /* ---------------- 身体 ---------------- */
    {
      id: 'abdomen',
      parent: 'thorax',
      role: 'bodyDark',
      z: 28,
      d: 'M -4.5 4 C -6 18 -4 34 0 48 C 4 34 6 18 4.5 4 Z',
      grow: (day) => 0.5 + 0.5 * norm(day, 0, 26),
    },
    { id: 'thorax', role: 'bodyDark', z: 30, x: 0, y: -12, d: ellipseD(6.5, 13) },
    { id: 'thoraxLine', parent: 'thorax', role: 'bodyLight', z: 31, x: 0, y: -2, d: ellipseD(2, 7) },
    { id: 'head', parent: 'thorax', role: 'bodyDark', z: 40, x: 0, y: -16, d: ellipseD(7.5, 7.5) },
    { id: 'eyeL', parent: 'head', role: 'eye', z: 42, x: -3.6, y: -1, d: ellipseD(2.4, 2.8), mirror: true },

    /* ---------------- 触角 ---------------- */
    {
      id: 'antenna',
      parent: 'head',
      role: 'line',
      z: 20,
      d: 'M 0 -3 C -7 -16 -13 -26 -19 -34',
      stroke: 2,
      mirror: true,
      fixed: true,
      grow: (day) => 0.35 + 0.65 * norm(day, 1, 26),
    },
    {
      id: 'antennaTip',
      parent: 'antenna',
      role: 'bodyDark',
      z: 20,
      x: -19,
      y: -34,
      d: ellipseD(2.7, 2.7),
      fixed: true,
      grow: (day) => 0.35 + 0.65 * norm(day, 1, 26),
    },
  ],

  pose(form, ts, day) {
    const f = Math.max(0.8, Math.min(4, form.flapHz))
    const w = ts * f * Math.PI * 2
    void day
    return {
      thorax: { y: -12 + Math.sin(w) * 2.6, rot: Math.sin(w) * 3 },
      forewing: { rot: 8 + Math.sin(w) * 26 },
      hindwing: { rot: 4 + Math.sin(w + 0.5) * 20 },
      antenna: { rot: Math.sin(ts * 1.7) * 7 },
    } satisfies Record<string, Override>
  },
}
