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
  const [isOwner, setIsOwner] = useState(false)
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
      setIsOwner(r.isOwner)
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

  /** 栏位展示:owner 只看选中的(参排);普通访客看自己的全部(≤5) */
  const slots = useMemo(
    () => (isOwner ? items.filter((i) => i.selected) : items),
    [items, isOwner],
  )

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
    // 默认展示它「当前所处」的形态(按现实年龄),而不是成熟态
    if (compiled && active) setDay(currentDayOf(active.createdAt, compiled.matureDay))
  }, [compiled, active])

  /* ---- 改名 ---- */
  const rename = async (id: string, name: string) => {
    try {
      const r = await api.patch(id, { name })
      setItems((prev) => prev.map((i) => (i.id === id ? r.creature : i)))
    } catch (e) {
      setErr(e instanceof Error ? e.message : '改名失败')
    }
  }

  /* ---- 选择参与排行 ---- */
  // 普通访客:单选 PATCH(每人 1 只)。owner:批量选,可同时保留多只(Top 5)。
  const select = async (id: string) => {
    try {
      if (isOwner) {
        const cur = items.filter((i) => i.selected).map((i) => i.id)
        const on = !items.find((i) => i.id === id)?.selected
        const next = on ? [...cur, id] : cur.filter((x) => x !== id)
        await api.selectMany(next)
        await load()
        setMsg(`已选 ${next.length} 只参与排行`)
      } else {
        const want = !items.find((i) => i.id === id)?.selected
        await api.patch(id, { selected: want })
        await load()
        setMsg(want ? '已让它参与排行' : '已取消参与排行')
      }
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
          {isOwner
            ? `共 ${items.length} 只 · ${slots.length} 只参与排行 · 点栏位切换 · 拖动滑杆看它每天的样子`
            : `${items.length}/${max} 只 · 从其中选 1 只参与全站排行 · 点栏位切换 · 拖动滑杆看它每天的样子`}
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

      {/* 底部栏位:owner 展示参排的 5 只(或当前已选),普通访客展示自己的全部 */}
      <section className="cp-slots">
        {slots.map((it) => (
          <button
            key={it.id}
            className={`cp-slot${it.id === activeId ? ' is-active' : ''}${it.selected ? ' is-rank' : ''}`}
            onClick={() => setActiveId(it.id)}
            title={it.descr}
          >
            <span className="cp-slot-thumb">
              <MiniRig c={it} box={72} />
            </span>
            <span className="cp-slot-name">{it.name || '无名'}</span>
            <span className="cp-slot-score">{it.total.toFixed(0)}</span>
          </button>
        ))}
        {isOwner
          ? Array.from({ length: Math.max(0, max - slots.length) }, (_, i) => (
              <div key={`ph${i}`} className="cp-slot cp-slot-empty">
                空
              </div>
            ))
          : Array.from({ length: Math.max(0, max - slots.length) }, (_, i) => (
              <div key={`ph${i}`} className="cp-slot cp-slot-ph">
                +
              </div>
            ))}
      </section>

      {/* owner:全部生灵,点一下加入/移出参排(手动精选 Top5) */}
      {isOwner && (
        <section className="cp-others">
          <h2 className="cp-others-h">全部生灵({items.length})· 点选加入 / 移出参排</h2>
          <div className="cp-others-grid">
            {items.map((it) => (
              <button
                key={it.id}
                className={`cp-oth${it.selected ? ' is-on' : ''}`}
                onClick={() => select(it.id)}
                title={it.descr}
              >
                <span className="cp-oth-thumb">
                  <MiniRig c={it} box={56} />
                </span>
                <span className="cp-oth-name">{it.name || '无名'}</span>
                <span className="cp-oth-score">{it.total.toFixed(0)}</span>
                <span className="cp-oth-badge">{it.selected ? '参排' : '＋'}</span>
              </button>
            ))}
          </div>
        </section>
      )}

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

/** 现实年龄(天),封顶在成熟天数 */
function currentDayOf(createdAt: string | undefined, matureDay: number): number {
  const t0 = createdAt ? new Date(createdAt).getTime() : Date.now()
  const age = (Date.now() - t0) / 86400000
  return Math.round(Math.max(0, Math.min(matureDay, age)))
}

/** 栏位 / 列表里的小图:渲染活体、当前天数形态;无蓝图回退静态 PNG */
function MiniRig({ c, box = 72 }: { c: MyCreature; box?: number }) {
  const cc = useMemo(() => {
    if (!c.blueprint) return null
    const norm = normalizeBlueprint(c.blueprint)
    if (!norm) return null
    try {
      return { ...compileBlueprint(norm), matureDay: norm.matureDay }
    } catch {
      return null
    }
  }, [c.blueprint])

  if (!cc) return c.img ? <img src={c.img} alt={c.name} /> : <span>?</span>
  return (
    <span className="cp-live">
      <RigCreature
        dna={cc.dna}
        rig={cc.rig}
        box={box}
        fixedDay={currentDayOf(c.createdAt, cc.matureDay)}
        matureDay={cc.matureDay}
        minScale={0.9}
      />
    </span>
  )
}
