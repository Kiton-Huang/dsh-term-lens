/**
 * dsh-term-lens —— 联网搜索降级
 *
 * 只在两种情形触发：
 *   1. 本地模型的 confidence 是 low（config.web.mode === 'auto'）
 *   2. 用户在浮卡上手动点了「联网」
 *
 * 故意不引第三方依赖：直接抓搜索引擎的 HTML 结果页，不需要 key。
 * 抓到片段后交给同一个本地模型做「只依据材料」的综述，不额外调任何云模型。
 *
 * ══ 为什么是「多后端 + 竞速」而不是单后端 ══════════════════════════════
 *
 * 原来只接 DuckDuckGo（html.duckduckgo.com）。实测在国内网络下它**必然超时**
 * （见 README 的工程笔记）：searchWeb 把异常 catch 成空数组，于是整条降级链路
 * 一声不响地跳过 —— 用户点「联网重查」白等 8 秒，看到的解释和刚才一模一样，
 * 界面上没有任何一句「联网失败了」。
 *
 * 现在改成：
 *   - 多个后端**并发**发起，谁先给出可用结果就用谁，其余立刻 abort
 *     （原来是串行等满超时，最坏 8s 起步）
 *   - 每个后端的结果先过一道**相关性自检**：结果标题/摘要里必须出现查询词里的
 *     某个词，否则视为不可用。这一条是给「搜索引擎把无关内容当结果返回」兜底的
 *     —— 实测 Bing 在部分网络下会对任何查询都返回一堆无关页面（10 条里 0 条相关），
 *     不做自检就会把垃圾喂给模型
 *   - 全军覆没时**把原因带回去**（哪个后端、什么错、耗时），由宿主发 web-error
 *     事件，浮卡上直接显示，不再静默
 *
 * 后端的取舍（实测，2026-10）：
 *   - duckduckgo  国际网络下最好：有链接、有摘要，能抓正文
 *   - bing        国际网络下可用；但存在「返回无关结果」的形态，靠自检挡住
 *   - baidu       国内可达、标题相关性最好；但结果链接是 JS 跳转，拿不到正文，
 *                 所以只贡献「标题 + 来源站点」（这仍然足以让模型判断术语的领域）
 *   - so360       国内可达；部分结果是直链（能抓正文），部分是 JS 跳转
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把相对链接补成绝对链接；补不出来返回空串。 */
function absolute(href, base) {
  try {
    const u = new URL(decodeEntities(href), base)
    return /^https?:$/.test(u.protocol) ? u.toString() : ''
  } catch {
    return ''
  }
}

/**
 * 这一页是「安全验证 / 人机校验」而不是搜索结果吗？
 *
 * 实测：百度的自动化请求几次之后就会开始返回 1438 字节的「百度安全验证」页
 * （HTTP 仍然是 200），搜狗在第 5-6 次请求时也会返回 5KB 的验证页。
 * 不识别出来的话，它们会被当成「没有结果」，用户看到的提示就变成了
 * 「百度 没有结果」—— 而真相是「被拦了，换个后端或等一会儿」。
 */
export function looksBlocked(html) {
  if (typeof html !== 'string') return false
  if (html.length > 60_000) return false
  return /(安全验证|人机验证|请输入验证码|验证码校验|异常流量|unusual traffic|are you a robot)/i.test(html)
}

async function fetchText(url, { timeoutMs, signal, init } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onOuterAbort = () => controller.abort(new Error('aborted'))
  if (signal) {
    if (signal.aborted) onOuterAbort()
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(init?.headers ?? {}),
      },
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
}

/* ══ 相关性自检 ══════════════════════════════════════════════════════ */

/**
 * 把查询切成「可以用来判断相关性」的词。
 * 英文按单词、中文切成 2-gram（「含义」这种词在结果标题里出现，就说明搜对了）。
 */
