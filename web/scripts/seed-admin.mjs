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
 *   node scripts/seed-admin.mjs [N] [baseUrl] [--select]
 * 默认**不**自动选 Top5(留给站长在面板里手动精选);加 --select 才自动按分选前 5。
 * 需要 owner 登录,脚本自动用 data/owner.token 换取 cookie。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(__dirname, '..')
const ARGS = process.argv.slice(2)
const N = Number(ARGS.find((a) => /^\d+$/.test(a)) || 30)
const BASE = ARGS.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:8790'
const AUTO_SELECT = ARGS.includes('--select')

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

// 精选描述:丰富、具体(栖境 + 颜色 + 显著特征 + 性格),覆盖 8 类原型。
// 词面尽量含评分引擎收录的原型 / 特质 / 颜色词,造型与分数都更稳。
const DESCRIPTIONS = [
  '一只赛博朋克风格的机械蝴蝶,翅脉里流淌着蓝色霓虹,翅纹像全息电路',
  '深海中一只半透明的幽光蝴蝶,翅膀像数据流一样闪烁,空灵缥缈',
  '远古森林里的金绿色彩蝶,翅上覆满花粉,轻盈优雅',
  '烈阳下的火红凤蝶,翅缘如燃烧的熔岩,凶猛而耀眼',
  '深海中发光的巨型水母,触手像数据流一样飘动,幽蓝空灵',
  '冰霜之下的银白鲸鱼,背脊泛着极光,古老而温柔',
  '霓虹浅滩里一条半透明的蓝紫游鱼,鳞片折射七彩,灵动可爱',
  '远古深海的机械章鱼,金属触腕镶嵌橙色指示灯,赛博神秘',
  '远古森林里一只长着金属鳞片的翠绿幼龙,古老而威严',
  '火山口盘踞的火红飞龙,鳞甲如熔岩流淌,凶猛狂暴',
  '星尘中悬浮的空灵古龙,半透明身躯缠绕荧光藤蔓,缥缈神圣',
  '齿轮与钢铁拼成的银灰蛟龙,关节喷射蓝色电光,赛博未来',
  '一团会呼吸的幽蓝光球,表面刻着古老纹路,空灵虚渺',
  '星核般悬浮的金色灵体,周身环绕光环,圣洁而缥缈',
  '深海中的荧光泡泡群,像水母又像数据流,梦幻发光',
  '一缕赛博幽灵,全息代码凝成的紫色光团,半透明闪烁',
  '钢铁浇铸的甲虫机器人,六条腿闪着橙色指示灯,机械精密',
  '远古琥珀里爬出的金色甲虫,甲壳刻满古纹,沧桑古老',
  '森林中一只发光的翠绿萤火虫,尾灯忽明忽暗,小巧可爱',
  '蓝紫色的机械蜻蜓,四翼如全息玻璃,赛博又空灵',
  '通体翠绿的翡翠翠鸟,羽毛像宝石,精巧温柔',
  '火焰中重生的金红凤凰,翎羽燃烧,凶猛而神圣',
  '银白的机械猫头鹰,眼睛是蓝色摄像头,古老又科幻',
  '星尘里的空灵白鹤,长颈缠绕荧光,缥缈优雅',
  '森林里一株会走路的金绿蘑菇,伞盖发光,圆润可爱',
  '深海藤蔓缠绕的幽蓝花妖,花蕊像心脏搏动,神秘空灵',
  '远古巨树的活藤,叶脉流动翡翠荧光,古老而坚韧',
  '冰霜中绽放的银白水晶花,花瓣半透明,圣洁空灵',
  '赛博霓虹的机械狐狸,金属皮毛下流淌蓝色电流,灵动未来',
  '圆滚滚的机械水獭,关节齿轮外露,呆萌可爱',
]

function descrAt(i) {
  return DESCRIPTIONS[i % DESCRIPTIONS.length]
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

    const sorted = [...born].sort((a, b) => b.total - a.total)

    // 默认不自动选 Top5(站长在面板里手动精选);--select 才按分自动选。
    if (AUTO_SELECT) {
      const top5 = sorted.slice(0, 5)
      console.log('\n[seed] 自动选 Top5:', top5.map((c) => `${c.id}(${c.total.toFixed(1)})`).join(' '))
      await api('/api/creature/selected', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({ ids: top5.map((c) => c.id) }),
      })
    } else {
      console.log('\n[seed] 未自动选参排;请在面板「全部生灵」手动精选 Top5。')
    }

    // 导出分数最高的一只,供后续用作应用图标兜底
    const top1 = sorted[0]
    fs.writeFileSync(path.join(DATA_DIR, 'top1.json'), JSON.stringify(top1, null, 2))
    console.log(`\n[seed] 完成,共 ${born.length} 只;最高分 = ${top1.id} (${top1.name} ${top1.total.toFixed(1)})`)
    console.log(`[seed] 图:${BASE}/creatures-png/${top1.id}.png`)
  } finally {
    renderer.close()
    chrome.kill()
  }
}

main().catch((e) => {
  console.error('[seed] 失败:', e.message)
  process.exit(1)
})
