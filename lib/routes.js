/**
 * dsh-term-lens —— 宿主 HTTP 路由
 *
 * DSH 的 webserver 服务是一个纯路由注册表：
 *   ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })
 * handler 拿到的是原生 node:http 的 (req, res)，返回 disposer 用于卸载。
 *
 * 路由设计：只注册一条 prefix 路由 `/term-lens`，内部自己分发。
 * 这样卸载只有一个 disposer，也不会和别人抢路径。
 *
 * 端点：
 *   GET  /term-lens/status          插件与 Ollama 健康状态、当前配置摘要
 *   GET  /term-lens/models          本机 Ollama 模型列表（给设置页的模型选择）
 *   POST /term-lens/explain         解释一个术语（SSE 流式）
 *   POST /term-lens/chat            围绕同一术语追问（SSE 流式，纯文本）
 *   GET  /term-lens/history         读会话历史
 *   POST /term-lens/history         追加查词历史
 *   DELETE /term-lens/history       删除历史（单条或全部）
 *   GET  /term-lens/cache           缓存统计 + 最近条目
 *   POST /term-lens/cache/clear     清空缓存
 *   GET  /term-lens/config          读配置
 *   POST /term-lens/config          改配置（白名单字段）
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_PATH, HISTORY_DIR, ROOT, CACHE_DIR, loadConfig, DEFAULT_CONFIG } from './config.js'
import { buildMessages, buildWebMessages, buildFollowUpMessages, normalizeExplanation, PROMPT_VERSION, EXPLANATION_SCHEMA, schemaFor } from './prompt.js'
import * as cache from './cache.js'
import { probe, listModels, chatStream, warmUp } from './ollama.js'
import { gatherMaterials, ENGINE_CHOICES } from './websearch.js'

const PREFIX = '/term-lens'

/**
 * 客户端回传的诊断信息。
 *
 * Desktop 版没有可用的 DevTools / console 通道，所以让客户端把它探测到的宿主能力
 * POST 回来，再用 GET /term-lens/diag 读。这是排查「设置页 / 侧栏没出现」这类
 * 问题的唯一手段 —— 否则只能靠猜。
 */
let lastDiag = null

/**
 * 诊断通道的使用计数。
 *
 * 光看 lastDiag 的内容分不清三种情况:
 *   a) 客户端根本没发
 *   b) 客户端发了但内容是空
 *   c) 我们自己在看
 * 把「写过几次 / 读过几次 / 注入脚本回执过几次」分开记,这三种就分得清了。
 */
const diagStats = {
  posts: 0,
  lastPostAt: null,
  gets: 0,
  lastGetAt: null,
  clientPings: 0,
  lastClientPingAt: null,
  lastClientPingQuery: null,
  envProbes: 0,
  lastEnvProbeAt: null,
}

/** 页面环境探测的回执，原样存下不做解释。 */
let lastEnv = null

/** 页面侧逐个尝试 bundle URL 的结果（探测脚本异步分次回传）。 */
const envFetchResults = {}

/** 自愈流程的分阶段回执，按到达顺序保留最近若干条。 */
const clientPingPhases = []

/** 读 lib/client.js 的源码，供 /client-bundle.js 自供。读不到返回 null。 */
function readClientBundle() {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'client.js'), 'utf8')
  } catch {
    return null
  }
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req, limit = 512 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

/** 会话 id 要能安全当文件名。 */
function safeId(id) {
  return String(id ?? 'anonymous').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

function historyPath(sessionId) {
  return join(HISTORY_DIR, `${safeId(sessionId)}.json`)
}

function readHistory(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(sessionId), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function appendHistory(sessionId, rows) {
  const existing = readHistory(sessionId)
  const seen = new Set()
  const merged = []
  for (const row of [...rows, ...existing]) {
    if (!row || typeof row.term !== 'string') continue
    const k = `${cache.normalizeTerm(row.term)}::${row.at ?? ''}`
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(row)
  }
  const trimmed = merged.slice(0, 500)
  writeFileSync(historyPath(sessionId), JSON.stringify(trimmed, null, 2), 'utf8')
  return trimmed
}

/** 整体覆盖历史（删除用）。 */
function writeHistory(sessionId, rows) {
  const safe = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.term === 'string').slice(0, 500)
  try {
    writeFileSync(historyPath(sessionId), JSON.stringify(safe, null, 2), 'utf8')
  } catch {
    /* 目录不存在等情况：读的时候会当成空历史 */
  }
  return safe
}

/* ── SSE ────────────────────────────────────────────────────────────── */

function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 关掉 nginx 一类的缓冲（DSH 自己不开代理，但留着无害）
    'x-accel-buffering': 'no',
  })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  let closed = false
  const send = (event, data) => {
    if (closed) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // 心跳注释帧：防止中间层因长时间无数据而断开
  const beat = setInterval(() => {
    if (!closed) res.write(': ping\n\n')
  }, 15_000)

  return {
    send,
    get closed() {
      return closed
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(beat)
      try {
        res.end()
      } catch {
        /* ignore */
      }
    },
  }
}

