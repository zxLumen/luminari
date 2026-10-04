/**
 * 批量生成「Admin 的生灵」并选 Top5(离线运维脚本)。
 *
 * 做四件事:
 *  1. 用 luminari 自己的生成 API 造 N 只(默认 30)蓝图;
 *  2. 用本机 Chrome(CDP)打开 `render.html` 把每只渲染成 PNG;
 *  3. 以 owner 身份逐只提交(score 由服务端算);
 *  4. 按分排序,把 Top5 标为 `selected`(Admin 不受 5 只上限约束 —— 服务端已对 owner 豁免)。
 *
 * 用法(在 web/ 下,先构建前端 + 起 server):
 *   node scripts/seed-admin.mjs [N] [baseUrl]
 * 需要 owner 登录,脚本自动用 data/owner.token 换取 cookie。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(__dirname, '..')
const N = Number(process.argv[2] || 30)
const BASE = process.argv[3] || 'http://127.0.0.1:8790'

const DATA_DIR = process.env.LUMINARI_DATA_DIR || path.join(WEB, 'data')
const ownerToken = fs.readFileSync(path.join(DATA_DIR, 'owner.token'), 'utf8').trim()

// ---------------------------------------------------------------- CDP

function findChrome() {
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error('未找到 Chrome/Chromium')
  return f
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pend = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pend.has(m.id)) {
        const { resolve, reject } = this.pend.get(m.id)
        this.pend.delete(m.id)
        if (m.error) reject(new Error(`${m.error.message}(${m.error.code})`))
        else resolve(m.result)
      }
    }
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('CDP 连接失败'))
    })
    return new Cdp(ws)
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pend.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  close() {
    this.ws.close()
  }
}

async function launchChrome(port) {
  const chrome = findChrome()
  const proc = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(DATA_DIR, 'chrome-seed'),
  ], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return proc
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Chrome 启动超时')
}

/** 用无头 Chrome 渲染一份 blueprint → dataURL */
async function makeRenderer(port) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(ver.webSocketDebuggerUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Page.enable', {}, sessionId)
  await browser.send('Runtime.enable', {}, sessionId)

  return {
    browser,
    async render(bp) {
      const b64 = Buffer.from(JSON.stringify(bp), 'utf8').toString('base64')
      // b64 含 +/=,必须整体 encodeURIComponent 才能安全放进查询串
      const url = `${BASE}/render.html?bp=${encodeURIComponent(b64)}`
      await browser.send('Page.navigate', { url }, sessionId)
      // 轮询 window.__LUM_PNG / __LUM_ERR
      for (let i = 0; i < 120; i++) {
        const r = await browser.send(
          'Runtime.evaluate',
          { expression: 'JSON.stringify({png:window.__LUM_PNG,err:window.__LUM_ERR})', returnByValue: true },
          sessionId,
        )
        const v = JSON.parse(r.result.value || '{}')
        if (v.err) throw new Error(v.err)
        if (v.png) return v.png
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('出图超时')
    },
    close() {
      browser.close()
    },
  }
}

// ---------------------------------------------------------------- HTTP

const cookie = `luminari_owner=${ownerToken}`

async function api(pathname, init) {
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const txt = await res.text()
  let body = {}
  try {
    body = txt ? JSON.parse(txt) : {}
  } catch {
    body = { error: txt.slice(0, 200) }
  }
  if (!res.ok) throw new Error(`${pathname} → ${res.status} ${body.error || ''}`)
  return body
}

// 随机描述:GENERATE 的原型池由服务端 randomBatch 提供;这里自造一批多样描述
const SUBJ = ['龙', '水母', '狐狸', '机械猫', '蝴蝶', '深海鱼', '鹿', '猫头鹰', '水獭', '独角兽', '蜘蛛', '鲸', '蜂鸟', '蜥蜴', '企鹅']
const MOD = ['赛博霓虹的', '深海的', '森林的', '火焰的', '冰霜的', '幽光的', '古老的', '星尘的', '机械的', '空灵的']
const QUIRK = ['会发光的翅膀', '半透明的身体', '金属质感的鳞片', '飘动的尾巴', '多对眼睛', '缠绕的触须', '环形光环', '水晶般的角']

function descrAt(i) {
  const r = (n) => (i * 2654435761 + n * 40503) % 1000003
  return `一只${MOD[r(1) % MOD.length]}${SUBJ[r(2) % SUBJ.length]},${QUIRK[r(3) % QUIRK.length]},${r(4) % 2 ? '优雅' : '神秘'}`
}

// ---------------------------------------------------------------- main

async function main() {
  const port = 9333
  console.log(`[seed] 生成 ${N} 只 → ${BASE}`)
  const chrome = await launchChrome(port)
  const renderer = await makeRenderer(port)
  const born = []

  try {
    for (let i = 0; i < N; i++) {
      const descr = descrAt(i)
      process.stdout.write(`[${i + 1}/${N}] ${descr} ... `)
      let gen
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          gen = await api('/api/creature/generate', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ descr }) })
          break
        } catch (e) {
          if (attempt === 2) throw e
          process.stdout.write(`retry(${e.message}) `)
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
      const png = await renderer.render(gen.blueprint)
      const c = await api('/api/creature/commit', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ descr, blueprint: gen.blueprint, png }),
      })
      born.push(c.creature)
      console.log(`#${c.creature.id} total=${c.creature.total.toFixed(1)} name=${c.name}`)
    }

    // 选 Top5(一次批量设置,避免逐只 PATCH 的单选互斥互相清除)
    const sorted = [...born].sort((a, b) => b.total - a.total)
    const top5 = sorted.slice(0, 5)
    console.log('\n[seed] Top5:', top5.map((c) => `${c.id}(${c.total.toFixed(1)})`).join(' '))
    await api('/api/creature/selected', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ ids: top5.map((c) => c.id) }),
    })

    // 导出 Top1 供后续用作应用图标
    const top1 = top5[0]
    fs.writeFileSync(path.join(DATA_DIR, 'top1.json'), JSON.stringify(top1, null, 2))
    console.log(`\n[seed] 完成,共 ${born.length} 只;Top1 = ${top1.id} (${top1.name})`)
    console.log(`[seed] Top1 图:${BASE}/creatures-png/${top1.id}.png`)
  } finally {
    renderer.close()
    chrome.kill()
  }
}

main().catch((e) => {
  console.error('[seed] 失败:', e.message)
  process.exit(1)
})
