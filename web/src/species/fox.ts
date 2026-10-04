import { ellipseD, norm, type Override, type Part, type Rig } from './types'

/**
 * 狐狸(侧视,朝右;跳跃/蹦跳循环)。
 *
 * 认得出的关键:尖吻 + 大三角耳 + 大蓬尾 + 四足。远侧两条腿画在身体**后面**、整体压暗、
 * 与近侧腿**错开一点 x**(完全重合就会被身体盖得看不见,失去前后层次)。
 *
 * 成长排期(逐日可见,到第 ~30 天才基本定型):
 *   0–22  头 / 腿 / 身 持续长
 *   0–24  尾巴变长变蓬
 *   4–16  深色爪、白胸、尾尖白
 *   10–18 浅色吻部
 *   22–30 胸口出现白斑
 *   24–32 耳尖转深
 *   28–36 尾巴多一道浅色绒纹
 */

function leg(id: string, x: number, y: number, role: 'body' | 'bodyDark', z: number): Part[] {
  return [
    {
      id,
      parent: 'body',
      role,
      z,
      x,
      y,
      d: 'M -3.4 0 C -4.6 12 -3.4 24 0 34 C 3.4 24 4.6 12 3.4 0 Z',
      grow: (day) => 0.5 + 0.5 * norm(day, 0, 22),
    },
    {
      id: `${id}-paw`,
      parent: id,
      role: 'black',
      z: z + 1,
      x: 1,
      y: 33,
      d: 'M -4 -3 C -4 2 4 2 4 -3 C 4 -6 -4 -6 -4 -3 Z',
      appear: (day) => norm(day, 4, 12),
    },
  ]
}

export const fox: Rig = {
  id: 'fox',
  label: '狐狸',
  hint: '侧视四足:蹦跳循环 + 身体挤压拉伸 + 尾巴延迟;耳/腿/尾/斑纹逐日生长',
  span: 88,
  parts: [
    /* ---------------- 远侧腿(画在身体后,压暗、错开) ---------------- */
    ...leg('legFR', 13, 6, 'bodyDark', 6),
    ...leg('legBR', -25, 6, 'bodyDark', 6),

    /* ---------------- 尾巴 ---------------- */
    {
      id: 'tail',
      parent: 'body',
      role: 'body',
      z: 10,
      x: -28,
      y: -6,
      d: 'M 0 10 C -22 8 -46 -2 -58 -26 C -50 -40 -32 -36 -22 -22 C -14 -8 -8 2 0 10 Z',
      grow: (day) => 0.4 + 0.6 * norm(day, 0, 24),
    },
    {
      id: 'tailTip',
      parent: 'tail',
      role: 'bodyLight',
      z: 11,
      d: 'M -22 -22 C -32 -36 -50 -40 -58 -26 C -53 -43 -34 -47 -22 -31 C -18 -27 -18 -23 -22 -22 Z',
      appear: (day) => norm(day, 4, 12),
      grow: (day) => 0.4 + 0.6 * norm(day, 0, 24),
    },
    {
      id: 'tailFluff',
      parent: 'tail',
      role: 'bodyLight',
      z: 12,
      x: -10,
      y: 4,
      d: 'M 0 0 C -12 2 -26 -2 -36 -12 C -28 -12 -16 -8 -6 -2 Z',
      appear: (day) => norm(day, 28, 36),
    },

    /* ---------------- 躯干 ---------------- */
    {
      id: 'body',
      role: 'body',
      z: 20,
      d: 'M -32 2 C -36 -12 -26 -21 -10 -21 L 20 -21 C 35 -19 41 -10 39 1 C 37 12 25 16 6 15 L -22 13 C -30 12 -34 8 -32 2 Z',
    },
    {
      id: 'belly',
      parent: 'body',
      role: 'bodyLight',
      z: 21,
      d: 'M -20 14 C -4 20 19 19 33 8 C 29 16 11 19 -6 17 L -20 15 C -24 14.5 -24 13.5 -20 14 Z',
      appear: (day) => norm(day, 6, 16),
    },
    {
      id: 'chest',
      parent: 'body',
      role: 'bodyLight',
      z: 22,
      x: 17,
      y: -6,
      d: 'M 0 0 C 7 3 8 12 5 19 C -1 14 -3 6 0 0 Z',
      appear: (day) => norm(day, 22, 30),
    },

    /* ---------------- 头 ---------------- */
    {
      id: 'head',
      parent: 'body',
      role: 'body',
      z: 30,
      x: 22,
      y: -14,
      d: 'M -10 -12 C 0 -24 16 -26 24 -18 L 34 -10 C 37 -7 36 -4 32 -4 L 4 -2 C -4 -2 -10 -6 -10 -12 Z',
      grow: (day) => 0.55 + 0.45 * norm(day, 0, 22),
    },
    {
      id: 'cheek',
      parent: 'head',
      role: 'bodyLight',
      z: 31,
      d: 'M 16 -8 L 33 -10 C 36 -7 35 -4 31 -4 L 14 -3 C 12 -6 13 -8 16 -8 Z',
      appear: (day) => norm(day, 10, 18),
    },
    { id: 'nose', parent: 'head', role: 'nose', z: 33, x: 33, y: -6, d: ellipseD(2.7, 2.2) },
    { id: 'eye', parent: 'head', role: 'eye', z: 34, x: 10, y: -14, d: ellipseD(2.4, 2.8) },
    {
      id: 'ear',
      parent: 'head',
      role: 'body',
      z: 29,
      x: -1,
      y: -13,
      d: 'M 0 0 L 5 -23 L 19 -6 Z',
      mirror: true,
      grow: (day) => 0.5 + 0.5 * norm(day, 0, 20),
    },
    {
      id: 'earIn',
      parent: 'ear',
      role: 'accentDark',
      z: 30,
      x: 1.5,
      y: -2,
      d: 'M 0 0 L 4.5 -15 L 13 -4 Z',
      appear: (day) => norm(day, 4, 12),
      grow: (day) => 0.5 + 0.5 * norm(day, 0, 20),
    },
    {
      id: 'earTip',
      parent: 'ear',
      role: 'black',
      z: 31,
      d: 'M 0 -15 L 5 -23 L 10 -13 Z',
      appear: (day) => norm(day, 24, 32),
    },

    /* ---------------- 近侧腿(画在身体前) ---------------- */
    ...leg('legFL', 22, 6, 'body', 40),
    ...leg('legBL', -16, 6, 'body', 40),
  ],

  pose(form, ts, day) {
    const g = 1.6
    const ph = (ts % g) / g
    const air = ph < 0.55 ? Math.sin((ph / 0.55) * Math.PI) : 0
    const land = ph >= 0.55 ? Math.sin(((ph - 0.55) / 0.45) * Math.PI) : 0
    void form
    void day
    return {
      body: {
        y: -air * 15 + land * 3,
        sy: 1 - air * 0.08 + land * 0.12,
        sx: 1 + air * 0.06 - land * 0.09,
        rot: -air * 5,
      },
      head: { rot: air * 9 },
      tail: { rot: -6 - air * 16 + Math.sin(ts * 1.3) * 5 },
      legFL: { rot: -air * 30 },
      legFR: { rot: -air * 20 },
      legBL: { rot: air * 26 },
      legBR: { rot: air * 18 },
    } satisfies Record<string, Override>
  },
}
