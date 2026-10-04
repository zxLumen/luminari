import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type FieldCreature } from './api.js'

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
  }, [items])

  // 平滑移动 + 周期显示气泡
  const [, force] = useState(0)
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
            <img className="cf-img" src={it.img} alt={it.name} draggable={false} />
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

function toViewport(nx: number, ny: number): { x: number; y: number } {
  const m = 24
  const w = window.innerWidth
  const h = window.innerHeight
  // 把归一化坐标压到四周一圈(留出中间空白),简单实现:直接线性映射到整视口再用边距夹住
  return {
    x: Math.min(w - 120 - m, Math.max(m, nx * (w - 120))),
    y: Math.min(h - 120 - m, Math.max(m, ny * (h - 120))),
  }
}

/** 没有 pos 时的兜底:按 id 散到四周 */
function edgeFallback(id: string): { x: number; y: number } {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const corners: { x: number; y: number }[] = [
    { x: 0.05, y: 0.12 },
    { x: 0.9, y: 0.1 },
    { x: 0.08, y: 0.82 },
    { x: 0.88, y: 0.8 },
    { x: 0.5, y: 0.06 },
  ]
  return corners[h % corners.length] ?? { x: 0.1, y: 0.1 }
}
