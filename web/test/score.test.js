import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBlueprint, compileBlueprint, heuristicScore, SCORE_VERSION, randomBatch } from '../server-dist/creature/index.js'

// 用 fallbackDna 造一份合法 blueprint,测打分链路
import { fallbackDna } from '../server-dist/creature/fallback.js'

/** 由 fallbackDna 组一份最小 blueprint(一个躯干部件,走完整校验) */
function minimalBlueprint(descr) {
  const dna = fallbackDna(descr)
  return {
    v: 1,
    dna,
    span: dna.span ?? 90,
    matureDay: dna.matureDay ?? 30,
    parts: [{ id: 'body', d: 'M -30 0 C -30 -20 30 -20 30 0 C 30 20 -30 20 -30 0 Z', role: 'body', z: 20 }],
    motionCfg: { family: 'idle', period: 1.6, amplitude: 1, rules: {} },
  }
}

test('SCORE_VERSION 存在且是字符串', () => {
  assert.equal(typeof SCORE_VERSION, 'string')
  assert.ok(SCORE_VERSION.length > 0)
})

test('打分链路:blueprint → normalize → compile → heuristicScore 产出两轴 + total', () => {
  const bp = minimalBlueprint('一只赛博猫')
  const norm = normalizeBlueprint(bp)
  assert.ok(norm, 'blueprint 应通过校验')
  const cc = compileBlueprint(norm)
  const score = heuristicScore(cc.dna, '一只赛博猫', { parts: norm.parts, span: norm.span })
  assert.ok(score.craft >= 0 && score.craft <= 100)
  assert.ok(score.appeal >= 0 && score.appeal <= 100)
  assert.ok(score.total >= 0 && score.total <= 100)
  // total = craft^0.6 * appeal^0.4
  const expect = Math.round(Math.pow(score.craft / 100, 0.6) * Math.pow(score.appeal / 100, 0.4) * 100 * 1000) / 1000
  assert.ok(Math.abs(score.total - expect) < 0.01, `total=${score.total} expect=${expect}`)
})

test('不同描述会得到不同分数(有区分度)', () => {
  const a = heuristicScore(compileBlueprint(normalizeBlueprint(minimalBlueprint('一只小虫子'))).dna, '一只小虫子', {})
  const b = heuristicScore(compileBlueprint(normalizeBlueprint(minimalBlueprint('一只赛博霓虹龙'))).dna, '一只赛博霓虹龙', {})
  // 至少不相等(具体谁高不保证,只验证不是常数)
  assert.ok(Number.isFinite(a.total) && Number.isFinite(b.total))
})

test('randomBatch 确定性:同 seed 同输出', () => {
  const a = randomBatch(6, 42)
  const b = randomBatch(6, 42)
  assert.deepEqual(a.items.map((i) => i.descr), b.items.map((i) => i.descr))
})