export function queryTokens(query) {
  const s = String(query ?? '')
  const out = new Set()
  for (const w of s.match(/[A-Za-z][A-Za-z0-9+#._-]{2,}/g) ?? []) out.add(w.toLowerCase())
  for (const seg of s.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    if (seg.length <= 4) out.add(seg)
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2))
  }
  return [...out]
}

/**
 * 结果是否「看起来和查询有关」。
 *
 * 存在的意义：有的搜索引擎在网络异常/反爬时会返回一个**与查询完全无关**的
 * 结果页（实测 Bing 干过：查 backpressure，返回的全是校园招聘、CCTV-5、
 * Steam 游戏页）。这些结果会原样进提示词，比「什么都搜不到」更糟 ——
 * 模型会拿它们编答案。所以宁可判为不可用，让链路带着原因去报告。
 */
export function looksRelevant(results, tokens) {
  if (!results?.length) return false
  if (!tokens?.length) return true
  const blob = results
    .map((r) => `${r.title ?? ''} ${r.snippet ?? ''}`)
    .join(' ')
    .toLowerCase()
  return tokens.some((t) => blob.includes(t.toLowerCase()))
}

/* ══ 各后端 ══════════════════════════════════════════════════════════ */

/** DuckDuckGo 无 JS 端点。有链接、有摘要，国际网络下最完整。 */
async function duckduckgoSearch(query, { timeoutMs, signal, max }) {
  const { ok, status, text } = await fetchText('https://html.duckduckgo.com/html/', {
    timeoutMs,
    signal,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
    },
  })
  if (!ok) throw new Error(`HTTP ${status}`)
  if (looksBlocked(text)) throw new Error('blocked')

  const results = []
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = linkRe.exec(text)) !== null && results.length < max) {
    results.push({ url: unwrapDdg(decodeEntities(m[1])), title: stripTags(m[2]), snippet: '' })
  }
  if (results.length === 0) return results

  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let s
  let i = 0
  while ((s = snippetRe.exec(text)) !== null && i < results.length) {
    results[i].snippet = stripTags(s[1])
    i++
  }
  return results
}

/** DuckDuckGo 把结果链接包成 //duckduckgo.com/l/?uddg=<encoded>，解出来。 */
function unwrapDdg(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const target = u.searchParams.get('uddg')
    if (target) return decodeURIComponent(target)
    if (u.hostname.endsWith('duckduckgo.com')) return href
    return u.toString()
  } catch {
    return href
  }
}

/** Bing HTML 结果页（li.b_algo）。 */
async function bingSearch(query, { timeoutMs, signal, max }) {
  const { ok, status, text } = await fetchText(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`,
    { timeoutMs, signal },
  )
  if (!ok) throw new Error(`HTTP ${status}`)
  if (looksBlocked(text)) throw new Error('blocked')

  const results = []
  const blocks = text.match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|$)/gi) ?? []
  for (const b of blocks) {
    if (results.length >= max) break
    const a = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const url = absolute(a[1], 'https://www.bing.com')
    const title = stripTags(a[2])
    if (!url || !title) continue
    const snippet = b.match(/<p class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]
      ?? b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]
      ?? ''
    results.push({ url, title, snippet: stripTags(snippet) })
  }
  return results
}

/**
 * 百度移动版结果页。
 *
 * 只取「标题 + 来源站点」：百度把结果链接包成 JS 跳转（实测抓回来只有 1KB 的
 * 跳转脚本，拿不到正文），所以 url 留空，材料由标题和摘要承担。
 * 好处是标题相关性实测最好（查 backpressure，8 条里 8 条是背压相关）。
 */
async function baiduSearch(query, { timeoutMs, signal, max }) {
  const { ok, status, text } = await fetchText(`https://m.baidu.com/s?word=${encodeURIComponent(query)}`, {
    timeoutMs,
    signal,
    init: { headers: { 'user-agent': MOBILE_UA } },
  })
  if (!ok) throw new Error(`HTTP ${status}`)
  if (looksBlocked(text)) throw new Error('blocked')

  const results = []
  const seen = new Set()
  // 结果标题都在 <h3 class="...cosc-title..."> 里
  const titleRe = /<h3[^>]+class="[^"]*(?:cosc-title|cu-title|c-title)[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi
  let m
  while ((m = titleRe.exec(text)) !== null && results.length < max) {
    const title = cleanTitle(stripTags(m[1]))
    if (!title || title.length < 2 || seen.has(title)) continue
    seen.add(title)
    // 紧跟其后的摘要（有就带上，没有就算了）
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 2000)
    const snippet = stripTags(
      tail.match(/class="[^"]*(?:c-abstract|content-right|c-line-clamp|c-color-text)[^"]*"[^>]*>([\s\S]{0,600}?)<\/(?:div|span|p)>/i)?.[1]
        ?? '',
    ).slice(0, 300)
    results.push({ url: '', title, snippet })
  }
  return results
}

