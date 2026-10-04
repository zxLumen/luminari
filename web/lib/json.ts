/**
 * 从模型输出里把 JSON 抠出来。
 *
 * 模型几乎一定会夹带前言/后语或 Markdown 围栏,所以不能直接 `JSON.parse`。
 * 策略:先去围栏,再从第一个 `{` 配平到对应的 `}`(按字符串状态跳过引号内的括号),
 * 这样即使正文里有花括号模板也不会截错。
 */
export function extractJson(text: string): unknown | null {
  if (typeof text !== 'string') return null
  let s = text.trim()

  // 去掉 ```json ... ``` / ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) s = fence[1].trim()

  const start = s.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
