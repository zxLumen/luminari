import type { CreatureBlueprint, CreatureDna } from '../lib/creature/index.js'

const j = async (res: Response) => {
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text.slice(0, 200) }
  }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error || `HTTP ${res.status}`
    const e = new Error(msg) as Error & { status?: number; body?: unknown }
    e.status = res.status
    e.body = body
    throw e
  }
  return body
}

export interface MyCreature {
  id: string
  descr: string
  name: string
  personality: string
  craft: number
  appeal: number
  total: number
  selected: boolean
  birthdayDay: number
  say: string
  pos: { x: number; y: number } | null
  memories: { kind: string; text: string; at: string }[]
  createdAt: string
  img: string
  blueprint?: CreatureBlueprint
  dna?: CreatureDna
}

export const api = {
  status: () => fetch('/api/status').then(j) as Promise<{ scoreVersion: string; maxCreatures: number; dailyCreate: number }>,
  mine: () => fetch('/api/creature/mine').then(j) as Promise<{ count: number; max: number; items: MyCreature[] }>,
  generate: (descr: string, retryHint = '') =>
    fetch('/api/creature/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descr, retryHint }),
    }).then(j) as Promise<{ blueprint: CreatureBlueprint; score: { craft: number; appeal: number; total: number } }>,
  commit: (body: { descr: string; blueprint: CreatureBlueprint; png: string; replaceId?: string; birthdayDay?: number }) =>
    fetch('/api/creature/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j) as Promise<{ creature: MyCreature; name: string; personality: string }>,
  patch: (id: string, patch: { name?: string; selected?: boolean }) =>
    fetch(`/api/creature/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(j) as Promise<{ creature: MyCreature }>,
  remove: (id: string) => fetch(`/api/creature/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(j),
  field: () => fetch('/api/creatures/field').then(j) as Promise<{ items: FieldCreature[] }>,
  top: (n = 5) => fetch(`/api/creatures/top?n=${n}`).then(j) as Promise<{ items: FieldCreature[] }>,
}

export interface FieldCreature {
  id: string
  descr: string
  name: string
  craft?: number
  appeal?: number
  total: number
  img: string
  say: string
  pos: { x: number; y: number } | null
  mine?: boolean
}
