import type { FormState } from '../../lib/creature/index.js'

/**
 * 物种 rig 引擎 —— 让「像不像」成为可调的数据,而不是每只动物重写一套渲染器。
 *
 * 一个物种 = 一棵部件树(Part)+ 一个姿态函数(pose)。部件树描述解剖结构,姿态函数
 * 只返回「这一帧各关节转多少」。任何后端(SVG / Canvas / WebGL)消费同一棵树即可,
 * 所以「加一个物种」和「加一种渲染」互不牵连。
 *
 * 坐标:y 向下(与 SVG 一致);每个部件的原点是它的**附着点/旋转中心**,不是包围盒中心。
 * 这样扇翅、摆腿、抖尾都只是绕原点转一下,不需要额外的枢轴校正。
 */

/** 2x3 仿射矩阵 [a c e; b d f] */
export type Mat = readonly [number, number, number, number, number, number]

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y]

export function rotateDeg(deg: number): Mat {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, 0, 0]
}

export const scaleM = (x: number, y: number): Mat => [x, 0, 0, y, 0, 0]

export function matStr(m: Mat): string {
  const q = (n: number) => Math.round(n * 1000) / 1000
  return `matrix(${q(m[0])} ${q(m[1])} ${q(m[2])} ${q(m[3])} ${q(m[4])} ${q(m[5])})`
}

export type Role =
  | 'body'
  | 'bodyDark'
  | 'bodyLight'
  | 'accent'
  | 'accentDark'
  | 'accentLight'
  | 'glow'
  | 'eye'
  | 'white'
  | 'black'
  | 'nose'
  | 'line'

/** 每帧姿态覆盖(相对基础姿态的增量) */
export interface Override {
  x?: number
  y?: number
  /** 叠加旋转(度) */
  rot?: number
  sx?: number
  sy?: number
  opacity?: number
}

export interface Part {
  id: string
  parent?: string
  /** 成熟期路径(`d`),原点是附着点/旋转中心 */
  d: string
  role: Role
  /** 绘制层级(小=靠后) */
  z: number
  x?: number
  y?: number
  rot?: number
  sx?: number
  sy?: number
  /** 左右镜像出第二份(x 取反) */
  mirror?: boolean
  /** 尺寸倍率随天数生长:返回 0..1.2 左右的相对倍率 */
  grow?: (day: number, form: FormState) => number
  /** 0..1 显现(同时乘尺寸与不透明度),用于「某天才长出来」 */
  appear?: (day: number) => number
  /** >0 时改为描边(线宽),不填充 */
  stroke?: number
  /** 细线/细节:不参与整体尺寸缩放 */
  fixed?: boolean
}

export interface Rig {
  id: string
  label: string
  hint: string
  /** 成熟期半宽(局部单位),用于 viewBox */
  span: number
  parts: Part[]
  /**
   * 每帧姿态:返回 `部件 id → 覆盖量`。
   * 只写「动」的部件;静态部件留空即可。
   */
  pose: (form: FormState, ts: number, day: number) => Record<string, Override>
}

export const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/** 把 day 映射到 0..1 的进度(带起止日,用于「第 5 天才出现」这类安排) */
export const norm = (day: number, a: number, b: number) => clamp01((day - a) / (b - a))

/** 中心在原点的椭圆路径(避免为了一个圆去写 <ellipse> 分支) */
export function ellipseD(rx: number, ry: number): string {
  return `M ${-rx} 0 a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0 Z`
}
