'use client'

/**
 * 六套渲染器共用的底座:几何推导、颜色工具、rAF 钩子。
 *
 * 关键约定:**渲染器每帧从 `dayStore` 自己读天数,不走 React 状态**。
 * 播放时每秒 4~48 帧的更新如果经由 setState,六个渲染器都要重跑调和;
 * canvas / WebGL 那几套更不该被 React 碰到。所以只有 HUD 订阅状态。
 */

import { useEffect, useId, useRef, useSyncExternalStore } from 'react'
import {
  STAGE_XP,
  DAILY_XP,
  stageFloatOf,
  resolveForm,
  STAGE_COUNT,
  type Archetype,
  type CreatureDna,
  type FormState,
} from '../../lib/creature/index.js'
import { dayStore } from '../store'

/** 由「第几天」直接得到连续形态 —— 六套渲染器唯一的形态入口 */
export function formOfDay(dna: CreatureDna, day: number): FormState {
  return resolveForm(dna, stageFloatOf(day * DAILY_XP))
}

/** 某天对应的阶段(整数)与阶段内进度 */
export function stageOfDay(day: number): { stage: number; t: number; progress: number } {
  const sf = stageFloatOf(day * DAILY_XP)
  const stage = Math.min(Math.floor(sf), STAGE_COUNT - 1)
  return { stage, t: sf - stage, progress: Math.min(1, Math.max(0, sf - stage)) }
}

/** 满级所需天数 */
export const FULL_DAYS = STAGE_XP[STAGE_COUNT - 1] / DAILY_XP

/* ---------------------------- 颜色 ---------------------------- */

export interface Rgb {
  r: number
  g: number
  b: number
}

export function hexRgb(hex: string): Rgb {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16)
  if (!Number.isFinite(n)) return { r: 128, g: 128, b: 128 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexRgb(hex)
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

/** mix 两个 hex,`t`=0 取 a,1 取 b */
export function mix(a: string, b: string, t: number): string {
  const ca = hexRgb(a)
  const cb = hexRgb(b)
  const k = Math.max(0, Math.min(1, t))
  const to = (x: number, y: number) => Math.round(x + (y - x) * k)
    .toString(16)
    .padStart(2, '0')
  return `#${to(ca.r, cb.r)}${to(ca.g, cb.g)}${to(ca.b, cb.b)}`
}

/** 从 0xRRGGBB 取单通道 0..1,给 WebGL uniform 用 */
export function channel(hex: string, ch: 'r' | 'g' | 'b'): number {
  return hexRgb(hex)[ch] / 255
}

/**
 * 读当前主题的强调色 —— WebGL / Canvas 没有 CSS 级联可用,只能显式取一次。
 * 取不到就用 DNA 自己的 glow 色,保证离屏渲染(测试/SSR)也不空。
 */
export function readThemeColor(varName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return v || fallback
}

/* ---------------------------- 原型外形参数 ---------------------------- */

/**
 * 每种原型的躯干比例。渲染器据此把同一份 DNA 解读成完全不同的轮廓 ——
 * 这正是 lab 要验证的事:DNA 的表达力够不够。
 */
export interface ArchStyle {
  /** 躯干半宽(相对 size) */
  bodyW: number
  /** 躯干长(相对 size) */
  bodyL: number
  /** 肢体长(相对 size) */
  limbLen: number
  /** 肢体根部宽(相对 size) */
  limbW: number
  /** 肢体张角(度) */
  limbAngle: number
  /** 眼半径(相对 size) */
  eyeR: number
  /** 躯干弯曲量 0..1 */
  curve: number
  /** 眼睛位置沿躯干的相对位置 */
  eyeAt: number
}

export const ARCH_STYLE: Record<Archetype, ArchStyle> = {
  butterfly: { bodyW: 0.1, bodyL: 0.46, limbLen: 0.62, limbW: 0.3, limbAngle: 28, eyeR: 0.05, curve: 0.16, eyeAt: 0.72 },
  fish: { bodyW: 0.2, bodyL: 0.62, limbLen: 0.3, limbW: 0.14, limbAngle: 62, eyeR: 0.07, curve: 0.42, eyeAt: 0.8 },
  dragon: { bodyW: 0.17, bodyL: 0.58, limbLen: 0.44, limbW: 0.13, limbAngle: 46, eyeR: 0.06, curve: 0.38, eyeAt: 0.78 },
  orb: { bodyW: 0.4, bodyL: 0.4, limbLen: 0.2, limbW: 0.08, limbAngle: 70, eyeR: 0.09, curve: 0.05, eyeAt: 0.5 },
  insect: { bodyW: 0.19, bodyL: 0.54, limbLen: 0.42, limbW: 0.07, limbAngle: 54, eyeR: 0.055, curve: 0.14, eyeAt: 0.8 },
  bird: { bodyW: 0.18, bodyL: 0.52, limbLen: 0.52, limbW: 0.26, limbAngle: 34, eyeR: 0.06, curve: 0.2, eyeAt: 0.76 },
  plant: { bodyW: 0.14, bodyL: 0.5, limbLen: 0.48, limbW: 0.16, limbAngle: 58, eyeR: 0.05, curve: 0.1, eyeAt: 0.72 },
  machine: { bodyW: 0.19, bodyL: 0.52, limbLen: 0.36, limbW: 0.11, limbAngle: 50, eyeR: 0.06, curve: 0.05, eyeAt: 0.76 },
}

/* ---------------------------- 几何 ---------------------------- */

/** 躯干中轴上的一点(局部坐标,原点=中心,单位=像素) */
export interface SpinePoint {
  x: number
  y: number
  /** 该处躯干半宽 */
  w: number
  /** 该处的切线角(弧度) */
  ang: number
}

/**
 * 由 DNA 推导躯干中轴与宽度剖面。
 *
 * 宽度剖面用 `sin(πu)^p` 的钟形,`p` 随阶段变小(成体更修长),这让「大一号」
 * 不只是等比放大 —— 形态也跟着长。
 */
export function buildSpine(form: FormState): SpinePoint[] {
  const st = ARCH_STYLE[form.archetype]
  const n = Math.max(3, form.segments * 2 + 3)
  const len = form.size * st.bodyL * 2
  const half = len / 2
  const wMax = form.size * st.bodyW
  const pts: SpinePoint[] = []
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1)
    const y = -half + u * len
    // 沿 S 形弯曲:两端反向,中间平 —— 侧视生物的经典轮廓
    const x = Math.sin((u - 0.5) * Math.PI) * form.size * st.curve
    // 钟形剖面,p 越小越「鱼/龙」,越大越「虫/球」
    const p = 0.55 + form.stage * 0.18
    const prof = Math.sin(Math.PI * Math.max(0.02, Math.min(0.98, u))) ** p
    const w = Math.max(0.4, wMax * prof)
    const dx = Math.cos((u - 0.5) * Math.PI) * form.size * st.curve * Math.PI
    pts.push({ x, y, w, ang: Math.atan2(dx, len) })
  }
  return pts
}

