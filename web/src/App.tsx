import { useEffect, useState } from 'react'
import { CreaturePanel } from './CreaturePanel.js'
import { Leaderboard } from './Leaderboard.js'
import { FloatsPref } from './FloatsPref.js'
import { api } from './api.js'
import type { Settings, ProviderSlot } from './api.js'

type Tab = 'mine' | 'rank' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('mine')
  return (
    <div className="app">
      <FloatsPref />
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
    </div>
  )
}

function Settings() {
  const [cfg, setCfg] = useState<Settings | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [slotDraft, setSlotDraft] = useState<Record<string, { model: string; baseURL: string }>>({})
  const [maxTokens, setMaxTokens] = useState('4096')
  const [temperature, setTemperature] = useState('0.6')
  const [visitorAi, setVisitorAi] = useState(true)

  const load = () =>
    api
      .settings()
      .then((s) => {
        setCfg(s)
        setLoadErr('')
        setMaxTokens(String(s.maxTokens))
        setTemperature(String(s.temperature))
        setVisitorAi(s.visitorAi)
        const d: Record<string, { model: string; baseURL: string }> = {}
        for (const p of s.providers) d[p.id] = { model: p.model, baseURL: p.baseURL }
        setSlotDraft(d)
      })
      .catch(() => setLoadErr('无法读取配置(可能未登录站长)'))

  useEffect(() => {
    void load()
  }, [])

  /** 统一执行一次写操作:成功后按 label 提示并重新拉取(刷新掩码/当前服务商)。 */
  const act = async (label: string, fn: () => Promise<Settings>) => {
    setBusy(true)
    setErr('')
    setMsg('')
    try {
      await fn()
      await load()
      setMsg(`${label}成功`)
    } catch (e) {
      setErr((e as Error).message || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  if (!cfg) {
    return <p className="app-hint">{loadErr || '加载配置…'}</p>
  }

  if (!cfg.isOwner) {
    return (
      <div className="settings">
        <h1>模型配置</h1>
        <p className="app-hint">仅站长可修改配置。下面是当前各服务商的 Key 状态。</p>
        <ul className="settings-list">
          {cfg.providers.map((p) => (
            <li key={p.id}>
              <b>{p.label}</b> · {p.hasKey ? `已配置 ${p.keyMask ?? ''}` : '未配置 Key'}
              {p.id === cfg.provider ? ' · 当前使用中' : ''}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const shownProvider = openId ?? cfg.provider
  const patchSlot = (p: ProviderSlot, model: string, baseURL: string) =>
    api.saveSettings({ providers: { [p.id]: { model, baseURL } } })

  return (
    <div className="settings">
      <h1>模型配置</h1>
      <p className="app-hint">生灵的生成 / 命名 / 对话都走这里的模型。Key 只存服务端,不回传明文。</p>

      <ul className="settings-list">
        {cfg.providers.map((p) => {
          const open = shownProvider === p.id
          const draft = slotDraft[p.id] ?? { model: p.model, baseURL: p.baseURL }
          return (
            <li key={p.id} className={p.id === cfg.provider ? 'is-active' : undefined}>
              <div className="settings-row">
                <label className="settings-radio">
                  <input
                    type="radio"
                    name="provider"
                    checked={p.id === cfg.provider}
                    disabled={busy}
                    onChange={() => {
                      setOpenId(p.id)
                      void act(`切换到 ${p.label}`, () => api.saveSettings({ provider: p.id }))
                    }}
                  />
                  <b>{p.label}</b>
                </label>
                <span className={p.hasKey ? 'settings-ok' : 'settings-warn'}>
                  {p.hasKey ? `已配置 ${p.keyMask ?? ''}` : '未配置 Key'}
                </span>
                {p.id === cfg.provider && <span className="settings-badge">当前</span>}
                <button type="button" disabled={busy} onClick={() => setOpenId(open ? null : p.id)}>
                  {open ? '收起' : '配置'}
                </button>
              </div>

              {open && (
                <div className="settings-editor">
                  <label>
                    模型
                    <input
                      value={draft.model}
                      disabled={busy}
                      onChange={(e) =>
                        setSlotDraft((d) => ({ ...d, [p.id]: { ...draft, model: e.target.value } }))
                      }
                    />
                  </label>
                  <label>
                    地址
                    <input
                      value={draft.baseURL}
                      disabled={busy}
                      onChange={(e) =>
                        setSlotDraft((d) => ({ ...d, [p.id]: { ...draft, baseURL: e.target.value } }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act('保存模型/地址', () => patchSlot(p, draft.model, draft.baseURL))}
                  >
                    保存模型/地址
                  </button>
                  <div className="settings-key">
                    <label>
                      API Key
                      <input
                        type="password"
                        placeholder={p.hasKey ? '已配置,留空则不改动' : '粘贴 Key'}
                        value={keyDraft[p.id] ?? ''}
                        disabled={busy}
                        onChange={(e) => setKeyDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !(keyDraft[p.id] ?? '').trim()}
                      onClick={() =>
                        void act('保存 Key', async () => {
                          const s = await api.saveKey(p.id, (keyDraft[p.id] ?? '').trim())
                          setKeyDraft((d) => ({ ...d, [p.id]: '' }))
                          return s
                        })
                      }
                    >
                      保存 Key
                    </button>
                    {p.hasKey && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act('清除 Key', () => api.saveKey(p.id, ''))}
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="settings-global">
        <h2>全局</h2>
        <label>
          maxTokens(256–8192)
          <input value={maxTokens} disabled={busy} onChange={(e) => setMaxTokens(e.target.value)} />
        </label>
        <label>
          temperature(0–2)
          <input value={temperature} disabled={busy} onChange={(e) => setTemperature(e.target.value)} />
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={visitorAi}
            disabled={busy}
            onChange={(e) => setVisitorAi(e.target.checked)}
          />
          放行访客使用 AI
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act('保存全局', () =>
              api.saveSettings({
                maxTokens: Number(maxTokens),
                temperature: Number(temperature),
                visitorAi,
              }),
            )
          }
        >
          保存全局
        </button>
      </div>

      {busy && <p className="app-hint">保存中…</p>}
      {msg && <p className="settings-msg">{msg}</p>}
      {(err || loadErr) && <p className="app-err">{err || loadErr}</p>}
    </div>
  )
}
