import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadState, saveState, addCreature, setSelectedMany } from '../lib/creature-store.js'
import { leaderboard, collectSelected, authorLabel } from '../lib/rank.js'

const VER = '2.0-two-axis'
const fake = (over = {}) => ({
  descr: '一只测试生物',
  name: '测试',
  personality: '',
  blueprint: { v: 1, parts: [{ id: 'body', d: 'M0 0 L1 1' }] },
  dna: { name: '测试' },
  craft: 60,
  appeal: 60,
  total: 60,
  scoreVersion: VER,
  birthdayDay: 30,
  ...over,
})

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'luminari-rank-'))
}

test('authorLabel:owner → Admin,访客 → 匿名短 id', () => {
  assert.equal(authorLabel('owner'), 'Admin')
  assert.equal(authorLabel('a1b2c3d4e5f6a7b8'), '访客 · a1b2c3')
})

test('setSelectedMany:一次选多只(站长 Top5),不再互斥', async () => {
  const dir = await tmpDir()
  const s = await loadState(dir, 'owner')
  const rows = [addCreature(s, fake({ total: 90 }), Infinity), addCreature(s, fake({ total: 80 }), Infinity), addCreature(s, fake({ total: 70 }), Infinity)]
  const hit = setSelectedMany(s, [rows[0].id, rows[1].id])
  assert.equal(hit, 2)
  await saveState(dir, 'owner', s)
  const sel = await collectSelected(dir)
  assert.equal(sel.length, 2)
})

test('leaderboard:跨域汇总、按分降序、带作者与名次、限 100', async () => {
  const dir = await tmpDir()
  // 站长的 2 只
  const o = await loadState(dir, 'owner')
  const a = addCreature(o, fake({ name: '甲', total: 74 }), Infinity)
  const b = addCreature(o, fake({ name: '乙', total: 70 }), Infinity)
  setSelectedMany(o, [a.id, b.id])
  await saveState(dir, 'owner', o)
  // 一个访客的 1 只
  const v = await loadState(dir, 'abcdef0123456789')
  const c = addCreature(v, fake({ name: '丙', total: 88 }))
  setSelectedMany(v, [c.id])
  await saveState(dir, 'abcdef0123456789', v)

  const lb = await leaderboard(dir, VER, 100)
  assert.equal(lb.length, 3)
  assert.deepEqual(lb.map((x) => x.name), ['丙', '甲', '乙'])
  assert.deepEqual(lb.map((x) => x.rank), [1, 2, 3])
  assert.equal(lb[0].author, '访客 · abcdef')
  assert.equal(lb[1].author, 'Admin')
})

test('leaderboard:只含当前评分版本', async () => {
  const dir = await tmpDir()
  const o = await loadState(dir, 'owner')
  const old = addCreature(o, fake({ total: 99, scoreVersion: 'v1' }), Infinity)
  const cur = addCreature(o, fake({ total: 50, scoreVersion: VER }), Infinity)
  setSelectedMany(o, [old.id, cur.id])
  await saveState(dir, 'owner', o)
  const lb = await leaderboard(dir, VER, 100)
  assert.equal(lb.length, 1)
  assert.equal(lb[0].total, 50)
})

test('leaderboard:限 100 生效', async () => {
  const dir = await tmpDir()
  const o = await loadState(dir, 'owner')
  const ids = []
  for (let i = 0; i < 105; i++) ids.push(addCreature(o, fake({ total: i }), Infinity).id)
  setSelectedMany(o, ids)
  await saveState(dir, 'owner', o)
  const lb = await leaderboard(dir, VER, 100)
  assert.equal(lb.length, 100)
  assert.equal(lb[0].total, 104)
})