/* ── 核心：解释一个术语 ─────────────────────────────────────────────── */

/**
 * 把底层错误翻译成「用户看得懂、并且知道下一步做什么」的话。
 *
 * ══ 为什么必须做这一层 ═══════════════════════════════════════════════
 *
 * 原先没装 Ollama 的人会看到解释卡片里一行红字：
 *
 *     connect ECONNREFUSED 127.0.0.1:11434
 *
 * 这是裸的 Node 网络错误。第一次装插件的人既不知道这是什么，也不知道
 * 该怎么办 —— 而这恰恰是**最容易发生**的一类问题（忘了启动 ollama serve、
 * 或者根本没装）。同理，装了但没 pull 默认模型时会看到
 * `model "qwen3:4b" not found`，也完全没有指引。
 *
 * 所以这里把可预期的失败逐条翻译成带**具体命令**的提示。
 * 兜底仍然返回原始信息 —— 宁可给技术细节，也不要给一句没有信息量的
 * 「出错了」。
 *
 * @returns {{message: string, hint: string, kind: string}}
 */
function explainOllamaFailure(err, config) {
  const raw = String(err?.message ?? err)
  const baseURL = config.ollama.baseURL
  const model = config.ollama.model

  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed|socket hang up/i.test(raw)) {
    return {
      kind: 'ollama-unreachable',
      message: `连不上 Ollama（${baseURL}）。`,
      hint:
        '两种可能：\n' +
        '1. 还没装 —— 去 https://ollama.com 下载安装；\n' +
        '2. 装了但没在跑 —— 在终端执行 `ollama serve`。\n' +
        '装好并启动后，回到设置页点「重新读取」即可。',
    }
  }

  if (/timeout|超时|ETIMEDOUT/i.test(raw)) {
    return {
      kind: 'ollama-timeout',
      message: `Ollama 响应超时（${baseURL}）。`,
      hint: '模型可能正在首次加载（大模型要几秒到几十秒）。稍等再试；若一直超时，检查本机负载或换一个更小的模型。',
    }
  }

  if (/not found|no such model|pull/i.test(raw) && /model/i.test(raw)) {
    return {
      kind: 'model-missing',
      message: `Ollama 里没有模型「${model}」。`,
      hint: `在终端执行：\n\`ollama pull ${model}\`\n或者到设置页把「解释用的本地模型」换成已经 pull 过的模型。`,
    }
  }

  return { kind: 'unknown', message: raw, hint: '' }
}

/**
 * 解析请求参数 → 决定用不用联网 → 走缓存或生成。
 * 以 SSE 事件流把过程吐给浏览器，让浮卡能边生成边渲染。
 *
 * 事件：
 *   meta       { term, model, cached, ck, key, viaWeb }
 *   delta      { text }                      原始 JSON 文本增量
 *   web-start  { }                            开始联网
 *   web-done   { count }
 *   done       { explanation, stats, cached, viaWeb }
 *   error      { message }
 */
