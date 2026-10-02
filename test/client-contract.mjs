/**
 * 客户端 bundle 契约测试。
 *
 * 在 Node 里用一个最小 DOM / React / fetch 替身真正执行 lib/client.js，
 * 验证：
 *   1. 它按 DSH 的模块协议注册自己（id 与 package.json 的 name 一致）
 *   2. factory(require) 返回的 exports 形状正确（apply 是函数、inject 是数组）
 *   3. apply(ctx) 能跑到底并返回 disposer
 *   4. 设置页注册进 settings.section（与壁纸引擎同一个插槽）
 *   5. 右栏 tab 与降级路径都正常
 *   6. 卸载后 DOM 与样式清理干净
 *
 * 这不替代真实浏览器验证，但能把「bundle 加载即崩」这类问题挡在安装之前。
 *   node test/client-contract.mjs
 */

import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

const log = (...a) => console.log(...a)
let failures = 0

/** 断言条目：{ section } 换节标题，{ name, fn } 是一条检查。 */
const ENTRIES = []
const section = (title) => ENTRIES.push({ section: title })
const check = (name, fn) => ENTRIES.push({ name, fn })

/* ── 1. 模块协议 ──────────────────────────────────────────────────── */

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let registered = null
const fakeWindow = {
  __ModuleLoader__: {
    load(spec) {
      registered = spec
    },
  },
}

