import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  loadState,
  saveState,
  addCreature,
  replaceCreature,
  renameCreature,
  setSelected,
  removeCreature,
  findById,
  MAX_CREATURES_PER_CID,
} from '../lib/creature-store.js'

const descr = '一只赛博猫'
const fake = (over = {}) => ({
  descr,
  name: '霓爪',
  personality: '我喜欢电流的味道',
  blueprint: { v: 1, parts: [{ id: 'body', d: 'M0 0 L1 1' }] },
  dna: { name: '霓爪' },
  craft: 60,
  appeal: 70,
  total: 65,
  scoreVersion: '2.0-two-axis',
  birthdayDay: 30,
  ...over,
})

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'luminari-'))
}

test('新增 + 读回', async () => {
  const dir = await tmpDir()
  const s = await loadState(dir, 'c1')
  const row = addCreature(s, fake())
  await saveState(dir, 'c1', s)
  const s2 = await loadState(dir, 'c1')
  assert.equal(s2.items.length, 1)
  assert.equal(s2.items[0].name, '霓爪')
  assert.ok(s2.items[0].id.startsWith('c'))
})

test('上限:第 6 只抛 LIMIT', async () => {
  const dir = await tmpDir()
  const s = await loadState(dir, 'c1')
  for (let i = 0; i < MAX_CREATURES_PER_CID; i++) addCreature(s, fake({ name: `生灵${i}` }))
  assert.throws(() => addCreature(s, fake()), /已经有 5 只/)
})

test('覆盖保留 id', async () => {
  const dir = await tmpDir()
  const s = await loadState(dir, 'c1')
  const row = addCreature(s, fake())
  const rep = replaceCreature(s, row.id, fake({ name: '新名', total: 90 }))
  assert.equal(rep.id, row.id)
  assert.equal(rep.name, '新名')
  await saveState(dir, 'c1', s)
  const s2 = await loadState(dir, 'c1')
  assert.equal(s2.items.length, 1)
  assert.equal(s2.items[0].total, 90)
})

test('改名', async () => {
  const dir = await tmpDir()
  const s = await loadState(dir, 'c1')
  const row = addCreature(s, fake())
  assert.equal(renameCreature(s, row.id, '改名了').name, '改名了')
  assert.equal(renameCreature(s, 'nope', 'x'), null)
})

test('选择参与排行是单选', async () => {
  const dir = await tmpDir()
  const s = await loadState(dir, 'c1')
  const a = addCreature(s, fake({ name: 'A' }))
  const b = addCreature(s, fake({ name: 'B' }))
  setSelected(s, a.id, true)
  setSelected(s, b.id, true)
  assert.equal(findById(s, a.id).selected, false)
  assert.equal(findById(s, b.id).selected, true)
})

test('删除', async () => {
  const dir = await tmpDir()
  const s = await loadState(dir, 'c1')
  const a = addCreature(s, fake())
  assert.equal(removeCreature(s, a.id), true)
  assert.equal(removeCreature(s, a.id), false)
  assert.equal(s.items.length, 0)
})