/** 肢体:从躯干某点伸出的锥形段(返回中轴折线,渲染器自己描粗细) */
export interface Limb {
  /** 附着点(局部坐标) */
  ax: number
  ay: number
  /** 末端(局部坐标) */
  bx: number
  by: number
  /** 根宽 */
  w: number
  /** 索引,用于相位偏移 */
  i: number
  /** 镜像侧:-1 左 / 1 右;0 表示不镜像(正对观众) */
  side: -1 | 0 | 1
}

export function buildLimbs(form: FormState, spine: SpinePoint[]): Limb[] {
  const st = ARCH_STYLE[form.archetype]
  const pairs = form.shape.limbPairs
  if (!pairs) return []
  const out: Limb[] = []
  const len = form.size * st.limbLen
  const w = Math.max(0.6, form.size * st.limbW)
  const sym = form.shape.symmetry

  for (let i = 0; i < pairs; i++) {
    // 从头(高 u)往尾(低 u)铺开,留出尾端
    const u = 0.2 + (0.62 * i) / Math.max(1, pairs - 1 || 1)
    const idx = Math.min(spine.length - 1, Math.round(u * (spine.length - 1)))
    const p = spine[idx]
    if (!p) continue
    // 张角:越靠头越张开,越靠尾越收拢(像翼根到翼尖)
    const spread = st.limbAngle * (1.15 - 0.55 * u)
    const base = p.ang - (Math.PI / 2) * (0.75 - 0.35 * u) - (spread * Math.PI) / 180
    // 肢体长度也随位置收短
    const k = 1 - 0.22 * u
    const bx = p.x + Math.cos(base) * len * k * Math.cos(p.ang)
    const by = p.y + Math.sin(base) * len * k

    out.push({ ax: p.x, ay: p.y, bx, by, w, i, side: 1 })
    // 对称侧:对称度低时左右长度不同,做出侧视的不对称
    const jitter = 1 - (1 - sym) * (i % 2 === 0 ? 0.35 : 0.1)
    out.push({ ax: p.x, ay: p.y, bx: p.x - (bx - p.x) * jitter, by, w, i, side: -1 })
  }
  return out
}