async function handleExplain(req, res, config, logger) {
  const body = await readJsonBody(req)
  const term = String(body.term ?? '').trim()
  if (!term) {
    sendJson(res, 400, { error: '缺少 term' })
    return
  }
  if (term.length > 200) {
    sendJson(res, 400, { error: '术语过长' })
    return
  }

  const context = typeof body.context === 'string' ? body.context : ''
  const scene = typeof body.scene === 'string' ? body.scene : undefined
  const sessionId = body.sessionId ?? 'anonymous'
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.ollama.model
  const forceWeb = body.web === true
  const forceRefresh = body.refresh === true

  const sse = openSse(res)
  // 客户端断开时中止下游的 Ollama 请求，别让它空跑
  const abort = new AbortController()
  req.on('close', () => {
    abort.abort(new Error('client closed'))
    sse.close()
  })

  try {
    // 缓存指纹必须带上影响提示词的一切：context / style / customSystem。
    // 少了 style 就会出现「改了风格却永远看到旧解释」—— 已经踩过一次。
    const keyInfo = {
      term,
      model,
      promptVersion: PROMPT_VERSION,
      context,
      style: config.prompt.style,
      customSystem: config.prompt.customSystem,
    }

    // 1. 缓存
    let explanation = null
    let viaWeb = false
    let stats = null
    let cached = false

    if (config.cache.enabled && !forceWeb && !forceRefresh) {
      const hit = cache.lookup(keyInfo)
      if (!hit.hit) {
        // 没命中：顺手清掉这个上下文下用不到的变体（比如换了风格之后的老条目）。
        // 不清的话它们永远命中不到，却一直占着磁盘。
        try {
          const dropped = cache.dropStaleVariants(term, model, PROMPT_VERSION, context)
          if (dropped > 0) logger.info('[term-lens] 清理失效缓存变体 %d 条 (%s)', dropped, term)
        } catch {
          /* 清理失败不影响查询 */
        }
      }
      if (hit.hit) {
        cached = true
        explanation = hit.explanation
        sse.send('meta', { term, model, cached: true, key: hit.meta.key, ck: hit.meta.ck, viaWeb: false })
        // 缓存命中直接结束：done 只发这一处,否则客户端会收到两次 done
        sse.send('done', { explanation, stats: null, cached: true, viaWeb: false })
        try {
          appendHistory(sessionId, [
            {
              term: explanation.term || term,
              at: new Date().toISOString(),
              oneLine: explanation.oneLine,
              confidence: explanation.confidence,
              model,
              viaWeb: false,
              cached: true,
              contextSnippet: context.slice(0, 200),
            },
          ])
        } catch (err) {
          logger.warn('[term-lens] 写历史失败: %s', err.message)
        }
        return
      }
    }

    // 2. 生成本地解释
    let rawText = ''
    if (!explanation) {
      sse.send('meta', { term, model, cached: false, viaWeb: false })
      const messages = buildMessages({ term, context, scene, prompt: config.prompt })
      // 按有没有上下文挑 schema：没有上下文时把 inContext 从 required 里去掉，
      // 否则等于逼模型编一个通用定义（实测约一半概率会编）。见 prompt.js 的说明。
      for await (const ev of chatStream(config, messages, { model, schema: schemaFor(context), signal: abort.signal })) {
        if (ev.type === 'delta') {
          rawText += ev.text
          sse.send('delta', { text: ev.text })
        } else if (ev.type === 'done') {
          rawText = ev.text || rawText
          stats = ev.stats
        }
      }
      explanation = normalizeExplanation(rawText, term)
    }

    // 3. 联网降级
    //
    // ⚠️ 这里最重要的一条规则：**联网没拿到材料必须让用户看见**。
    // 原来的实现是「materials 为空就静默跳过」—— 用户点「联网重查」，白等 8 秒
    // （搜索超时），然后看到和刚才一模一样的解释，界面上一个字都没变。
    // 现在失败会发 web-error 事件，浮卡直接把原因写在卡片上。
    const autoWeb =
      config.web.enabled &&
      config.web.mode === 'auto' &&
      !viaWeb &&
      !cached &&
      explanation.confidence === config.web.autoBelowConfidence

    if (forceWeb || autoWeb) {
      if (!config.web.enabled) {
        sse.send('web-error', {
          message: '联网搜索在设置里被关掉了（web.enabled = false），这次只用了本地模型。',
          attempts: [],
        })
      } else {
        viaWeb = true
        sse.send('web-start', { reason: forceWeb ? 'manual' : 'low-confidence', engine: config.web.engine ?? 'auto' })
        const gathered = await gatherMaterials(`${term} 含义 原理`, config, { signal: abort.signal })
        const materials = gathered.materials ?? []
        if (materials.length === 0) {
          // 没有材料 = 这次没真的联上网，别在卡片上打「联网」标记
          viaWeb = false
          sse.send('web-error', {
            message: gathered.reason ?? '联网搜索没有拿到可用资料。',
            attempts: gathered.attempts ?? [],
          })
        } else {
          sse.send('web-done', { count: materials.length, provider: gathered.provider, attempts: gathered.attempts ?? [] })
          const messages = buildWebMessages({ term, context, prompt: config.prompt, results: materials })
          let webRaw = ''
          let webStats = null
          for await (const ev of chatStream(config, messages, { model, schema: schemaFor(context), signal: abort.signal })) {
            if (ev.type === 'delta') {
              webRaw += ev.text
              sse.send('delta', { text: ev.text })
            } else if (ev.type === 'done') {
              webRaw = ev.text || webRaw
              webStats = ev.stats
            }
          }
          const webExplanation = normalizeExplanation(webRaw, term)
          // 联网结果只在它确实产出内容时替换本地解释
          if (webExplanation.oneLine && webExplanation.oneLine !== '模型没有返回可解析的结果。') {
            explanation = webExplanation
            stats = webStats
          } else {
            viaWeb = false
            sse.send('web-error', { message: '联网综述没有产出可用内容，保留本地模型的解释。', attempts: gathered.attempts ?? [] })
          }
        }
      }
    }

    // 4. 落缓存 + 历史
    if (config.cache.enabled && explanation) {
      try {
        cache.store({ ...keyInfo, explanation, meta: { stats, viaWeb }, found: !explanation.unparsed })
        if (config.cache.maxEntries) cache.prune(config.cache.maxEntries)
      } catch (err) {
        logger.warn('[term-lens] 写缓存失败: %s', err.message)
      }
    }
    try {
      appendHistory(sessionId, [
        {
          term: explanation.term || term,
          at: new Date().toISOString(),
          oneLine: explanation.oneLine,
          confidence: explanation.confidence,
          model,
          viaWeb,
          contextSnippet: context.slice(0, 200),
        },
      ])
    } catch (err) {
      logger.warn('[term-lens] 写历史失败: %s', err.message)
    }

    sse.send('done', { explanation, stats, cached, viaWeb })
  } catch (err) {
    if (!abort.signal.aborted) {
      logger.warn('[term-lens] 解释失败: %s', err?.stack ?? err)
      // 翻译成用户能照做的提示 —— 见 explainOllamaFailure 的说明
      const f = explainOllamaFailure(err, config)
      sse.send('error', { message: f.message, hint: f.hint, kind: f.kind })
    }
  } finally {
    sse.close()
  }
}

