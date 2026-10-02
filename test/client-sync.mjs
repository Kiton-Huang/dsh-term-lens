/**
 * 客户端投递（自愈）的测试。
 *
 * 这一层是「在没有 DevTools 的桌面版里把客户端代码送进页面」的关键路径，
 * 而且它跑在无法调试的浏览器里 —— 所以每一段生成的脚本都要在替身上真跑一遍。
 *
 * ⚠️ 这一层曾经把 DSH 启动搞崩过。所以除了功能正确，还必须守住三条铁律：
 *      1. 启动阶段什么都不做（一律推迟到 boot 之后）
 *      2. 绝不出现同步 XHR
 *      3. 绝不自动重载页面
 *
 *   node test/client-sync.mjs
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  readClientSource,
  clientBundleStamp,
  buildLoaderObservationScript,
  buildInjectRow,
  installClientSync,
} from '../lib/client-sync.js'

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

log('== dsh-term-lens 客户端投递（自愈）测试 ==')

const source = readClientSource()
const stamp = clientBundleStamp(source)
log(`  client.js ${source?.length} 字节, stamp = ${stamp}`)

/* ── 页面替身 ─────────────────────────────────────────────────────── */

const FAKE_BUNDLE =
  "window.__ModuleLoader__.load({ id: 'dsh-term-lens', factory: function(require){ return { apply: function(){}, inject: [] } } });"

/**
 * 造一个能精确控制「boot 是否已完成」的页面替身。
 *
 * 关键：rAF 与 setTimeout 分开排队，这样才能断言
 * 「解析期不动手」和「ready 之后还要再等一会儿」。
 */
function makePage({ readyState = 'loading', pendingQueue = [], boot = undefined, bundleText = FAKE_BUNDLE } = {}) {
  const state = { scripts: [], reloads: 0, rafs: [], timers: [], listeners: {}, xhrCalls: [] }

  function makeScriptEl() {
    const el = { _src: '', async: false, onload: null, onerror: null }
    Object.defineProperty(el, 'src', { get: () => el._src, set: (v) => (el._src = v) })
    return el
  }

  const head = {
    appendChild(el) {
      state.scripts.push(el)
      try {
        new Function('window', bundleText)(window)
        el.onload?.()
      } catch (e) {
        el.onerror?.(e)
      }
    },
  }

  const loaded = []
  const window = {
    __ModuleLoader__: { load: (spec) => loaded.push(spec), pendingQueue, mode: 'live' },
    __DSH_BOOT__: boot,
    __DSH_TRANSPORT__: { streamBaseUrl: 'http://127.0.0.1:19387' },
    addEventListener(type, fn) {
      ;(state.listeners[type] ??= []).push(fn)
    },
    location: { reload: () => state.reloads++ },
    requestAnimationFrame: (fn) => state.rafs.push(fn),
    setTimeout: (fn, ms) => state.timers.push({ fn, ms }),
  }

  const document = {
    readyState,
    baseURI: 'dsh-app://app/',
    head,
    documentElement: head,
    body: head,
    createElement: (tag) => (tag === 'script' ? makeScriptEl() : { appendChild() {}, style: {} }),
    getElementById: () => null,
    querySelector: () => null,
  }
  window.document = document

  function XHR() {
    this.open = (method, url, async) => state.xhrCalls.push({ method, url, async })
    this.send = () => {}
  }

  /** 跑掉所有排队的 rAF。 */
  function flushRaf() {
    const q = state.rafs.splice(0)
    for (const fn of q) fn(0)
  }
  /** 跑掉所有排队的 setTimeout（模拟 boot 完成后的空闲时刻）。 */
  function flushTimers() {
    let guard = 0
    while (state.timers.length && guard++ < 200) {
      const t = state.timers.shift()
      t.fn()
    }
  }
  function flushAll() {
    flushRaf()
    flushTimers()
    flushRaf()
  }
  /** 模拟浏览器派发 DOMContentLoaded 之后正常跑完。 */
  function fireDomReady() {
    for (const fn of state.listeners.DOMContentLoaded ?? []) fn()
  }

  return { window, document, state, loaded, XHR, flushRaf, flushTimers, flushAll, fireDomReady }
}

function run(script, page) {
  new Function('window', 'document', 'XMLHttpRequest', 'requestAnimationFrame', 'setTimeout', script)(
    page.window,
    page.window.document,
    page.XHR,
    page.window.requestAnimationFrame,
    page.window.setTimeout,
  )
}

/* ── stamp ────────────────────────────────────────────────────────── */