/** 眼睛位置(局部坐标) */
export function eyePos(form: FormState, spine: SpinePoint[]): { x: number; y: number; r: number } {
  const st = ARCH_STYLE[form.archetype]
  const idx = Math.min(spine.length - 1, Math.round(st.eyeAt * (spine.length - 1)))
  const p = spine[idx] ?? spine[spine.length - 1]
  const r = Math.max(0.6, form.size * st.eyeR)
  return { x: p?.x ?? 0, y: (p?.y ?? 0) - (p?.w ?? 0) * 0.15, r }
}

/** 轮廓包围盒(给 canvas / WebGL 用,SVG 用 viewBox 就够) */
export function boundsOf(form: FormState): number {
  const st = ARCH_STYLE[form.archetype]
  return form.size * (Math.max(1, st.limbLen) + 0.5)
}

/* ---------------------------- 性格 → 物理量 ---------------------------- */

/**
 * 八条性格轴里并没有「轻重」「软硬」这两根轴,但软体和粒子都需要它们。
 * 所以在渲染器边界做一次显式映射 —— **不污染 DNA**:DNA 记的是「这只东西
 * 是什么性格」,渲染器决定「那种性格在物理上意味着什么」。换个原型/换套渲染器,
 * 这个映射可以完全不同。
 */
type Traits = FormState['traits']

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/** 沉重度 0(轻飘漂浮)..1(沉甸甸压手) */
export function weightOf(t: Traits): number {
  return clamp01((t.mechanical * 0.55 + t.ancient * 0.45 + t.fierce * 0.2 - t.ethereal * 0.9 - t.cute * 0.3) / 5)
}

/** 刚度 0(一戳就软)..1(硬邦邦) */
export function stiffnessOf(t: Traits): number {
  return clamp01((t.mechanical * 0.7 + t.cyber * 0.5 - t.organic * 0.6 - t.cute * 0.25) / 5)
}

/** 躁动度 0(沉稳)..1(停不下来) */
export function agitationOf(t: Traits): number {
  return clamp01((t.luminous * 0.35 + t.ethereal * 0.3 + t.fierce * 0.3 + t.cute * 0.2 - t.ancient * 0.7 - t.mechanical * 0.4) / 5)
}

/* ---------------------------- rAF ---------------------------- */

/**
 * 跑一条自己的动画循环,回调拿到 `day` 与秒级时间 `ts`。
 *
 * 依赖数组里**不放 day**:天数每帧都在变,放进 deps 会不断重建循环。
 * 循环内直接 `dayStore.get()` 读,这是性能的关键。
 */
export function useCreatureLoop(
  dna: CreatureDna,
  draw: (form: FormState, ts: number, day: number) => void,
  active = true,
  dayOverride?: number,
) {
  const drawRef = useRef(draw)
  const dayRef = useRef(dayOverride)
  // 在 effect 里同步,而不是渲染期直接赋值 —— 渲染期改 ref 会让并发渲染下
  // 读到别的渲染树的值(React 官方明确禁止)。
  useEffect(() => {
    drawRef.current = draw
    dayRef.current = dayOverride
  })

  const uid = useId()
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    if (!active) return
    let raf = 0
    const t0 = performance.now()
    // reduced motion:不做连续动画,只在「天数变了」时重绘一帧(跳到某天的静态姿态)
    let lastDay = NaN
    const loop = (now: number) => {
      const day = dayRef.current ?? dayStore.get()
      if (!reduced || day !== lastDay) {
        drawRef.current(formOfDay(dna, day), (now - t0) / 1000, day)
        lastDay = day
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // dna 变化才重建循环;天数每帧都变,绝不能进 deps(会不断重建循环)。
    // `draw` **故意不在 deps**:它是每次渲染都新造的内联箭头,进来就等于每帧
    // 重建整条循环;改由上面的 effect 把它同步进 ref,循环读到的永远是最新的。
    // uid 让同 key 的多实例(swarm)各自拿到独立的 effect。
  }, [dna, active, uid, reduced])
}

/**
 * 同上,但由调用方持有每帧要变的可变状态(物理质点、GPU 上传缓冲……)。
 *
 * 为什么要这个变体:那些状态**只在循环内部有意义** —— 建在 effect 的局部作用域里,
 * 生命周期与循环严格一致,卸载即销毁,不存在「ref 指向的脏数据」。
 * 也因此能通过 React Compiler 的 immutability 检查:Compiler 的假设是「渲染产出的
 * 值不能被改」,而这里被改的是 effect 内部的局部对象,压根没参与过渲染。
 *
 * `init` 只在 dna 变化时重跑一次 —— 拓扑/缓冲会重建(对物理渲染器等于重置模拟,
 * 符合直觉:换了一只生物,就该从新形态开始)。
 */
