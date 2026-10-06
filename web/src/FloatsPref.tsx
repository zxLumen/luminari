import { useEffect, useState } from 'react'
import { EMBEDDED, postToHost } from './embed.js'

/**
 * 「主页四周生灵」显隐开关。
 *
 * 只在本应用被博客 iframe 嵌入时出现(独立打开无从控制主页)。偏好存在**宿主(博客)**
 * 侧,这里通过 postMessage 读写:挂载时握手拿当前值,切换时上报。协议见博客
 * `docs/APP-EMBED.md` 与 `floats-pref.ts`。
 */
export function FloatsPref() {
  const [hidden, setHidden] = useState(false)
  const [allowed, setAllowed] = useState(true)

  useEffect(() => {
    if (!EMBEDDED) return
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; hidden?: unknown; allowed?: unknown } | null
      if (!d || typeof d !== 'object' || d.type !== 'zx:floats-state') return
      if (typeof d.hidden === 'boolean') setHidden(d.hidden)
      if (typeof d.allowed === 'boolean') setAllowed(d.allowed)
    }
    window.addEventListener('message', onMsg)
    // 握手:向宿主询问当前显示状态与是否放行关闭
    postToHost({ type: 'zx:floats-hello', app: 'luminari' })
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // 未嵌入,或站长未放行访客关闭:不显示开关
  if (!EMBEDDED || !allowed) return null

  const toggle = () => {
    const next = !hidden
    setHidden(next)
    postToHost({ type: 'zx:floats-set', app: 'luminari', hidden: next })
  }

  return (
    <div className={`floats-pref${hidden ? ' is-hidden' : ''}`}>
      <div className="floats-pref-text">
        <b>主页四周的生灵</b>
        <span>{hidden ? '已收起,主页不再显示' : '显示中,会在主页四周浮动'}</span>
      </div>
      <button
        type="button"
        className="floats-pref-switch"
        role="switch"
        aria-checked={!hidden}
        aria-label={hidden ? '显示主页四周生灵' : '收起主页四周生灵'}
        onClick={toggle}
      >
        <span className="floats-pref-knob" />
      </button>
    </div>
  )
}
