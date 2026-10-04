import { fitBradleyTerry, reconcilePair } from '../server-dist/creature/index.js'
import { completeChat } from './llm.js'

/**
 * 视觉成对裁判 + BT 精排。
 *
 * 说明:评分(分)永远来自确定性的 `heur`;VLM 只回答「这两只谁更好看」,
 * 把 Top 边界处的顺序调得更贴人眼。失败/无 key → 退回纯 heur 顺序。
 */

export const JUDGE_SYSTEM = `你是一位视觉审美评委。用户会给你两张生物插画(A 和 B),你要判断哪一张**看起来更好看**。

规则:
- 只评判**审美观感**:构图、配色和谐、形体完整度、有没有记忆点、有没有明显的视觉缺陷(比如糊成一团、颜色刺眼、比例失衡)。
- **不要**因为「更复杂 / 部件更多 / 更花哨」就认为更好看。简洁而整洁,可以胜过繁复而杂乱。
- **先写一句「两张图的具体视觉差异」**(必须落到图上真实存在的东西,不要空话),再给结论。
- 结论只能是这三个之一,单独一行:【A】【B】【平局】

输出格式(严格遵守):
差异:<一句话,说出你在图里实际看到的区别>
结论:【A】 或 【B】 或 【平局】`

/** 把两张图 + 指引拼成一条 user 消息(图片只能放 user 消息里) */
function judgeUserMessage(a, b) {
  return [
    { type: 'text', text: '下面依次是图 A 和图 B。请按规则评判,先写差异,再给结论。' },
    { type: 'text', text: '图 A:' },
    { type: 'image_url', image_url: { url: a, detail: 'low' } },
    { type: 'text', text: '图 B:' },
    { type: 'image_url', image_url: { url: b, detail: 'low' } },
  ]
}

export function parseVerdict(text) {
  const reason = text.match(/差异[:：]\s*(.+)/)?.[1]?.trim() ?? ''
  const m = text.match(/【\s*(A|B|平局)\s*】/i)
  if (m) {
    const v = m[1].toUpperCase()
    return { verdict: v === 'A' || v === 'B' ? v : '平局', reason }
  }
  const tail = text.slice(-80)
  const ai = tail.lastIndexOf('A')
  const bi = tail.lastIndexOf('B')
  const tie = tail.lastIndexOf('平局')
  if (tie >= 0 && tie > ai && tie > bi) return { verdict: '平局', reason }
  if (ai >= 0 || bi >= 0) return { verdict: ai > bi ? 'A' : 'B', reason }
  return { verdict: null, reason }
}

async function judgePair(aiConfig, firstPng, secondPng) {
  try {
    const res = await completeChat(aiConfig, {
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: judgeUserMessage(firstPng, secondPng) },
      ],
      maxTokens: 900,
      temperature: 0,
      noThinking: false,
    })
    return parseVerdict(res.text).verdict
  } catch {
    return null
  }
}

const toOutcome = (v) => (v === 'A' ? 'a' : v === 'B' ? 'b' : 'tie')

/**
 * 对候选池(已按 heur 降序、带 data URL 图)做相邻成对精排。
 * 返回精排后的顺序(未 applied 时调用方保留 heur 顺序)。
 */
export async function rerankTop(aiConfig, items, maxPairs = 6) {
  const withImg = items.filter((i) => i.png)
  if (withImg.length < 2) return { order: items.map((i) => i.id), applied: false }

  const pairsToAsk = []
  for (let k = 0; k + 1 < withImg.length && pairsToAsk.length < maxPairs; k++) {
    pairsToAsk.push([withImg[k], withImg[k + 1]])
  }

  const btPairs = []
  let ok = 0
  for (const [x, y] of pairsToAsk) {
    const ab = await judgePair(aiConfig, x.png, y.png)
    const ba = await judgePair(aiConfig, y.png, x.png)
    if (!ab || !ba) continue
    const rec = reconcilePair(String(x.id), String(y.id), toOutcome(ab), toOutcome(ba))
    if (!rec.disagreed) ok++
    btPairs.push({ a: String(x.id), b: String(y.id), outcome: rec.outcome })
  }
  if (ok === 0) return { order: items.map((i) => i.id), applied: false }

  const ids = withImg.map((i) => String(i.id))
  const bt = fitBradleyTerry(ids, btPairs)
  const strength = (id) => bt.theta[id] ?? 0
  const ranked = [...withImg].sort((a, b) => strength(String(b.id)) - strength(String(a.id)))
  const rest = items.filter((i) => !i.png)
  return { order: [...ranked, ...rest].map((i) => i.id), applied: true }
}