log('\n-- stamp --')
await check('能读到 client.js，stamp 是 12 位十六进制', () => {
  assert.ok(source, '没读到 client.js')
  assert.match(stamp, /^[0-9a-f]{12}$/)
})
await check('stamp 与文件内容对应', () => {
  const raw = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(stamp, createHash('sha1').update(raw).digest('hex').slice(0, 12))
})

/* ── 安全铁律 ─────────────────────────────────────────────────────── */

log('\n-- 安全铁律（启动崩溃的根因）--')
const recoveryScript = buildLoaderObservationScript(stamp)
const injectRow = buildInjectRow(stamp)

await check('注入脚本里没有同步 XHR', () => {
  assert.ok(!/open\([^)]*,\s*false\s*\)/.test(injectRow.text), '同步 XHR 会阻塞启动')
})
await check('注入脚本里绝不调用 __ModuleLoader__.create()', () => {
  assert.ok(!/ModuleLoader__\s*\.\s*create/.test(injectRow.text), '抢跑 create 会让应用起不来')
})
await check('注入脚本里没有自动重载', () => {
  assert.ok(!/location\s*\.\s*reload/.test(injectRow.text), '自动重载会把「代码没更新」升级成「应用打不开」')
})
await check('注入脚本里没有 fetch', () => {
  assert.ok(!/\bfetch\s*\(/.test(injectRow.text), '不该用 fetch，避免与启动争抢')
})
await check('注入脚本带 boot 后门闸', () => {
  assert.ok(injectRow.text.includes('__tlReady'), '缺少推迟门闸')
  assert.ok(injectRow.text.includes('DOMContentLoaded'), '缺少 DOMContentLoaded 兜底')
})

await check('解析期（readyState=loading）完全不动手', () => {
  const page = makePage({ readyState: 'loading' })
  run(recoveryScript, page)
  page.flushRaf()
  assert.equal(page.state.scripts.length, 0, '解析期不该插 script')
  assert.equal(page.state.xhrCalls.length, 0, '解析期不该发任何请求')
})
await check('busy 时只登记 DOMContentLoaded 监听', () => {
  const page = makePage({ readyState: 'loading' })
  run(recoveryScript, page)
  assert.equal((page.state.listeners.DOMContentLoaded ?? []).length, 1, '应当登记一个监听')
})
await check('DOMContentLoaded 之后仍然要等空闲才动手', () => {
  const page = makePage({ readyState: 'loading' })
  run(recoveryScript, page)
  page.fireDomReady()
  assert.equal(page.state.xhrCalls.length, 0, '刚 ready 还不该发请求')
  page.flushRaf()
  assert.equal(page.state.xhrCalls.length, 0, '过了 rAF 也要等空闲定时器')
  page.flushTimers()
  assert.ok(page.state.xhrCalls.length > 0, '空闲后才开始观测')
})
await check('boot 已完成时也不阻塞（只是排进队列）', () => {
  const page = makePage({ readyState: 'complete' })
  run(recoveryScript, page)
  assert.equal(page.state.xhrCalls.length, 0, '刚 ready 时不该发请求')
  page.flushAll()
  assert.ok(page.state.xhrCalls.length > 0, '空闲后才开始观测')
})

/* ── 只读观测 ─────────────────────────────────────────────────────── */

log('\n-- 只读观测（不再投递）--')
const idle = (opts) => {
  const page = makePage({ readyState: 'complete', ...opts })
  run(recoveryScript, page)
  page.flushAll()
  return page
}

await check('脚本语法正确', () => {
  new Function(recoveryScript)
})
await check('绝不改动 __ModuleLoader__（也绝不往里注册探针）', () => {
  const page = makePage({ readyState: 'complete' })
  const before = page.window.__ModuleLoader__
  run(recoveryScript, page)
  page.flushAll()
  assert.equal(page.window.__ModuleLoader__, before, '加载器对象被换掉了')
  assert.equal(page.loaded.length, 0, `不该往加载器里注册任何东西（探针也不行），实际注册了 ${page.loaded.length} 次`)
  assert.ok(!('__dshTermLensCaptured' in page.window), '不该留下捕获标记')
})
await check('绝不插入 <script>', () => {
  const page = idle()
  assert.equal(page.state.scripts.length, 0, `不该插 script，实际 ${page.state.scripts.length}`)
})
await check('报告队列快照', () => {
  const page = idle({ pendingQueue: [{ id: 'a', factory: () => {} }, { id: 'b' }] })
  const q = page.state.xhrCalls.find((c) => c.url.includes('phase=queue'))
  assert.ok(q, '应当报告队列')
  const u = decodeURIComponent(q.url)
  assert.ok(u.includes('count=2'), `应报数量，实际: ${u}`)
  assert.ok(u.includes('hasMine=0'), '应报我们有没有在队列里')
  assert.ok(u.includes('a|b'), '应报 id 列表')
})
await check('报告启动清单里我们那条 entry', () => {
  const page = idle({
    boot: { entries: [{ id: 'dsh-term-lens', url: 'plugins/??dsh-term-lens/client.js&rev=abc', rev: 'abc', immediately: true }] },
  })
  const c = page.state.xhrCalls.find((x) => x.url.includes('phase=entry'))
  assert.ok(c, '应当报告 entry')
  const u = decodeURIComponent(c.url)
  assert.ok(u.includes('rev=abc'), `应报 rev: ${u}`)
  assert.ok(u.includes('imm=true'), '应报 immediately')
})
await check('报告 DOM 证据（apply 真的跑了的铁证）', () => {
  const page = idle()
  const c = page.state.xhrCalls.find((x) => x.url.includes('phase=dom'))
  assert.ok(c, '应当报告 DOM 状态')
  const u = decodeURIComponent(c.url)
  assert.ok(u.includes('chip=0') && u.includes('style=0'), `假页面上应当都没有: ${u}`)
  assert.ok(u.includes('appliedFlag='), '应报 applied 标记')
})
await check('没有加载器时回执 no-loader', () => {
  const page = makePage({ readyState: 'complete' })
  page.window.__ModuleLoader__ = undefined
  run(recoveryScript, page)
  page.flushAll()
  assert.ok(page.state.xhrCalls.some((c) => c.url.includes('phase=no-loader')))
})
await check('所有回执都是异步 XHR', () => {
  const page = idle()
  assert.ok(page.state.xhrCalls.length > 0, '应当有回执')
  for (const c of page.state.xhrCalls) assert.notEqual(c.async, false, `不该是同步 XHR: ${c.url}`)
})
await check('页面什么都没有时也不崩', () => {
  const page = makePage({ readyState: 'complete' })
  page.window.__ModuleLoader__ = undefined
  page.window.document = undefined
  run(recoveryScript, page)
  page.flushAll()
})

/* ── 注入行与挂载 ─────────────────────────────────────────────────── */

log('\n-- 注入行与挂载 --')
await check('完整注入行含门闸、观测、探测，且语法正确', () => {
  assert.equal(injectRow.kind, 'script')
  assert.equal(injectRow.placement, 'body')
  assert.ok(injectRow.text.includes('__dsh_term_lens_env_probe'), '缺少探测标记')
  assert.ok(injectRow.text.includes('WANT_ID'), '缺少观测段')
  new Function(injectRow.text)
})
await check('注册事件、推一行、幂等、可卸载', () => {
  const handlers = new Map()
  const ctx = {
    on(n, f) {
      if (!handlers.has(n)) handlers.set(n, new Set())
      handlers.get(n).add(f)
    },
    off(n, f) {
      handlers.get(n)?.delete(f)
    },
  }
  const dispose = installClientSync(ctx, { info() {}, warn: (...a) => log('    [warn]', ...a) })
  assert.equal(typeof dispose, 'function')
  const table = []
  for (const fn of handlers.get('webserver/index-inject')) fn(table)
  assert.equal(table.length, 1)
  for (const fn of handlers.get('webserver/index-inject')) fn(table)
  assert.equal(table.length, 1, '不该重复推')
  const table2 = [{ kind: 'script', placement: 'body', text: '/* __dsh_term_lens_env_probe */' }]
  for (const fn of handlers.get('webserver/index-inject')) fn(table2)
  assert.equal(table2.length, 1, '识别得出已有行')
  dispose()
  assert.equal(handlers.get('webserver/index-inject').size, 0)
})
await check('注入表异常输入不崩', () => {
  const handlers = new Map()
  const ctx = { on: (n, f) => handlers.set(n, f), off() {} }
  installClientSync(ctx, { info() {}, warn() {} })
  for (const bad of [null, 'not-array', [null, undefined, 42], {}]) handlers.get('webserver/index-inject')(bad)
})
await check('宿主路由里实现了 /env、/client-bundle.js 与 /client-ping', () => {
  const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  assert.ok(routes.includes("'/env'"), '缺少 /env')
  assert.ok(routes.includes("'/client-bundle.js'"), '缺少 /client-bundle.js')
  assert.ok(routes.includes("'/client-ping'"), '缺少 /client-ping')
})

log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
process.exit(failures === 0 ? 0 : 1)