/**
 * 追问：围绕同一个术语继续对话（SSE 流式，纯文本）。
 *
 * 与 /explain 的三点不同：
 *   1. **不用 JSON schema**。追问的答案是自由文本，套结构化字段只会把答案挤碎。
 *   2. **不落缓存**。问题千变万化，缓存命中率极低，还会把缓存撑爆。
 *   3. **带多轮上下文**。前面的问答要一起送回去，否则「那它呢」这种追问无法理解。
 */
async function handleChat(req, res, config, logger) {
  const body = await readJsonBody(req)
  const term = String(body.term ?? '').trim()
  const question = String(body.question ?? '').trim()
  if (!term) {
    sendJson(res, 400, { error: '缺少 term' })
    return
  }
  if (!question) {
    sendJson(res, 400, { error: '缺少 question' })
    return
  }
  if (question.length > 2000) {
    sendJson(res, 400, { error: '问题过长（上限 2000 字）' })
    return
  }

  const context = typeof body.context === 'string' ? body.context : ''
  const explanation = body.explanation && typeof body.explanation === 'object' ? body.explanation : null
  const history = Array.isArray(body.history) ? body.history : []
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.ollama.model

  const sse = openSse(res)
  const abort = new AbortController()
  req.on('close', () => {
    abort.abort(new Error('client closed'))
    sse.close()
  })

  const started = Date.now()
  try {
    const { system, turns } = buildFollowUpMessages({ term, context, explanation, history, prompt: config.prompt })
    sse.send('meta', { term, model, turns: turns.length })

    let raw = ''
    let stats = null
    // 本轮提问作为最后一个 user turn
    for await (const ev of chatStream(
      config,
      { system, turns: [...turns, { role: 'user', content: question }] },
      {
        model,
        signal: abort.signal,
        // ⚠️ 追问必须**打开**思考链，这一点与首轮解释相反。
        //
        // 实测（test/experiment-followup.mjs，qwen3:4b）：
        //
        //   think:false + 宽松提示词 → 正文里 4 个推理标记，900/900 tokens 被截断
        //   think:false + 严格禁元话语 → 正文里 **5** 个标记（更糟！提示词里描述
        //        "不要做什么"，模型反而把它当成待办清单来复述），同样被截断
        //   think:true                → 正文 1 个标记，且 done_reason=stop 正常收尾，
        //        推理过程完整地待在 message.thinking 里
        //
        // 首轮解释之所以能用 think:false，是因为它有 JSON schema 约束解码 ——
        // schema 本身就是最强的"作文约束"。追问是自由文本，没有这层保护，
        // 那就得让模型照它本来的方式思考，只是把思考和回答分开取。
        think: true,
        // 思考链也吃 token 预算，给宽一点，否则答案还没开始就被截断
        numPredict: Math.max(config.ollama.numPredict ?? 900, 2000),
      },
    )) {
      if (ev.type === 'delta') {
        raw += ev.text
        sse.send('delta', { text: ev.text })
      } else if (ev.type === 'done') {
        raw = ev.text || raw
        stats = ev.stats
      }
    }

    sse.send('done', {
      answer: raw.trim(),
      stats,
      elapsedMs: Date.now() - started,
    })
  } catch (err) {
    if (!abort.signal.aborted) {
      logger.warn('[term-lens] 追问失败: %s', err?.stack ?? err)
      // 追问出错的原因和首轮一样（多半是 Ollama 没跑），同样给可照做的提示
      const f = explainOllamaFailure(err, config)
      sse.send('error', { message: f.message, hint: f.hint, kind: f.kind })
    }
  } finally {
    sse.close()
  }
}

