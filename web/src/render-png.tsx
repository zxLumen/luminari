import type { CreatureDna, compileBlueprint } from '../lib/creature/index.js'
import { createRoot } from 'react-dom/client'
import { RigCreature } from './renderers/RigCreature.js'

/**
 * 把 RigCreature 的 SVG 渲染成 PNG data URL。
 * 流程:离屏容器 → React 渲染 → 取 <svg> → 序列化 → Image → canvas(铺底色)→ toDataURL。
 * 必须先铺底色:RigCreature 的 SVG 无背景,透明底喂给不同模型处理不一。
 */

export const RENDER_BOX = 300
export const RENDER_BG = '#f2f0f5'

export async function renderToPng(
  dna: CreatureDna,
  rig: ReturnType<typeof compileBlueprint>['rig'],
  matureDay: number,
  box = RENDER_BOX,
  day = matureDay,
  minScale?: number,
): Promise<string> {
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-99999px'
  host.style.top = '0'
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await new Promise<void>((res) => {
      root.render(
        <RigCreature dna={dna} rig={rig} box={box} fixedDay={day} matureDay={matureDay} minScale={minScale} />,
      )
      // 多等几帧 + 一个短延时:确保 React 已提交、rAF 循环至少画过一帧(否则首帧 transform 还没写上)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 40))),
      )
    })
    const svg = host.querySelector('svg')
    if (!svg) throw new Error('未找到 SVG')
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bg.setAttribute('x', '0')
    bg.setAttribute('y', '0')
    bg.setAttribute('width', String(box))
    bg.setAttribute('height', String(box))
    bg.setAttribute('fill', RENDER_BG)
    svg.insertBefore(bg, svg.firstChild)
    const str = new XMLSerializer().serializeToString(svg)
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str)
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = box
    canvas.height = box
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无 canvas 2d 上下文')
    ctx.fillStyle = RENDER_BG
    ctx.fillRect(0, 0, box, box)
    ctx.drawImage(img, 0, 0, box, box)
    return canvas.toDataURL('image/png')
  } finally {
    root.unmount()
    host.remove()
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('图片加载失败'))
    img.src = src
  })
}
