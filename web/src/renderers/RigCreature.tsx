'use client'

import { useCallback, useId, useLayoutEffect, useMemo, useRef } from 'react'
import type { CreatureDna, FormState } from '../../lib/creature/index.js'
import { formOfDay, mix, useCreatureLoop } from './shared'
import {
  IDENTITY,
  matStr,
  mul,
  norm,
  rotateDeg,
  scaleM,
  translate,
  type Mat,
  type Override,
  type Part,
  type Role,
} from '../species/types'
import type { Rig } from '../species/types'

/**
 * 物种 rig 的 SVG 后端 —— 「像不像」这一刀的主力。
 *
 * 画的是**解剖部件树**(翅/腿/尾/耳各有自己的路径),而不是「一条脊柱 + N 根锥形肢体」。
 * 任何 rig 都能被这个组件渲染,所以加物种不用碰渲染代码。
 *
 * 镜像规则(踩过的坑):`mirror` 只标在**子树根**上(翅、腿、耳),后代**继承**这面镜子。
 * 早期版本让每个子部件各自 `mirror`,结果翅脉/翅斑绕「自己父级的原点」反射,
 * 长到了另一侧翅膀的原地 —— 左右不对称。现在整棵子树一次性反射,天然对称。
 *
 * 性能:DOM 骨架只在挂载时按部件树建一次,之后每帧只
 * `setAttribute('transform', matrix(...))` + `opacity`,完全不进 React 调和。
 */

function roleColors(pal: CreatureDna['palette']): Record<Role, string> {
  return {
    body: pal.body,
    bodyDark: mix(pal.body, '#241a2e', 0.45),
    bodyLight: mix(pal.body, '#ffffff', 0.55),
    accent: pal.accent,
    accentDark: mix(pal.accent, '#241a2e', 0.4),
    accentLight: mix(pal.accent, '#ffffff', 0.45),
    glow: pal.glow,
    eye: '#161020',
    white: '#ffffff',
    black: '#241a1e',
    nose: '#2a2024',
    line: mix(pal.body, '#241a2e', 0.6),
  }
}

function outlined(role: Role): boolean {
  return role === 'body' || role === 'accent' || role === 'bodyLight' || role === 'accentLight'
}

function baseOpacity(role: Role): number {
  return role === 'glow' ? 0.9 : 1
}

export interface RigCreatureProps {
  dna: CreatureDna
  rig: Rig
  box?: number
  /** 固定在某一天(用于成长条带);不传则随时间轴播放 */
  fixedDay?: number
  /** 成熟天数(决定整体缩放曲线的终点);缺省 34(手写物种的默认) */
  matureDay?: number
  /** 尺寸下限(占比);幼体不至于太小。缺省 0.6 */
  minScale?: number
}

interface Item {
  key: string
  part: Part
}

/** 部件的局部矩阵 = 平移 · 旋转 · 缩放(生长/显现/姿态都折算进缩放) */
function localMatrix(p: Part, o: Override | undefined, day: number, form: FormState): Mat {
  const ap = p.appear?.(day) ?? 1
  const gr = p.fixed ? 1 : (p.grow?.(day, form) ?? 1)
  const k = ap * gr
  const x = (p.x ?? 0) + (o?.x ?? 0)
  const y = (p.y ?? 0) + (o?.y ?? 0)
  const rot = (p.rot ?? 0) + (o?.rot ?? 0)
  const sx = (p.sx ?? 1) * (o?.sx ?? 1) * k
  const sy = (p.sy ?? 1) * (o?.sy ?? 1) * k
  return mul(translate(x, y), mul(rotateDeg(rot), scaleM(sx, sy)))
}