/* ── 路由注册 ───────────────────────────────────────────────────────── */

/**
 * @returns {Array<() => void>} disposers
 */
export function registerRoutes(ctx, config, logger, options = {}) {
  const disposers = []
  const storage = options.storage ?? { ok: true, root: ROOT, error: null }

  const dispatch = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    try {
      // —— 状态 ——
      if (path === '/status' && method === 'GET') {
        const health = await probe(config)
        // 装了 Ollama 但没 pull 默认模型 —— 这是「解释永远失败」的第二大原因，
        // 而且报错（model not found）比连不上更难懂。所以主动查一次，
        // 让设置页能在用户第一次选词之前就说清楚。
        let modelReady = null
        let installedModels = []
        if (health.ok) {
          try {
            const ms = await listModels(config)
            installedModels = ms.map((m) => m.name)
            modelReady = installedModels.includes(config.ollama.model)
          } catch {
            modelReady = null // 查不到就不下结论，别误报
          }
        }
        sendJson(res, 200, {
          plugin: { name: 'dsh-term-lens', version: '0.1.0' },
          ollama: health,
          // 前端据此显示可照做的提示
          readiness: {
            modelReady,
            wantedModel: config.ollama.model,
            installedModels,
            pullCommand: modelReady === false ? `ollama pull ${config.ollama.model}` : null,
          },
          config: {
            model: config.ollama.model,
            baseURL: config.ollama.baseURL,
            webMode: config.web.enabled ? config.web.mode : 'off',
            webEngine: config.web.enabled ? (config.web.engine ?? 'auto') : 'off',
            style: config.prompt.style,
            language: config.prompt.language,
            // 客户端要用它决定放不放追问输入框。少了这一项的话，
            // 客户端读到 undefined 就会把追问当成「被关闭」—— 已经犯过一次。
            followUp: config.prompt.followUp !== false,
            cacheEnabled: config.cache.enabled,
            trigger: config.trigger,
          },
          cache: cache.stats(),
          // 数据目录是否可用。拿不到时插件仍然加载，但配置/缓存/历史都落不了盘 ——
          // 这件事必须让用户在设置页上看得见，而不是只躺在宿主日志里。
          storage,
          paths: { root: ROOT, config: CONFIG_PATH, cache: CACHE_DIR },
        })
        return
      }

      // —— 客户端诊断回传 ——
      if (path === '/diag') {
        if (method === 'POST') {
          const body = await readJsonBody(req)
          diagStats.posts++
          diagStats.lastPostAt = new Date().toISOString()
          lastDiag = { at: diagStats.lastPostAt, ...body }
          logger.info('[term-lens] 收到客户端诊断: %s', JSON.stringify(lastDiag).slice(0, 600))
          sendJson(res, 200, { ok: true })
          return
        }
        // GET 也要计入次数:「读了几次」和「写了几次」是两件事,
        // 只看内容分不清「客户端没发」和「发了但内容为空」。
        diagStats.gets++
        diagStats.lastGetAt = new Date().toISOString()
        sendJson(res, 200, { diag: lastDiag, env: lastEnv, envFetch: envFetchResults, clientPhases: clientPingPhases, stats: diagStats })
        return
      }

      // —— 自供客户端 bundle ——
      // 桌面版里 DSH 自己的 bundle 供给不走 HTTP：页面是 `dsh-app://app/`，
      // 传输靠 `__DSH_TRANSPORT__`（只有 ownsHost / streamBaseUrl），
      // 而 `/plugins/*` 一律 404。所以插件不能依赖那条链路 ——
      // 这里由宿主自己把 client.js 供出来，页面侧可取可注入。
      if (path === '/client-bundle.js' && method === 'GET') {
        const src = readClientBundle()
        if (src === null) {
          sendJson(res, 500, { error: '读不到 lib/client.js' })
          return
        }
        const buf = Buffer.from(src, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': String(buf.byteLength),
          'cache-control': 'no-store',
        })
        res.end(buf)
        return
      }

      // —— 页面环境探测回执 ——
      // 注入脚本把页面里真实存在的启动清单 / 传输通道 / 模块加载器形态送回。
      // 这是排查「客户端代码为什么到不了页面」的唯一可靠依据。
      if (path === '/env') {
        const u = new URL(req.url ?? '/', 'http://localhost')
        const params = Object.fromEntries(u.searchParams)
        diagStats.envProbes++
        diagStats.lastEnvProbeAt = new Date().toISOString()
        // 探测分多次回执:同步的一次给主报告,异步 fetch 各报一次。
        // 所以按名字累计,不互相覆盖。
        if (params.fetchName !== undefined) {
          envFetchResults[params.fetchName] = params.fetchResult ?? ''
        } else {
          lastEnv = { at: diagStats.lastEnvProbeAt, params }
        }
        logger.info('[term-lens] 页面环境回执: %s', JSON.stringify(params).slice(0, 400))
        sendJson(res, 200, { ok: true })
        return
      }

      // —— 注入脚本的落地回执 ——
      // 这是唯一能证明「宿主往页面里注入的脚本真的执行了」的通道。
      // 如果 /diag 是 null 而这里也没有记录,说明注入根本没到达渲染进程。
      if (path === '/client-ping') {
        const url2 = new URL(req.url ?? '/', 'http://localhost')
        const q = Object.fromEntries(url2.searchParams)
        diagStats.clientPings++
        diagStats.lastClientPingAt = new Date().toISOString()
        diagStats.lastClientPingQuery = q
        // 自愈流程分阶段回执（found-url / fetched / handed-to-loader / failed …）。
        // 按 phase 累计，这样「投递卡在哪一步」一眼可见 ——
        // 静默失败会让排查退回猜测，这个插件前面已经吃过好几次亏。
        if (q.phase) {
          clientPingPhases.push({ at: diagStats.lastClientPingAt, phase: q.phase, detail: q.detail ?? '' })
          if (clientPingPhases.length > 40) clientPingPhases.shift()
        }
        logger.info('[term-lens] 注入脚本回执: %s', JSON.stringify(q).slice(0, 300))
        // 1x1 透明 gif,方便用 <img> 打点;用 script 打点时这内容无所谓
        const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
        res.writeHead(200, { 'content-type': 'image/gif', 'content-length': String(gif.length), 'cache-control': 'no-store' })
        res.end(gif)
        return
      }

      // —— 模型列表 ——
      if (path === '/models' && method === 'GET') {
        try {
          const models = await listModels(config)
          sendJson(res, 200, { models, current: config.ollama.model })
        } catch (err) {
          sendJson(res, 502, { error: `读取模型列表失败: ${err.message}` })
        }
        return
      }

      // —— 解释（SSE）——
      if (path === '/explain' && method === 'POST') {
        await handleExplain(req, res, config, logger)
        return
      }

      // —— 追问 / 继续对话（SSE，纯文本，不落缓存）——
      if (path === '/chat' && method === 'POST') {
        await handleChat(req, res, config, logger)
        return
      }

      // —— 预热（切模型后调用，把加载耗时挪到用户还在读的时候）——
      if (path === '/warmup' && method === 'POST') {
        const body = await readJsonBody(req)
        try {
          await warmUp(config, body.model)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJson(res, 502, { ok: false, error: err.message })
        }
        return
      }

      // —— 历史 ——
      if (path === '/history') {
        const sessionId = url.searchParams.get('sessionId') ?? 'anonymous'
        if (method === 'GET') {
          sendJson(res, 200, { rows: readHistory(sessionId) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          const rows = appendHistory(sessionId, Array.isArray(body.rows) ? body.rows : [])
          sendJson(res, 200, { rows })
          return
        }
        // 删除：body 里给了 term 就删那一条（同名的全删），否则整份清空。
        // 用 DELETE + body 而不是 query 参数，因为术语本身可能很长或含特殊字符。
        if (method === 'DELETE') {
          const body = await readJsonBody(req).catch(() => ({}))
          const term = typeof body.term === 'string' ? body.term.trim() : ''
          const current = readHistory(sessionId)
          const next = term ? current.filter((r) => (r?.term ?? '') !== term) : []
          const removed = current.length - next.length
          writeHistory(sessionId, next)
          logger.info('[term-lens] 历史删除: %s (%d 条)', term || '全部', removed)
          sendJson(res, 200, { rows: next, removed })
          return
        }
      }

      // —— 缓存 ——
      if (path === '/cache' && method === 'GET') {
        sendJson(res, 200, { stats: cache.stats(), recent: cache.listRecent(120) })
        return
      }
      if (path === '/cache/clear' && method === 'POST') {
        let removed = 0
        for (const shard of existsSync(CACHE_DIR) ? readdirSync(CACHE_DIR) : []) {
          const dir = join(CACHE_DIR, shard)
          let files = []
          try {
            files = readdirSync(dir)
          } catch {
            continue
          }
          for (const f of files) {
            if (!f.endsWith('.json')) continue
            try {
              unlinkSync(join(dir, f))
              removed++
            } catch {
              /* ignore */
            }
          }
        }
        sendJson(res, 200, { ok: true, removed })
        return
      }

      // —— 配置 ——
      if (path === '/config') {
        if (method === 'GET') {
          sendJson(res, 200, { config, defaults: DEFAULT_CONFIG, path: CONFIG_PATH })
          return
        }
        if (method === 'POST') {
          const patch = await readJsonBody(req)
          const { next, ignored } = mergeConfig(config, patch)
          writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
          // 就地改 config 对象，让路由闭包立刻看到新值
          applyInPlace(config, next)
          // `ignored` 里是**被丢弃或被调整**的字段。没有它的话，用户填了一个非法值
          // （比如忘了写 http:// 的地址），接口照样回 200 {ok:true}，设置页显示
          // 「已保存」，而值其实没生效 —— 只能靠「改了没反应」去猜。见 D4。
          sendJson(res, 200, { ok: true, config, ignored })
          return
        }
      }

      sendJson(res, 404, { error: `未知端点: ${method} ${PREFIX}${path}` })
    } catch (err) {
      logger.warn('[term-lens] 路由错误 %s %s: %s', method, path, err?.stack ?? err)
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) })
      else
        try {
          res.end()
        } catch {
          /* ignore */
        }
    }
  }

  disposers.push(ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: dispatch }))
  return disposers
}

