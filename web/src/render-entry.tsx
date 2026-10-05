import { normalizeBlueprint, compileBlueprint } from '../lib/creature/index.js'
import { renderToPng } from './render-png.js'

/**
 * 离屏批量出图入口(仅 render.html 用):
 * 读 `?bp=<base64(JSON blueprint)>` → 校验 → 编译 → 出 PNG → 挂 window.__LUM_PNG。
 * Chrome 脚本轮询该字段取图。不参与正常应用。
 */
async function main() {
  const w = window as unknown as { __LUM_PNG?: string; __LUM_ERR?: string }
  try {
    const raw = new URLSearchParams(location.search).get('bp') || ''
    if (!raw) throw new Error('缺少 bp 参数')
    // base64 → UTF-8 字符串(先转字节再按 UTF-8 解,避免 escape/unescape 处理中文出错)
    const bin = atob(raw)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    const json = JSON.parse(new TextDecoder().decode(bytes))
    const norm = normalizeBlueprint(json)
    if (!norm) throw new Error('骨架不可用')
    const cc = compileBlueprint(norm)
    const q = new URLSearchParams(location.search)
    const dayRaw = Number(q.get('day'))
    const day = Number.isFinite(dayRaw) && q.get('day') !== null ? dayRaw : cc.matureDay
    const minRaw = Number(q.get('min'))
    const minScale = Number.isFinite(minRaw) && q.get('min') !== null ? minRaw : undefined
    w.__LUM_PNG = await renderToPng(cc.dna, cc.rig, cc.matureDay, undefined, day, minScale)
  } catch (e) {
    w.__LUM_ERR = e instanceof Error ? e.message : String(e)
  }
}

void main()
