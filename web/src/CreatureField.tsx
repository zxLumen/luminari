import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type FieldCreature } from './api.js'
import { RigCreature } from './renderers/RigCreature.js'
import { normalizeBlueprint, compileBlueprint } from '../lib/creature/index.js'

/**
 * 生灵层:Top5 + 我的 selected 生灵,沿视口四周游走,头顶冒「想说的话」。
 *
 * 位置来自服务端对话轮给的归一化 pos(0..1),前端映射到"四周安全区"。
 * 用 fixed + rAF 平滑移动;**不频繁**——到位后静止,直到下一轮刷新。
 * 悬停暂停并展开气泡;点击可看名字/分。
 * 窄屏(≤820px)不渲染(避免遮挡内容)。
 */

const NARROW = '(max-width: 820px)'
const BUBBLE_MS = 6000

interface Float {
  id: string
  x: number
  y: number
  tx: number
  ty: number
  show: boolean
}

export function CreatureField({ refreshMs = 5 * 60 * 1000 }: { refreshMs?: number }) {
  const [items, setItems] = useState<FieldCreature[]>([])
  const [narrow, setNarrow] = useState(true)
  const [hover, setHover] = useState<string | null>(null)
  const floats = useRef<Map<string, Float>>(new Map())
  const [, force] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(NARROW)
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const r = await api.field()
        if (alive) setItems(r.items)
      } catch {
        /* 静默:生灵层不可用不影响页面 */
      }
    }
    void pull()
    const t = setInterval(pull, refreshMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [refreshMs])

  // 位置映射:把归一化 pos 铺到"四周边缘安全区",避免都挤中间
  useEffect(() => {
    const map = floats.current
    for (const it of items) {
      const p = it.pos ?? edgeFallback(it.id)
      const { x, y } = toViewport(p.x, p.y)
      const cur = map.get(it.id)
      if (cur) {
        cur.tx = x
        cur.ty = y
      } else {
        map.set(it.id, { id: it.id, x, y, tx: x, ty: y, show: false })
      }
    }
    // 清理已消失的
    for (const key of [...map.keys()]) if (!items.some((i) => i.id === key)) map.delete(key)
    // 新位置已写入 floats,但 effect 在渲染后运行;主动重渲染一次让生灵立即出现
    force((n) => n + 1)
  }, [items])

  // 平滑移动 + 周期显示气泡
  useEffect(() => {
    let raf = 0
    const tick = () => {
      let moved = false
      for (const f of floats.current.values()) {
        const dx = f.tx - f.x
        const dy = f.ty - f.y
        if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) {
          f.x += dx * 0.04
          f.y += dy * 0.04
          moved = true
        }
      }
      if (moved) force((n) => n + 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // 轮换气泡:每只每隔一会儿冒一次
  useEffect(() => {
    const timers: number[] = []
    items.forEach((it, i) => {
      const t = window.setInterval(() => {
        const f = floats.current.get(it.id)
        if (!f) return
        f.show = true
        force((n) => n + 1)
        window.setTimeout(() => {
          f.show = false
          force((n) => n + 1)
        }, BUBBLE_MS)
      }, 12000 + i * 2500)
      timers.push(t)
    })
    return () => timers.forEach(clearInterval)
  }, [items])

  const live = useMemo(() => {
    const m = new Map<string, { cc: ReturnType<typeof compileBlueprint>; matureDay: number }>()
    for (const it of items) {
      if (!it.blueprint) continue
      const norm = normalizeBlueprint(it.blueprint)
      if (!norm) continue
      try {
        m.set(it.id, { cc: compileBlueprint(norm), matureDay: norm.matureDay })
      } catch {
        /* 坏蓝图退回静态 PNG */
      }
    }
    return m
  }, [items])

  const visible = useMemo(() => items, [items])
  if (narrow || !visible.length) return null

  return (
    <div className="cf-layer" aria-hidden>
      {visible.map((it) => {
        const f = floats.current.get(it.id)
        if (!f) return null
        const open = f.show || hover === it.id
        return (
          <div
            key={it.id}
            className={`cf-item${it.mine ? ' is-mine' : ''}`}
            style={{ transform: `translate3d(${f.x}px, ${f.y}px, 0)` }}
            onMouseEnter={() => setHover(it.id)}
            onMouseLeave={() => setHover((h) => (h === it.id ? null : h))}
          >
            {open && it.say && <div className="cf-bubble">{it.say}</div>}
            {live.has(it.id) ? (
              <div className="cf-live">
                <RigCreature
                  dna={live.get(it.id)!.cc.dna}
                  rig={live.get(it.id)!.cc.rig}
                  box={96}
                  matureDay={live.get(it.id)!.matureDay}
                />
              </div>
            ) : (
              <img className="cf-img" src={it.img} alt={it.name} draggable={false} />
            )}
            <div className="cf-name">
              {it.name || '无名'}
              {typeof it.total === 'number' && <span className="cf-score">{it.total.toFixed(0)}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const BOX = 120 // 生灵本体 96 + 名字行,贴边留白用

/** 把一个归一化点(0..1)贴到最近的一条视口边上,沿边自由分布(不限于四角)。 */
function toViewport(nx: number, ny: number): { x: number; y: number } {
  const m = 16
  const w = window.innerWidth
  const h = window.innerHeight
  const maxX = Math.max(m, w - BOX - m)
  const maxY = Math.max(m, h - BOX - m)
  const px = m + Math.min(1, Math.max(0, nx)) * (maxX - m)
  const py = m + Math.min(1, Math.max(0, ny)) * (maxY - m)
  const dL = px - m
  const dR = maxX - px
  const dT = py - m
  const dB = maxY - py
  const min = Math.min(dL, dR, dT, dB)
  if (min === dL) return { x: m, y: py }
  if (min === dR) return { x: maxX, y: py }
  if (min === dT) return { x: px, y: m }
  return { x: px, y: maxY }
}

/** 没有 pos 时的兜底:按 id 散到四周任意位置(贴边,不限于四角)。 */
function edgeFallback(id: string): { x: number; y: number } {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  // 哈希 → 0..1 的周长参数 → 单位方框边上的归一化点
  const t = ((h % 1000) / 1000) * 4
  if (t < 1) return { x: t, y: 0 }
  if (t < 2) return { x: 1, y: t - 1 }
  if (t < 3) return { x: 1 - (t - 2), y: 1 }
  return { x: 0, y: 1 - (t - 3) }
}
