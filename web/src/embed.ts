/**
 * 应用内嵌入(博客应用栏 iframe)时与宿主的通信。
 *
 * 跨子域 iframe 与宿主不同源,只能靠 `postMessage`;宿主 origin 由
 * `document.referrer` 反推(宿主 iframe 的 referrerPolicy 必须是 `origin`,
 * 见博客 docs/APP-EMBED.md)。**绝不退化到 `'*'`** —— 取不到就不发。
 */

const HOST_ORIGIN = (() => {
  try {
    return document.referrer ? new URL(document.referrer).origin : ''
  } catch {
    return ''
  }
})()

/** 是否被宿主 iframe 嵌入(独立打开时为 false) */
export const EMBEDDED =
  typeof window !== 'undefined' && window.parent !== window && !!HOST_ORIGIN

/** 向宿主发送消息;非嵌入环境静默跳过。 */
export function postToHost(data: Record<string, unknown>): void {
  if (!EMBEDDED) return
  try {
    window.parent.postMessage(data, HOST_ORIGIN)
  } catch {
    /* ignore */
  }
}