/* ── 配置合并 ───────────────────────────────────────────────────────── */

/**
 * 只允许改白名单字段，避免插件配置被写坏。
 *
 * 返回值：`{ next, ignored }`。`ignored` 是被**丢弃或被调整**的字段及原因。
 *
 * 为什么必须把它们带出去：原来非法值一律静默忽略，接口仍回 `200 {ok:true}`，
 * 设置页于是显示「已保存」，而用户填的值（比如忘了写 `http://` 的地址）其实
 * 一个字都没进配置 —— 用户看到的现象是「值自己跳回去了 / 改了没反应」，
 * 只能靠猜。现在每一处拒绝和钳制都留下一条原因，由设置页原样展示。
 */
function mergeConfig(current, patch) {
  const next = structuredClone(current)
  const ignored = []
  const reject = (path, reason) => ignored.push({ path, reason, kind: 'rejected' })
  const adjust = (path, reason) => ignored.push({ path, reason, kind: 'adjusted' })
  /** 带钳制的数值字段：越界要留痕，否则「我设了 99999 怎么没生效」无处可查。 */
  const setNum = (path, raw, lo, hi) => {
    if (raw === undefined) return
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      reject(path, `需要一个数字，收到的是 ${JSON.stringify(raw)}`)
      return
    }
    const clamped = Math.min(hi, Math.max(lo, raw))
    if (clamped !== raw) adjust(path, `${raw} 超出允许范围 ${lo}~${hi}，已按 ${clamped} 保存`)
    return clamped
  }

  // 结构版本必须原样保留：丢了的话下次加载会被当成旧配置而触发迁移，
  // 用户的设置就会被无声重置。
  if (typeof patch.configVersion === 'number') next.configVersion = patch.configVersion

  if (patch.ollama?.baseURL !== undefined) {
    const v = patch.ollama.baseURL
    if (typeof v === 'string' && /^https?:\/\//.test(v.trim())) next.ollama.baseURL = v.trim().replace(/\/+$/, '')
    else reject('ollama.baseURL', '必须以 http:// 或 https:// 开头，例如 http://127.0.0.1:11434')
  }
  if (patch.ollama?.model !== undefined) {
    const v = patch.ollama.model
    if (typeof v === 'string' && v.trim()) next.ollama.model = v.trim()
    else reject('ollama.model', '模型名不能为空')
  }
  if (patch.ollama?.think !== undefined) {
    if (typeof patch.ollama.think === 'boolean') next.ollama.think = patch.ollama.think
    else reject('ollama.think', '需要 true / false')
  }
  if (patch.ollama?.keepAlive !== undefined) {
    if (typeof patch.ollama.keepAlive === 'string') next.ollama.keepAlive = patch.ollama.keepAlive
    else reject('ollama.keepAlive', '需要形如 30m 的字符串')
  }
  {
    const t = setNum('ollama.temperature', patch.ollama?.temperature, 0, 2)
    if (t !== undefined) next.ollama.temperature = t
  }

  if (patch.web?.enabled !== undefined) {
    if (typeof patch.web.enabled === 'boolean') next.web.enabled = patch.web.enabled
    else reject('web.enabled', '需要 true / false')
  }
  if (patch.web?.mode !== undefined) {
    if (['auto', 'manual', 'off'].includes(patch.web.mode)) next.web.mode = patch.web.mode
    else reject('web.mode', `只能是 auto / manual / off，收到 ${JSON.stringify(patch.web.mode)}`)
  }
  if (patch.web?.engine !== undefined) {
    if (ENGINE_CHOICES.includes(patch.web.engine)) next.web.engine = patch.web.engine
    else reject('web.engine', `只能是 ${ENGINE_CHOICES.join(' / ')}，收到 ${JSON.stringify(patch.web.engine)}`)
  }
  if (patch.web?.autoBelowConfidence !== undefined) {
    if (['low', 'medium', 'high'].includes(patch.web.autoBelowConfidence)) next.web.autoBelowConfidence = patch.web.autoBelowConfidence
    else reject('web.autoBelowConfidence', '只能是 low / medium / high')
  }
  {
    const v = setNum('web.maxResults', patch.web?.maxResults, 1, 10)
    if (v !== undefined) next.web.maxResults = v
  }
  {
    const v = setNum('web.timeoutMs', patch.web?.timeoutMs, 1000, 60000)
    if (v !== undefined) next.web.timeoutMs = v
  }

  {
    const v = setNum('trigger.minLength', patch.trigger?.minLength, 1, 20)
    if (v !== undefined) next.trigger.minLength = v
  }
  {
    const v = setNum('trigger.maxLength', patch.trigger?.maxLength, 10, 400)
    if (v !== undefined) next.trigger.maxLength = v
  }
  if (patch.trigger?.showFloatingChip !== undefined) {
    if (typeof patch.trigger.showFloatingChip === 'boolean') next.trigger.showFloatingChip = patch.trigger.showFloatingChip
    else reject('trigger.showFloatingChip', '需要 true / false')
  }
  if (patch.trigger?.autoOpenCard !== undefined) {
    if (typeof patch.trigger.autoOpenCard === 'boolean') next.trigger.autoOpenCard = patch.trigger.autoOpenCard
    else reject('trigger.autoOpenCard', '需要 true / false')
  }
  if (patch.trigger?.chipPlacement !== undefined) {
    if (['above', 'below'].includes(patch.trigger.chipPlacement)) next.trigger.chipPlacement = patch.trigger.chipPlacement
    else reject('trigger.chipPlacement', '只能是 above / below')
  }
  if (patch.trigger?.shortcut !== undefined) {
    if (typeof patch.trigger.shortcut === 'string') next.trigger.shortcut = patch.trigger.shortcut
    else reject('trigger.shortcut', '需要字符串（留空表示只用浮出按钮）')
  }

  // style 可以是内置 id，也可以是用户自建风格的 name —— 所以不能再用固定枚举校验。
  // 校验挪到「必须是字符串且长度合理」，真正的有效性由 prompt.js 的
  // resolveStyleHint 兜底（找不到就回落 standard，不会让提示词缺一块）。
  if (patch.prompt?.style !== undefined) {
    const v = patch.prompt.style
    if (typeof v === 'string' && v.trim().length <= 40) next.prompt.style = v.trim()
    else if (typeof v !== 'string') reject('prompt.style', '需要字符串')
    else reject('prompt.style', '风格名最长 40 个字符')
  }
  if (patch.prompt?.language !== undefined) {
    if (typeof patch.prompt.language === 'string') next.prompt.language = patch.prompt.language
    else reject('prompt.language', '需要字符串')
  }
  if (patch.prompt?.customSystem !== undefined) {
    if (patch.prompt.customSystem === null || typeof patch.prompt.customSystem === 'string') {
      next.prompt.customSystem = patch.prompt.customSystem
    } else reject('prompt.customSystem', '需要字符串或 null')
  }
  if (patch.prompt?.followUp !== undefined) {
    if (typeof patch.prompt.followUp === 'boolean') next.prompt.followUp = patch.prompt.followUp
    else reject('prompt.followUp', '需要 true / false')
  }
  // 自建风格：逐项校验，坏数据直接丢掉而不是写进配置
  if (Array.isArray(patch.prompt?.styles)) {
    const raw = patch.prompt.styles
    const clean = raw
      .filter((s) => s && typeof s.name === 'string' && typeof s.hint === 'string')
      .map((s) => ({ name: s.name.trim().slice(0, 40), hint: s.hint.trim().slice(0, 2000) }))
      .filter((s) => s.name && s.hint && !['concise', 'standard', 'deep'].includes(s.name))
      .slice(0, 30)
    next.prompt.styles = clean
    if (clean.length !== raw.length) {
      reject('prompt.styles', `${raw.length} 项里有 ${raw.length - clean.length} 项不合法被丢弃（名字和提示都要填，且不能叫 concise/standard/deep）`)
    }
  } else if (patch.prompt?.styles !== undefined) {
    reject('prompt.styles', '需要数组')
  }

  if (patch.cache?.enabled !== undefined) {
    if (typeof patch.cache.enabled === 'boolean') next.cache.enabled = patch.cache.enabled
    else reject('cache.enabled', '需要 true / false')
  }
  {
    const v = setNum('cache.maxEntries', patch.cache?.maxEntries, 10, 100000)
    if (v !== undefined) next.cache.maxEntries = v
  }

  return { next, ignored }
}

function applyInPlace(target, source) {
  for (const k of Object.keys(target)) delete target[k]
  Object.assign(target, source)
}