/** 搜狗。标题与摘要质量不错，但结果链接是 JS 跳转，拿不到正文；连续请求几次会被拦。 */
async function sogouSearch(query, { timeoutMs, signal, max }) {
  const { ok, status, text } = await fetchText(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, {
    timeoutMs,
    signal,
  })
  if (!ok) throw new Error(`HTTP ${status}`)
  if (looksBlocked(text)) throw new Error('blocked')

  const results = []
  const blocks = text.match(/<div[^>]+class="vrwrap"[\s\S]*?(?=<div[^>]+class="vrwrap"|$)/gi) ?? []
  for (const b of blocks) {
    if (results.length >= max) break
    const a = b.match(/<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const title = cleanTitle(stripTags(a[2]))
    if (!title) continue
    const snippet = stripTags(
      b.match(/class="[^"]*(?:str_info|space-txt|fz-mid|text-limit)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '',
    )
    results.push({ url: '', title, snippet })
  }
  return results
}

/** 标题里常混进图标占位（"..."、"###"、"|"），清掉两端的噪声字符。 */
function cleanTitle(t) {
  return String(t ?? '')
    .replace(/^[\s.·•|#\-–—]+/, '')
    .replace(/[\s.·•|#\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 360 搜索。部分结果是直链（能抓正文），部分是 JS 跳转。 */
async function so360Search(query, { timeoutMs, signal, max }) {
  const { ok, status, text } = await fetchText(`https://www.so.com/s?q=${encodeURIComponent(query)}`, {
    timeoutMs,
    signal,
  })
  if (!ok) throw new Error(`HTTP ${status}`)
  if (looksBlocked(text)) throw new Error('blocked')

  const results = []
  const blocks = text.match(/<li[^>]+class="res-list[^"]*"[\s\S]*?(?=<li[^>]+class="res-list|<\/ol>|$)/gi) ?? []
  for (const b of blocks) {
    if (results.length >= max) break
    const a = b.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const raw = absolute(a[1], 'https://www.so.com')
    const title = cleanTitle(stripTags(a[2]))
    if (!title) continue
    // 站内相关搜索（/s?q=…）不是结果，跳过
    if (/\/s\?q=/.test(raw)) continue
    const snippet = stripTags(
      b.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]
        ?? b.match(/<div[^>]*class="[^"]*res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]
        ?? '',
    )
    // /link?m=… 是 JS 跳转，抓不到正文；只在有直链时才把 url 带出去
    const fetchable = !!raw && !/\/link\?/.test(raw)
    results.push({ url: fetchable ? raw : '', title, snippet })
  }
  return results
}

/** 后端注册表。`label` 会出现在给用户看的失败原因里。 */
export const ENGINES = {
  duckduckgo: { label: 'DuckDuckGo', search: duckduckgoSearch },
  bing: { label: 'Bing', search: bingSearch },
  so360: { label: '360搜索', search: so360Search },
  baidu: { label: '百度', search: baiduSearch },
  sogou: { label: '搜狗', search: sogouSearch },
}

/**
 * 可选的 web.engine 取值。
 *
 * auto 只放两个：一个国际（国际网络下结果最完整）、一个国内。
 * 之所以不是「全都上」—— 每加一个后端就多一次对外请求，也就多一分把用户选中的
 * 术语发给第三方的隐私成本。而国内这一票给的是 **360 而不是百度**，依据是实测：
 * 连续 6 次查询，360 全部正常（615-916ms，无验证页），百度在第 5 次左右就开始
 * 返回 1438 字节的「百度安全验证」页，搜狗也在第 5 次被拦。
 * 百度/搜狗/Bing 仍然可以单独选用（`web.engine`）。
 */
export const ENGINE_CHOICES = ['auto', 'duckduckgo', 'bing', 'so360', 'baidu', 'sogou', 'off']
const AUTO_ENGINES = ['duckduckgo', 'so360']

/** 把 config.web.engine 解析成实际要用的后端列表。 */
export function resolveEngines(config) {
  const raw = config?.web?.engine ?? 'auto'
  if (raw === 'off') return []
  if (raw === 'auto') return [...AUTO_ENGINES]
  return ENGINES[raw] ? [raw] : [...AUTO_ENGINES]
}

/** 把一串后端错误翻译成一句用户看得懂的话。 */
function describeFailure(attempts) {
  const failed = attempts.filter((a) => !a.ok)
  if (failed.length === 0) return '没有搜到相关结果。'
  const parts = failed.map((a) => {
    const label = ENGINES[a.engine]?.label ?? a.engine
    if (a.reason === 'blocked') return `${label} 被反爬拦下（要求人机验证）`
    if (a.reason === 'unreachable') return `${label} 连不上`
    if (a.reason === 'timeout') return `${label} 超时`
    if (a.reason === 'irrelevant') return `${label} 返回的结果与术语无关`
    if (a.reason === 'empty') return `${label} 没有结果`
    if (a.reason === 'cancelled') return `${label} 已取消`
    return `${label} 失败（${a.detail ?? a.reason}）`
  })
  return `联网搜索没有拿到可用资料：${parts.join('；')}。`
}

/* ══ 对外的搜索入口 ══════════════════════════════════════════════════ */

/**
 * 并发问所有后端，谁先给出「可用」结果就用谁。
 *
 * @returns {Promise<{results: Array, provider: string|null, attempts: Array, reason: string|null}>}
 */
export async function searchWeb(query, config, { signal } = {}) {
  const engines = resolveEngines(config)
  const timeoutMs = config.web.timeoutMs
  const max = config.web.maxResults
  const tokens = queryTokens(query)
  if (engines.length === 0) {
    return { results: [], provider: null, attempts: [], reason: '联网搜索已关闭。' }
  }

  const inner = new AbortController()
  const onOuterAbort = () => inner.abort(new Error('aborted'))
  if (signal) {
    if (signal.aborted) onOuterAbort()
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }

  const tasks = engines.map((id) => {
    const started = Date.now()
    const task = { engine: id, ok: false, reason: 'pending', ms: 0, count: 0, result: null }
    const promise = (async () => {
      try {
        const results = await ENGINES[id].search(query, { timeoutMs, signal: inner.signal, max })
        task.ms = Date.now() - started
        task.count = results.length
        if (results.length === 0) {
          task.reason = 'empty'
          return task
        }
        if (!looksRelevant(results, tokens)) {
          task.reason = 'irrelevant'
          return task
        }
        task.ok = true
        task.reason = 'ok'
        task.result = results
        return task
      } catch (err) {
        task.ms = Date.now() - started
        const msg = String(err?.message ?? err)
        if (/^blocked$/.test(msg)) task.reason = 'blocked'
        else if (/timeout|超时/i.test(msg)) task.reason = 'timeout'
        else if (/aborted/i.test(msg)) task.reason = 'cancelled'
        else task.reason = 'unreachable'
        task.detail = msg.slice(0, 120)
        return task
      }
    })()
    return { id, task, promise }
  })

  // 竞速：第一个「可用」的结果胜出；全都不行就等全部结束再报告原因
  let winner = null
  await new Promise((resolve) => {
    let pending = tasks.length
    let done = false
    for (const t of tasks) {
      t.promise.then(() => {
        if (!done && t.task.ok) {
          done = true
          winner = t.task
          resolve()
          return
        }
        if (--pending === 0 && !done) {
          done = true
          resolve()
        }
      })
    }
  })

  if (winner) {
    // 胜出之后其余后端立刻取消，别让它们继续占着网络
    inner.abort(new Error('aborted'))
  }
  if (signal) signal.removeEventListener('abort', onOuterAbort)

  const attempts = tasks.map((t) => {
    const a = t.task
    if (!a.ok && a.reason === 'pending') a.reason = 'cancelled'
    return { engine: a.engine, ok: a.ok, reason: a.reason, ms: a.ms, count: a.count, detail: a.detail }
  })

  return {
    results: winner?.result ?? [],
    provider: winner?.engine ?? null,
    attempts,
    reason: winner ? null : describeFailure(attempts),
  }
}

/**
 * 取一个网页的可读正文片段。去掉导航/脚本噪声，够模型判断就够了。
 */
export async function fetchPageText(url, { timeoutMs, signal } = {}) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return ''
    const { ok, text } = await fetchText(url, { timeoutMs, signal })
    if (!ok) return ''
    return stripTags(text).slice(0, 4000)
  } catch {
    return ''
  }
}

