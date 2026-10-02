/**
 * dsh-term-lens —— Ollama 客户端
 *
 * 只依赖 node:http / node:https，不用 fetch（避免 Electron 主进程环境差异，
 * 也方便精确控制超时与流式读取）。
 *
 * 对外是一组 async generator：`chatStream()` yield 增量事件，
 * 调用方（HTTP 路由）把它转成 SSE，或把全部增量拼起来当非流式用。
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** 把 baseURL 归一化，返回 { request, origin, host, port, basePath, secure } */
function resolveEndpoint(baseURL) {
  const url = new URL(baseURL)
  const secure = url.protocol === 'https:'
  return {
    request: secure ? httpsRequest : httpRequest,
    origin: url.origin,
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    basePath: url.pathname.replace(/\/+$/, ''),
    secure,
  }
}

function openStream(endpoint, path, { method = 'GET', body, timeoutMs = 120_000, signal } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const headers = { accept: 'application/x-ndjson' }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.byteLength)
  }

  return new Promise((resolve, reject) => {
    const req = endpoint.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: `${endpoint.basePath}${path}`,
        method,
        headers,
      },
      (res) => resolve(res),
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Ollama 请求超时（${timeoutMs}ms）`))
    })
    req.on('error', reject)
    if (signal) {
      const onAbort = () => req.destroy(new Error('aborted'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (payload) req.write(payload)
    req.end()
  })
}

async function readErrorBody(res) {
  const chunks = []
  for await (const c of res) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8').slice(0, 2000)
  try {
    const parsed = JSON.parse(text)
    return parsed.error || text
  } catch {
    return text || `HTTP ${res.statusCode}`
  }
}

/** 按行切 NDJSON。返回 async generator of parsed objects。 */
async function* ndjson(res) {
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of res) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        yield JSON.parse(line)
      } catch {
        // 单行解析失败不该中断整个流
      }
    }
  }
  const tail = buffer.trim()
  if (tail) {
    try {
      yield JSON.parse(tail)
    } catch {
      /* ignore */
    }
  }
}

/** 健康检查 + 版本号。 */
export async function probe(config) {
  const endpoint = resolveEndpoint(config.ollama.baseURL)
  const started = Date.now()
  try {
    const res = await openStream(endpoint, '/api/version', { timeoutMs: 4000 })
    if (res.statusCode !== 200) {
      return { ok: false, error: await readErrorBody(res), baseURL: config.ollama.baseURL }
    }
    const chunks = []
    for await (const c of res) chunks.push(c)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return { ok: true, version: json.version ?? null, baseURL: config.ollama.baseURL, latencyMs: Date.now() - started }
  } catch (err) {
    return { ok: false, error: err.message, baseURL: config.ollama.baseURL, latencyMs: Date.now() - started }
  }
}

/** 列出本机模型，供 UI 的模型切换器用。 */
export async function listModels(config) {
  const endpoint = resolveEndpoint(config.ollama.baseURL)
  const res = await openStream(endpoint, '/api/tags', { timeoutMs: 6000 })
  if (res.statusCode !== 200) throw new Error(await readErrorBody(res))
  const chunks = []
  for await (const c of res) chunks.push(c)
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  return (json.models ?? []).map((m) => ({
    name: m.name ?? m.model,
    sizeBytes: m.size ?? 0,
    parameterSize: m.details?.parameter_size ?? null,
    quantization: m.details?.quantization_level ?? null,
    family: m.details?.family ?? null,
    updatedAt: m.modified_at ?? null,
    capabilities: m.capabilities ?? [],
  }))
}

/**
 * 流式对话。yield:
 *   { type: 'delta', text }        —— 增量文本（JSON 模式下是 JSON 文本的增量）
 *   { type: 'done', text, stats }  —— 结束，text 是完整文本
 *
 * @param {object} config
 * @param {{system: string, user?: string, turns?: Array<{role:string,content:string}>}} messages
 *        `turns` 是多轮问答（追问用）；`user` 是单轮提问。
 *        两者都给时按 system → turns → user 的顺序拼。
 * @param {{model?: string, schema?: object|null, signal?: AbortSignal}} opts
 */
export async function* chatStream(config, messages, opts = {}) {
  const endpoint = resolveEndpoint(config.ollama.baseURL)
  const model = opts.model || config.ollama.model
  const turns = Array.isArray(messages.turns) ? messages.turns : []
  const body = {
    model,
    stream: true,
    keep_alive: config.ollama.keepAlive,
    messages: [
      { role: 'system', content: messages.system },
      ...turns,
      ...(messages.user ? [{ role: 'user', content: messages.user }] : []),
    ],
    options: {
      temperature: config.ollama.temperature,
      // 单次调用可以覆盖（追问要带思考链，就得给更宽的预算）
      num_predict: opts.numPredict ?? config.ollama.numPredict,
      // 重复惩罚：小模型在结构化输出里很容易复读同一句,这是兜底闸门
      repeat_penalty: config.ollama.repeatPenalty ?? 1.15,
      repeat_last_n: config.ollama.repeatLastN ?? 256,
    },
  }
  // 结构化输出用 JSON Schema 约束解码（Ollama 的 `format` 既接受 'json'
  // 也接受 schema 对象）。经验教训：只给 'json' 时 4B 模型会复读同一串 token
  // 直到撞上预测上限,报 "token repeat limit reached"。给 schema 后每个字段的
  // 取值集合被语法约束,复读的余地就没有了。
  if (opts.schema) body.format = opts.schema
  else if (opts.json === true) body.format = 'json'
  // qwen3 / deepseek-r1 默认带思考链；关掉能明显降低首字延迟
  if (config.ollama.think === false) body.think = false
  // 追问要**显式打开**思考链 —— 理由见 routes.js 的 handleChat。
  // 优先级高于配置：这是功能正确性问题（不打开就会把推理写进正文），不是偏好。
  if (opts.think === true) body.think = true

  const started = Date.now()
  let firstTokenAt = null
  const res = await openStream(endpoint, '/api/chat', { method: 'POST', body, signal: opts.signal, timeoutMs: 180_000 })

  if (res.statusCode !== 200) {
    throw new Error(`Ollama ${res.statusCode}: ${await readErrorBody(res)}`)
  }

  let full = ''
  let stats = null
  for await (const line of ndjson(res)) {
    if (line.error) throw new Error(`Ollama: ${line.error}`)
    const delta = line.message?.content
    if (typeof delta === 'string' && delta.length > 0) {
      if (firstTokenAt === null) firstTokenAt = Date.now()
      full += delta
      yield { type: 'delta', text: delta }
    }
    if (line.done) {
      stats = {
        model: line.model ?? model,
        totalDurationMs: line.total_duration != null ? Math.round(line.total_duration / 1e6) : Date.now() - started,
        loadDurationMs: line.load_duration != null ? Math.round(line.load_duration / 1e6) : null,
        promptEvalCount: line.prompt_eval_count ?? null,
        evalCount: line.eval_count ?? null,
        ttftMs: firstTokenAt === null ? null : firstTokenAt - started,
      }
    }
  }
  yield { type: 'done', text: full, stats }
}

/** 非流式便捷封装：要整段结果时用（联网综述、预热）。 */
export async function chat(config, messages, opts = {}) {
  let text = ''
  let stats = null
  for await (const ev of chatStream(config, messages, opts)) {
    if (ev.type === 'delta') text += ev.text
    else if (ev.type === 'done') {
      text = ev.text
      stats = ev.stats
    }
  }
  return { text, stats }
}

/**
 * 预热：让模型加载进显存并保持 keep_alive。
 * 空 prompt + num_predict 0 是最省的做法，Ollama 会加载模型但几乎不生成。
 */
export async function warmUp(config, model) {
  const endpoint = resolveEndpoint(config.ollama.baseURL)
  const body = {
    model: model || config.ollama.model,
    stream: false,
    keep_alive: config.ollama.keepAlive,
    messages: [{ role: 'user', content: 'ok' }],
    options: { num_predict: 1, temperature: 0 },
  }
  const res = await openStream(endpoint, '/api/chat', { method: 'POST', body, timeoutMs: 180_000 })
  if (res.statusCode !== 200) throw new Error(await readErrorBody(res))
  for await (const _ of res) {
    /* 丢弃 */
  }
}
