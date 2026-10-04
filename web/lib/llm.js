/**
 * OpenAI 兼容的上游调用:文本对话 + 多模态(视觉裁判)。
 * 与 StockApp / yijing64 的 llm.js 同源,增加了 image_url 多模态支持。
 */

export const endpointURL = (baseURL) => {
  const trimmed = String(baseURL ?? '').trim()
  if (!trimmed) return null
  try {
    return new URL('chat/completions', trimmed.endsWith('/') ? trimmed : `${trimmed}/`)
  } catch {
    return null
  }
}

export const isOpenCode = (baseURL) => String(baseURL ?? '').toLowerCase().includes('opencode.ai')

export const standardHeaders = (config, sessionId) => {
  /** @type {Record<string,string>} */
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Luminari/1.0',
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  if (isOpenCode(config.baseURL)) {
    headers['x-opencode-session'] = sessionId
  }
  return headers
}

/** messages 里 content 可以是纯字符串,也可以是 ContentPart[](多模态)。原样透传 */
export const requestBody = ({ model, messages, maxTokens, stream = false, includeUsage = false, temperature = 0.6, noThinking = false }) => {
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    max_tokens: maxTokens,
    stream,
  }
  if (stream && includeUsage) body.stream_options = { include_usage: true }
  // 思考链模型把 reasoning 和正文记在同一份 max_tokens 上。文本生成/对话不需要思考过程,
  // 用 reasoning_effort=none 压掉(只对 opencode 端点发,别处未验证)。
  if (noThinking) body.reasoning_effort = 'none'
  return body
}

/** 把上游错误正文变成一句能看懂的话(纯文本 / JSON 都兼容)。 */
export const friendlyDetail = (text) => {
  const t = String(text ?? '').trim()
  if (!t) return ''
  try {
    const j = JSON.parse(t)
    return j?.error?.message || j?.message || j?.error || t.slice(0, 300)
  } catch {
    return t.slice(0, 300)
  }
}

/** 非流式单轮补全,返回 { text, inTokens, outTokens, finishReason }。 */
export async function completeChat(config, { messages, maxTokens = 1500, temperature = 0.6, noThinking = true, sessionId = 'luminari', signal }) {
  const url = endpointURL(config.baseURL)
  if (!url) throw new Error('模型端点未配置')
  const res = await fetch(url, {
    method: 'POST',
    headers: standardHeaders(config, sessionId),
    body: JSON.stringify(requestBody({ model: config.model, messages, maxTokens, temperature, noThinking })),
    signal,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`上游 ${res.status}:${friendlyDetail(raw)}`)
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`上游返回非 JSON:${raw.slice(0, 200)}`)
  }
  const msg = json?.choices?.[0]?.message
  // 思考链模型把正文放 content,推理放 reasoning_content —— 只取 content。
  const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((c) => c?.text ?? '').join('') : ''
  return {
    text,
    inTokens: json?.usage?.prompt_tokens ?? 0,
    outTokens: json?.usage?.completion_tokens ?? 0,
    finishReason: json?.choices?.[0]?.finish_reason ?? '',
  }
}
