import { useEffect, useMemo, useState } from 'react'
import { api, type RankRow } from './api.js'
import { RigCreature } from './renderers/RigCreature.js'
import { normalizeBlueprint, compileBlueprint, STAGE_LABELS, type CreatureBlueprint } from '../lib/creature/index.js'

/** 现实天数(从出生到现在),封顶在成熟天数 */
function currentDayOf(createdAt: string | undefined, matureDay: number): number {
  const t0 = createdAt ? new Date(createdAt).getTime() : Date.now()
  const age = (Date.now() - t0) / 86400000
  return Math.max(0, Math.min(matureDay, age))
}

/** 从蓝图取成熟天数(用于滑杆上限) */
function matureDayOf(bp?: CreatureBlueprint): number {
  if (!bp) return 34
  return normalizeBlueprint(bp)?.matureDay ?? 34
}

/**
 * 排行榜:全站参与排行的生灵按分降序 Top100。
 * 每行:缩略图 + 名次 + 名字 + 作者 + 分数 + 提示词;点缩略图看大图预览。
 */
export function Leaderboard() {
  const [rows, setRows] = useState<RankRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState<RankRow | null>(null)

  useEffect(() => {
    api
      .leaderboard(100)
      .then((r) => setRows(r.items))
      .catch((e) => setErr(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="lb">
      <header className="lb-head">
        <h1>排行榜 · Top {rows.length || 100}</h1>
        <p className="lb-lead">全站参与排行的生灵,按分降序。缩略图是它**当前天数**的形态;点开可按天预览各阶段。</p>
      </header>

      {err && <p className="lb-err">{err}</p>}
      {loading ? (
        <p className="lb-hint">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="lb-hint">还没有生灵上榜。</p>
      ) : (
        <ol className="lb-list">
          {rows.map((r) => (
            <li key={r.id} className={`lb-row${r.rank <= 3 ? ' is-top' : ''}`}>
              <span className="lb-rank">{r.rank}</span>
              <button className="lb-thumb" onClick={() => setPreview(r)} title="看大图 / 按天预览">
                <LiveCreature
                  blueprint={r.blueprint}
                  box={64}
                  day={currentDayOf(r.createdAt, matureDayOf(r.blueprint))}
                  minScale={0.9}
                  fallbackSrc={r.img}
                  alt={r.name}
                />
              </button>
              <div className="lb-main">
                <div className="lb-name">{r.name || '无名'}</div>
                <div className="lb-author">{r.author}</div>
                <div className="lb-descr" title={r.descr}>
                  {r.descr}
                </div>
              </div>
              <div className="lb-score">
                <span className="lb-total">{r.total.toFixed(1)}</span>
                <span className="lb-sub">
                  craft {r.craft.toFixed(0)} · appeal {r.appeal.toFixed(0)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}

      {preview && <PreviewModal row={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

function PreviewModal({ row, onClose }: { row: RankRow; onClose: () => void }) {
  const matureDay = matureDayOf(row.blueprint)
  const [day, setDay] = useState(() => currentDayOf(row.createdAt, matureDay))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stage =
    STAGE_LABELS[Math.min(STAGE_LABELS.length - 1, Math.floor((day / matureDay) * STAGE_LABELS.length))] ?? ''

  return (
    <div className="lb-modal" onClick={onClose}>
      <div className="lb-modal-box" onClick={(e) => e.stopPropagation()}>
        <button className="lb-modal-close" onClick={onClose} title="关闭 (Esc)">
          ✕
        </button>
        <LiveCreature
          className="lb-modal-img"
          blueprint={row.blueprint}
          box={300}
          day={day}
          fallbackSrc={row.img}
          alt={row.name}
        />
        <div className="lb-modal-side">
          <div className="lb-modal-rank">#{row.rank}</div>
          <h2 className="lb-modal-name">{row.name || '无名'}</h2>
          <div className="lb-modal-author">作者:{row.author}</div>
          <div className="lb-modal-scores">
            <span className="lb-total">{row.total.toFixed(1)}</span>
            <span className="lb-sub">
              craft {row.craft.toFixed(0)} · appeal {row.appeal.toFixed(0)}
            </span>
          </div>
          <div className="lb-modal-timeline">
            <input
              type="range"
              min={0}
              max={matureDay}
              step={1}
              value={Math.round(day)}
              onChange={(e) => setDay(Number(e.target.value))}
              aria-label="预览天数"
            />
            <span className="lb-modal-day">
              第 {Math.round(day)} 天 · {stage}
            </span>
          </div>
          <div className="lb-modal-descr-label">提示词</div>
          <p className="lb-modal-descr">{row.descr}</p>
        </div>
      </div>
    </div>
  )
}

/** 有蓝图就渲染活体 RigCreature(指定天数形态、动作照常),否则回退静态 PNG */
function LiveCreature({
  blueprint,
  box,
  day,
  minScale,
  fallbackSrc,
  alt,
  className,
}: {
  blueprint?: CreatureBlueprint
  box: number
  day?: number
  minScale?: number
  fallbackSrc: string
  alt: string
  className?: string
}) {
  const cc = useMemo(() => {
    if (!blueprint) return null
    const norm = normalizeBlueprint(blueprint)
    if (!norm) return null
    try {
      return { ...compileBlueprint(norm), matureDay: norm.matureDay }
    } catch {
      return null
    }
  }, [blueprint])

  if (!cc) return <img className={className} src={fallbackSrc} alt={alt} />
  return (
    <span className={className ? `live-wrap ${className}` : 'live-wrap'}>
      <RigCreature
        dna={cc.dna}
        rig={cc.rig}
        box={box}
        fixedDay={day ?? cc.matureDay}
        matureDay={cc.matureDay}
        minScale={minScale}
      />
    </span>
  )
}