/** 用一个极简的 DOM/URL/fetch 替身把 bundle 跑起来。 */
function makeSandbox() {
  const elements = new Map()

  function makeEl(tag = 'div', id = '') {
    const el = {
      tagName: String(tag).toUpperCase(),
      id,
      style: { cssText: '', setProperty() {}, removeProperty() {} },
      children: [],
      parentNode: null,
      _attrs: {},
      _listeners: new Map(),
      textContent: '',
      innerHTML: '',
      className: '',
      offsetWidth: 120,
      offsetHeight: 40,
      setAttribute(k, v) {
        this._attrs[k] = String(v)
      },
      getAttribute(k) {
        return this._attrs[k] ?? null
      },
      removeAttribute(k) {
        delete this._attrs[k]
      },
      // dataset 在真实 DOM 里与 data-* 属性双向同步。插件靠它打样式归属标记,
      // 所以替身必须照做 —— 否则测不出「标记有没有真的写进属性」。
      get dataset() {
        const attrs = this._attrs
        const toAttr = (prop) => `data-${String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
        return new Proxy(
          {},
          {
            get: (_, prop) => (typeof prop === 'string' ? (attrs[toAttr(prop)] ?? undefined) : undefined),
            set: (_, prop, value) => {
              attrs[toAttr(prop)] = String(value)
              return true
            },
            has: (_, prop) => typeof prop === 'string' && toAttr(prop) in attrs,
          },
        )
      },
      appendChild(c) {
        c.parentNode = this
        this.children.push(c)
        if (c.id) elements.set(c.id, c)
        return c
      },
      removeChild(c) {
        const i = this.children.indexOf(c)
        if (i >= 0) this.children.splice(i, 1)
        c.parentNode = null
        if (c.id) elements.delete(c.id)
      },
      remove() {
        this.parentNode?.removeChild(this)
      },
      contains(n) {
        let cur = n
        while (cur) {
          if (cur === this) return true
          cur = cur.parentNode
        }
        return false
      },
      addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set())
        this._listeners.get(type).add(fn)
      },
      removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn)
      },
      dispatch(type, ev = {}) {
        for (const fn of this._listeners.get(type) ?? []) fn({ type, target: this, ...ev })
      },
      querySelector(sel) {
        return matchAll(documentElement, sel)[0] ?? null
      },
      querySelectorAll(sel) {
        return matchAll(documentElement, sel)
      },
      closest() {
        return null
      },
      getBoundingClientRect() {
        return { left: 100, top: 200, right: 180, bottom: 220, width: 80, height: 20, x: 100, y: 200 }
      },
      focus() {},
      select() {},
      setSelectionRange() {},
    }
    return el
  }

  const documentElement = makeEl('html', '__html')
  const head = makeEl('head', '__head')
  const body = makeEl('body', '__body')
  // head/body 必须真的挂在 documentElement 下 —— 否则从根遍历的
  // querySelector 永远找不到样式表,测不出「去重」与「按标记清理」。
  documentElement.appendChild(head)
  documentElement.appendChild(body)

  /**
   * 极简选择器匹配。只支持插件真正用到的那几类:
   *   tag / tag[attr="value"] / tag[attr]
   */
  function matchAll(root, selector) {
    const m = /^([a-zA-Z*]*)((\[[^\]]+\])*)$/.exec(String(selector).trim())
    if (!m) return []
    const tag = (m[1] || '*').toLowerCase()
    const attrSpecs = [...m[2].matchAll(/\[([a-zA-Z-]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/g)].map((x) => ({
      name: x[1],
      value: x[2] === undefined ? undefined : x[2].replace(/^["']|["']$/g, ''),
    }))
    const out = []
    const walk = (node) => {
      for (const child of node.children ?? []) {
        const tagOk = tag === '*' || child.tagName.toLowerCase() === tag
        const attrsOk = attrSpecs.every(({ name, value }) => {
          const actual = child._attrs?.[name]
          if (actual === undefined) return false
          return value === undefined || actual === value
        })
        if (tagOk && attrsOk) out.push(child)
        walk(child)
      }
    }
    walk(root)
    return out
  }

  const document = {
    head,
    body,
    documentElement,
    createElement: (t) => makeEl(t),
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: (sel) => matchAll(documentElement, sel)[0] ?? null,
    querySelectorAll: (sel) => matchAll(documentElement, sel),
    addEventListener() {},
    removeEventListener() {},
    execCommand: () => true,
  }

  const window = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: { href: 'http://127.0.0.1:19387/' },
    getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    localStorage: (() => {
      const map = new Map()
      return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear(),
        get length() {
          return map.size
        },
      }
    })(),
  }

  return { window, document, elements, makeEl }
}

/* ── React 替身 ───────────────────────────────────────────────────── */

/**
 * 有状态的极简 React。
 *
 * 必须真的保存 hook 状态并支持重渲染 —— 否则测不了「设置页读到配置之后画出表单」
 * 这条路径(useState 每次返回初始值,组件永远停在 loading 态)。
 */
const hookState = new Map() // key -> { values: [], deps: [] }
let renderKey = null
let hookIndex = 0
let pendingEffects = []
let scheduleRender = () => {}

const FakeReact = {
  createElement(type, props, ...children) {
    return { $$typeof: 'el', type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  Fragment: Symbol('Fragment'),
  useRef(v) {
    const st = hookState.get(renderKey)
    const i = hookIndex++
    if (st.values[i] === undefined) st.values[i] = { current: v }
    return st.values[i]
  },
  useState(initial) {
    const st = hookState.get(renderKey)
    const i = hookIndex++
    if (!(i in st.values)) st.values[i] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      st.values[i] = typeof next === 'function' ? next(st.values[i]) : next
      scheduleRender()
    }
    return [st.values[i], set]
  },
  useEffect(fn, deps) {
    const st = hookState.get(renderKey)
    const i = hookIndex++
    const prev = st.deps[i]
    const changed = prev === undefined || !deps || deps.some((d, k) => d !== prev[k])
    st.deps[i] = deps
    if (changed) pendingEffects.push(fn)
  },
  useReducer(reducer, initial) {
    const st = hookState.get(renderKey)
    const i = hookIndex++
    if (!(i in st.values)) st.values[i] = initial
    const dispatch = (action) => {
      st.values[i] = reducer(st.values[i], action)
      scheduleRender()
    }
    return [st.values[i], dispatch]
  },
  useMemo(fn) {
    hookIndex++
    return fn()
  },
  useCallback(fn) {
    hookIndex++
    return fn
  },
}

/**
 * 渲染一个组件函数,带 hook 状态;effect 里的 setState 会触发重渲染,
 * 直到稳定(最多 20 轮),返回最后一棵元素树。
 */
function renderComponent(Comp, props = {}, key = 'test') {
  const prevKey = renderKey
  renderKey = key
  if (!hookState.has(key)) hookState.set(key, { values: [], deps: [] })
  const st = hookState.get(key)

  let tree = null
  for (let round = 0; round < 20; round++) {
    hookIndex = 0
    pendingEffects = []
    let rerender = false
    scheduleRender = () => {
      rerender = true
    }
    tree = Comp(props)
    for (const fn of pendingEffects) {
      const cleanup = fn()
      if (typeof cleanup === 'function') st.deps.push(cleanup)
    }
    if (!rerender) break
  }
  renderKey = prevKey
  return tree
}

const fakeRoots = []
const FakeReactDOM = {
  createRoot(container) {
    const root = {
      container,
      render(el) {
        this.el = el
      },
      unmount() {
        this.unmounted = true
      },
    }
    fakeRoots.push(root)
    return root
  },
}

/* ── 执行 bundle ──────────────────────────────────────────────────── */

const requireShim = (name) => {
  if (name === 'react') return FakeReact
  if (name === 'react-dom') return FakeReactDOM
  throw new Error(`bundle 请求了未预期的模块: ${name}`)
}

const sandbox = makeSandbox()
const runner = new Function(
  'window',
  'document',
  'location',
  'navigator',
  'fetch',
  'console',
  'setTimeout',
  'clearTimeout',
  'AbortController',
  source,
)

const FAKE_CONFIG = {
  ollama: { baseURL: 'http://127.0.0.1:11434', model: 'qwen3:4b', keepAlive: '30m', temperature: 0.2, think: false },
  web: { enabled: true, mode: 'auto', autoBelowConfidence: 'low', maxResults: 5 },
  trigger: { minLength: 2, maxLength: 80, showFloatingChip: true, autoOpenCard: true, shortcut: 'Ctrl+Shift+E' },
  prompt: { language: 'zh-CN', style: 'standard', customSystem: null },
  cache: { enabled: true, maxEntries: 2000 },
}

function fakeFetch(url) {
  const u = String(url)
  if (u.includes('/term-lens/status')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        plugin: { name: 'dsh-term-lens', version: '0.1.0' },
        ollama: { ok: true, version: '0.35.0' },
        config: { model: 'qwen3:4b', trigger: FAKE_CONFIG.trigger },
        cache: { count: 3, bytes: 4096 },
        paths: { config: 'C:\\Users\\x\\.dsh-term-lens\\config.json', cache: 'C:\\Users\\x\\.dsh-term-lens\\cache' },
      }),
    }
  }
  if (u.includes('/term-lens/models')) {
    return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:4b' }, { name: 'deepseek-r1:8b' }], current: 'qwen3:4b' }) }
  }
  if (u.includes('/term-lens/config')) {
    return { ok: true, status: 200, json: async () => ({ config: FAKE_CONFIG, defaults: FAKE_CONFIG, path: 'x' }) }
  }
  if (u.includes('/term-lens/cache/clear')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, removed: 3 }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

let threw = null
try {
  runner(
    Object.assign(sandbox.window, fakeWindow),
    sandbox.document,
    sandbox.window.location,
    { clipboard: { writeText: async () => {} } },
    fakeFetch,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  )
} catch (err) {
  threw = err
}

/* ── 检查 ─────────────────────────────────────────────────────────── */

section('加载协议')
check('bundle 执行时调用 __ModuleLoader__.load', () => {
  assert.ok(!threw, `bundle 执行抛错: ${threw?.stack ?? threw}`)
  assert.ok(registered, '没有调用 window.__ModuleLoader__.load')
})
check('注册 id 与 package.json 的 name 一致', () => {
  assert.equal(registered.id, pkg.name, `id=${registered.id} 与 name=${pkg.name} 不一致，宿主会找不到这个 bundle`)
})
check('factory 是函数', () => {
  assert.equal(typeof registered.factory, 'function')
})

section('导出契约')
let pluginExports
check('factory(require) 返回 exports', () => {
  pluginExports = registered.factory(requireShim)
  assert.ok(pluginExports, 'factory 必须返回 module.exports，否则宿主拿到 undefined')
})
check('exports.apply 是函数', () => {
  assert.equal(typeof pluginExports.apply, 'function', '客户端插件必须导出 apply')
})
check('exports.inject 是数组', () => {
  assert.ok(Array.isArray(pluginExports.inject), 'inject 必须是数组')
  assert.equal(pluginExports.inject.length, 0, '刻意声明空依赖，保证 DSH 升级后插件仍能加载')
})

section('挂载与卸载')
const slotCalls = { injected: [], registered: [] }
const tabCalls = []
const shortcutInvokes = []
let disposer
check('apply(ctx) 走 ctx.get 取服务，不抛错并返回 disposer', () => {
  // 模拟真实宿主：客户端的 ctx 是**受限上下文** ——
  // 直接读 ctx.slots 会抛 `cannot get property "slots" without inject`
  // （这正是「设置入口一直不出现」的根因）。所以这里把它变成硬约束：
  // 任何 ctx.<service> 的直接读取都抛，逼出 ctx.get 的正确用法。
  const services = {
    slots: {
      inject(key, cb) {
        slotCalls.injected.push(key)
        return cb()
      },
      register(options, component) {
        slotCalls.registered.push({ options, component })
        return () => {}
      },
    },
    // 右栏 tab 类型注册表：用来核对 logo
    sidebarRightTabs: {
      register(options) {
        tabCalls.push({ options })
        return () => {}
      },
    },
    // shortcuts.invoke 用来从浮卡打开设置
    shortcuts: {
      invoke(id, context) {
        shortcutInvokes.push({ id, context })
      },
    },
    // 故意不提供 sidebarRight —— 模拟宿主没有右栏导航服务的配置
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(name) {
      return services[name]
    },
  }
  for (const name of ['slots', 'sidebarRight', 'sidebarRightTabs']) {
    Object.defineProperty(ctx, name, {
      get() {
        throw new Error(`cannot get property "${name}" without inject`)
      },
      configurable: true,
    })
  }
  disposer = pluginExports.apply(ctx)
  assert.equal(typeof disposer, 'function', 'apply 必须返回清理函数')
})
check('挂载后往 body 插入了 chip 与 card 容器', () => {
  const ids = sandbox.document.body.children.map((c) => c.id).filter(Boolean)
  assert.ok(ids.includes('dsh-term-lens-chip'), `缺少 chip 容器, 实际: ${ids.join(',')}`)
  assert.ok(fakeRoots.length >= 1, '没有为卡片创建 React 根')
})
check('样式表带 data-plugin 归属标记，且只注入一份', () => {
  // 归属标记是关键:不打标的 <style> 会被 client-modules 的 claimStyles()
  // 认领走,之后随别的插件卸载而被删除。
  const styled = sandbox.document.head.children.filter((c) => c.tagName === 'STYLE')
  assert.equal(styled.length, 1, `应恰好注入一个样式表, 实际 ${styled.length}`)
  const tag = styled[0]
  assert.equal(tag.getAttribute('data-plugin'), 'dsh-term-lens', 'data-plugin 必须是本包名,否则样式会被别人认领')
  assert.ok(tag.getAttribute('data-plugin-css'), 'data-plugin-css 是去重键,不能缺')
  assert.ok(tag.textContent.includes('#dsh-term-lens-chip'), '样式内容应包含 chip 规则')
  assert.ok(tag.textContent.includes('.tl-set'), '样式内容应包含设置页规则')
})
check('React 根已创建并 render 被调用', () => {
  assert.ok(fakeRoots[0].el !== undefined, 'React 根的 render 没有被调用')
})

section('插槽注册 · 设置页')
// 注意:这里不能用顶层 await。
// check() 只是「登记」检查,真正执行在文件末尾的 for 循环里;
// 顶层 await 会把模块求值卡住,使它之后的 check() 在循环跑完后才登记,永远不执行。
// 所有等待都必须放进检查函数内部。
/** 轮询等一个条件成立,最多 1 秒。 */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) {
    await new Promise((r) => setTimeout(r, 10))
  }
  return predicate()
}

check('设置页注册进 settings.section（与壁纸引擎同一插槽）', async () => {
  const found = await waitFor(() => slotCalls.registered.some((r) => r.options?.name === 'settings.section'))
  assert.ok(found, `没有注册 settings.section, 实际: ${slotCalls.registered.map((r) => r.options?.name).join(', ') || '(无)'}`)
  const reg = slotCalls.registered.find((r) => r.options?.name === 'settings.section')
  assert.equal(reg.options.id, 'dsh-term-lens', 'id 必须是本包名,否则会顶掉别人的设置页')
  assert.equal(typeof reg.options.label, 'string', 'label 是左侧导航上显示的文字')
  assert.equal(typeof reg.options.order, 'number', 'order 决定导航项顺序,壁纸引擎用的是 500')
  assert.equal(typeof reg.component, 'function', '必须给出一个组件工厂')
  // 用 slots.inject 包一层是必须的:settings.section 只在设置面板挂载期间存在,
  // 直接 register 到未声明的插槽会 throw。
  assert.ok(slotCalls.injected.includes('settings.section'), 'settings.section 必须经 slots.inject 注册')
  log(`     settings.section: id=${reg.options.id} order=${reg.options.order} label=${reg.options.label}`)
})

check('设置页组件能渲染出表单（含各字段）', async () => {
  const reg = slotCalls.registered.find((r) => r.options?.name === 'settings.section')
  const factory = reg.component()
  assert.ok(factory, '组件工厂必须返回一个元素')
  assert.equal(typeof factory.type, 'function', '应当返回设置页组件')

  // 空值断言:断言后必须早退,否则下一行会拿 undefined 崩掉,
  // 把「注册缺失」误报成 TypeError。
  assert.ok(factory, '组件工厂必须返回值')
  const SettingsComp = factory.type

  // 用有状态的替身渲染,直到配置到达、表单画出来
  let tree = renderComponent(SettingsComp, {}, 'settings')
  const deadline = Date.now() + 1000
  while (Date.now() < deadline && !JSON.stringify(tree).includes('解释用的本地模型')) {
    await new Promise((r) => setTimeout(r, 20))
    tree = renderComponent(SettingsComp, {}, 'settings')
  }

  const text = JSON.stringify(tree)
  for (const needle of ['解释用的本地模型', 'Ollama 地址', '触发方式', '联网搜索降级', '解释风格', '缓存条目上限', '清空缓存', '保存']) {
    assert.ok(text.includes(needle), `设置表单缺少字段: ${needle}`)
  }
  // 状态行应反映 Ollama 可用
  assert.ok(text.includes('Ollama 就绪'), '缺少 Ollama 状态行')
  // 模型下拉里应同时有本机模型和当前配置的模型
  assert.ok(text.includes('deepseek-r1:8b'), '模型下拉没有列出本机模型')
  log('     设置表单字段完备（模型/地址/触发/联网/风格/缓存/状态行）')
})

section('插槽注册 · 右栏 tab')
check('右栏 tab 正文注册进 sidebar.right.pane.tab', async () => {
  await waitFor(() => slotCalls.registered.some((r) => r.options?.name === 'sidebar.right.pane.tab'))
  const reg = slotCalls.registered.find((r) => r.options?.name === 'sidebar.right.pane.tab')
  assert.ok(reg, `没有注册 sidebar.right.pane.tab, 实际: ${slotCalls.registered.map((r) => r.options?.name).join(', ') || '(无)'}`)
  assert.equal(reg.options.key, 'dsh-term-lens')
  assert.ok(slotCalls.injected.includes('sidebar.right.pane.tab'), 'sidebar.right.pane.tab 必须经 slots.inject 注册')
})

section('图标')
check('右栏 tab 类型注册了搜索图标（不再用默认立方体占位符）', () => {
  const call = tabCalls.find((c) => c.options?.id === 'dsh-term-lens')
  assert.ok(call, `没有注册右栏 tab 类型, 实际: ${tabCalls.map((c) => c.options?.id).join(', ') || '(无)'}`)
  const entry = call.options.guide?.[0]
  assert.ok(entry, 'guide 里没有条目 —— DSH 会用默认立方体占位图标')
  assert.equal(typeof entry.icon, 'function', 'icon 必须是 React 组件（对照 ui-sidebar-terminal 的 icon: PluginArtworkTerminal）')
  log(`     guide icon = ${entry.icon.name || '(匿名组件)'}`)
})
check('搜索图标能渲染出 svg', () => {
  const call = tabCalls.find((c) => c.options?.id === 'dsh-term-lens')
  const Icon = call.options.guide[0].icon
  const el = renderComponent(Icon, { size: 14 }, 'search-icon')
  assert.ok(el, '图标组件必须返回元素')
  assert.equal(el.type, 'svg', `应当渲染 svg，实际 ${String(el.type)}`)
  // 放大镜 = 一个圆 + 一条手柄线
  const kids = Array.isArray(el.props.children) ? el.props.children : [el.props.children]
  assert.ok(kids.some((k) => k?.type === 'circle'), '缺少镜片圆')
  assert.ok(kids.some((k) => k?.type === 'path'), '缺少镜柄')
  assert.equal(el.props.stroke, 'currentColor', '颜色应跟随主题')
})
check('浮卡头部是 历史 / 固定 / 关闭 三个按钮（设置按钮已按需求撤掉）', () => {
  assert.ok(!source.includes('function GearIcon'), '齿轮图标应当已删除')
  assert.ok(!/onSettings/.test(source), '不该再有设置按钮的接线')
  // 前缀匹配：标题后面还附了快捷键提示，写死全文会因为改文案而误报
  assert.ok(/title: '历史记录（侧边栏）/.test(source), '缺少历史按钮')
  assert.ok(/title: '关闭 \(Esc\)'/.test(source), '缺少关闭按钮')
  // 也不该有缩放按钮
  assert.ok(!/缩小 \(Ctrl\+-\)/.test(source), '不该有缩小按钮')
  assert.ok(!/放大 \(Ctrl\+\+\)/.test(source), '不该有放大按钮')
})
check('固定按钮用图钉图标，不用不起眼的字形', () => {
  // 起因：原先用的是字形 ⧉ —— 它在很多字体里渲染成一个小方框，
  // 用户反馈「固定键没有存在在弹窗上」，其实是认不出来。绝不能再退回去。
  // 注释里会出现 ⧉（记录这段历史），所以只在**代码**里检查。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(/function PinIcon/.test(code), '缺少 PinIcon 组件')
  assert.ok(/h\(PinIcon, \{ size: \d+ \}\)/.test(code), '头部没有渲染 PinIcon')
  assert.ok(!code.includes('\u29c9'), '不该再用字形 ⧉（用户认不出，等于按钮不存在）')
})
check('窗口级操作只放在右上角，底部不重复', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  // 固定与历史各只有一个入口（右上角）。底部再放一份只是重复，还会把那行挤满。
  assert.equal((code.match(/onClick: onPin/g) ?? []).length, 1, '固定按钮应当只有右上角一处')
  assert.equal((code.match(/onClick: onHistory/g) ?? []).length, 1, '历史按钮应当只有右上角一处')
  // 底部保留的是「对这份解释做什么」的动作
  for (const label of ['发进对话', '联网重查', '重新生成']) {
    assert.ok(code.includes(`'${label}'`), `底部缺少「${label}」`)
  }
  // 底部那三个带文字的固定/历史按钮必须已经移除
  assert.ok(!/state\.pinned \? '已固定' : '固定'/.test(code), '底部不该再有带文字的固定按钮')
  assert.ok(!/'历史',/.test(code), '底部不该再有带文字的历史按钮')
})

section('固定在页面上')
check('「固定」是钉住浮窗，不是固定到右侧栏', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(/function togglePinCard/.test(code), '缺少 togglePinCard')
  // 旧语义（把解释送到右侧栏）必须已经不存在
  assert.ok(!/pinToSidebar/.test(code), '旧的「固定到右侧栏」应当已删除')
  assert.ok(!/固定到右侧栏/.test(code), '不该再有「固定到右侧栏」的文案')
})
check('固定的卡片不会因为点击外部而关闭', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*\n?/g, '')
  const i = code.indexOf('const onDocMouseDown')
  assert.ok(i >= 0, '找不到 onDocMouseDown')
  const seg = code.slice(i, i + 700)
  assert.ok(/if \(state\.card\.pinned\)/.test(seg), '点击外部时没有判断固定状态 —— 固定就不该被关掉')
})
check('「重新生成 / 联网重查」不会把已固定的窗口变回未固定', () => {
  assert.ok(/const keepPinned = state\.card\?\.pinned === true/.test(source), '缺少 keepPinned 逻辑')
  assert.ok(/pinned: keepPinned/.test(source), '没有把 pinned 带进新状态')
})
check('固定状态有可切换的按钮状态与视觉标记', () => {
  assert.ok(/'aria-pressed': state\.pinned/.test(source), '固定按钮缺少 aria-pressed')
  assert.ok(/'data-pinned': state\.pinned/.test(source), '卡片缺少 data-pinned 标记')
  assert.ok(/\.tl-card\[data-pinned="1"\]/.test(source), '缺少固定状态的样式')
  assert.ok(/已固定/.test(source), '按钮上没有「已固定」文案反馈')
})

section('历史侧边栏')
check('历史是与浮卡并列的独立入口', () => {
  assert.ok(/function toggleHistoryPanel/.test(source), '缺少 toggleHistoryPanel')
  assert.ok(/function HistoryIcon/.test(source), '缺少 HistoryIcon 组件')
  assert.ok(/h\(HistoryIcon/.test(source), '没有渲染 HistoryIcon')
  assert.ok(/title: '历史记录（侧边栏）/.test(source), '缺少历史按钮的提示文案')
  // 提示里要带上快捷键，否则 Alt+H 没人知道
  assert.ok(/Alt\+H/.test(source), '历史按钮的提示里没有标出快捷键 Alt+H')
})
check('历史面板只有列表，不重复渲染当前术语的详情', () => {
  const i = source.indexOf('function PanelContent')
  assert.ok(i >= 0, '找不到 PanelContent')
  // 只看渲染树，不看注释（注释里会提到 ExplanationBody 来说明为什么移除它）
  const seg = source
    .slice(i, i + 3200)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert.ok(seg.includes('tl-history-list'), '缺少历史列表')
  // 详情块必须不存在，理由有两条：
  //   1. 用户的诉求是「看历史」，详情属于当前弹窗，重复一份很吵
  //   2. 它是这个面板里最重的一块，还随 store 每次变化重渲染
  //      —— 表现就是「点历史条目卡顿、双击都没反应」
  assert.ok(!seg.includes('tl-pane-detail'), '不该再渲染详情区')
  assert.ok(!seg.includes('h(ExplanationBody'), '历史面板里不该渲染完整解释体（正是卡顿的来源）')
})

section('追问开关')
check('客户端读的配置键必须与设置写的一致', () => {
  // 曾经的真实 bug：设置页写 prompt.followUp，客户端却读 trigger.followUpEnabled，
  // 结果永远是 undefined —— 追问被永久拒绝，提示「未在设置开启」。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(/let followUpEnabled = true/.test(code), '缺少 followUpEnabled 状态（默认应当为 true）')
  assert.ok(/if \(!followUpEnabled\)/.test(code), '追问没有检查开关')
  assert.ok(!/trigger\.followUpEnabled/.test(code), '不该把追问开关塞进 trigger（键名对不上的根源）')
  assert.ok(/\?path=prompt\.followUp/.test(code) || /'prompt\.followUp'/.test(code), '设置页应当写 prompt.followUp')
  // 只有明确是 false 才关闭：字段缺失（老宿主/请求失败）不该让功能整个不可用
  assert.ok(/status\?\.config\?\.followUp === false/.test(code), '应当只在明确 false 时关闭')
})
check('/status 必须返回 followUp', () => {
  const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  const i = routes.indexOf("path === '/status'")
  // 取样到下一个端点为止，而不是写死长度 —— 写死过 1200，后来 /status 里
  // 加了 readiness 块就把它挤出去了，测试跟着误报
  const j = routes.indexOf("path === '/diag'", i)
  const seg = routes.slice(i, j > i ? j : i + 4000)
  assert.ok(/followUp: config\.prompt\.followUp !== false/.test(seg), '/status 没有返回 followUp —— 客户端会读到 undefined')
})

section('解释 schema')
check('按有没有上下文挑 schema（否则无上下文时会编造 inContext）', () => {
  const prompt = readFileSync(new URL('../lib/prompt.js', import.meta.url), 'utf8')
  assert.ok(/export const EXPLANATION_SCHEMA_NO_CTX/.test(prompt), '缺少「无上下文」版 schema')
  assert.ok(/export function schemaFor/.test(prompt), '缺少 schemaFor')
  // 无上下文版必须把 inContext 从 required 里去掉 —— 那正是「编造」的根源：
  // 模型没法输出空串，只好拿通用定义来填
  assert.ok(/EXPLANATION_SCHEMA\.required\.filter/.test(prompt), '无上下文版没有去掉 inContext 的 required')
  const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  assert.ok(/schema: schemaFor\(context\)/.test(routes), 'routes 应当按上下文挑 schema')
})
check('cleanInContext 能清掉被包装的哨兵串', () => {
  const prompt = readFileSync(new URL('../lib/prompt.js', import.meta.url), 'utf8')
  // 判据必须是「短句内包含」而不是「精确相等」：模型会写成
  //   当前无明确上下文，请使用默认说明：（未提供上下文）
  assert.ok(
    /NO_CONTEXT_MARKERS\.some\(\(m\) => v\.includes\(m\)\)/.test(prompt),
    '仍是精确匹配，清不掉被包装的哨兵串',
  )
  assert.ok(/NO_CONTEXT_MAX_LEN/.test(prompt), '缺少长度门槛（防止误清真实的 inContext）')
})

section('主题兼容')
check('表单控件不写死主题色（浅色主题下会变一片白）', () => {
  const TICK = String.fromCharCode(96)
  const s = source.indexOf('const CSS = ')
  const opener = source.indexOf(TICK, s)
  const closer = source.indexOf(TICK, opener + 1)
  const block = source.slice(opener + 1, closer)
  assert.ok(block.length > 5000, '没读到样式块')
  // 这是「启用外观插件后一片纯白」的根因：前景与背景同时用了会随主题翻转的变量
  const rs = block.indexOf('.tl-set-input, .tl-set-select, .tl-set-area')
  const formRule = block.slice(rs, block.indexOf('.tl-set-select option', rs))
  assert.ok(formRule.length > 100, '没取到表单控件规则')
  assert.ok(!/background:\s*var\(--dsw-alias-bg-layer/.test(formRule), '表单控件不该用主题背景变量（浅色主题会变白底）')
  assert.ok(!/color:\s*var\(--dsw-alias-label-primary/.test(formRule), '表单控件不该写死前景色')
  assert.ok(/color:\s*inherit/.test(formRule), '前景色应当 inherit')
  assert.ok(/background:\s*transparent/.test(formRule), '背景应当 transparent，交给浏览器')
  // color-scheme 让原生控件（下拉箭头/复选框/resize 手柄）跟随主题
  assert.ok(/color-scheme:\s*dark light/.test(block), '缺少 color-scheme，浅色主题下原生控件会不匹配')
})
check('当前条目在列表里有高亮标记', () => {
  assert.ok(/'data-current': row\.term === current/.test(source), '没有标出当前条目')
  // 高亮落在「行容器」上：一行现在有主按钮和删除按钮两个兄弟节点，
  // 不能把删除按钮嵌进主按钮里（<button> 套 <button> 是非法 HTML）
  assert.ok(/\.tl-history-row\[data-current="1"\]/.test(source), '缺少当前条目的样式')
})
check('历史删除：每行一个删除按钮 + 可清空全部', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(/function TrashIcon/.test(code), '缺少 TrashIcon 组件')
  assert.ok(/tl-history-del/.test(code), '缺少行内删除按钮')
  assert.ok(/onDelete: \(term\) => deleteHistory\(term\)/.test(code), '删除没有接到处理函数')
  assert.ok(/onClearAll: \(\) => deleteHistory\(\)/.test(code), '缺少「清空」接线')
  assert.ok(/async function deleteHistory/.test(code), '缺少 deleteHistory')
  // 本地与宿主两边都要删，否则刷新后删掉的词会回来
  assert.ok(/store\.setJson\(HISTORY_KEY, next\)/.test(code), '没有删本地存储')
  assert.ok(/method: 'DELETE'/.test(code), '没有删宿主历史')
  // 删除按钮必须是主按钮的兄弟节点，不能嵌套
  assert.ok(!/<button[^>]*>\s*<button/.test(code), '出现了嵌套按钮（非法 HTML）')
})

section('继续对话（追问）')
check('浮卡里有追问输入与消息列表', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(/function FollowUp/.test(code), '缺少 FollowUp 组件')
  assert.ok(/h\(FollowUp, \{ state, onAsk/.test(code), 'FollowUp 没有挂进浮卡')
  assert.ok(/className: 'tl-ask-area'/.test(code), '缺少输入框')
  assert.ok(/onAsk: \(q\) => askFollowUp\(s\.card, q\)/.test(code), 'CardMount 没有接 onAsk')
})
check('追问走独立的 /chat 端点，且不落缓存', () => {
  assert.ok(/async function askQuestion/.test(source), '缺少 askQuestion')
  assert.ok(/\\?\$\{API\}\/chat/.test(source) || source.includes('${API}/chat'), '没有请求 /chat')
  const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  assert.ok(routes.includes("'/chat'"), '宿主没有实现 /chat 路由')
  assert.ok(/async function handleChat/.test(routes), '缺少 handleChat')
  // 追问答案形态是自由文本，不能套 JSON schema
  const i = routes.indexOf('async function handleChat')
  const seg = routes.slice(i, i + 2600)
  assert.ok(!/schema:/.test(seg), '追问不该用 JSON schema 约束（会把答案挤成碎片）')
  assert.ok(!/cache\.store/.test(seg), '追问不该落缓存（问题千变万化，只会把缓存撑爆）')
})
check('追问会带上已给出的解释与之前的问答', () => {
  const prompt = readFileSync(new URL('../lib/prompt.js', import.meta.url), 'utf8')
  assert.ok(/export function buildFollowUpMessages/.test(prompt), '缺少 buildFollowUpMessages')
  assert.ok(/不要重复已经讲过的内容/.test(prompt), '没有告诉模型「别复述已给的内容」')
  assert.ok(/history/.test(prompt), '没有接收多轮历史')
  // 只带最近若干轮，避免把 4B 模型的上下文挤爆
  assert.ok(/slice\(-6\)/.test(prompt), '没有截断历史轮数')
})
check('追问必须打开思考链（否则推理链会写进正文）', () => {
  // 真实事故：用户追问「我还是不太懂键」，模型把推理过程当答案吐了出来
  //   「首先，用户说：… 回顾我已有的信息： … 最佳响应策略： … 草拟回答：」
  // 而且稳定用满 num_predict 被截断。实测对比（test/experiment-followup.mjs）：
  //   think:false → 正文 4~5 个推理标记，900/900 截断
  //   think:true  → 正文干净、done_reason=stop，推理待在 message.thinking 里
  // 这是功能正确性问题，必须挡住回归。
  const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  const i = routes.indexOf('async function handleChat')
  const seg = routes.slice(i, i + 4000)
  assert.ok(/think:\s*true/.test(seg), 'handleChat 没有打开思考链 —— 推理链会写进正文')
  assert.ok(/numPredict:\s*Math\.max/.test(seg), '没有给思考链留出额外的 token 预算（会被截断）')

  const ollama = readFileSync(new URL('../lib/ollama.js', import.meta.url), 'utf8')
  assert.ok(/opts\.think === true/.test(ollama), 'chatStream 不支持按调用覆盖 think')
  // think:true 的优先级必须高于配置里的 think:false，否则追问会被配置压回去
  const thinkFalseAt = ollama.indexOf('config.ollama.think === false')
  const thinkTrueAt = ollama.indexOf('opts.think === true')
  assert.ok(thinkFalseAt >= 0 && thinkTrueAt > thinkFalseAt, 'opts.think 必须在 config.think 之后生效')
})
check('换词/重查时会掐掉还在跑的追问', () => {
  assert.ok(/askController\.abort\(\)/.test(source), '没有中止在跑的追问')
  assert.ok(/askController = new AbortController\(\)/.test(source), '没有重建控制器（abort 过的控制器永久失效）')
})

section('解释风格')
check('风格可以是内置档，也可以是自建风格的任意名字', () => {
  const prompt = readFileSync(new URL('../lib/prompt.js', import.meta.url), 'utf8')
  assert.ok(/export function resolveStyleHint/.test(prompt), '缺少 resolveStyleHint')
  assert.ok(/prompt\.styles/.test(prompt), '没有读自建风格')
  assert.ok(/return STYLE_HINT\.standard/.test(prompt), '名字找不到时没有回退到标准档')
  assert.ok(/export const BUILTIN_STYLES/.test(prompt), '缺少内置风格清单')
})
check('设置页能新建与删除自建风格', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(/const BUILTIN_STYLES = \[/.test(code), '客户端缺少内置风格清单')
  assert.ok(/label: '自建风格'/.test(code), '缺少自建风格区块')
  assert.ok(/保存并启用/.test(code), '缺少新建风格的按钮')
  // 删掉正在用的风格要顺手切回标准档，否则 style 会指向一个不存在的名字
  assert.ok(/'prompt\.style': 'standard'/.test(code), '删掉正在用的风格时没有切回标准档')
})
check('风格标注「测试中」，并说明作用范围', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(/解释风格（测试中）/.test(code), '风格标签没有标「（测试中）」')
  // 风格只管首轮解释，对追问无效 —— 这一点必须写在界面上，
  // 否则用户会以为「详细回答」也该影响追问（真实困惑过）
  assert.ok(/不影响追问/.test(code), '没有说明风格不影响追问')
})

section('API 接入占位')
check('API 入口只展示、不可填写', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(/API 接入（开发中）/.test(code), '缺少「API 接入（开发中）」标签')
  // 能填却无效的字段比明确说「还没做」更让人困惑，也更容易被当成 bug
  const i = code.indexOf('API 接入（开发中）')
  const seg = code.slice(i, i + 900)
  assert.ok(/disabled: true/.test(seg), 'API 输入框应当 disabled')
  assert.ok(/readOnly: true/.test(seg), 'API 输入框应当 readOnly')
  assert.ok(/暂不可填写/.test(seg), '缺少「暂不可填写」的占位文案')
  // 不能悄悄把值提交给宿主 —— 宿主也没有这个配置项
  assert.ok(!/patch\('api\./.test(code), 'API 字段不该接到 patch（宿主没有这个配置项）')
  assert.ok(!/'api\./.test(code), 'API 字段不该出现在任何配置路径里')
})

section('尺寸（拖拽边缘）')
check('提供八个方向的拖拽把手', () => {
  assert.ok(source.includes('RESIZE_HANDLES'), '缺少把手定义')
  const edges = [...source.matchAll(/edge: '([nsew]{1,2})'/g)].map((m) => m[1])
  for (const need of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    assert.ok(edges.includes(need), `缺少 ${need} 方向的把手`)
  }
  log(`     把手方向: ${edges.join(' ')}`)
})
check('尺寸有上下限，不会拖成 0 或超出视口', () => {
  assert.ok(source.includes('function clampSize'), '缺少 clampSize')
  assert.ok(/SIZE_MIN_W = \d+/.test(source), '缺少最小宽度')
  assert.ok(/SIZE_MIN_H = \d+/.test(source), '缺少最小高度')
  assert.ok(/SIZE_MAX_W_RATIO/.test(source) && /SIZE_MAX_H_RATIO/.test(source), '缺少视口上限比例')
})
check('左/上边缘拖拽时对边保持不动', () => {
  // 关键几何：拖左边缘要同时改宽度和 x，且触到下限时位置不能继续漂移
  const i = source.indexOf('function beginResize')
  const seg = source.slice(i, i + 1400)
  assert.ok(/edge\.includes\('w'\)/.test(seg), '缺少西向处理')
  assert.ok(/edge\.includes\('n'\)/.test(seg), '缺少北向处理')
  assert.ok(/x = start\.x \+ \(start\.w - clamped\.w\)/.test(seg), '西向到下限时位置没锁住')
  assert.ok(/y = start\.y \+ \(start\.h - clamped\.h\)/.test(seg), '北向到下限时位置没锁住')
})
check('尺寸会被持久化', () => {
  assert.ok(source.includes('SIZE_KEY'), '缺少尺寸存储键')
  assert.ok(/store\.setJson\(SIZE_KEY/.test(source), '尺寸没有落盘')
  assert.ok(/function readSavedSize/.test(source), '没有读取已保存尺寸')
})
check('缩放方案已完全移除（没有残留）', () => {
  for (const dead of ['zoomStore', 'applyZoom', '--tl-zoom', 'ZOOM_KEY']) {
    assert.ok(!source.includes(dead), `仍有缩放残留: ${dead}`)
  }
})

section('降级路径')
check('完全没有 slots 服务时不抛错，主功能保留', async () => {
  const d = pluginExports.apply({ logger: { info() {}, warn() {}, error() {}, debug() {} } })
  assert.equal(typeof d, 'function', '仍须返回 disposer')
  await new Promise((r) => setTimeout(r, 30))
  d()
})

section('清理')
check('disposer 清理干净 DOM 与样式', () => {
  disposer()
  const ids = sandbox.document.body.children.map((c) => c.id)
  assert.ok(!ids.includes('dsh-term-lens-chip'), 'chip 容器没被移除')
  const styled = sandbox.document.head.children.filter((c) => c.tagName === 'STYLE')
  assert.equal(styled.length, 0, '样式表没被移除')
  assert.ok(fakeRoots[0].unmounted, 'React 根没被 unmount')
})

section('与宿主 API 的约定')
check('客户端请求的端点都在宿主路由里实现了', () => {
  // 允许路径里有连字符（/client-ping、/client-bundle.js）
  const endpoints = [...source.matchAll(/\$\{API\}(\/[a-z0-9/-]+)/g)].map((m) => m[1])
  const unique = [...new Set(endpoints)]
  assert.ok(unique.length > 0, '没有发现任何 API 调用')
  const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  for (const ep of unique) {
    assert.ok(routes.includes(`'${ep}'`), `客户端请求了 ${ep} 但宿主路由里没有实现`)
  }
  log(`     客户端使用的端点: ${unique.join(', ')}`)
})

section('跨文件一致性')
check('客户端与宿主的「未解析」哨兵字符串一致', () => {
  const prompt = readFileSync(new URL('../lib/prompt.js', import.meta.url), 'utf8')
  const sentinel = '模型没有返回可解析的结果。'
  assert.ok(source.includes(sentinel), '客户端没有引用哨兵字符串')
  assert.ok(prompt.includes(sentinel), '宿主 prompt.js 里没有这个哨兵')
})
check('设置页字段与宿主配置白名单对得上', () => {
  // 设置页写出去的每个配置路径，宿主 mergeConfig 都必须认识，
  // 否则用户改了却静默不生效 —— 这种「改了没反应」最难查。
  const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  const paths = new Set([...source.matchAll(/patch\('([a-zA-Z.]+)'/g)].map((m) => m[1]))
  assert.ok(paths.size > 0, '没有找到任何 patch() 调用')
  for (const p of paths) {
    const [group, key] = p.split('.')
    assert.ok(
      new RegExp(`next\\.${group}\\b`).test(routes) && new RegExp(`\\b${key}\\b`).test(routes),
      `设置页会写 ${p}，但宿主 routes.js 的 mergeConfig 里看不到这个字段`,
    )
  }
  log(`     设置页写入的配置路径: ${[...paths].sort().join(', ')}`)
})

section('触发行为')
check('默认是「选中浮出按钮、点了才解释」', () => {
  // 这是明确要求的行为:不要选中就立刻解释。
  const t = source.match(/let trigger = \{[\s\S]*?\n\t*\}/)
  assert.ok(t, '没有找到客户端 trigger 默认值')
  assert.match(t[0], /autoOpenCard:\s*false/, 'autoOpenCard 默认必须是 false')
  assert.match(t[0], /showFloatingChip:\s*true/, 'showFloatingChip 默认必须是 true')
  assert.match(t[0], /chipPlacement:\s*'above'/, '按钮默认应浮在选区上方')
})
check('宿主配置默认值与客户端一致', () => {
  const cfg = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')
  assert.match(cfg, /autoOpenCard:\s*false/, 'lib/config.js 的 autoOpenCard 默认也必须是 false')
  assert.match(cfg, /chipPlacement:\s*'above'/, 'lib/config.js 缺 chipPlacement 默认值')
})
check('选中时只有在 autoOpenCard 打开后才发起解释', () => {
  // 定位到浮出按钮那段(注意用带横线的注释标记,设置页里也有「浮出「解释」按钮」字样)
  const marker = '// —— 浮出「解释」按钮 ——'
  const i = source.indexOf(marker)
  assert.ok(i > 0, `没有找到浮出按钮的逻辑 (${marker})`)
  const seg = source.slice(i)
  const guard = seg.indexOf('if (trigger.autoOpenCard) requestExplain')
  assert.ok(guard > 0, 'requestExplain 必须由 autoOpenCard 守卫')
  // 守卫之前不能有「无条件」的 requestExplain 调用
  const unconditional = seg.slice(0, guard).match(/(?<!if \(trigger\.autoOpenCard\) )requestExplain\(/)
  assert.equal(unconditional, null, '浮出按钮之后、守卫之前存在无条件的 requestExplain 调用')
})
check('点击卡片外部会关闭', () => {
  // 用户要求:点解释框外面能关掉。
  const i = source.indexOf('const onDocMouseDown')
  assert.ok(i > 0, '没有找到 onDocMouseDown')
  const seg = source.slice(i, i + 420)
  assert.match(seg, /state\.card/, '外部按下时必须检查卡片是否开着')
  assert.match(seg, /closeCard\(\)/, '外部按下时必须调用 closeCard')
})
check('关闭时会中止在跑的请求并抑制重开', () => {
  const i = source.indexOf('function closeCard()')
  assert.ok(i > 0, '没有找到 closeCard')
  const seg = source.slice(i, i + 400)
  assert.match(seg, /runner\.cancel\(\)/, 'closeCard 必须中止流式请求,否则关了还在后台跑')
  assert.match(seg, /dismissedTerm\s*=/, 'closeCard 必须记录 dismissedTerm 以抑制同一个词重开')
})
check('内部触发路径受 dismissedTerm 抑制', () => {
  const i = source.indexOf('function requestExplain(term')
  assert.ok(i > 0, '没有找到 requestExplain')
  const seg = source.slice(i, i + 300)
  assert.match(seg, /if \(term === dismissedTerm\) return/, 'requestExplain 必须先检查 dismissedTerm')
})
check('样式只用 DSH 真实存在的主题变量', () => {
  // 变量名写错不会报错,只会静默回退到 fallback 颜色 —— 在浅色主题下尤其难看。
  const KNOWN = new Set([
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-border-l3',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-state-business-primary',
    '--dsw-font-family',
    '--dsw-font-mono',
    // 玻璃拟态配方(全部取自 DSH 自己的聊天/菜单表面)
    '--dsw-specific-input-major',
    '--dsw-specific-menu',
    '--dsw-specific-sidebar-fill',
    '--dsw-menu-backdrop-filter',
    '--dsw-elevation-stroke-color',
    '--dsw-elevation-prominent',
    '--dsw-radius-lg',
  ])
  const used = new Set([...source.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))
  assert.ok(used.size > 0, '样式里没有用任何主题变量')
  for (const v of used) assert.ok(KNOWN.has(v), `用了未在 DSH 包里核实过的变量 ${v}`)
  log(`     使用 ${used.size} 个主题变量: ${[...used].join(', ')}`)
})

/* ── 按顺序执行并报告 ─────────────────────────────────────────────── */

log('== dsh-term-lens 客户端 bundle 契约测试 ==')
log(`package name = ${pkg.name}`)
log(`dsh.client = ${JSON.stringify(pkg.dsh?.client)}\n`)

for (const entry of ENTRIES) {
  if (entry.section) {
    log(`\n-- ${entry.section} --`)
    continue
  }
  try {
    await entry.fn()
    log(`  ok   ${entry.name}`)
  } catch (err) {
    failures++
    log(`  FAIL ${entry.name}: ${err?.message ?? err}`)
  }
}

log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
process.exit(failures === 0 ? 0 : 1)