/**
 * 完整降级：搜索 → 抓正文 → 返回给提示词用的材料。
 *
 * 注意「材料」不要求有正文：国内几个后端的结果链接是 JS 跳转，抓不到正文，
 * 但**标题本身就是有用的材料**（「背压(Backpressure)的核心原理与实现方式」
 * 这一条标题就足以让模型知道这个英文词在中文语境里对应的说法）。
 * 所以只要有标题就算一条材料，正文能抓就抓、抓不到用摘要、再没有就留空。
 *
 * @returns {Promise<{materials: Array<{title:string,url:string,text:string}>, provider:string|null, attempts:Array, reason:string|null}>}
 *   `reason` 非空表示「这次联网没有拿到任何可用材料」，调用方**必须**把它告诉用户，
 *   否则就回到了「点联网白等一场、界面毫无反应」的老问题。
 */
export async function gatherMaterials(query, config, { signal } = {}) {
  const { results, provider, attempts, reason } = await searchWeb(query, config, { signal })
  if (results.length === 0) return { materials: [], provider: null, attempts, reason }

  // 并行抓正文；只有拿到直链的才抓（百度/部分 360/搜狗的结果没有可抓的链接）
  const pages = await Promise.all(
    results.map(async (r) => {
      const text = await fetchPageText(r.url, { timeoutMs: config.web.timeoutMs, signal })
      return { title: r.title, url: r.url, text: text || r.snippet || '' }
    }),
  )
  const materials = pages.filter((p) => (p.title ?? '').trim().length > 0 || (p.text ?? '').trim().length > 0)
  return {
    materials,
    provider,
    attempts,
    reason: materials.length === 0 ? '搜到了结果，但没能取到任何正文或摘要。' : null,
  }
}
