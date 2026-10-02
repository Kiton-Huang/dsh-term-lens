/**
 * 路由集成测试：用假的 cordis ctx 起真正的 http 服务，跑完整请求链路。
 *   node test/routes-smoke.mjs
 *   SMOKE_LLM=1 node test/routes-smoke.mjs   # 额外验证 SSE 真实流式
 *
 * 假的 ctx 只实现插件真正用到的东西：webServer.register / logger。
 * 这样能在不启动 DSH 的前提下验证路由、SSE 帧格式、错误处理与缓存。
 */
import { createServer } from 'node:http'
import { strict as assert } from 'node:assert'
import { registerRoutes } from '../lib/routes.js'
import { loadConfig, ensureDirs } from '../lib/config.js'
import * as cache from '../lib/cache.js'

const log = (...a) => console.log(...a)
let failures = 0
async function check(name, fn) {
  try {
    await fn()
    log(`  ok   ${name}`)
  } catch (err) {
    failures++
    log(`  FAIL ${name}: ${err?.message ?? err}`)
  }
}

ensureDirs()
const config = loadConfig()
config.cache.enabled = true

/* ── 最小 cordis ctx 替身 ─────────────────────────────────────────── */

function makeCtx() {
  const routes = new Map()
  return {
    logger: {
      info: () => {},
      warn: (...a) => log('    [warn]', ...a),
      error: (...a) => log('    [error]', ...a),
      debug: () => {},
    },
    webServer: {
      register(route) {
        const key = `${route.kind}:${route.path}`
        if (routes.has(key)) throw new Error(`duplicate route ${key}`)
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
    _routes: routes,
  }
}

const ctx = makeCtx()
const disposers = registerRoutes(ctx, config, ctx.logger)
assert.equal(disposers.length, 1, '应当只注册一条 prefix 路由')
assert.ok(ctx._routes.has('prefix:/term-lens'), '路由路径应为 prefix:/term-lens')

const route = ctx._routes.get('prefix:/term-lens')

/* ── 起真服务器，把请求交给路由 handler ──────────────────────────── */

const server = createServer((req, res) => {
  // 复刻 DSH webserver 的 prefix 匹配语义
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (path === '/term-lens' || path.startsWith('/term-lens/')) {
    route.handler(req, res).catch((err) => {
      log('    [handler threw]', err)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end()
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
log(`测试服务器: ${base}`)

/* ── 测试 ─────────────────────────────────────────────────────────── */

log('\n== dsh-term-lens 路由集成测试 ==')
log(`base=${base}`)

log('\n-- 基础端点 --')
await check('GET /term-lens/status 返回状态与配置', async () => {
  const res = await fetch(`${base}/term-lens/status`)
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.plugin.name, 'dsh-term-lens')
  assert.ok(json.ollama, '应带 Ollama 健康信息')
  assert.ok(json.config.model, '应带当前模型')
  assert.ok(json.cache, '应带缓存统计')
})

await check('/status 带 readiness，供界面提示「缺什么、该怎么做」', async () => {
  const json = await (await fetch(`${base}/term-lens/status`)).json()
  const r = json.readiness
  assert.ok(r, '缺少 readiness —— 界面就没法提示没装模型 / 没装 Ollama')
  assert.equal(r.wantedModel, json.config.model, 'wantedModel 应当是当前配置的模型')
  // modelReady 三态：true / false / null（查不到就不下结论）
  assert.ok([true, false, null].includes(r.modelReady), `modelReady 取值异常: ${r.modelReady}`)
  assert.ok(Array.isArray(r.installedModels), 'installedModels 应当是数组')
  if (r.modelReady === false) {
    assert.ok(/^ollama pull /.test(r.pullCommand ?? ''), '缺模型时必须给出可直接执行的 pull 命令')
  }
})

await check('错误信息翻译成可照做的提示（不是裸的网络错误）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  assert.ok(/function explainOllamaFailure/.test(src), '缺少 explainOllamaFailure')

  // 直接测那个函数：把源码抠出来执行，避免为了造错误去改配置
  const i = src.indexOf('function explainOllamaFailure')
  const j = src.indexOf('\n/**', i)
  const fn = new Function(`${src.slice(i, j).replace('function explainOllamaFailure', 'function f')}; return f`)()
  const cfg = { ollama: { baseURL: 'http://127.0.0.1:11434', model: 'qwen3:4b' } }

  // ① 没装 Ollama —— 最容易发生，必须给出安装与启动两条路
  const a = fn(new Error('connect ECONNREFUSED 127.0.0.1:11434'), cfg)
  assert.ok(!a.message.includes('ECONNREFUSED'), '不该把裸的 ECONNREFUSED 直接给用户')
  assert.ok(/ollama\.com/.test(a.hint), '没装 Ollama 时应当给出下载地址')
  assert.ok(/ollama serve/.test(a.hint), '没启动时应当给出启动命令')

  // ② 没 pull 模型 —— 原先完全没有提示
  const b = fn(new Error('Ollama 404: model "qwen3:4b" not found, try pulling it first'), cfg)
  assert.ok(/ollama pull qwen3:4b/.test(b.hint), `缺模型时应当给出 pull 命令，实际: ${b.hint}`)

  // ③ 超时 —— 首次加载大模型很常见
  const c = fn(new Error('Ollama 请求超时（180000ms）'), cfg)
  assert.ok(/首次加载/.test(c.hint), '超时应当提示可能是首次加载')

  // ④ 兜底：不认识也要给原始信息，不能给一句没信息量的「出错了」
  const d = fn(new Error('something unexpected'), cfg)
  assert.ok(d.message.includes('something unexpected'), '兜底应当保留原始信息')
})

await check('两个 SSE 端点都发送翻译后的错误', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  const hits = [...src.matchAll(/explainOllamaFailure\(err, config\)/g)].length
  assert.ok(hits >= 2, `/explain 与 /chat 都应当翻译错误，实际用了 ${hits} 处`)
})

await check('GET /term-lens/models 返回模型列表', async () => {
  const res = await fetch(`${base}/term-lens/models`)
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.ok(Array.isArray(json.models))
})

await check('未知端点返回 404 且是合法 JSON', async () => {
  const res = await fetch(`${base}/term-lens/nope`)
  assert.equal(res.status, 404)
  const json = await res.json()
  assert.match(json.error, /未知端点/)
})

await check('解释缺 term 时返回 400', async () => {
  const res = await fetch(`${base}/term-lens/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})

await check('GET /term-lens/history 空会话返回空数组', async () => {
  const res = await fetch(`${base}/term-lens/history?sessionId=__smoke__`)
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.ok(Array.isArray(json.rows))
})

await check('GET/POST /term-lens/config 往返一致', async () => {
  const before = await (await fetch(`${base}/term-lens/config`)).json()
  assert.ok(before.config?.ollama?.model)
  const res = await fetch(`${base}/term-lens/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: { style: 'deep' } }),
  })
  assert.equal(res.status, 200)
  const after = await res.json()
  assert.equal(after.config.prompt.style, 'deep', '配置应被写入并回读')
  // 还原
  await fetch(`${base}/term-lens/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: { style: before.config.prompt.style } }),
  })
})

await check('配置白名单：非法值被忽略而不是写坏', async () => {
  const before = await (await fetch(`${base}/term-lens/config`)).json()
  const res = await fetch(`${base}/term-lens/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ollama: { baseURL: 'not-a-url', temperature: 999 },
      web: { mode: 'nonsense' },
      // style 不再用固定枚举校验（它可以指向用户自建风格的**名字**），
      // 所以这里改用「超长」这种必然非法的输入来验证仍然会被挡住。
      prompt: { style: 'x'.repeat(200) },
    }),
  })
  const after = await res.json()
  assert.equal(after.config.ollama.baseURL, before.config.ollama.baseURL, '非法 baseURL 不该写入')
  assert.equal(after.config.prompt.style, before.config.prompt.style, '超长 style 不该写入')
  assert.equal(after.config.web.mode, before.config.web.mode, '非法 mode 不该写入')
})

