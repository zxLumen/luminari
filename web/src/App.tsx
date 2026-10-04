import { useState } from 'react'
import { CreaturePanel } from './CreaturePanel.js'
import { CreatureField } from './CreatureField.js'
import { Leaderboard } from './Leaderboard.js'

type Tab = 'mine' | 'rank' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('mine')
  return (
    <div className="app">
      <nav className="app-tabs">
        <button className={tab === 'mine' ? 'is-on' : ''} onClick={() => setTab('mine')}>
          我的生灵
        </button>
        <button className={tab === 'rank' ? 'is-on' : ''} onClick={() => setTab('rank')}>
          排行榜
        </button>
        <button className={tab === 'settings' ? 'is-on' : ''} onClick={() => setTab('settings')}>
          设置
        </button>
      </nav>
      {tab === 'mine' && <CreaturePanel />}
      {tab === 'rank' && <Leaderboard />}
      {tab === 'settings' && <Settings />}
      {/* 四周游走的生灵层(窄屏自动隐藏) */}
      <CreatureField />
    </div>
  )
}

function Settings() {
  const [cfg, setCfg] = useState<{ provider?: string; model?: string; hasKey?: boolean; keyMask?: string; providers?: { id: string; label: string; hasKey: boolean; keyMask: string | null }[] } | null>(null)
  const [err, setErr] = useState('')

  if (!cfg) {
    fetch('/api/settings')
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setErr('无法读取配置(可能未登录站长)'))
    return <p className="app-hint">{err || '加载配置…'}</p>
  }

  return (
    <div className="settings">
      <h1>模型配置</h1>
      <p className="app-hint">
        生灵的生成 / 命名 / 对话都走这里的模型。Key 只存服务端,不回传明文。
      </p>
      <ul className="settings-list">
        {cfg.providers?.map((p) => (
          <li key={p.id}>
            <b>{p.label}</b> · {p.hasKey ? `已配置 ${p.keyMask ?? ''}` : '未配置 Key'}
          </li>
        ))}
      </ul>
      {err && <p className="app-err">{err}</p>}
    </div>
  )
}