export function RigCreature({ dna, rig, box = 200, fixedDay, matureDay = 34, minScale = 0.6 }: RigCreatureProps) {
  const rawId = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const rootRef = useRef<SVGGElement | null>(null)
  const glowRef = useRef<SVGCircleElement | null>(null)
  const gRefs = useRef<Record<string, SVGGElement | null>>({})
  const pathRefs = useRef<Record<string, SVGPathElement | null>>({})

  const colors = useMemo(() => roleColors(dna.palette), [dna.palette])
  const childrenOf = useMemo(() => {
    const m = new Map<string, Part[]>()
    for (const p of rig.parts) {
      if (!p.parent) continue
      const arr = m.get(p.parent)
      if (arr) arr.push(p)
      else m.set(p.parent, [p])
    }
    return m
  }, [rig])
  const roots = useMemo(() => rig.parts.filter((p) => !p.parent), [rig])

  /**
   * 静态绘制清单:沿树走一遍,遇到 `mirror` 就把「变体数」翻倍。
   * 每个变体一条 `<path>`,文档顺序按 z 排(平铺,不嵌套 `<g>`,以便全局层级可控)。
   */
  const items = useMemo<Item[]>(() => {
    const raw: Item[] = []
    const walk = (part: Part, parentVariants: number) => {
      const n = part.mirror ? parentVariants * 2 : parentVariants
      for (let i = 0; i < n; i++) raw.push({ key: `${part.id}#${i}`, part })
      for (const c of childrenOf.get(part.id) ?? []) walk(c, n)
    }
    for (const r of roots) walk(r, 1)
    raw.sort((a, b) => a.part.z - b.part.z)
    return raw
  }, [roots, childrenOf])

  const draw = useCallback(
    (form: FormState, ts: number, day: number) => {
      const root = rootRef.current
      if (!root) return
      // 整体尺寸随天数长大(幼体 → 成年更大器);按 box 归一,strip 小图也不会溢出
      const grow = norm(day, 0, matureDay)
      const fit = (box * 0.42) / rig.span
      const S = fit * (minScale + (1.35 - minScale) * grow)
      root.setAttribute('transform', `translate(${box / 2} ${box / 2}) scale(${S})`)
      // 觉醒辉光:随阶段越来越亮、越来越大
      const glow = glowRef.current
      if (glow) {
        glow.setAttribute('r', String(rig.span * (0.42 + 0.36 * grow)))
        glow.setAttribute('opacity', String(0.5 + 0.5 * grow))
      }

      const ov = rig.pose(form, ts, day)
      const world: Record<string, Mat> = {}

      const calc = (part: Part, parentWorlds: Mat[]) => {
        const local = localMatrix(part, ov[part.id], day, form)
        const worlds = parentWorlds.map((pm) => mul(pm, local))
        if (part.mirror) {
          // 整棵子树绕「父级原点」(即身体中线)反射一次
          for (const pm of parentWorlds) worlds.push(mul(pm, mul(scaleM(-1, 1), local)))
        }
        worlds.forEach((w, i) => {
          world[`${part.id}#${i}`] = w
        })
        for (const c of childrenOf.get(part.id) ?? []) calc(c, worlds)
      }
      for (const r of roots) calc(r, [IDENTITY])

      for (const it of items) {
        const m = world[it.key]
        if (!m) continue
        const g = gRefs.current[it.key]
        if (g) g.setAttribute('transform', matStr(m))
        const el = pathRefs.current[it.key]
        if (el) {
          const ap = it.part.appear?.(day) ?? 1
          const o = ov[it.part.id]
          el.setAttribute(
            'opacity',
            String(Math.max(0, Math.min(1, ap * baseOpacity(it.part.role) * (o?.opacity ?? 1)))),
          )
        }
      }
    },
    [box, rig, items, childrenOf, roots, matureDay, minScale],
  )

  // 自适应画框:按「成熟态」量出真实内容包围盒(隐去背景辉光,并取几个扇动相位),
  // 据此把 viewBox 设成刚好框住它 —— 任何尺寸/大翅膀都不会被裁,且各只观感一致
  // (幼体在这个固定框里按比例更小,成长感仍在)。
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const glow = glowRef.current
    const prevDisplay = glow?.getAttribute('display') ?? null
    glow?.setAttribute('display', 'none')
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const ts of [0, 0.35, 0.7, 1.05, 1.4]) {
      draw(formOfDay(dna, matureDay), ts, matureDay)
      const b = svg.getBBox()
      if (!Number.isFinite(b.x) || (b.width === 0 && b.height === 0)) continue
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.width)
      maxY = Math.max(maxY, b.y + b.height)
    }
    if (glow) {
      if (prevDisplay === null) glow.removeAttribute('display')
      else glow.setAttribute('display', prevDisplay)
    }
    if (!Number.isFinite(minX)) {
      svg.setAttribute('viewBox', `0 0 ${box} ${box}`)
      return
    }
    const w = maxX - minX
    const h = maxY - minY
    const pad = Math.max(w, h) * 0.08 + 2
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const size = Math.max(w, h) + pad * 2
    svg.setAttribute('viewBox', `${cx - size / 2} ${cy - size / 2} ${size} ${size}`)
  }, [draw, dna, matureDay, box])

  // 固定天数时也保持动画(fixedDay 只锁「形态/大小」,动作照常播放)
  useCreatureLoop(dna, draw, true, fixedDay)

  const glowId = `rigglow${rawId}`
  const shadowId = `rigsh${rawId}`

  return (
    <svg
      ref={svgRef}
      className="rig-svg"
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      aria-label={`${rig.label} ${dna.name}`}
      role="img"
    >
      <defs>
        <radialGradient id={glowId}>
          <stop offset="0%" stopColor={colors.glow} stopOpacity="0.5" />
          <stop offset="60%" stopColor={colors.glow} stopOpacity="0.14" />
          <stop offset="100%" stopColor={colors.glow} stopOpacity="0" />
        </radialGradient>
        <filter id={shadowId} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.4" floodColor="#0a0812" floodOpacity="0.35" />
        </filter>
      </defs>

      <g ref={rootRef}>
        <circle ref={glowRef} cx={0} cy={0} r={rig.span * 0.42} fill={`url(#${glowId})`} />
        {items.map((it) => {
          const p = it.part
          const isLine = (p.stroke ?? 0) > 0
          return (
            <g
              key={it.key}
              ref={(el) => {
                gRefs.current[it.key] = el
              }}
            >
              <path
                ref={(el) => {
                  pathRefs.current[it.key] = el
                }}
                d={p.d}
                fill={isLine ? 'none' : colors[p.role]}
                stroke={isLine ? colors[p.role] : outlined(p.role) ? colors.line : 'none'}
                strokeWidth={isLine ? p.stroke : outlined(p.role) ? 2 : 0}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={baseOpacity(p.role)}
                filter={p.role === 'body' || p.role === 'accent' ? `url(#${shadowId})` : undefined}
              />
            </g>
          )
        })}
      </g>
    </svg>
  )
}
