import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type MyCreature } from './api.js'
import { RigCreature } from './renderers/RigCreature.js'
import { renderToPng } from './render-png.js'
import { normalizeBlueprint, compileBlueprint, STAGE_LABELS } from '../lib/creature/index.js'

/**
 * 生灵面板:底部 5 栏位 + 中央大预览 + 拖动看每天的样子 + 改名 + 选择参与排行 + 创建。
 *
 * 中央预览用固定天数的 RigCreature(fixedDay),滑杆控制天数 → 「每天的样子」。
 * 出图在浏览器端用真实渲染器完成,创建时把 PNG 提交给服务端。
 */

const RATINGS = ['棒', '还行', '差'] as const

export function CreaturePanel() {
  const [items, setItems] = useState<MyCreature[]>([])
  const [max, setMax] = useState(5)
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [day, setDay] = useState(30)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [descr, setDescr] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.mine()
      setItems(r.items)
      setMax(r.max)
      setActiveId((cur) => (cur && r.items.some((i) => i.id === cur) ? cur : r.items[0]?.id ?? null))
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const active = useMemo(() => items.find((i) => i.id === activeId) ?? null, [items, activeId])

  const compiled = useMemo(() => {
    if (!active?.blueprint) return null
    try {
      const norm = normalizeBlueprint(active.blueprint)
      if (!norm) return null
      return { cc: compileBlueprint(norm), matureDay: norm.matureDay }
    } catch {
      return null
    }
  }, [active])

  useEffect(() => {
    if (compiled) setDay(compiled.matureDay)
  }, [compiled])

  /* ---- 改名 ---- */
  const rename = async (id: string, name: string) => {
    try {
      const r = await api.patch(id, { name })
      setItems((prev) => prev.map((i) => (i.id === id ? r.creature : i)))
    } catch (e) {
      setErr(e instanceof Error ? e.message : '改名失败')
    }
  }

  /* ---- 选择参与排行(单选) ---- */
  const select = async (id: string) => {
    try {
      const want = !items.find((i) => i.id === id)?.selected
      await api.patch(id, { selected: want })
      await load()
      setMsg(want ? '已让它参与排行' : '已取消参与排行')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败')
    }
  }

  /* ---- 删除 ---- */
  const remove = async (id: string) => {
    if (!confirm('确定删除这只生灵?')) return
    try {
      await api.remove(id)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败')
    }
  }

  /* ---- 创建 ---- */
  const create = async () => {
    const d = descr.trim()
    if (!d) return
    setErr('')
    setMsg('生成中…')
    setCreating(true)
    try {
      const gen = await api.generate(d)
      const norm = normalizeBlueprint(gen.blueprint)
      if (!norm) throw new Error('骨架不可用')
      const cc = compileBlueprint(norm)
      setMsg('出图中…')
      const png = await renderToPng(cc.dna, cc.rig, cc.matureDay)
      let replaceId: string | undefined
      if (items.length >= max) {
        const pick = window.prompt(`你已经有 ${max} 只了。输入要覆盖的生灵编号:${items.map((i) => i.id.slice(-4)).join(' / ')}`)
        const found = items.find((i) => i.id.endsWith(pick?.trim() || ''))
        if (!found) throw new Error('未选择要覆盖的生灵')
        replaceId = found.id
      }
      setMsg('登记中…')
      const r = await api.commit({ descr: d, blueprint: norm, png, replaceId, birthdayDay: cc.matureDay })
      setDescr('')
      await load()
      setActiveId(r.creature.id)
      setMsg(`「${r.name}」诞生了`)
    } catch (e) {
      const status = (e as { status?: number }).status
      setErr(e instanceof Error ? e.message : '创建失败')
      if (status === 429) setCreating(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="cp">
      <header className="cp-head">
        <h1>我的生灵</h1>
        <p className="cp-lead">
          {items.length}/{max} 只 · 从其中选 1 只参与全站排行 · 点栏位切换 · 拖动滑杆看它每天的样子
        </p>
      </header>

      {(msg || err) && <p className={`cp-msg${err ? ' is-err' : ''}`}>{err || msg}</p>}

      {/* 中央大预览 */}
      <section className="cp-stage">
        {active && compiled ? (
          <>
            <div className="cp-stage-view">
              <RigCreature
                dna={compiled.cc.dna}
                rig={compiled.cc.rig}
                box={320}
                fixedDay={day}
                matureDay={compiled.matureDay}
              />
            </div>
            <div className="cp-stage-side">
              <div className="cp-stage-name">
                <NameEdit name={active.name || '无名'} onSave={(n) => rename(active.id, n)} />
              </div>
              {active.personality && <p className="cp-stage-soul">「{active.personality}」</p>}
              <p className="cp-stage-descr">{active.descr}</p>
              <div className="cp-stage-scores">
                <Score label="总分" value={active.total} big />
                <Score label="工艺 craft" value={active.craft} />
                <Score label="吸引 appeal" value={active.appeal} />
              </div>
              <div className="cp-stage-actions">
                <button className={active.selected ? 'is-on' : ''} onClick={() => select(active.id)}>
                  {active.selected ? '★ 正在参与排行' : '☆ 让它参与排行'}
                </button>
                <button className="cp-danger" onClick={() => remove(active.id)}>删除</button>
              </div>
            </div>
          </>
        ) : (
          <p className="cp-empty">{loading ? '加载中…' : '还没有生灵,下面创建一只吧'}</p>
        )}
      </section>

      {/* 拖动滑杆:看每天的样子 */}
      {active && compiled && (
        <div className="cp-timeline">
          <input
            type="range"
            min={0}
            max={compiled.matureDay}
            value={day}
            onChange={(e) => setDay(Number(e.target.value))}
          />
          <span className="cp-day">
            第 {day} 天 · {STAGE_LABELS[Math.min(STAGE_LABELS.length - 1, Math.floor((day / compiled.matureDay) * STAGE_LABELS.length))] ?? ''}
          </span>
        </div>
      )}

      {/* 底部 5 栏位 */}
      <section className="cp-slots">
        {items.map((it) => (
          <button
            key={it.id}
            className={`cp-slot${it.id === activeId ? ' is-active' : ''}${it.selected ? ' is-rank' : ''}`}
            onClick={() => setActiveId(it.id)}
            title={it.descr}
          >
            <span className="cp-slot-thumb">
              {it.img ? <img src={it.img} alt={it.name} /> : <span>?</span>}
            </span>
            <span className="cp-slot-name">{it.name || '无名'}</span>
            <span className="cp-slot-score">{it.total.toFixed(0)}</span>
          </button>
        ))}
        {items.length < max && <div className="cp-slot cp-slot-ph">+</div>}
      </section>

      {/* 创建 */}
      <section className="cp-create">
        <input
          value={descr}
          placeholder="描述你想养的生物,例如:一只深海发光的水母"
          onChange={(e) => setDescr(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !creating && create()}
          disabled={creating}
        />
        <button onClick={create} disabled={creating || !descr.trim()}>
          {creating ? '创建中…' : items.length >= max ? '创建并覆盖' : '创建'}
        </button>
      </section>
    </div>
  )
}

function NameEdit({ name, onSave }: { name: string; onSave: (n: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(name)
  useEffect(() => setV(name), [name])
  if (!editing) {
    return (
      <span className="cp-name" onClick={() => setEditing(true)} title="点击改名">
        {name} ✎
      </span>
    )
  }
  return (
    <input
      className="cp-name-input"
      value={v}
      maxLength={24}
      autoFocus
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setEditing(false)
        if (v.trim() && v.trim() !== name) onSave(v.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setV(name)
          setEditing(false)
        }
      }}
    />
  )
}

function Score({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <div className={`cp-score${big ? ' is-big' : ''}`}>
      <span className="cp-score-v">{value.toFixed(0)}</span>
      <span className="cp-score-l">{label}</span>
    </div>
  )
}