export function useCreatureLoopWith<S>(
  dna: CreatureDna,
  init: () => S,
  draw: (state: S, form: FormState, ts: number, day: number) => void,
  active = true,
) {
  const drawRef = useRef(draw)
  const initRef = useRef(init)
  useEffect(() => {
    drawRef.current = draw
    initRef.current = init
  })

  const uid = useId()
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    if (!active) return
    const state = initRef.current()
    let raf = 0
    const t0 = performance.now()
    // 同 useCreatureLoop:reduced motion 下只在天数变化时走一帧
    let lastDay = NaN
    const loop = (now: number) => {
      const day = dayStore.get()
      if (!reduced || day !== lastDay) {
        drawRef.current(state, formOfDay(dna, day), (now - t0) / 1000, day)
        lastDay = day
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [dna, active, uid, reduced])
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const mq = window.matchMedia(REDUCED_MOTION_QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/**
 * 尊重系统「减少动态效果」设置。
 *
 * 用 `useSyncExternalStore` 而不是 ref + 手动监听:媒体查询的匹配结果是**会变、
 * 但没有 setState 触发**的外部值,ref 方案读它需要一次额外重渲染,而渲染期又不能读 ref。
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  )
}

/** 按设备像素比配置 canvas,返回是否成功拿到 2d / webgl2 上下文 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D | null,
  cssSize: number,
): number {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const px = Math.max(1, Math.round(cssSize * dpr))
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px
    canvas.height = px
    // **CSS 尺寸必须显式钉成 cssSize**。只设 width/height 属性的话,元素按后备缓冲区
    // 的像素尺寸布局 —— dpr=2 的屏幕上每张 canvas 会撑成两倍大,直接把卡片顶开。
    canvas.style.width = `${cssSize}px`
    canvas.style.height = `${cssSize}px`
  }
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return dpr
}

/* ---------------------------- 路径 ---------------------------- */

type Pt = [number, number]

/**
 * Catmull-Rom → 三次贝塞尔,输出闭合平滑路径。
 *
 * 不用 `L` 直连:躯干/肢体的轮廓点有十几二十个,直线段会显出折角;样条插值后
 * 才是有机轮廓。tension 0.5 是标准 Catmull-Rom。
 */
export function closedSpline(pts: Pt[], tension = 0.5): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M ${r(pts[0][0])} ${r(pts[0][1])} Z`
  if (n === 2) return `M ${r(pts[0][0])} ${r(pts[0][1])} L ${r(pts[1][0])} ${r(pts[1][1])} Z`

  const at = (i: number): Pt => pts[((i % n) + n) % n]
  const k = tension / 3

  let d = `M ${r(pts[0][0])} ${r(pts[0][1])}`
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const c1x = p1[0] + (p2[0] - p0[0]) * k
    const c1y = p1[1] + (p2[1] - p0[1]) * k
    const c2x = p2[0] - (p3[0] - p1[0]) * k
    const c2y = p2[1] - (p3[1] - p1[1]) * k
    d += ` C ${r(c1x)} ${r(c1y)} ${r(c2x)} ${r(c2y)} ${r(p2[0])} ${r(p2[1])}`
  }
  return `${d} Z`
}

/** 沿中轴生成带状闭合轮廓(躯干):左右两侧各偏移半个宽度 */
export function ribbon(spine: SpinePoint[], widthScale = 1): string {
  if (spine.length < 2) return ''
  const left: Pt[] = []
  const right: Pt[] = []
  for (const p of spine) {
    const nx = -Math.sin(p.ang)
    const ny = Math.cos(p.ang)
    const w = Math.max(0.3, p.w * widthScale)
    left.push([p.x + nx * w, p.y + ny * w])
    right.push([p.x - nx * w, p.y - ny * w])
  }
  right.reverse()
  return closedSpline([...left, ...right])
}

/** 锥形肢体(局部坐标:附着点为 0,0) */
export function taper(w0: number, w1: number, bx: number, by: number): string {
  const len = Math.hypot(bx, by) || 1
  const nx = -by / len
  const ny = bx / len
  return closedSpline([
    [nx * w0, ny * w0],
    [bx + nx * w1, by + ny * w1],
    [bx - nx * w1, by - ny * w1],
    [-nx * w0, -ny * w0],
  ])
}

/** 保留两位小数:路径串每帧重建,字符串越短调和/解析越快 */
export function r(n: number): number {
  return Math.round(n * 100) / 100
}