await check('自建风格：任意名字可写入并被样式过滤保护', async () => {
  const before = await (await fetch(`${base}/term-lens/config`)).json()
  const res = await fetch(`${base}/term-lens/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: {
        style: '精简回答',
        styles: [
          { name: '精简回答', hint: '一两句话说清，不要要点列表' },
          { name: 'concise', hint: '与内置重名，应被丢弃' },
          { name: '缺 hint' },
          { name: 123, hint: '名字不是字符串' },
        ],
      },
    }),
  })
  const after = await res.json()
  assert.equal(after.config.prompt.style, '精简回答', '自建风格名字应当可以启用')
  const names = (after.config.prompt.styles ?? []).map((s) => s.name)
  assert.deepEqual(names, ['精简回答'], `坏数据与重名应当被过滤, 实际: ${JSON.stringify(names)}`)
  // 还原
  await fetch(`${base}/term-lens/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: { style: before.config.prompt.style, styles: before.config.prompt.styles ?? [] } }),
  })
})

log('\n-- 缓存短路 --')
await check('预置缓存 → /explain 直接返回 cached 且不起模型', async () => {
  const term = '__routes_smoke__'
  const model = config.ollama.model
  const context = 'smoke context'
  const { PROMPT_VERSION } = await import('../lib/prompt.js')
  cache.store({
    term,
    model,
    promptVersion: PROMPT_VERSION,
    context,
    // 指纹里必须带上风格与自定义要求 —— 与 /explain 实际查询时用的 keyInfo 一致，
    // 否则预置的这条缓存根本命中不了（缓存指纹改了就会这样）
    style: config.prompt.style,
    customSystem: config.prompt.customSystem,
    explanation: {
      term,
      reading: '',
      oneLine: '这是预置的缓存结果',
      inContext: '',
      bullets: ['a', 'b'],
      pitfalls: [],
      related: [],
      example: '',
      confidence: 'high',
    },
    meta: {},
  })

  const res = await fetch(`${base}/term-lens/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ term, context, model, sessionId: '__smoke__' }),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const text = await res.text()
  assert.match(text, /"cached":true/, 'meta 事件应标记 cached')
  assert.match(text, /这是预置的缓存结果/, 'done 事件应带缓存内容')

  // 校验 SSE 帧格式
  const frames = text.split('\n\n').filter((f) => f.trim() && !f.startsWith(':'))
  for (const f of frames) {
    assert.match(f, /^event: \w+\ndata: \{/, `SSE 帧格式不对: ${JSON.stringify(f.slice(0, 80))}`)
  }
  const events = frames.map((f) => f.match(/^event: (\w+)/)[1])
  assert.deepEqual(events, ['meta', 'done'], `缓存路径应只有 meta+done,实际: ${events.join(',')}`)
})

await check('缓存命中后历史被追加', async () => {
  const res = await fetch(`${base}/term-lens/history?sessionId=__smoke__`)
  const json = await res.json()
  assert.ok(json.rows.some((r) => r.term === '__routes_smoke__'), '历史里应有这次查询')
})

await check('listRecent 能看到刚写的条目', () => {
  const recent = cache.listRecent(50)
  assert.ok(recent.some((r) => r.term === '__routes_smoke__'))
})

log('\n-- 真实 SSE 流式 --')
if (process.env.SMOKE_LLM === '1') {
  await check('POST /explain 真实流式：有 delta 帧、有 done、结果可解析', async () => {
    const res = await fetch(`${base}/term-lens/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        term: 'backpressure',
        context: 'The stream applies backpressure when the consumer is slow.',
        scene: 'code',
        sessionId: '__smoke__',
        refresh: true, // 绕过缓存，强制真跑
      }),
    })
    assert.equal(res.status, 200)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const events = []
    let deltas = 0
    let sawDone = false
    let firstDeltaAt = null
    const started = Date.now()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstDeltaAt === null) firstDeltaAt = Date.now()
      buffer += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        if (frame.startsWith(':')) continue
        const ev = frame.match(/^event: (\w+)/)?.[1]
        const data = JSON.parse(frame.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? '{}')
        events.push(ev)
        if (ev === 'delta') deltas++
        if (ev === 'done') {
          sawDone = true
          assert.ok(data.explanation?.oneLine, 'done 事件必须带可用的 oneLine')
          assert.ok(['high', 'medium', 'low'].includes(data.explanation.confidence))
          log(`    事件序列: ${events.join(' → ')}  (delta × ${deltas})`)
          log(`    首帧延迟 ${firstDeltaAt - started}ms, 总耗时 ${Date.now() - started}ms`)
          log(`    oneLine: ${data.explanation.oneLine}`)
          log(`    在本语境里: ${data.explanation.inContext || '(空)'}`)
        }
      }
    }
    assert.ok(deltas > 3, `应当收到多个 delta 增量,实际 ${deltas}`)
    assert.ok(sawDone, '应当收到 done 事件')
  })
} else {
  log('  (跳过;加 SMOKE_LLM=1 开启)')
}

/* ── 收尾 ─────────────────────────────────────────────────────────── */

log('\n-- 卸载 --')
await check('disposer 能注销路由', () => {
  for (const d of disposers) d()
  assert.equal(ctx._routes.size, 0, '卸载后路由表应为空')
})

server.close()
log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
process.exit(failures === 0 ? 0 : 1)
