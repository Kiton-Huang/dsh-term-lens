/**
 * dsh-term-lens — browser half.
 *
 * Loaded by the DSH client module system: the host serves this file under
 * `/plugins/dsh-term-lens/client.js` and the shell materializes the factory.
 * `require("react")` / `require("react-dom")` resolve against the shell's
 * frozen platform table (PLATFORM_MODULES), so this bundle ships no
 * dependencies of its own. It must stay a classic script — the loader creates
 * a plain <script> without type="module", so `import`/`export` are illegal
 * here.
 *
 * Three surfaces, all driven by one selection watcher:
 *   1. a tiny chip that pops next to a fresh text selection
 *   2. a floating card that streams the explanation in place
 *   3. a docked right-sidebar tab, registered when the host offers the slots
 *      service (opened by the card's "pin" button)
 *
 * Nothing here touches the conversation, the composer, or the agent.
 */
window.__ModuleLoader__.load({
	id: 'dsh-term-lens',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const ReactDOM = require('react-dom')
		const h = React.createElement

		/* ══ 常量 ═══════════════════════════════════════════════════════ */

		const API = '/term-lens'
		const LOG = '[term-lens]'
		const PKG = 'dsh-term-lens'
		const TAB_KIND = 'term-lens'

		/**
		 * 客户端构建标记。
		 *
		 * 每次改动客户端代码就 +1。诊断报告里带上它,就能回答一个基本问题:
		 * 浏览器里跑的到底是不是我刚改的那一版。没有它,「改了没生效」只能靠猜。
		 */
		const CLIENT_BUILD = 15

		const CHIP_ID = 'dsh-term-lens-chip'
		const CARD_ID = 'dsh-term-lens-card'
		const PANEL_ID = 'dsh-term-lens-panel'
		const TOAST_ID = 'dsh-term-lens-toast'

		/**
		 * 样式表的归属标记。
		 *
		 * 这不是可选的:client-modules 的 claimStyles() 在每个插件物化时,会把 DOM 里
		 * 所有【没有 data-plugin 属性】的 <style> 统统盖成那个插件的 id,之后那个插件
		 * 卸载就会把它们删掉 —— 不打标记的样式迟早会莫名消失。
		 */
		const STYLE_OWNER = PKG
		const STYLE_TAG_ID = `${PKG}/styles.css`

		const HISTORY_KEY = `${PKG}:history:v1`
		const MODEL_KEY = `${PKG}:model`
		const POS_KEY = `${PKG}:card-pos`

		/** 宿主说「没解析出结果」时 oneLine 的取值,与 lib/prompt.js 保持一致 */
		const UNPARSED = '模型没有返回可解析的结果。'

		function log(...args) {
			console.log(LOG, ...args)
		}
		function warn(...args) {
			console.warn(LOG, ...args)
		}

		/* ══ 安全存储 ═══════════════════════════════════════════════════ */

		/**
		 * 直接摸 localStorage 是有风险的:隐私模式、被策略禁用、或配额满时
		 * getItem/setItem 会抛异常。挂载路径中途抛异常会留下半截 DOM,
		 * 所以所有读写都走这里,失败就静默降级成「不持久化」。
		 */
		const store = {
			get(key, fallback = null) {
				try {
					const v = window.localStorage.getItem(key)
					return v === null ? fallback : v
				} catch {
					return fallback
				}
			},
			getJson(key, fallback) {
				try {
					const raw = this.get(key, null)
					return raw === null ? fallback : JSON.parse(raw)
				} catch {
					return fallback
				}
			},
			set(key, value) {
				try {
					window.localStorage.setItem(key, value)
					return true
				} catch {
					return false
				}
			},
			setJson(key, value) {
				return this.set(key, JSON.stringify(value))
			},
		}

		/* ══ 选区判定 ═══════════════════════════════════════════════════ */

		/** 选中文本是否值得查:长度合规、不是纯符号/纯数字、不是一整段代码。 */
		function acceptableTerm(raw, trigger) {
			const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
			if (text.length < (trigger.minLength ?? 2)) return null
			if (text.length > (trigger.maxLength ?? 80)) return null
			// 至少要有两个「字母/汉字」类字符,否则是符号噪声
			const wordish = text.match(/[\p{L}\p{N}]/gu) ?? []
			if (wordish.length < 2) return null
			// 纯数字不查
			if (/^[\d\s.,%+-]+$/.test(text)) return null
			return text
		}

		/** 选中内容是否落在输入控件或我们自己的 UI 里 —— 是的话就不该触发。 */
		function isExplainableNode(node) {
			let el = node && node.nodeType === 1 ? node : node?.parentElement
			let depth = 0
			while (el && depth < 12) {
				if (el.id === CHIP_ID || el.id === CARD_ID || el.id === PANEL_ID) return false
				if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return false
				el = el.parentElement
				depth++
			}
			// 只要不在输入控件里就认。DSH 的 transcript 没有稳定 class,
			// 所以用「排除法」而不是「白名单」,这样换版本也不会失效。
			return true
		}

		/** 取选区所在块级元素的可读文本,作为给模型的上下文。 */
		function contextAround(range, maxChars = 1200) {
			try {
				let el = range.startContainer
				if (el.nodeType !== 1) el = el.parentElement
				// 往上找到第一个「像一段内容」的祖先
				const BLOCKS = ['P', 'LI', 'PRE', 'CODE', 'TD', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4']
				let best = null
				let depth = 0
				while (el && depth < 8) {
					const tag = el.tagName
					if (BLOCKS.includes(tag)) {
						best = el
						if (tag === 'PRE' || tag === 'P' || tag === 'LI') break
					}
					el = el.parentElement
					depth++
				}
				const text = String(best?.innerText ?? best?.textContent ?? '')
					.replace(/\s+/g, ' ')
					.trim()
				if (!text) return { context: '', scene: 'chat' }
				const scene = best?.tagName === 'PRE' || best?.closest?.('pre') ? 'code' : 'chat'
				if (text.length <= maxChars) return { context: text, scene }
				// 太长就以选区为中心截一段
				const needle = String(range.toString() ?? '')
				const at = needle ? text.indexOf(needle.slice(0, 40)) : -1
				if (at < 0) return { context: text.slice(0, maxChars), scene }
				const half = Math.floor(maxChars / 2)
				const from = Math.max(0, at - half)
				return { context: text.slice(from, from + maxChars), scene }
			} catch (err) {
				warn('contextAround 失败', err)
				return { context: '', scene: 'chat' }
			}
		}

		/** 当前会话 id。拿不到就退化成「本次浏览器会话」级别。 */
		function currentSessionId() {
			try {
				const url = new URL(window.location.href)
				for (const k of ['session', 'sessionId', 's']) {
					const v = url.searchParams.get(k)
					if (v) return v
				}
				const hash = url.hash.replace(/^#\/?/, '')
				const m = hash.match(/session[/=]([A-Za-z0-9-]{6,})/)
				if (m) return m[1]
				const attr = document.querySelector('[data-session-id]')?.getAttribute('data-session-id')
				if (attr) return attr
			} catch {
				/* ignore */
			}
			return 'anonymous'
		}

		/* ══ 宿主通信 ═══════════════════════════════════════════════════ */

		async function getStatus() {
			const res = await fetch(`${API}/status`, { headers: { accept: 'application/json' } })
			if (!res.ok) throw new Error(`status ${res.status}`)
			return res.json()
		}

		async function getModels() {
			const res = await fetch(`${API}/models`, { headers: { accept: 'application/json' } })
			if (!res.ok) throw new Error(`models ${res.status}`)
			return res.json()
		}

		function warmUp(model) {
			return fetch(`${API}/warmup`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model }),
			}).catch(() => {})
		}

		async function getConfig() {
			const res = await fetch(`${API}/config`, { headers: { accept: 'application/json' } })
			if (!res.ok) throw new Error(`config ${res.status}`)
			return res.json()
		}

		async function saveConfig(patch) {
			const res = await fetch(`${API}/config`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch),
			})
			if (!res.ok) throw new Error(`保存失败 (${res.status})`)
			return res.json()
		}

		async function clearCache() {
			const res = await fetch(`${API}/cache/clear`, { method: 'POST' })
			if (!res.ok) throw new Error(`清空失败 (${res.status})`)
			return res.json()
		}

		/**
		 * 把客户端探测到的宿主能力回传给宿主。
		 *
		 * Desktop 版没有可用的 DevTools / console 通道，浏览器里的日志看不到，
		 * 所以「设置页 / 侧栏为什么没出现」只能靠这条通道回答 —— 否则只能猜。
		 */
		function reportDiag(data) {
			try {
				fetch(`${API}/diag`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(data),
				}).catch(() => {})
			} catch {
				/* 诊断失败绝不影响主功能 */
			}
		}

		/**
		 * 读一条 SSE 流并按事件分发。
		 *
		 * 抽出来共用：/explain 与 /chat 用的是同一套 SSE 协议，
		 * 复制一份迟早会因为只改了一边而错位（这个插件的注入脚本就吃过这个亏）。
		 *
		 * @param {Response} res
		 * @param {(event: string, payload: any) => void} onEvent
		 * @param {(chunk: string) => void} [onText] 累积的 delta 文本
		 */
		async function readSse(res, onEvent, onText) {
			if (!res.body) throw new Error('浏览器不支持流式响应')
			const reader = res.body.getReader()
			const decoder = new TextDecoder()
			let buffer = ''
			let raw = ''

			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })

				let sep
				while ((sep = buffer.indexOf('\n\n')) >= 0) {
					const frame = buffer.slice(0, sep)
					buffer = buffer.slice(sep + 2)
					if (frame.startsWith(':')) continue // 心跳注释帧

					let event = 'message'
					const dataLines = []
					for (const line of frame.split('\n')) {
						if (line.startsWith('event:')) event = line.slice(6).trim()
						else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
					}
					if (dataLines.length === 0) continue
					let payload
					try {
						payload = JSON.parse(dataLines.join('\n'))
					} catch {
						continue
					}
					if (event === 'delta') {
						raw += payload.text ?? ''
						onText?.(raw)
					}
					onEvent(event, payload)
				}
			}
		}

		/**
		 * 流式解释。逐事件回调,让浮卡能边生成边渲染。
		 * @param {object} body  term / context / scene / model / web / refresh
		 * @param {object} handlers  onMeta / onDelta / onWebStart / onWebDone / onWebError / onDone / signal
		 */
		async function explain(body, handlers = {}) {
			const res = await fetch(`${API}/explain`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				body: JSON.stringify({ ...body, sessionId: body.sessionId ?? currentSessionId() }),
				signal: handlers.signal,
			})
			if (!res.ok) {
				const text = await res.text().catch(() => '')
				throw new Error(`解释请求失败 (${res.status}) ${text.slice(0, 200)}`)
			}

			await readSse(
				res,
				(event, payload) => {
					switch (event) {
						case 'meta':
							handlers.onMeta?.(payload)
							break
						case 'web-start':
							handlers.onWebStart?.(payload)
							break
						case 'web-done':
							handlers.onWebDone?.(payload)
							break
						case 'web-error':
							// 联网没拿到材料。**必须往上抛**：原来这种情况宿主是静默跳过的，
							// 用户点「联网重查」白等一场、界面一个字都不变。
							handlers.onWebError?.(payload)
							break
						case 'done':
							handlers.onDone?.(payload)
							break
						case 'error': {
							// 把宿主给的 hint/kind 挂在 error 上一起往上抛。
							// 只抛 message 的话，「该怎么做」就在这一层丢了 ——
							// 而没装 Ollama 的人恰恰只差这一句。
							const e = new Error(payload.message ?? '未知错误')
							e.hint = payload.hint ?? ''
							e.kind = payload.kind ?? ''
							throw e
						}
						default:
							break
					}
				},
				(raw) => handlers.onDelta?.(raw),
			)
		}

		/**
		 * 围绕同一个术语追问（继续对话）。
		 *
		 * 不走缓存：问题千变万化，缓存命中率极低还会把缓存撑爆。
		 * 需要把**已经给出的解释**和**之前的问答**一起送回去，否则「那它呢」
		 * 这类追问模型无法理解。
		 *
		 * @param {{term:string, context?:string, explanation?:object, history?:Array, question:string}} body
		 * @param {{onDelta?:Function, onDone?:Function, signal?:AbortSignal}} handlers
		 */
		async function askQuestion(body, handlers = {}) {
			const res = await fetch(`${API}/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				body: JSON.stringify(body),
				signal: handlers.signal,
			})
			if (!res.ok) {
				const text = await res.text().catch(() => '')
				throw new Error(`追问失败 (${res.status}) ${text.slice(0, 200)}`)
			}

			await readSse(
				res,
				(event, payload) => {
					if (event === 'done') handlers.onDone?.(payload)
					else if (event === 'error') throw new Error(payload.message ?? '未知错误')
				},
				(raw) => handlers.onDelta?.(raw),
			)
		}

		/**
		 * 流式期间的乐观解析:JSON 还没长全时,尽量把已经完整的字段抽出来显示,
		 * 这样用户看到的是一点点长出来的解释,而不是一片空白等好几秒。
		 */
		function optimisticParse(text, term) {
			const out = {
				term,
				reading: '',
				oneLine: '',
				inContext: '',
				bullets: [],
				pitfalls: [],
				related: [],
				example: '',
				confidence: null,
			}
			if (!text) return out

			const grab = (key) => {
				const closed = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
				const m = text.match(closed)
				if (m) {
					try {
						return JSON.parse(`"${m[1]}"`)
					} catch {
						return m[1]
					}
				}
				// 还没闭合:取到最后一个字符,当作正在输入的内容
				const open = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`)
				const o = text.match(open)
				if (o) return o[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
				return ''
			}

			out.oneLine = grab('oneLine')
			out.inContext = grab('inContext')
			out.reading = grab('reading')
			out.example = grab('example')
			const conf = text.match(/"confidence"\s*:\s*"(high|medium|low)"/)
			if (conf) out.confidence = conf[1]

			// 数组字段:只要元素已经闭合就收进来
			const arrGrab = (key, max = 6) => {
				const idx = text.indexOf(`"${key}"`)
				if (idx < 0) return []
				const seg = text.slice(idx, idx + 1200)
				const items = []
				const re = /"((?:[^"\\]|\\.)*)"/g
				let m
				let first = true
				while ((m = re.exec(seg)) !== null) {
					if (first) {
						first = false // 跳过 key 自身
						continue
					}
					items.push(m[1])
					if (items.length >= max) break
				}
				return items
			}
			if (!out.oneLine) {
				out.bullets = arrGrab('bullets')
				out.pitfalls = arrGrab('pitfalls', 3)
			}
			return out
		}

		/* ══ 样式 ═══════════════════════════════════════════════════════ */

		const CSS = `
#${CHIP_ID} {
  position: fixed; z-index: 2147483000;
  display: flex; align-items: center; gap: 4px;
  padding: 3px 9px 3px 8px; border-radius: 999px;
  font: 500 12px/1.4 var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
  background: var(--dsw-specific-menu, rgba(40,40,40,.72));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(16px));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(16px));
  color: var(--dsw-alias-label-primary, #f5f5f5);
  border: 1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-border-l1, rgba(255,255,255,.14)));
  box-shadow: var(--dsw-elevation-prominent, 0 4px 14px rgba(0,0,0,.28));
  cursor: pointer; user-select: none; white-space: nowrap;
  opacity: 0; transform: translateY(2px) scale(.96);
  transition: opacity .12s ease, transform .12s ease;
}
#${CHIP_ID}:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.1)); }
#${CHIP_ID}[data-shown="1"] { opacity: 1; transform: translateY(0) scale(1); }

/*
  玻璃拟态配方 —— 全部取自 DSH 自己的聊天/菜单表面,不自己造颜色:
    --dsw-specific-input-major     聊天输入框的填充色(半透明)
    --dsw-menu-backdrop-filter     菜单用的背景模糊
    --dsw-elevation-stroke-color   浮层的描边色
    --dsw-elevation-prominent      浮层的投影
  这样在浅色/深色主题下都能自动贴合,不会出现「深色主题下卡片是白底」这类问题。
*/
.tl-surface {
  background: var(--dsw-specific-input-major, rgba(35,35,35,.72));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(16px));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(16px));
  border: 1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-border-l1, rgba(255,255,255,.14)));
  box-shadow: var(--dsw-elevation-prominent, 0 12px 36px rgba(0,0,0,.34));
  color: var(--dsw-alias-label-primary, #ededed);
  /* 让浏览器知道这里两种配色都支持：滚动条、原生控件（下拉箭头、
     复选框、textarea 的 resize 手柄）会按当前主题自己选合适的颜色。
     不写这个的话，浅色主题下这些原生部件会渲染成深色，很突兀。 */
  color-scheme: dark light;
}

.tl-card {
  width: 384px; max-width: calc(100vw - 24px);
  /* 默认「显示全部内容」：不设高度上限，卡片按内容自然长高。
     以前是 max-height:70vh，内容一多就在卡片内部出滚动条，看起来像被截断。
     现在只在真的超出视口时才由 JS 兜底限高（见 FloatingCard 的 style）。 */
  overflow: hidden;
  display: flex; flex-direction: column;
  border-radius: var(--dsw-radius-lg, 12px);
  font: 400 13px/1.6 var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
}
.tl-card-head {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.08));
  cursor: grab;
}
.tl-card-head:active { cursor: grabbing; }
.tl-term {
  font-weight: 600; font-size: 13.5px; flex: 1 1 auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tl-reading { font-size: 11px; opacity: .55; font-weight: 400; margin-left: 4px; }
.tl-badge {
  font-size: 10px; padding: 1px 5px; border-radius: 5px; font-weight: 500;
  border: 1px solid currentColor; opacity: .8; flex: 0 0 auto;
}
.tl-badge[data-conf="high"] { color: #4ade80; }
.tl-badge[data-conf="medium"] { color: #fbbf24; }
.tl-badge[data-conf="low"] { color: #f87171; }
.tl-badge[data-kind="cached"] { color: #60a5fa; }
.tl-badge[data-kind="web"] { color: #c084fc; }
.tl-iconbtn {
  flex: 0 0 auto; width: 24px; height: 24px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 0; cursor: pointer;
  color: inherit; opacity: .6; font-size: 13px; padding: 0;
}
.tl-iconbtn:hover { opacity: 1; background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.tl-iconbtn[disabled] { opacity: .3; cursor: default; }
.tl-body { padding: 10px 12px; overflow-y: auto; flex: 1 1 auto; }
.tl-oneline { font-size: 13px; margin: 0 0 8px; }
.tl-section { margin-top: 9px; }
.tl-section-title {
  font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase;
  opacity: .5; margin-bottom: 3px; font-weight: 600;
}
.tl-list { margin: 0; padding-left: 16px; }
.tl-list li { margin: 2px 0; }
.tl-context {
  border-left: 2px solid var(--dsw-alias-border-l1, rgba(255,255,255,.2));
  padding-left: 8px; opacity: .88; font-size: 12.5px;
}
.tl-pitfall { color: #fbbf24; }
.tl-related { display: flex; flex-wrap: wrap; gap: 5px; }
.tl-related-chip {
  font-size: 11.5px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.07));
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.1));
  color: inherit;
}
.tl-related-chip:hover { border-color: var(--dsw-alias-border-l1, rgba(255,255,255,.3)); }
.tl-code {
  margin: 0; padding: 8px 10px; border-radius: 7px; overflow-x: auto;
  font: 400 11.5px/1.5 var(--dsw-font-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.28));
  white-space: pre;
}
.tl-foot {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 7px 10px;
  border-top: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.08));
}
.tl-btn {
  font: 500 11.5px/1.5 inherit; padding: 3px 9px; border-radius: 7px; cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.07));
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.1));
  color: inherit;
  /* 带图标的按钮（如「固定」）需要基线对齐图标和文字 */
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
}
.tl-btn svg { flex: 0 0 auto; }
.tl-btn:hover:not([disabled]) { border-color: var(--dsw-alias-border-l1, rgba(255,255,255,.3)); }
.tl-btn[disabled] { opacity: .45; cursor: default; }
.tl-spacer { flex: 1 1 auto; }
.tl-streaming { font-size: 11px; opacity: .6; font-style: italic; }
.tl-caret::after { content: "▍"; animation: tl-blink 1s steps(2, start) infinite; opacity: .7; }
@keyframes tl-blink { to { visibility: hidden; } }
.tl-err { color: #f87171; font-size: 12px; }
/* 联网失败的提示条：不抢正文的风头，但必须看得见 */
.tl-webnote {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #b9bec7);
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  /* 左侧警示条写死琥珀色：主题变量表里没有 warning 系，写死反而在深浅两色下都看得见 */
  border-left: 3px solid #e0a030;
}
/* 错误要成对显示：说清「怎么了」+「该怎么办」。
   只给一句 connect ECONNREFUSED 对第一次装插件的人等于没说。 */
.tl-errbox { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.tl-errhint {
  font-size: 12px; line-height: 1.7; opacity: .75;
  white-space: pre-wrap; word-break: break-word;
  padding: 8px 10px; border-radius: 7px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06));
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.1));
}
.tl-empty { opacity: .6; font-size: 12px; }

/* 拖拽把手：贴在卡片边缘的最外层，透明但可抓。
   放在 .tl-body 之外，避免和滚动区抢事件。 */
.tl-resize {
  position: absolute;
  z-index: 2;
  background: transparent;
}
.tl-resize:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.12)); }

/* ── 兜底侧板 ─────────────────────────────────────────────────────────
   只在拿不到原生右栏服务时出现。做成「一整块侧栏」而不是「贴边的一坨」：
   标题行有层次、正文有留白、底部有提示，避免看起来像个半成品。 */
.tl-panel {
  display: flex; flex-direction: column;
  height: 100%; min-height: 0;
  font: 400 13px/1.65 var(--dsw-font-family, system-ui, sans-serif);
}
.tl-panel-head {
  flex: 0 0 auto;
  display: flex; align-items: baseline; gap: 8px;
  padding: 12px 10px 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.08));
}
.tl-panel-title { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.tl-panel-sub {
  flex: 1 1 auto; min-width: 0;
  font-size: 12px; opacity: .5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tl-panel-body {
  flex: 1 1 auto; min-height: 0;
  overflow-y: auto;
  padding: 16px;
}
.tl-panel-foot {
  flex: 0 0 auto;
  padding: 10px 16px;
  border-top: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.08));
}
.tl-panel-hint { font-size: 11.5px; opacity: .45; }

/* 历史面板正文：列表是主体，详情跟在下面 */
.tl-pane { display: flex; flex-direction: column; gap: 16px; }
.tl-pane-listhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tl-history-list { display: flex; flex-direction: column; gap: 1px; }
/* 一行 = 主按钮 + 删除按钮（兄弟节点，不是嵌套按钮） */
.tl-history-row {
  display: flex; align-items: center; gap: 2px;
  border-radius: 6px;
}
.tl-history-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.tl-history-row[data-current="1"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary, #4d9fff);
}
/* 删除按钮默认藏起来，鼠标进到这一行才出现 —— 免得列表看起来一团图标 */
.tl-history-del { opacity: 0; flex: 0 0 auto; margin-right: 4px; }
.tl-history-row:hover .tl-history-del, .tl-history-del:focus-visible { opacity: .7; }
.tl-history-del:hover { opacity: 1; color: #f87171; }
.tl-btn-quiet { font-size: 11px; padding: 2px 7px; opacity: .7; }
.tl-btn-quiet:hover { opacity: 1; }

/* ── 继续对话（追问）─────────────────────────────────────────────────
   放在正文与底栏之间。消息多了内部滚动，不让卡片无限长高。 */
.tl-ask {
  flex: 0 0 auto;
  border-top: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.08));
  padding: 8px 10px 10px;
}
.tl-ask-list {
  max-height: 260px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 7px;
  margin-bottom: 8px;
}
.tl-ask-msg[data-role="user"] { align-self: flex-end; max-width: 88%; }
.tl-ask-msg[data-role="assistant"] { align-self: stretch; }
.tl-ask-q {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.09));
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.1));
  border-radius: 9px; padding: 5px 9px;
  font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
}
.tl-ask-a { font-size: 12.5px; line-height: 1.7; }
.tl-ask-pending { font-size: 12px; opacity: .5; font-style: italic; }
.tl-ask-err { margin-bottom: 6px; }
.tl-ask-input { display: flex; align-items: flex-end; gap: 6px; }
.tl-ask-area {
  flex: 1 1 auto; min-width: 0; resize: vertical;
  min-height: 28px; max-height: 120px;
  font: 400 12.5px/1.5 var(--dsw-font-family, system-ui, sans-serif);
  padding: 5px 8px; border-radius: 8px;
  color: inherit;
  background: var(--dsw-specific-input-major, rgba(0,0,0,.2));
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.12));
}
.tl-ask-area:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, #4d9fff); }
.tl-ask-area::placeholder { color: inherit; opacity: .4; }

/* 追问回答里的轻量 markdown */
.tl-md-p { margin: 0 0 5px; }
.tl-md-p:last-child { margin-bottom: 0; }
.tl-md-list { margin: 0 0 5px; padding-left: 18px; }
.tl-md-list li { margin: 1px 0; }
.tl-md-code {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: .92em; padding: 1px 4px; border-radius: 4px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.1));
}

/* ── 设置页：自建风格 ─────────────────────────────────────────────── */
.tl-set-styles { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 8px; }
.tl-set-style-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 7px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.05));
}
.tl-set-style-name { flex: 0 0 auto; font-weight: 600; font-size: 12.5px; }
.tl-set-style-hint {
  flex: 1 1 auto; min-width: 0;
  font-size: 12px; opacity: .6;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tl-set-style-add { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.tl-set-style-add .tl-btn { align-self: flex-start; }

/* 固定状态的视觉提示：左侧一条强调色 + 图钉按钮点亮 */
.tl-card[data-pinned="1"] {
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.45)),
              inset 3px 0 0 var(--dsw-alias-state-business-primary, #4d9fff);
}
.tl-iconbtn[data-on="1"], .tl-btn[data-on="1"] {
  opacity: 1;
  color: var(--dsw-alias-state-business-primary, #4d9fff);
  border-color: var(--dsw-alias-state-business-primary, #4d9fff);
}
.tl-iconbtn[data-on="1"] { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.1)); }

.tl-history-item {
  display: block; width: 100%; text-align: left; cursor: pointer;
  padding: 5px 7px; border-radius: 6px; border: 0; background: transparent;
  color: inherit; font: 400 12px/1.5 inherit;
}
.tl-history-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.tl-history-term { font-weight: 600; }
.tl-history-line { opacity: .65; font-size: 11.5px; }

/* ── 设置页 ──────────────────────────────────────────────────────── */
.tl-set { max-width: 620px; font: 400 13px/1.6 var(--dsw-font-family, system-ui, sans-serif); }
.tl-set-h { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
.tl-set-sub { font-size: 12px; opacity: .6; margin: 0 0 14px; }
.tl-set-field { margin: 0 0 13px; }
.tl-set-label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; }
.tl-set-hint { font-size: 11.5px; opacity: .55; margin-top: 3px; }
/* 「该怎么做」的说明块：比普通 hint 更实，因为它是可照做的步骤 */
.tl-set-fix {
  opacity: .8;
  white-space: pre-wrap;
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.05));
  border-left: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
}

/* ── 表单控件 ──────────────────────────────────────────────────────
   ⚠️ 这里**刻意不写 color / background**。

   曾经的写法是
       color: var(--dsw-alias-label-primary, #ededed);
       background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.26));
   在外观插件切到**浅色主题**时会变成一片白：主题变量换成浅色后
   前景和背景一起变白（或者一边换成浅色、另一边还在用深色兜底值），
   文字就看不见了。

   正确做法是交还给浏览器：不设 background、color 用 inherit，
   再配上 color-scheme，原生控件会自己按当前配色渲染出对比正确的
   背景、文字与下拉箭头。这样浅色/深色主题都不会出问题。 */
.tl-set-input, .tl-set-select, .tl-set-area {
  width: 100%; box-sizing: border-box;
  font: 400 12.5px/1.5 inherit; padding: 5px 8px; border-radius: 7px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .4));
}
/* 下拉框需要不透明背景，否则展开时下面的文字会透出来。
   用 color-scheme 让浏览器给出与主题匹配的底色，而不是我们猜一个。 */
.tl-set-select { color-scheme: dark light; }
.tl-set-select option { color: canvastext; background-color: canvas; }
.tl-set-input::placeholder, .tl-set-area::placeholder { color: inherit; opacity: .38; }
.tl-set-input:focus, .tl-set-select:focus, .tl-set-area:focus {
  outline: none; border-color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
/* 禁用的占位输入框：明显不可用，但仍能看清「这里将来是干什么的」 */
.tl-set-input[disabled] {
  cursor: not-allowed;
  opacity: .5;
  border-style: dashed;
}
.tl-set-area { min-height: 62px; resize: vertical; font-family: inherit; }
.tl-set-row { display: flex; align-items: center; gap: 8px; margin: 0 0 9px; }
.tl-set-row.tl-set-field { margin-bottom: 13px; }
.tl-set-check { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-state-business-primary, #4d6bfe); flex: 0 0 auto; color-scheme: dark light; }
.tl-set-rowlabel { font-size: 12.5px; cursor: pointer; }
.tl-set-sep { height: 1px; background: var(--dsw-alias-border-l3, rgba(255,255,255,.08)); margin: 18px 0 14px; }
.tl-set-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.tl-set-actions { display: flex; align-items: center; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.tl-set-primary {
  font: 500 12.5px/1.5 inherit; padding: 5px 14px; border-radius: 7px; cursor: pointer;
  background: var(--dsw-alias-state-business-primary, #4d6bfe); color: #fff; border: 1px solid transparent;
}
.tl-set-primary:hover:not([disabled]) { filter: brightness(1.08); }
.tl-set-primary[disabled] { opacity: .45; cursor: default; }
.tl-set-msg { font-size: 12px; }
.tl-set-msg[data-kind="ok"] { color: #4ade80; }
.tl-set-msg[data-kind="err"] { color: #f87171; }
.tl-set-status { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.tl-set-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.tl-set-dot[data-ok="1"] { background: #4ade80; }
.tl-set-dot[data-ok="0"] { background: #f87171; }
.tl-set-code {
  font: 400 11px/1.5 var(--dsw-font-mono, ui-monospace, Consolas, monospace);
  opacity: .6; word-break: break-all;
}
`

		function ensureStyles() {
			if (typeof document === 'undefined') return
			if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
			const el = document.createElement('style')
			el.dataset.plugin = STYLE_OWNER
			el.dataset.pluginCss = STYLE_TAG_ID
			el.textContent = CSS
			document.head.appendChild(el)
		}

		function removeStyles() {
			document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)?.remove()
		}

		/* ── 尺寸（拖拽边缘调整）────────────────────────────────────────
		   用户拖动卡片边缘/角来改大小，尺寸持久化。
		   为什么不做整体缩放：那要改 DSH 的 <html>/<body>，一旦失败连累整个界面；
		   而"卡片太小看不清"的真实需求用改尺寸就能满足，且完全不动别人的节点。 */

		const SIZE_KEY = `${PKG}:card-size`
		const SIZE_MIN_W = 260
		const SIZE_MIN_H = 160
		/** 相对视口的上限，避免拖到比窗口还大 */
		const SIZE_MAX_W_RATIO = 0.92
		const SIZE_MAX_H_RATIO = 0.9

		function clampSize(w, h) {
			const maxW = Math.max(SIZE_MIN_W, Math.round(window.innerWidth * SIZE_MAX_W_RATIO))
			const maxH = Math.max(SIZE_MIN_H, Math.round(window.innerHeight * SIZE_MAX_H_RATIO))
			return {
				w: Math.min(maxW, Math.max(SIZE_MIN_W, Math.round(w))),
				h: Math.min(maxH, Math.max(SIZE_MIN_H, Math.round(h))),
			}
		}

		function readSavedSize() {
			const saved = store.getJson(SIZE_KEY, null)
			if (!saved || typeof saved.w !== 'number' || typeof saved.h !== 'number') return null
			return clampSize(saved.w, saved.h)
		}

		/** 卡片不能越过视口底部；越过了就整体上移。 */
		function clampCardY(y, height) {
			const maxY = Math.max(8, window.innerHeight - height - 8)
			return Math.min(Math.max(8, y), maxY)
		}

		/**
		 * 从一次 mousedown 开始拖拽调整尺寸。
		 *
		 * @param {string} edge  'e' | 'w' | 's' | 'n' | 组合如 'se' 'nw'
		 * @param {MouseEvent} e
		 * @param {{w:number,h:number,x:number,y:number}} start
		 * @param {(next:{w:number,h:number,x:number,y:number}) => void} onMove
		 * @param {() => void} onEnd
		 */
		function beginResize(edge, e, start, onMove, onEnd) {
			e.preventDefault()
			e.stopPropagation()
			const sx = e.clientX
			const sy = e.clientY
			let latest = { ...start }

			const move = (ev) => {
				const dx = ev.clientX - sx
				const dy = ev.clientY - sy
				let w = start.w
				let h = start.h
				let x = start.x
				let y = start.y

				// 右/下边缘：只改尺寸
				if (edge.includes('e')) w = start.w + dx
				if (edge.includes('s')) h = start.h + dy
				// 左/上边缘：改尺寸的同时平移，保证对边不动
				if (edge.includes('w')) {
					w = start.w - dx
					x = start.x + dx
				}
				if (edge.includes('n')) {
					h = start.h - dy
					y = start.y + dy
				}

				const clamped = clampSize(w, h)
				// 触到下限时，左/上边缘不能让位置继续漂移
				if (edge.includes('w')) x = start.x + (start.w - clamped.w)
				if (edge.includes('n')) y = start.y + (start.h - clamped.h)

				latest = { w: clamped.w, h: clamped.h, x, y }
				onMove(latest)
			}

			const up = () => {
				window.removeEventListener('mousemove', move)
				window.removeEventListener('mouseup', up)
				onEnd(latest)
			}
			window.addEventListener('mousemove', move)
			window.addEventListener('mouseup', up)
		}

		/** 八个方向的拖拽把手。 */
		const RESIZE_HANDLES = [
			{ edge: 'n', style: { top: -3, left: 10, right: 10, height: 6, cursor: 'ns-resize' } },
			{ edge: 's', style: { bottom: -3, left: 10, right: 10, height: 6, cursor: 'ns-resize' } },
			{ edge: 'w', style: { left: -3, top: 10, bottom: 10, width: 6, cursor: 'ew-resize' } },
			{ edge: 'e', style: { right: -3, top: 10, bottom: 10, width: 6, cursor: 'ew-resize' } },
			{ edge: 'nw', style: { left: -4, top: -4, width: 14, height: 14, cursor: 'nwse-resize' } },
			{ edge: 'ne', style: { right: -4, top: -4, width: 14, height: 14, cursor: 'nesw-resize' } },
			{ edge: 'sw', style: { left: -4, bottom: -4, width: 14, height: 14, cursor: 'nesw-resize' } },
			{ edge: 'se', style: { right: -4, bottom: -4, width: 14, height: 14, cursor: 'nwse-resize' } },
		]

		/* ══ 解释卡片（浮窗与侧栏共用的展示层）═══════════════════════════ */

		/**
		 * 极简 markdown 渲染。
		 *
		 * 刻意不引入 markdown 库：这里只需要「代码块 + 列表 + 加粗 + 行内代码」
		 * 这四样。追问的回答基本都是这个形态，而完整解析器会带来 XSS 面
		 * （我们渲染的是模型输出，属于不可信文本）。
		 *
		 * @param {{text: string, rich?: boolean}} props
		 *        rich = true 时额外处理列表与行内标记（追问用），
		 *        否则保持原来的「只切代码块」行为（解释正文用，它本来就是结构化字段）。
		 */
		function CodeOrText({ text, rich = false }) {
			if (!text) return null
			const m = text.match(/```([\w+-]*)\n?([\s\S]*?)```/)
			if (!m) return rich ? h('div', null, renderInlineBlocks(text)) : h('div', null, text)
			const before = text.slice(0, m.index).trim()
			const after = text.slice(m.index + m[0].length).trim()
			return h(
				'div',
				null,
				before ? h('div', { style: { marginBottom: 6 } }, rich ? renderInlineBlocks(before) : before) : null,
				h('pre', { className: 'tl-code' }, m[2].replace(/\n$/, '')),
				after ? h('div', { style: { marginTop: 6 } }, rich ? renderInlineBlocks(after) : after) : null,
			)
		}

		/**
		 * 把一段纯文本按行渲染：`- ` 开头的行变成列表项，其余是段落。
		 * 行内 `code` 与 **粗体** 也处理掉。
		 */
		function renderInlineBlocks(text) {
			const lines = String(text).split('\n')
			const out = []
			let list = null
			const flush = () => {
				if (list) {
					out.push(h('ul', { key: `ul-${out.length}`, className: 'tl-md-list' }, list))
					list = null
				}
			}
			for (const raw of lines) {
				const line = raw.trimEnd()
				const bullet = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/)
				if (bullet) {
					list = list ?? []
					list.push(h('li', { key: `li-${out.length}-${list.length}` }, renderInline(bullet[1])))
					continue
				}
				flush()
				if (!line.trim()) continue
				out.push(h('p', { key: `p-${out.length}`, className: 'tl-md-p' }, renderInline(line)))
			}
			flush()
			return out
		}

		/** 行内标记：**粗体** 与 `代码`。用 React 元素拼，不用 innerHTML（避免注入）。 */
		function renderInline(text) {
			const parts = []
			const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
			let last = 0
			let m
			let i = 0
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) parts.push(text.slice(last, m.index))
				const tok = m[0]
				if (tok.startsWith('**')) parts.push(h('strong', { key: `b${i++}` }, tok.slice(2, -2)))
				else parts.push(h('code', { key: `c${i++}`, className: 'tl-md-code' }, tok.slice(1, -1)))
				last = m.index + tok.length
			}
			if (last < text.length) parts.push(text.slice(last))
			return parts.length ? parts : [text]
		}

		function Badge({ kind, value, children }) {
			return h('span', { className: 'tl-badge', 'data-kind': kind, 'data-conf': value }, children)
		}

		/* ── 图标 ──────────────────────────────────────────────────────
		   自己画内联 SVG,不依赖 @deepseek-ai/dsh-client-ui-primitives 的图标导出:
		   那个包的 lib/client.js 在桌面版 asar 里不存在,靠它容易踩空,
		   而且它的图标名一改我们就跟着坏。内联 SVG 完全可控。
		   尺寸用 1em 跟随字号,颜色用 currentColor 跟随主题。 */

		/** 放大镜 —— 用于设置导航与右栏的 logo */
		function SearchIcon({ size = '1em' }) {
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('circle', { cx: 11, cy: 11, r: 7 }),
				h('path', { d: 'M20 20l-3.6-3.6' }),
			)
		}

		/**
		 * 图钉 —— 「固定到右侧栏」按钮。
		 *
		 * 之前这里用的是字形 `⧉`，但它在很多字体里渲染成一个不起眼的小方框，
		 * 用户根本认不出那是「固定」（实测反馈：以为按钮不存在）。改成明确的
		 * 图钉图形；用普通描边而不是 evenodd 填充，保证各浏览器渲染一致。
		 */
		function PinIcon({ size = '1em' }) {
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('path', { d: 'M12 17v5' }),
				h('path', { d: 'M9 3h6' }),
				h('path', { d: 'M10 3v6l-2 3v1h8v-1l-2-3V3' }),
			)
		}

		/** 历史记录 —— 列表图标，用于打开侧边栏看查过的词 */
		function HistoryIcon({ size = '1em' }) {
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('path', { d: 'M4 6h16' }),
				h('path', { d: 'M4 12h16' }),
				h('path', { d: 'M4 18h10' }),
			)
		}

		/** 垃圾桶 —— 删除历史条目 */
		function TrashIcon({ size = '1em' }) {
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('path', { d: 'M4 7h16' }),
				h('path', { d: 'M10 4h4' }),
				h('path', { d: 'M6 7l1 13h10l1-13' }),
				h('path', { d: 'M10 11v6' }),
				h('path', { d: 'M14 11v6' }),
			)
		}

		/** 关闭 —— 用描边叉号，比字形 ✕ 在各字体下更一致 */
		function CloseIcon({ size = '1em' }) {			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('path', { d: 'M6 6l12 12' }),
				h('path', { d: 'M18 6L6 18' }),
			)
		}

		/**
		 * 解释本体。只负责「把一份解释画出来」,定位/拖动/关闭等外层行为由外壳决定
		 * —— 浮窗和侧栏因此能共用同一份展示逻辑。
		 *
		 * error / hint 由宿主翻译好传来（见 routes.js 的 explainOllamaFailure）：
		 * 裸的 `connect ECONNREFUSED` 对第一次装插件的人毫无意义，
		 * 所以错误信息 + 该怎么做要成对显示。
		 */
		function ExplanationBody({ exp, streaming, webPhase, error, hint, webNote, onChain, onOpenSettings }) {
			if (error) {
				return h(
					'div',
					{ className: 'tl-errbox' },
					h('div', { className: 'tl-err' }, error),
					hint ? h('div', { className: 'tl-errhint' }, hint) : null,
					onOpenSettings ? h('button', { className: 'tl-btn', onClick: onOpenSettings }, '打开设置') : null,
				)
			}
			if (streaming && !exp) {
				return h('div', { className: 'tl-empty' }, webPhase ? '正在联网搜索…' : '正在生成解释…')
			}
			if (!exp) return null

			const placeholder = !exp.oneLine && streaming
			return h(
				React.Fragment,
				null,
				// 联网失败的提示：解释照常显示，但要明确告诉用户「刚才那次联网没成功、为什么」，
				// 否则点了「联网重查」的人只会以为按钮坏了。
				webNote ? h('div', { className: 'tl-webnote' }, webNote) : null,
				h('p', { className: `tl-oneline${streaming ? ' tl-caret' : ''}` }, exp.oneLine || (placeholder ? '' : '（无内容）')),
				exp.inContext
					? h(
							'div',
							{ className: 'tl-section' },
							h('div', { className: 'tl-section-title' }, '在这个语境里'),
							h('div', { className: 'tl-context' }, exp.inContext),
						)
					: null,
				exp.bullets?.length
					? h(
							'div',
							{ className: 'tl-section' },
							h('div', { className: 'tl-section-title' }, '要点'),
							h(
								'ul',
								{ className: 'tl-list' },
								exp.bullets.map((b, i) => h('li', { key: i }, b)),
							),
						)
					: null,
				exp.pitfalls?.length
					? h(
							'div',
							{ className: 'tl-section' },
							h('div', { className: 'tl-section-title' }, '容易搞错'),
							h(
								'ul',
								{ className: 'tl-list' },
								exp.pitfalls.map((b, i) => h('li', { key: i, className: 'tl-pitfall' }, b)),
							),
						)
					: null,
				exp.example ? h('div', { className: 'tl-section' }, h(CodeOrText, { text: exp.example })) : null,
				exp.related?.length
					? h(
							'div',
							{ className: 'tl-section' },
							h('div', { className: 'tl-section-title' }, '相关术语'),
							h(
								'div',
								{ className: 'tl-related' },
								exp.related.map((r, i) =>
									h(
										'button',
										{
											key: i,
											className: 'tl-related-chip',
											title: r.why || '',
											onClick: () => onChain?.(r.term),
										},
										r.term,
										r.why ? h('span', { style: { opacity: 0.5 } }, ` · ${r.why}`) : null,
									),
								),
							),
						)
					: null,
			)
		}

		/* ══ 解释请求的驱动器 ═══════════════════════════════════════════ */

		/** 一个实例同一时刻只跑一个请求,新的会中止旧的。 */
		function createExplainRunner() {
			let inflight = null
			return {
				async run(req, handlers) {
					if (inflight) {
						try {
							inflight.abort()
						} catch {
							/* ignore */
						}
					}
					const controller = new AbortController()
					inflight = controller
					let raw = ''
					try {
						await explain(
							{
								term: req.term,
								context: req.context ?? '',
								scene: req.scene ?? 'chat',
								model: req.model || undefined,
								web: req.web === true,
								refresh: req.refresh === true,
							},
							{
								signal: controller.signal,
								onMeta: handlers.onMeta,
								onWebStart: handlers.onWebStart,
								onWebDone: handlers.onWebDone,
								onWebError: handlers.onWebError,
								onDelta: (text) => {
									raw = text
									handlers.onDelta?.(optimisticParse(raw, req.term))
								},
								onDone: (payload) => {
									handlers.onDone?.(payload.explanation ?? optimisticParse(raw, req.term), payload)
								},
							},
						)
					} catch (err) {
						if (err?.name === 'AbortError') return
						// 宿主在 SSE error 事件里带上了 hint/kind（见 explainOllamaFailure）。
						// 挂在 error 对象上往下传，调用方才能把「怎么办」一起显示出来。
						handlers.onError?.(String(err?.message ?? err), err?.hint ?? '', err?.kind ?? '')
					} finally {
						if (inflight === controller) inflight = null
					}
				},
				cancel() {
					try {
						inflight?.abort()
					} catch {
						/* ignore */
					}
					inflight = null
				},
			}
		}

		/**
		 * 继续对话（追问）。
		 *
		 * 一次解释不一定够。看完卡片常有后续疑问（「那它和 X 有什么区别」
		 * 「在这个项目里怎么用」），而「重新生成」只会得到同一份解释，
		 * 所以这里提供真正的多轮问答。
		 *
		 * 输入框用 textarea 而不是 input：追问经常会写几行（贴一段代码问
		 * 「这里为什么这么写」），单行 input 用起来很难受。
		 * Enter 发送、Shift+Enter 换行 —— 与主流聊天框一致。
		 */
		function FollowUp({ state, onAsk, disabled }) {
			const [draft, setDraft] = React.useState('')
			const listRef = React.useRef(null)
			const messages = Array.isArray(state?.messages) ? state.messages : []
			const asking = state?.asking === true

			// 新消息进来时滚到底部，否则边生成边看会看不到最新内容
			React.useEffect(() => {
				const el = listRef.current
				if (el) el.scrollTop = el.scrollHeight
			}, [messages.length, asking, messages[messages.length - 1]?.content])

			const send = () => {
				const q = draft.trim()
				if (!q || asking || disabled) return
				setDraft('')
				onAsk(q)
			}
			const onKeyDown = (e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault()
					send()
				}
				// 别让 Esc 冒泡到卡片（那是「关闭卡片」）
				if (e.key === 'Escape') e.stopPropagation()
			}

			return h(
				'div',
				{ className: 'tl-ask' },
				messages.length
					? h(
							'div',
							{ className: 'tl-ask-list', ref: listRef },
							messages.map((m, i) =>
								h(
									'div',
									{ key: i, className: 'tl-ask-msg', 'data-role': m.role },
									m.role === 'user'
										? h('div', { className: 'tl-ask-q' }, m.content)
										: m.content
											? h('div', { className: 'tl-ask-a' }, h(CodeOrText, { text: m.content, rich: true }))
											: h('div', { className: 'tl-ask-pending' }, '思考中…'),
								),
							),
						)
					: null,
				state?.askError ? h('div', { className: 'tl-err tl-ask-err' }, `追问失败：${state.askError}`) : null,
				h(
					'div',
					{ className: 'tl-ask-input' },
					h('textarea', {
						className: 'tl-ask-area',
						rows: 1,
						placeholder: asking ? '正在回答…' : '继续问，例如「它和限流什么区别」',
						value: draft,
						disabled: asking || disabled,
						onChange: (e) => setDraft(e.target.value),
						onKeyDown,
					}),
					h(
						'button',
						{
							className: 'tl-btn',
							onClick: send,
							disabled: asking || disabled || !draft.trim(),
							title: '发送 (Enter)',
						},
						asking ? '…' : '问',
					),
				),
			)
		}

		/* ══ 浮窗外壳 ═══════════════════════════════════════════════════ */
		function FloatingCard({ card, state, models, model, onClose, onPin, onHistory, onChat, onWeb, onRetry, onChain, onAsk, onOpenSettings, allowDrag }) {
			const elRef = React.useRef(null)
			const dragRef = React.useRef(null)
			const [pos, setPos] = React.useState(() => store.getJson(POS_KEY, null))
			/** 用户拖拽边缘定下的尺寸；null = 用 CSS 默认宽度、高度自适应内容 */
			const [size, setSize] = React.useState(() => readSavedSize())
			const [ready, setReady] = React.useState(false)

			// 首次渲染后测尺寸再定位,避免闪到屏幕外。之后由用户拖动决定位置。
			React.useEffect(() => {
				const el = elRef.current
				if (!el) return
				const rect = el.getBoundingClientRect()
				const w = size?.w || rect.width || 384
				const ht = size?.h || rect.height || 220
				if (!pos) {
					const anchor = card.anchor ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
					let x = anchor.x
					let y = anchor.y + 10
					if (x + w > window.innerWidth - 10) x = window.innerWidth - w - 10
					if (x < 10) x = 10
					if (y + ht > window.innerHeight - 10) {
						// 下方放不下就翻到选区上方
						const above = (anchor.yTop ?? anchor.y) - ht - 10
						y = above > 10 ? above : Math.max(10, window.innerHeight - ht - 10)
					}
					setPos({ x, y: clampCardY(y, ht) })
				}
				setReady(true)
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [])

			React.useEffect(() => {
				const onKey = (e) => {
					if (e.key === 'Escape') onClose()
				}
				window.addEventListener('keydown', onKey)
				return () => window.removeEventListener('keydown', onKey)
			}, [onClose])

			const onHeadDown = (e) => {
				if (!allowDrag) return
				if (e.target.closest?.('.tl-iconbtn') || e.target.closest?.('.tl-btn')) return
				const el = elRef.current
				if (!el) return
				const rect = el.getBoundingClientRect()
				dragRef.current = { offX: e.clientX - rect.left, offY: e.clientY - rect.top, w: rect.width }
				e.preventDefault()
				const move = (ev) => {
					const d = dragRef.current
					const x = Math.min(Math.max(4, ev.clientX - d.offX), window.innerWidth - d.w - 4)
					const y = Math.min(Math.max(4, ev.clientY - d.offY), window.innerHeight - 40)
					setPos({ x, y })
				}
				const up = () => {
					window.removeEventListener('mousemove', move)
					window.removeEventListener('mouseup', up)
					setPos((p) => {
						store.setJson(POS_KEY, p)
						return p
					})
				}
				window.addEventListener('mousemove', move)
				window.addEventListener('mouseup', up)
			}

			/** 从一个把手开始拖拽改尺寸。 */
			const onResizeDown = (edge) => (e) => {
				const el = elRef.current
				if (!el) return
				const rect = el.getBoundingClientRect()
				const start = { w: rect.width, h: rect.height, x: rect.left, y: rect.top }
				// 第一次拖拽时高度还是「自适应内容」，取实测值作为起点
				beginResize(edge, e, start, (next) => {
					setSize({ w: next.w, h: next.h })
					setPos({ x: next.x, y: next.y })
				}, (next) => {
					setSize({ w: next.w, h: next.h })
					setPos({ x: next.x, y: next.y })
					store.setJson(SIZE_KEY, { w: next.w, h: next.h })
					store.setJson(POS_KEY, { x: next.x, y: next.y })
				})
			}

			const style = {
				position: 'fixed',
				zIndex: 2147483001,
				...(ready && pos ? { left: `${pos.x}px`, top: `${pos.y}px` } : { left: '-9999px', top: 0 }),
				...(size
					? // 用户拖过：用他定下的尺寸（maxHeight 必须清掉，否则旧上限会盖住它）
						{ width: `${size.w}px`, height: `${size.h}px`, maxHeight: 'none' }
					: // 用户没拖过：宽度用 CSS 默认、高度完全随内容 ——
						// 这就是「一开始显示全部内容」。只在内容真的比视口还高时
						// 才封顶，那时才需要内部滚动。
						{ maxHeight: '92vh' }),
			}

			return h(
				'div',
				{ ref: elRef, id: CARD_ID, className: 'tl-card tl-surface', 'data-pinned': state.pinned ? '1' : '0', style, onMouseDown: (e) => e.stopPropagation() },
				h(
					'div',
					{ className: 'tl-card-head', onMouseDown: onHeadDown },
					h(
						'span',
						{ className: 'tl-term' },
						card.term,
						state.explanation?.reading ? h('span', { className: 'tl-reading' }, state.explanation.reading) : null,
					),
					state.streaming
						? null
						: state.explanation?.confidence
							? h(Badge, { value: state.explanation.confidence }, state.explanation.confidence)
							: null,
					state.cached ? h(Badge, { kind: 'cached' }, '缓存') : null,
					state.viaWeb ? h(Badge, { kind: 'web' }, '联网') : null,
					// 历史侧边栏：和浮卡并列的功能，看这次会话查过什么
					h(
						'button',
						{
							className: 'tl-iconbtn',
							title: '历史记录（侧边栏）· Alt+H',
							'aria-label': '历史记录',
							onClick: onHistory,
						},
						h(HistoryIcon, { size: 15 }),
					),
					// 固定在页面上（再点一次取消）
					h(
						'button',
						{
							className: 'tl-iconbtn',
							'data-on': state.pinned ? '1' : '0',
							title: state.pinned ? '取消固定（现在点外部不会关闭）' : '固定在页面上（点外部也不关闭）',
							'aria-label': '固定在页面上',
							'aria-pressed': state.pinned ? 'true' : 'false',
							onClick: onPin,
						},
						h(PinIcon, { size: 15 }),
					),
					h(
						'button',
						{ className: 'tl-iconbtn', title: '关闭 (Esc)', 'aria-label': '关闭', onClick: onClose },
						h(CloseIcon, { size: 15 }),
					),
				),
				h(
					'div',
					{ className: 'tl-body' },
					h(ExplanationBody, {
						exp: state.explanation,
						streaming: state.streaming,
						webPhase: state.webPhase,
						webNote: state.webNote,
						error: state.error,
						hint: state.errorHint,
						onChain,
						onOpenSettings,
					}),
				),
				h(
					'div',
					{ className: 'tl-foot' },
					state.streaming
						? h('span', { className: 'tl-streaming' }, state.webPhase ? '联网中…' : '生成中…')
						: h(
								React.Fragment,
								null,
								h('button', { className: 'tl-btn', onClick: onChat, disabled: !state.explanation?.oneLine }, '发进对话'),
								h('button', { className: 'tl-btn', onClick: onWeb, disabled: state.streaming }, '联网重查'),
								h('button', { className: 'tl-btn', onClick: onRetry, disabled: state.streaming }, '重新生成'),
							),
					h('span', { className: 'tl-spacer' }),
					// 底部只放「对这份解释做什么」的动作。
					// 固定与历史属于窗口级操作，统一收在右上角 —— 底部再放一份
					// 只是重复，还会把这一行挤满。
					// （模型选择器同理已移除，换模型在设置里。）
				),
				h(FollowUp, { state, onAsk, disabled: state.streaming }),
				// 拖拽把手：贴边透明，鼠标移上去才显形。放最后以免盖住内容。
				...RESIZE_HANDLES.map((hd) =>
					h('div', {
						key: hd.edge,
						className: 'tl-resize',
						'data-edge': hd.edge,
						title: '拖动调整大小',
						style: { ...hd.style },
						onMouseDown: onResizeDown(hd.edge),
					}),
				),
			)
		}

		/* ══ 侧栏/兜底面板的内容 ════════════════════════════════════════ */

		/**
		 * 历史侧边栏的正文。
		 *
		 * 这里和浮卡的分工不同：浮卡管「当前这个词的完整解释」，
		 * 侧栏管「这次会话查过什么」——所以历史列表是主体，放最上面；
		 * 下面跟着当前这条的详情。
		 */
		function PanelContent({ state, entries, onPick, onChain, onChat, onWeb, onRetry, onDelete, onClearAll }) {
			const current = state?.term ?? null
			return h(
				'div',
				{ className: 'tl-pane' },
				// —— 历史列表（主体）——
				//
				// 性能注意：这里只渲染「词 + 一句话」这种最轻的内容。
				// 之前把完整的 ExplanationBody 也塞在这个面板里，它不仅是最重的一块
				// （长正文 + 代码块），还会随 store 每次变化重渲染，
				// 表现就是「点历史条目卡顿、有时候双击都没反应」。已移除。
				entries?.length
					? h(
							'div',
							null,
							h(
								'div',
								{ className: 'tl-pane-listhead' },
								h('span', { className: 'tl-section-title' }, `本次会话查过的词 · ${entries.length}`),
								h(
									'button',
									{ className: 'tl-btn tl-btn-quiet', onClick: onClearAll, title: '清空全部历史' },
									'清空',
								),
							),
							h(
								'div',
								{ className: 'tl-history-list' },
								entries.map((row, i) =>
									// 一行是「主按钮 + 删除按钮」两个兄弟节点。
									// 不能把删除按钮嵌进主按钮里 —— <button> 里套 <button> 是非法 HTML，
									// 浏览器的行为不可预测。
									h(
										'div',
										{
											key: `${row.term}-${i}`,
											className: 'tl-history-row',
											'data-current': row.term === current ? '1' : '0',
										},
										h(
											'button',
											{
												className: 'tl-history-item',
												title: '点一下看这条解释',
												onClick: () => onPick(row.term),
											},
											h('div', { className: 'tl-history-term' }, row.term),
											h('div', { className: 'tl-history-line' }, row.oneLine || ''),
										),
										h(
											'button',
											{
												className: 'tl-iconbtn tl-history-del',
												title: `删除「${row.term}」`,
												'aria-label': `删除 ${row.term}`,
												onClick: () => onDelete(row.term),
											},
											h(TrashIcon, { size: 13 }),
										),
									),
								),
							),
						)
					: h('div', { className: 'tl-empty' }, '还没有记录。选中对话或代码里的术语，点浮出的「解释」即可。'),
				// 这里刻意**不显示**当前术语的详情。
				//
				// 之前放了一份完整的 ExplanationBody，问题有两个：
				//   1. 用户的诉求是「看历史」，详情属于当前弹窗，重复一份很吵
				//   2. 它是这个面板里最重的一块（长正文 + 代码块），
				//      而且随 store 每次变化重渲染 —— 点历史条目时明显卡顿
				// 想看某个词的详情，点列表里那一条即可（会把解释渲染到浮卡上）。
			)
		}

		/* ══ 设置页（settings.section）══════════════════════════════════ */

		/**
		 * 内置风格档位。
		 *
		 * 与宿主 lib/prompt.js 的 STYLE_HINT 一一对应 —— 那里是真正生效的提示词，
		 * 这里只是给设置页显示的名字。改提示词时两边要一起看：
		 * 只改这边的文案不会影响模型行为。
		 */
		const BUILTIN_STYLES = [
			{ id: 'concise', label: '精简回答 —— 一两句话说清' },
			{ id: 'standard', label: '标准回答 —— 完整卡片' },
			{ id: 'deep', label: '详细回答 —— 含原理与对比' },
		]

		/**
		 * 一级设置页:与壁纸引擎并列在设置面板左侧导航里。
		 *
		 * 数据面是宿主自己的 /term-lens/config(落在 ~/.dsh-term-lens/config.json),
		 * 不走 DSH 的 configForms —— 那是「Host 设置文档」通道,需要插件占用一个
		 * Host Config 条目;而本插件的配置本来就是自己管的文件,直接读写更简单,
		 * 也不污染 profile。
		 */
		function SettingsSection() {
			const [cfg, setCfg] = React.useState(null)
			const [models, setModels] = React.useState([])
			const [status, setStatus] = React.useState(null)
			const [dirty, setDirty] = React.useState(false)
			const [saving, setSaving] = React.useState(false)
			const [msg, setMsg] = React.useState(null)
			/** 自建风格的草稿：{ name, hint } */
			const [newStyle, setNewStyle] = React.useState({ name: '', hint: '' })

			const reload = React.useCallback(async () => {
				try {
					// /status 才有 Ollama 健康、缓存统计与文件路径;/config 只给配置本身。
					// 两者都要,状态行与表单才都完整。
					const [cfgRes, modelsRes, statusRes] = await Promise.all([
						getConfig(),
						getModels().catch(() => ({ models: [] })),
						getStatus().catch(() => null),
					])
					setCfg(cfgRes.config)
					setModels(modelsRes.models ?? [])
					setStatus(statusRes)
				} catch (err) {
					setMsg({ kind: 'err', text: `读取配置失败: ${err.message}` })
				}
			}, [])

			React.useEffect(() => {
				reload()
			}, [reload])

			/** 局部改一个字段。深路径用点号。 */
			const patch = (path, value) => {
				setCfg((prev) => {
					const next = structuredClone(prev)
					const parts = path.split('.')
					let cur = next
					for (const p of parts.slice(0, -1)) cur = cur[p]
					cur[parts[parts.length - 1]] = value
					return next
				})
				setDirty(true)
				setMsg(null)
			}

			/** 一次性改多个字段（自建风格的增删要同时动 styles 和 style）。 */
			const patchAll = (entries) => {
				setCfg((prev) => {
					const next = structuredClone(prev)
					for (const [path, value] of Object.entries(entries)) {
						const parts = path.split('.')
						let cur = next
						for (const p of parts.slice(0, -1)) cur = cur[p]
						cur[parts[parts.length - 1]] = value
					}
					return next
				})
				setDirty(true)
				setMsg(null)
			}

			const onSave = async () => {
				setSaving(true)
				setMsg(null)
				try {
					const res = await saveConfig(cfg)
					setCfg(res.config)
					setDirty(false)
					// 宿主会把「被丢弃 / 被钳制」的字段回传（见 routes.js 的 mergeConfig）。
					// 有的话必须说出来 —— 否则用户填了个非法值，界面提示「已保存」、
					// 值却悄悄变回旧的，只能靠猜。
					const ignored = Array.isArray(res.ignored) ? res.ignored : []
					if (ignored.length > 0) {
						const lines = ignored.map((i) => `· ${i.path}：${i.reason}`).join('\n')
						setMsg({
							kind: 'err',
							text: `${ignored.length} 项没能按你填的保存，其余已保存：\n${lines}`,
						})
					} else {
						setMsg({ kind: 'ok', text: '已保存。触发类设置立即生效,其余下一次查询生效。' })
					}
				} catch (err) {
					setMsg({ kind: 'err', text: err.message })
				} finally {
					setSaving(false)
				}
			}

			const onClearCache = async () => {
				try {
					const res = await clearCache()
					setMsg({ kind: 'ok', text: `已清空 ${res.removed} 条缓存` })
					// 重新读状态,让上面的缓存条数立刻反映清空结果
					setStatus(await getStatus().catch(() => status))
				} catch (err) {
					setMsg({ kind: 'err', text: err.message })
				}
			}

			if (!cfg) {
				return h('div', { className: 'tl-set' }, h('p', { className: 'tl-set-sub' }, msg?.text ?? '正在读取配置…'))
			}

			const Field = ({ label, hint, children }) =>
				h('div', { className: 'tl-set-field' }, h('label', { className: 'tl-set-label' }, label), children, hint ? h('div', { className: 'tl-set-hint' }, hint) : null)

			const Check = ({ path, label, hint }) =>
				h(
					'div',
					{ className: 'tl-set-row' },
					h('input', {
						className: 'tl-set-check',
						type: 'checkbox',
						checked: !!get(cfg, path),
						onChange: (e) => patch(path, e.target.checked),
					}),
					h('label', { className: 'tl-set-rowlabel', onClick: () => patch(path, !get(cfg, path)) }, label),
					hint ? h('span', { className: 'tl-set-hint' }, hint) : null,
				)

			const ollamaOk = status?.ollama?.ok === true
			// modelReady 为 null = 查不到（比如刚启动），这时不下结论、不报警
			const modelReadyOk = status?.readiness?.modelReady !== false

			return h(
				'div',
				{ className: 'tl-set' },
				h('h2', { className: 'tl-set-h' }, '术语透镜'),
				h('p', { className: 'tl-set-sub' }, '选中术语即用本地模型解释。配置存在 ~/.dsh-term-lens/config.json,与 DSH 的 profile 设置互不干扰。'),

				// —— 运行状态 ——
				//
				// 分三种情况显示，因为「该怎么做」完全不同：
				//   连不上 → 没装或没启动，给安装/启动命令
				//   连上了但缺模型 → 给 pull 命令
				//   都就绪 → 一行状态
				h(
					'div',
					{ className: 'tl-set-status' },
					h('span', { className: 'tl-set-dot', 'data-ok': ollamaOk && modelReadyOk ? '1' : '0' }),
					h(
						'span',
						null,
						!ollamaOk
							? `连不上 Ollama（${cfg.ollama.baseURL}）`
							: modelReadyOk
								? `Ollama 就绪 (v${status.ollama.version ?? '?'})`
								: `Ollama 就绪，但缺少模型「${status?.readiness?.wantedModel ?? cfg.ollama.model}」`,
					),
					h('span', { className: 'tl-set-hint' }, `· 缓存 ${status?.cache?.count ?? 0} 条 / ${formatBytes(status?.cache?.bytes ?? 0)}`),
				),
				// 数据目录不可用：插件仍然能用（选中照样能解释），但配置/缓存/历史都存不下来。
				// 宿主已经带着问题把插件拉起来了，这里必须把原因显示出来，
				// 否则用户只会看到「设置改了不生效、历史永远是空的」。
				status?.storage && status.storage.ok === false
					? h(
							'div',
							{ className: 'tl-set-hint tl-set-fix' },
							`数据目录不可写：${status.storage.root}\n${status.storage.error ?? ''}\n` +
								'插件会继续工作，但配置、缓存、查词历史都无法保存。检查该目录的权限，或用环境变量 DSH_TERM_LENS_HOME 换一个可写的目录。',
						)
					: null,
				!ollamaOk
					? h(
							'div',
							{ className: 'tl-set-hint tl-set-fix' },
							'请先安装并启动 Ollama：\n' +
								'1. 到 https://ollama.com 下载安装（没装的话）\n' +
								'2. 在终端执行 `ollama serve`\n' +
								'弄好后点下面的「重新读取」。',
						)
					: modelReadyOk
						? null
						: h(
								'div',
								{ className: 'tl-set-hint tl-set-fix' },
								`这个模型还没下载。在终端执行：\n\`${status?.readiness?.pullCommand ?? `ollama pull ${cfg.ollama.model}`}\`\n` +
									(status?.readiness?.installedModels?.length
										? `本机已有：${status.readiness.installedModels.join('、')} —— 也可以直接在下面换成其中一个。`
										: ''),
							),

				// —— 模型 ——
				h('div', { className: 'tl-set-sep' }),
				Field({
					label: '解释用的本地模型',
					hint: models.length
						? '列表来自本机 Ollama。4B 够快，8B 更准但明显更慢。换模型只在这里 —— 浮卡上不再放切换器，那是低频操作。'
						: '读不到模型列表 —— 确认 ollama serve 在跑。',
					children: h(
						'select',
						{ className: 'tl-set-select', value: cfg.ollama.model, onChange: (e) => patch('ollama.model', e.target.value) },
						// 当前配置的模型可能不在列表里(比如还没 pull),也让它显示出来
						[...new Set([cfg.ollama.model, ...models.map((m) => m.name)])].filter(Boolean).map((name) =>
							h('option', { key: name, value: name }, name),
						),
					),
				}),
				Field({
					label: 'Ollama 地址',
					hint: '默认 http://127.0.0.1:11434',
					children: h('input', {
						className: 'tl-set-input',
						type: 'text',
						value: cfg.ollama.baseURL,
						onChange: (e) => patch('ollama.baseURL', e.target.value),
					}),
				}),
				h(
					'div',
					{ className: 'tl-set-grid' },
					Field({
						label: '模型驻留时长',
						hint: 'keep_alive,避免每次查询重新加载',
						children: h('input', {
							className: 'tl-set-input',
							type: 'text',
							value: cfg.ollama.keepAlive,
							onChange: (e) => patch('ollama.keepAlive', e.target.value),
						}),
					}),
					Field({
						label: '温度',
						hint: '越低越稳定,术语解释建议 0~0.3',
						children: h('input', {
							className: 'tl-set-input',
							type: 'number',
							step: '0.1',
							min: '0',
							max: '2',
							value: cfg.ollama.temperature,
							onChange: (e) => patch('ollama.temperature', Number(e.target.value)),
						}),
					}),
				),
				Check({ path: 'ollama.think', label: '启用模型的思考链', hint: '关掉可显著降低首字延迟' }),

				// —— 触发 ——
				h('div', { className: 'tl-set-sep' }),
				h('div', { className: 'tl-set-label' }, '触发方式'),
				Check({ path: 'trigger.showFloatingChip', label: '选中后在文本旁浮出「解释」按钮', hint: '关掉后只能靠快捷键触发' }),
				Check({ path: 'trigger.autoOpenCard', label: '选中后立刻开始解释（不等点击）', hint: '默认关闭:随手选中(复制/定位)时不该白跑一次模型' }),
				Field({
					label: '按钮位置',
					hint: '相对选区',
					children: h(
						'select',
						{ className: 'tl-set-select', value: cfg.trigger.chipPlacement ?? 'above', onChange: (e) => patch('trigger.chipPlacement', e.target.value) },
						h('option', { value: 'above' }, '选区上方（默认，不遮住下一行）'),
						h('option', { value: 'below' }, '选区下方'),
					),
				}),
				h(
					'div',
					{ className: 'tl-set-grid' },
					Field({
						label: '快捷键',
						hint: '留空则只用浮出按钮',
						children: h('input', {
							className: 'tl-set-input',
							type: 'text',
							placeholder: 'Ctrl+Shift+E',
							value: cfg.trigger.shortcut ?? '',
							onChange: (e) => patch('trigger.shortcut', e.target.value),
						}),
					}),
					Field({
						label: '选词长度上限',
						hint: '超过就不触发,避免选中整段代码',
						children: h('input', {
							className: 'tl-set-input',
							type: 'number',
							min: '10',
							max: '400',
							value: cfg.trigger.maxLength,
							onChange: (e) => patch('trigger.maxLength', Number(e.target.value)),
						}),
					}),
				),

				// —— 联网 ——
				h('div', { className: 'tl-set-sep' }),
				Field({
					label: '联网搜索降级',
					hint: '本地模型 confidence 低时,自动联网补充;搜索结果仍由本地模型综述',
					children: h(
						'select',
						{ className: 'tl-set-select', value: cfg.web.mode, onChange: (e) => patch('web.mode', e.target.value) },
						h('option', { value: 'auto' }, 'auto —— 置信度低时自动联网'),
						h('option', { value: 'manual' }, 'manual —— 只在点「联网重查」时'),
						h('option', { value: 'off' }, 'off —— 完全不用联网'),
					),
				}),
				Field({
					label: '搜索后端',
					hint:
						'auto 会同时问一个国际后端和一个国内后端，谁先给出可用结果就用谁。' +
						'国内网络下 DuckDuckGo 通常连不上；百度/搜狗连续查几次会要求人机验证。' +
						'想完全避开第三方就把上面那项设为 off。',
					children: h(
						'select',
						{ className: 'tl-set-select', value: cfg.web.engine ?? 'auto', onChange: (e) => patch('web.engine', e.target.value) },
						h('option', { value: 'auto' }, 'auto —— DuckDuckGo + 360搜索（推荐）'),
						h('option', { value: 'duckduckgo' }, 'DuckDuckGo —— 国际网络下最完整'),
						h('option', { value: 'so360' }, '360搜索 —— 国内实测最稳'),
						h('option', { value: 'bing' }, 'Bing'),
						h('option', { value: 'baidu' }, '百度 —— 相关性好，但很快要验证'),
						h('option', { value: 'sogou' }, '搜狗'),
					),
				}),

				// —— 解释风格 ——
				h('div', { className: 'tl-set-sep' }),
				h(
					'div',
					{ className: 'tl-set-grid' },
					Field({
						label: '解释风格（测试中）',
						hint: '只影响解释卡片与「联网重查」，不影响追问。内置三档，外加你在下面自建的风格。',
						children: h(
							'select',
							{ className: 'tl-set-select', value: cfg.prompt.style, onChange: (e) => patch('prompt.style', e.target.value) },
							BUILTIN_STYLES.map((s) => h('option', { key: s.id, value: s.id }, s.label)),
							// 自建风格用 optgroup 分出来，一眼能看出哪些是自己加的
							(cfg.prompt.styles ?? []).length
								? h(
										'optgroup',
										{ label: '自建风格' },
										(cfg.prompt.styles ?? []).map((s) => h('option', { key: s.name, value: s.name }, s.name)),
									)
								: null,
						),
					}),
					Field({
						label: '解释语言',
						children: h(
							'select',
							{ className: 'tl-set-select', value: cfg.prompt.language, onChange: (e) => patch('prompt.language', e.target.value) },
							h('option', { value: 'zh-CN' }, '简体中文'),
							h('option', { value: 'zh-TW' }, '繁體中文'),
							h('option', { value: 'en' }, 'English'),
							h('option', { value: 'ja' }, '日本語'),
						),
					}),
				),
				// —— 自建风格 ——
				h(
					'div',
					{ className: 'tl-set-field' },
					h('label', { className: 'tl-set-label' }, '自建风格'),
					h(
						'div',
						{ className: 'tl-set-hint' },
						'给一套偏好起个名字，之后就能在上面的下拉里直接切换。例子：名字「精简回答」+ 要求「一两句话说清，不要要点列表」。',
					),
					(cfg.prompt.styles ?? []).length
						? h(
								'div',
								{ className: 'tl-set-styles' },
								(cfg.prompt.styles ?? []).map((s, i) =>
									h(
										'div',
										{ key: `${s.name}-${i}`, className: 'tl-set-style-row' },
										h('div', { className: 'tl-set-style-name' }, s.name),
										h('div', { className: 'tl-set-style-hint' }, s.hint),
										h(
											'button',
											{
												className: 'tl-iconbtn',
												title: `删除风格「${s.name}」`,
												'aria-label': `删除风格 ${s.name}`,
												onClick: () => {
													const next = (cfg.prompt.styles ?? []).filter((_, j) => j !== i)
													// 正在用的风格被删掉 → 顺手切回标准档，避免留下一个悬空的名字
													if (cfg.prompt.style === s.name) patchAll({ 'prompt.styles': next, 'prompt.style': 'standard' })
													else patch('prompt.styles', next)
												},
											},
											h(TrashIcon, { size: 13 }),
										),
									),
								),
							)
						: null,
					h(
						'div',
						{ className: 'tl-set-style-add' },
						h('input', {
							className: 'tl-set-input',
							type: 'text',
							placeholder: '风格名字，如「精简回答」',
							value: newStyle.name,
							onChange: (e) => setNewStyle({ ...newStyle, name: e.target.value }),
						}),
						h('textarea', {
							className: 'tl-set-area',
							rows: 2,
							placeholder: '这套风格的具体要求，如「只给一两句话，不要要点列表，不要代码」',
							value: newStyle.hint,
							onChange: (e) => setNewStyle({ ...newStyle, hint: e.target.value }),
						}),
						h(
							'button',
							{
								className: 'tl-btn',
								disabled: !newStyle.name.trim() || !newStyle.hint.trim(),
								onClick: () => {
									const name = newStyle.name.trim()
									const hint = newStyle.hint.trim()
									if (!name || !hint) return
									const existing = (cfg.prompt.styles ?? []).filter((s) => s.name !== name)
									patchAll({
										'prompt.styles': [...existing, { name, hint }],
										'prompt.style': name, // 新建即启用，省一步
									})
									setNewStyle({ name: '', hint: '' })
								},
							},
							'保存并启用',
						),
					),
				),
				Field({
					label: '自定义要求',
					hint: '追加到提示词末尾,例如「多举 Java 的例子」。对所有风格都生效；只影响某一套偏好请用下面的「自建风格」',
					children: h('textarea', {
						className: 'tl-set-area',
						placeholder: '留空则不加',
						value: cfg.prompt.customSystem ?? '',
						onChange: (e) => patch('prompt.customSystem', e.target.value || null),
					}),
				}),
				Check({ path: 'prompt.followUp', label: '允许在浮卡里继续追问', hint: '追问不走缓存，每次都要真实推理；慢机器上可以关掉' }),

				// —— 缓存 ——
				h('div', { className: 'tl-set-sep' }),
				Check({ path: 'cache.enabled', label: '启用磁盘缓存', hint: '同一个词第二次选中零延迟' }),
				Field({
					label: '缓存条目上限',
					hint: '超出后按最久未用淘汰',
					children: h('input', {
						className: 'tl-set-input',
						type: 'number',
						min: '10',
						max: '100000',
						value: cfg.cache.maxEntries,
						onChange: (e) => patch('cache.maxEntries', Number(e.target.value)),
					}),
				}),

				// —— 操作 ——
				h(
					'div',
					{ className: 'tl-set-actions' },
					h('button', { className: 'tl-set-primary', onClick: onSave, disabled: !dirty || saving }, saving ? '保存中…' : dirty ? '保存' : '已保存'),
					h(
						'button',
						{
							className: 'tl-btn',
							onClick: () => {
								setDirty(false)
								setMsg(null)
								reload()
							},
						},
						'放弃修改',
					),
					h('button', { className: 'tl-btn', onClick: onClearCache }, '清空缓存'),
					h('button', { className: 'tl-btn', onClick: reload }, '重新读取'),
					h('span', { className: 'tl-set-spacer tl-spacer' }),
					msg ? h('span', { className: 'tl-set-msg', 'data-kind': msg.kind }, msg.text) : null,
				),

				// —— API 接入（占位，尚未开放填写）——
				//
				// 刻意做成 disabled +「（开发中）」而不是先放一个能填但没用的输入框：
				// 能填却无效的字段比明确说「还没做」更让人困惑，也更容易被当成 bug 上报。
				h('div', { className: 'tl-set-sep' }),
				h('div', { className: 'tl-set-label' }, 'API 接入（开发中）'),
				h(
					'div',
					{ className: 'tl-set-row' },
					h('input', {
						className: 'tl-set-input',
						type: 'text',
						disabled: true,
						readOnly: true,
						placeholder: '暂不可填写 —— 开发中',
						'aria-disabled': 'true',
					}),
				),
				h(
					'div',
					{ className: 'tl-set-hint' },
					'计划支持「云端模型 / 第三方 API 兜底」：本地模型不认识某个词、或本机没装 Ollama 时改走 API。目前只能用本地 Ollama，这一项还不能配置。',
				),

				// —— 文件位置 ——
				h('div', { className: 'tl-set-sep' }),
				h('div', { className: 'tl-set-label' }, '文件位置'),
				h('div', { className: 'tl-set-code' }, `配置: ${status?.paths?.config ?? '—'}`),
				h('div', { className: 'tl-set-code' }, `缓存: ${status?.paths?.cache ?? '—'}`),
				h('div', { className: 'tl-set-hint' }, '也可以直接编辑该文件,改完重启 DSH 生效。'),
			)
		}

		/** 读深路径,缺失返回 undefined。 */
		function get(obj, path) {
			return path.split('.').reduce((acc, p) => (acc == null ? undefined : acc[p]), obj)
		}

		function formatBytes(n) {
			if (!n) return '0 B'
			if (n < 1024) return `${n} B`
			if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
			return `${(n / 1024 / 1024).toFixed(1)} MB`
		}

		/* ══ 挂载 ═══════════════════════════════════════════════════════ */

		/**
		 * 安全取一个宿主服务。
		 *
		 * ⚠️ 客户端的 `ctx` 是**受限上下文**（实测 Object.keys 只给出 1 个键），
		 * 直接读 `ctx.slots` 会抛：
		 *     cannot get property "slots" without inject
		 *
		 * 这正是「设置入口一直不出现」的根因 —— registerSlots() 在第一步探测服务
		 * 时就抛了，后面全部没执行，而且异步块当时没有 catch，错误被静默吞掉。
		 *
		 * 正确姿势是 `ctx.get(name)`。DSH 第一方文档明写：
		 *   "Prefer ctx.get(name) with an undefined check; use inject only for
		 *    hard dependencies."
		 *
		 * 取不到就返回 undefined，由调用方退化处理（我们本来就有兜底侧板）。
		 */
		function service(ctx, name) {
			try {
				if (ctx && typeof ctx.get === 'function') return ctx.get(name)
			} catch {
				/* 受限上下文可能连 get 都不给 */
			}
			try {
				return ctx ? ctx[name] : undefined
			} catch {
				/* 直接读属性在受限上下文里会抛，吞掉 */
			}
			return undefined
		}

		/**
		 * 宿主上下文。
		 *
		 * 模块级的组件（如 FloatingCard / ExplanationBody）拿不到 mount() 的局部变量，
		 * 但它们需要 `ctx.get(...)` 取服务。所以 mount() 时把它记在这里。
		 */
		let hostCtx = null

		/**
		 * 打开 DSH 的设置面板。
		 *
		 * DSH 把「打开设置」做成了一条**命令** `settings.open`（由 ui-settings-general
		 * 注册，默认键位 Ctrl+,），命令注册表提供 `ctx.shortcuts.invoke(id, context)`
		 * 来「与键位无关地」触发它。context 需要 target / region / modal 三个字段，
		 * 构造方式对照 DSH 自己的 installNativeKeyboard。
		 *
		 * 用在错误卡片上：没装 Ollama 时用户需要去设置页换模型或看状态，
		 * 与其让他自己找入口，不如直接给一个按钮。
		 *
		 * @returns {boolean} 是否成功把打开请求交出去
		 */
		function openSettingsPanel() {
			try {
				const shortcuts = hostCtx ? service(hostCtx, 'shortcuts') : null
				if (!shortcuts || typeof shortcuts.invoke !== 'function') {
					reportPhase('settings-open:no-service', 'shortcuts.invoke 不可用')
					return false
				}
				const target = document.activeElement ?? null
				const region = target?.closest?.('.xterm')
					? 'terminal'
					: target?.matches?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
						? 'editable'
						: 'page'
				const tops = document.querySelectorAll('[data-shortcut-modal]')
				const top = tops.length ? tops[tops.length - 1] : null
				const modal = top?.dataset?.shortcutModal ?? null
				shortcuts.invoke('settings.open', { target, region, modal })
				reportPhase('settings-open:invoked', `region=${region} modal=${modal}`)
				return true
			} catch (err) {
				reportPhase('settings-open:threw', err?.message ?? String(err))
				return false
			}
		}

		/** 安全读对象键（ctx 可能是代理，读取本身可能抛）。 */
		function safeKeys(obj, limit = 60) {
			try {
				return Object.keys(obj).filter((k) => !k.startsWith('_')).slice(0, limit)
			} catch {
				return []
			}
		}

		/**
		 * 启动阶段回执。
		 *
		 * 为什么需要：Desktop 版看不到浏览器 console，所以「apply 到底跑到哪一步」
		 * 一直只能靠猜 —— 而我已经因此绕了好几轮弯路。这个函数让客户端把每一步
		 * 如实报回宿主（异步 XHR，不阻塞、不抛错）。
		 *
		 * 最后一条 phase 就是它走到的地方；如果中途崩了，那条之后就不会再有新的。
		 */
		function reportPhase(phase, detail) {
			try {
				const u = `${API}/client-ping?phase=${encodeURIComponent(`client:${phase}`)}&detail=${encodeURIComponent(String(detail ?? '').slice(0, 240))}`
				const x = new XMLHttpRequest()
				x.open('GET', u, true)
				x.send(null)
			} catch {
				/* 回执失败绝不能影响主功能 */
			}
		}

		/**
		 * 客户端侧的全部接线。返回 disposer。
		 *
		 * 用「清理登记表」而不是长串 removeEventListener:任何一步失败都能整体回卷,
		 * 不会留下半截 DOM。
		 */
		function mount(ctx) {
			// 模块级组件要取服务，见 hostCtx 的说明
			hostCtx = ctx
			const cleanup = []
			const onCleanup = (fn) => cleanup.push(fn)
			const runAll = () => {
				for (const fn of cleanup.splice(0).reverse()) {
					try {
						fn()
					} catch (err) {
						warn('清理失败', err)
					}
				}
			}

			reportPhase('mount:start', `build=${CLIENT_BUILD}`)

			try {
				ensureStyles()
				onCleanup(removeStyles)

				/* —— 请求驱动器与浮出按钮的宿主 ——
				   这两个必须最先建立:后面的 hideChip / closeCard / CardMount 都会引用它们,
				   声明顺序错了就会踩暂时性死区(而且只在运行时才炸)。 */
				const runner = createExplainRunner()
				/** 追问用的中止控制器：关卡片 / 换词时要掐掉，否则答案会落到别的卡片上 */
				let askController = new AbortController()

				const chipHost = document.createElement('div')
				chipHost.id = CHIP_ID
				chipHost.setAttribute('data-shown', '0')
				chipHost.innerHTML = '<span>⌕</span><span>解释</span>'
				chipHost.style.display = 'none'
				document.body.appendChild(chipHost)
				onCleanup(() => chipHost.remove())

				/* —— 触发参数:先用默认值,拿到宿主配置后再覆盖 —— */
				let trigger = {
					minLength: 2,
					maxLength: 80,
					showFloatingChip: true,
					autoOpenCard: false,
					chipPlacement: 'above',
					shortcut: 'Ctrl+Shift+E',
				}
				/**
				 * 追问开关。
				 *
				 * 单独一个变量，不塞进 `trigger` —— 它属于 prompt 配置
				 * （`prompt.followUp`），塞进 trigger 就会出现「设置写 prompt、
				 * 客户端读 trigger」这种键名对不上的 bug（已经犯过一次：
				 * 结果追问被永久拒绝，提示「未在设置开启」）。
				 *
				 * 默认 true，与 config.js 的 DEFAULT_CONFIG 保持一致。
				 */
				let followUpEnabled = true

				/* —— 状态 —— */
				let state = {
					chip: null,
					card: null,
					models: [],
					model: store.get(MODEL_KEY, null),
					entries: store.getJson(HISTORY_KEY, []),
				}
				const listeners = new Set()
				const emit = () => {
					for (const l of [...listeners]) {
						try {
							l()
						} catch (err) {
							warn('订阅者失败', err)
						}
					}
				}
				const setState = (patch) => {
					state = { ...state, ...patch }
					emit()
				}

				/**
				 * 刚被用户关掉的那个词 + 关掉的时刻。
				 *
				 * 关掉卡片后,浏览器往往还会补一次 mouseup / selectionchange,
				 * 于是同一个词立刻又被重新解释一遍 —— 表现就是「关都关不掉」。
				 * 记下它,短时间内不再自动触发。
				 *
				 * ⚠️ **必须有时效。** 这个抑制原先没有过期条件，结果是
				 * 「一旦关掉某个词的卡片，那个词就再也浮不出解释按钮」——
				 * 反复检索同一个词时按钮不出现，就是这个 bug。
				 * 用户关掉卡片之后重新选中同一个词，意图是明确的：他就是要再看一次。
				 * 所以只挡住紧跟其后的那次杂散事件，不挡下一次主动选中。
				 */
				let dismissedTerm = null
				let dismissedAt = 0
				/** 够长以吸收关卡片引发的杂散事件，够短以不挡用户的下一次主动操作 */
				const DISMISS_SUPPRESS_MS = 900
				/**
				 * 上一次的选区词。
				 *
				 * 声明在这里而不是「选区监听」那一节：closeCard() 要清它，
				 * 而 closeCard 在上面的声明区就被定义 —— 声明放太晚会在运行时
				 * 踩暂时性死区（`let` 在声明语句执行前访问会抛 ReferenceError）。
				 */
				let lastTerm = ''

				/** 收起浮出的按钮。chipHost 声明在后面,但这些函数只在运行时调用,闭包没问题。 */
				function hideChip() {
					chipHost.setAttribute('data-shown', '0')
					chipHost.style.display = 'none'
					if (state.chip) setState({ chip: null })
				}

				/** 关闭卡片:中止在跑的请求,收起按钮,并短时抑制同一个词重开。 */
				function closeCard() {
					runner.cancel()
					// 追问也要掐掉：不掐的话答案会继续流回来，
					// 落到下一张卡片上（换词之后尤其明显）
					try {
						askController.abort()
					} catch {
						/* ignore */
					}
					dismissedTerm = state.card?.term ?? null
					dismissedAt = Date.now()
					// 清掉「上一次的选区」记忆：否则同一个词重新选中时会被
					// unchanged 判定挡住，按钮还是不出现。
					lastTerm = null
					setState({ card: null, chip: null })
					chipHost.setAttribute('data-shown', '0')
					chipHost.style.display = 'none'
				}

				/**
				 * 把当前浮卡钉在页面上（再点一次取消）。
				 *
				 * 固定的含义是「不被点击外部关掉」：
				 * 普通浮卡在点外面就收起，方便随手查词；但用户可能想把某个解释
				 * 留在屏幕上对照着看 —— 那就固定它，直到自己按 ✕。
				 */
				function togglePinCard() {
					if (!state.card) return
					const next = !state.card.pinned
					dismissedTerm = null
					setState({ card: { ...state.card, pinned: next } })
					reportPhase(next ? 'pin:on' : 'pin:off', `term=${state.card.term}`)
					toast(next ? '已固定，点 ✕ 才会关闭' : '已取消固定，点外部即可关闭')
				}

				/**
				 * 打开/关闭历史侧边栏。
				 *
				 * 这是与浮卡**并列**的功能，不是兜底：浮卡负责「当前这个词」，
				 * 侧栏负责「这次会话查过什么」——可回看、可重查。
				 */
				function toggleHistoryPanel() {
					if (panelHost) {
						closePanel()
						return
					}
					reportPhase('history:open', `entries=${state.entries?.length ?? 0}`)
					openPanel()
				}
				function useStore() {
					const [, force] = React.useReducer((x) => x + 1, 0)
					React.useEffect(() => {
						listeners.add(force)
						return () => listeners.delete(force)
					}, [])
					return state
				}

				/* —— ② 浮卡容器 —— */
				const cardHost = document.createElement('div')
				document.body.appendChild(cardHost)
				const cardRoot = ReactDOM.createRoot(cardHost)
				onCleanup(() => {
					try {
						cardRoot.unmount()
					} catch {
						/* ignore */
					}
					cardHost.remove()
				})

				/* —— ③ 历史侧边栏 ——
				   与浮卡**并列**的功能：浮卡管「当前这个词」，侧栏管「这次会话查过什么」。
				   自带实现而不是依赖原生右栏，因为原生 `openTab` 在会话未 adopt 时会
				   静默失败（实测过），而历史记录是常用功能，不能时灵时不灵。

				   它贴在窗口右缘，而 DSH 自己的会话 header 控件也在右上角，所以
				   顶部让开一段。 */
				const PANEL_TOP_OFFSET = 46
				let panelHost = null
				let panelRoot = null
				function closePanel() {
					try {
						panelRoot?.unmount()
					} catch {
						/* ignore */
					}
					panelRoot = null
					panelHost?.remove()
					panelHost = null
				}
				onCleanup(closePanel)

				function openPanel() {
					closePanel()
					panelHost = document.createElement('div')
					panelHost.id = PANEL_ID
					// 用 DSH 自己的侧栏填充色与菜单模糊,和右栏视觉一致
					Object.assign(panelHost.style, {
						position: 'fixed',
						// 让开 DSH 会话 header / 窗口控制按钮所在的那一条
						top: `${PANEL_TOP_OFFSET}px`,
						right: '0',
						bottom: '0',
						width: '360px',
						zIndex: '2147482999',
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
						background: 'var(--dsw-specific-sidebar-fill, rgba(30,30,30,.78))',
						backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(16px))',
						WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(16px))',
						color: 'var(--dsw-alias-label-primary, #ededed)',
						borderLeft: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-border-l1, rgba(255,255,255,.14)))',
						boxShadow: 'var(--dsw-elevation-prominent, -8px 0 24px rgba(0,0,0,.28))',
						font: '400 13px/1.6 var(--dsw-font-family, system-ui, sans-serif)',
					})
					document.body.appendChild(panelHost)
					panelRoot = ReactDOM.createRoot(panelHost)
					panelRoot.render(h(PanelMount))
				}

				function PanelMount() {
					const s = useStore()
					return h(
						'div',
						{ className: 'tl-panel' },
						// 标题行：关闭按钮放最右，不和 DSH 右上角的控件抢位置
						h(
							'div',
							{ className: 'tl-panel-head' },
							h('span', { className: 'tl-panel-title' }, '历史记录'),
							h('span', { className: 'tl-panel-sub' }, s.entries?.length ? `${s.entries.length} 条` : ''),
							h(
								'button',
								{ className: 'tl-iconbtn', onClick: closePanel, title: '关闭 (Esc)', 'aria-label': '关闭' },
								h(CloseIcon, { size: 15 }),
							),
						),
						h(
							'div',
							{ className: 'tl-panel-body' },
							h(PanelContent, {
								state: s.card,
								entries: s.entries,
								onPick: (term) => requestExplain(term, { context: '', scene: 'chat', force: true }),
								onChain: (term) => requestExplain(term, { context: '', scene: 'chat', force: true }),
								onChat: () => sendToChat(s.card),
								onWeb: () => requestExplain(s.card?.term, { ...(s.card ?? {}), web: true, refresh: true }),
								onRetry: () => requestExplain(s.card?.term, { ...(s.card ?? {}), refresh: true }),
								onDelete: (term) => deleteHistory(term),
								onClearAll: () => deleteHistory(),
							}),
						),
						h(
							'div',
							{ className: 'tl-panel-foot' },
							h('span', { className: 'tl-panel-hint' }, '选中术语即可继续查询 · Alt+H 开关本面板'),
						),
					)
				}

				/* —— ④ 浮卡挂载 —— */
				function CardMount() {
					const s = useStore()
					if (!s.card) return null
					return h(FloatingCard, {
						card: s.card,
						state: s.card,
						models: s.models,
						model: s.model,
						allowDrag: true,
						onClose: closeCard,
						onChat: () => sendToChat(s.card),
						onWeb: () => requestExplain(s.card.term, { ...s.card, web: true, refresh: true }),
						onRetry: () => requestExplain(s.card.term, { ...s.card, refresh: true }),
						onChain: (t) => requestExplain(t, { context: '', scene: 'chat', force: true }),
						onPin: togglePinCard,
						onHistory: toggleHistoryPanel,
						onAsk: (q) => askFollowUp(s.card, q),
						onOpenSettings: openSettingsPanel,
					})
				}
				cardRoot.render(h(CardMount))

				/* —— ⑤ 发起一次解释 —— */
				/**
				 * 用户显式要求解释（点了按钮 / 按了快捷键）。
				 * 会解除「刚关掉」的抑制 —— 同一个词,用户再点就是要再看一次。
				 */
				function showCard(term, opts = {}) {
					dismissedTerm = null
					requestExplain(term, opts)
				}

				/**
				 * 内部触发路径（如「选中后立刻解释」）。
				 * 受 dismissedTerm 抑制:用户关掉之后,选区没换就不该再自己弹出来。
				 */
				function requestExplain(term, opts = {}) {
					if (!term) return
					if (term === dismissedTerm) return
					// 换词/重查时掐掉还在跑的追问，并换一个全新的控制器 ——
					// 旧控制器一旦 abort 就永久失效，不换的话后续追问会立刻被取消。
					try {
						askController.abort()
					} catch {
						/* ignore */
					}
					askController = new AbortController()
					// 「重新生成 / 联网重查」不该把已固定的窗口变回未固定
					const keepPinned = state.card?.pinned === true && state.card?.term === term
					setState({
						card: {
							term,
							context: opts.context ?? '',
							scene: opts.scene ?? 'chat',
							explanation: null,
							streaming: true,
							error: null,
							cached: false,
							viaWeb: false,
							webPhase: false,
							webNote: null,
							pinned: keepPinned,
							anchor: { x: opts.x ?? window.innerWidth / 2, y: opts.y ?? 120, yTop: opts.yTop },
						},
					})
					runner.run(
						{
							term,
							context: opts.context ?? '',
							scene: opts.scene ?? 'chat',
							model: state.model || undefined,
							web: opts.web === true,
							refresh: opts.refresh === true || opts.force === true,
						},
						{
							onMeta: (m) => setState({ card: { ...state.card, cached: !!m.cached, viaWeb: !!m.viaWeb } }),
							onWebStart: () => setState({ card: { ...state.card, webPhase: true, webNote: null } }),
							onWebDone: () => setState({ card: { ...state.card, webPhase: false } }),
							// 联网失败：把宿主编好的原因直接写在卡片上。
							// 只记进 console 是不够的 —— Desktop 版根本看不到 console。
							onWebError: (payload) =>
								setState({
									card: {
										...state.card,
										webPhase: false,
										viaWeb: false,
										webNote: payload?.message ?? '联网搜索没有拿到资料。',
									},
								}),
							onDelta: (partial) => setState({ card: { ...state.card, explanation: partial } }),
							onDone: (exp, payload) => {
								const key = exp.term || term
								const entries = [
									{
										term: key,
										oneLine: exp.oneLine,
										confidence: exp.confidence,
										at: new Date().toISOString(),
										viaWeb: !!payload?.viaWeb,
									},
									...state.entries.filter((r) => r.term !== key),
								].slice(0, 60)
								store.setJson(HISTORY_KEY, entries)
								setState({
									card: { ...state.card, explanation: exp, streaming: false, cached: !!payload?.cached, viaWeb: !!payload?.viaWeb },
									entries,
								})
							},
							onError: (message, hint) =>
								setState({ card: { ...state.card, streaming: false, error: message, errorHint: hint } }),
						},
					)
				}

				/**
				 * 追问：围绕当前术语继续对话。
				 *
				 * 为什么要这个功能：一次解释不一定够。看完卡片可能还有疑问
				 * （「那它和 X 有什么区别」「在这个项目里怎么用」），点「重新生成」
				 * 只会得到同一份解释，所以需要真正的多轮问答。
				 *
				 * 状态放在 card.messages 里（每条 { role, content }），
				 * 这样它跟着卡片一起被固定、被关闭、被重新渲染。
				 */
				async function askFollowUp(card, question) {
					const term = card?.term
					const q = String(question ?? '').trim()
					if (!term || !q || card?.asking) return
					if (!followUpEnabled) {
						toast('追问已在设置里关闭（设置 → 术语透镜 → 允许在浮卡里继续追问）')
						reportPhase('ask:disabled-by-config')
						return
					}

					// 先乐观地把这一问放进列表，用户立刻能看到自己问了什么
					const priorMessages = Array.isArray(card.messages) ? card.messages : []
					const historyTurns = priorMessages.map((m) => ({ role: m.role, content: m.content }))
					setState({
						card: {
							...card,
							messages: [...priorMessages, { role: 'user', content: q }, { role: 'assistant', content: '' }],
							asking: true,
							askError: null,
						},
					})
					reportPhase('ask:start', `term=${term}`)

					try {
						await askQuestion(
							{
								term,
								context: card.context ?? '',
								explanation: card.explanation ?? null,
								history: historyTurns,
								question: q,
								model: state.model || undefined,
							},
							{
								signal: askController.signal,
								onDelta: (partial) => {
									// 覆盖最后那条 assistant 占位
									const cur = state.card
									if (!cur?.messages?.length) return
									const next = cur.messages.slice()
									next[next.length - 1] = { role: 'assistant', content: partial }
									setState({ card: { ...cur, messages: next } })
								},
								onDone: (payload) => {
									const cur = state.card
									if (!cur?.messages?.length) return
									const next = cur.messages.slice()
									next[next.length - 1] = { role: 'assistant', content: payload.answer ?? '' }
									setState({ card: { ...cur, messages: next, asking: false } })
									reportPhase('ask:done', `elapsed=${payload.elapsedMs ?? '?'}ms`)
								},
							},
						)
					} catch (err) {
						if (askController.signal.aborted) return
						reportPhase('ask:failed', err?.message ?? String(err))
						const cur = state.card
						if (!cur) return
						// 把失败的占位去掉，错误挂在提问上
						const next = (cur.messages ?? []).slice()
						if (next.length && next[next.length - 1].role === 'assistant' && !next[next.length - 1].content) next.pop()
						setState({ card: { ...cur, messages: next, asking: false, askError: err?.message ?? String(err) } })
					}
				}

				/**
				 * 删除历史。
				 *
				 * 本地 localStorage 与宿主的历史文件都要删 —— 只删一边会出现
				 * 「刷新之后删掉的词又回来了」。两边都以 term 为键。
				 *
				 * @param {string} [term] 省略则清空全部
				 */
				async function deleteHistory(term) {
					const before = state.entries ?? []
					const next = term ? before.filter((r) => (r?.term ?? '') !== term) : []
					setState({ entries: next })
					store.setJson(HISTORY_KEY, next)
					reportPhase('history:delete', term ? `term=${term}` : 'all')
					try {
						await fetch(`${API}/history?sessionId=${encodeURIComponent(currentSessionId())}`, {
							method: 'DELETE',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(term ? { term } : {}),
						})
					} catch (err) {
						// 宿主侧删失败不回滚本地：下次重新解释时会重新写入，
						// 比「点了删除却什么都没发生」要好
						warn('宿主侧历史删除失败', err)
					}
					toast(term ? `已删除「${term}」` : '已清空历史')
				}

				/* —— ⑥ 发进对话:走剪贴板，不碰 composer —— */				async function sendToChat(card) {
					const exp = card?.explanation
					if (!exp) return
					const md = [
						`## ${exp.term || card.term}`,
						exp.reading ? `*${exp.reading}*` : '',
						'',
						exp.oneLine,
						exp.inContext ? `\n**在这个语境里**：${exp.inContext}` : '',
						exp.bullets?.length ? `\n**要点**\n${exp.bullets.map((b) => `- ${b}`).join('\n')}` : '',
						exp.pitfalls?.length ? `\n**容易搞错**\n${exp.pitfalls.map((b) => `- ${b}`).join('\n')}` : '',
						exp.example ? `\n\`\`\`\n${exp.example}\n\`\`\`` : '',
					]
						.filter(Boolean)
						.join('\n')
					try {
						await navigator.clipboard.writeText(md)
						toast('解释已复制到剪贴板,在输入框里粘贴即可 (Ctrl+V)')
					} catch (err) {
						warn('剪贴板不可用', err)
						copyFallback(md)
					}
				}

				function copyFallback(text) {
					try {
						const ta = document.createElement('textarea')
						ta.value = text
						ta.style.cssText = 'position:fixed;left:-9999px;top:0'
						document.body.appendChild(ta)
						ta.select()
						document.execCommand('copy')
						ta.remove()
						toast('解释已复制到剪贴板,在输入框里粘贴即可')
					} catch (err) {
						warn('复制兜底也失败', err)
						toast('无法访问剪贴板,请手动复制')
					}
				}

				/* —— ⑦ 在原生右栏打开我们的 tab（可选路径）——
				   浮卡上的「历史」按钮走的是自带侧栏面板（一定可用）；
				   这个函数留给需要把解释放进原生右栏的场景。 */
				/**
				 * 请求在原生右栏打开我们的 tab。
				 *
				 * `openTab(kind, options)` 内部是 `this.require()` + `placeTab(...)`，
				 * 会话没被 adopt 时它会**静默返回**（既不抛错也不打开）。所以：
				 *   - 服务缺失 → 明确报原因
				 *   - 调用成功 → 如实上报（这时仍可能什么都没显示，那是宿主侧的状态问题）
				 *
				 * @returns {{ok: boolean, reason: string}}
				 */
				function openSidebarTab(term) {
					const svc = service(ctx, 'sidebarRight')
					if (!svc || typeof svc.openTab !== 'function') {
						return { ok: false, reason: `no-sidebarRight(${typeof svc})` }
					}
					try {
						svc.openTab(TAB_KIND, { params: { term, focus: Date.now() } })
						return { ok: true, reason: 'called' }
					} catch (err) {
						// 真抛错说明 kind 没注册 / 会话未 adopt / 参数不合法
						return { ok: false, reason: `openTab-threw: ${err?.message ?? err}` }
					}
				}
				void openSidebarTab

				/* —— ⑧ 插槽注册:设置页 + 右栏 tab —— */
				/**
				 * 这里刻意用运行时特性探测而不是顶层 `inject:[...]` 硬依赖。
				 *
				 * 插件的硬依赖会让 fiber 一直等,只要宿主少了任何一个,整个插件(包括
				 * 「选中即解释」这个主功能)就完全不工作。而设置页和侧栏都只是附加能力,
				 * 缺失时退化掉就行。
				 *
				 * 两处注册都走 slots.inject:插槽是「父级渲染时才存在」的,
				 * 直接 register 到未声明的插槽会 throw。
				 *   - settings.section 由 sidebar.settings 的条目声明
				 *   - sidebar.right.pane.tab 在该 tab 类型被打开时才被声明
				 *
				 * 每一步的结果都记进 diag 并回传 —— Desktop 版看不到浏览器 console,
				 * 这是唯一能回答「为什么设置页没出现」的通道。
				 */
				function probeContext() {
					const report = { clientBuild: CLIENT_BUILD, keys: null, checks: {}, errors: [] }
					// ctx 上到底挂了哪些服务。这对判断「宿主有没有这个能力」至关重要。
					try {
						report.keys = Object.keys(ctx).filter((k) => !k.startsWith('_')).sort()
					} catch (err) {
						report.errors.push(`读 ctx 键失败: ${err.message}`)
					}
					const probe = (name, service, method) => {
						let present = false
						let hasMethod = null
						try {
							present = !!service
							hasMethod = present && typeof service[method] === 'function'
						} catch (err) {
							report.errors.push(`探测 ${name} 失败: ${err.message}`)
						}
						report.checks[name] = { present, hasMethod }
					}
					probe('slots', service(ctx, 'slots'), 'register')
					probe('slots.inject', service(ctx, 'slots'), 'inject')
					probe('sidebarRight', service(ctx, 'sidebarRight'), 'openTab')
					probe('sidebarRightTabs', service(ctx, 'sidebarRightTabs'), 'register')
					probe('shortcuts', service(ctx, 'shortcuts'), 'invoke')
					return report
				}

				/** 记录注册结果:回调是否真的跑过、有没有抛错。 */
				const slotReport = { settings: 'pending', sidebarType: null, sidebarBody: 'pending', errors: [] }

				function registerSlots() {
					reportPhase('slots:enter', `ctxKeys=${safeKeys(ctx).length}`)

					let diag
					try {
						diag = probeContext()
						diag.slotReport = slotReport
						// 探针结果也留在 slotReport 里,让它随每次回执都出现 ——
						// 这样「哪个服务缺失」一眼可见,不用翻更早的回执。
						slotReport.services = diag.checks
						slotReport.ctxKeys = diag.keys
						diag.platform = { ua: navigator?.userAgent ?? null, href: location.href }
						diag.trigger = { ...trigger, autoOpenCardDefault: false }
						reportPhase('slots:probed', `slots=${!!service(ctx, 'slots')} sidebarRight=${!!service(ctx, 'sidebarRight')} tabs=${!!service(ctx, 'sidebarRightTabs')}`)
						reportDiag(diag)
						reportPhase('slots:diag-sent')
					} catch (err) {
						reportPhase('slots:probe-threw', err?.message ?? String(err))
					}

					const slots = service(ctx, 'slots')
					if (!slots || typeof slots.register !== 'function') {
						slotReport.settings = 'no-slots-service'
						slotReport.sidebarBody = 'no-slots-service'
						reportPhase('slots:no-service', `typeof slots=${typeof slots}`)
						warn('宿主没有 slots 服务:设置页与右栏都不可用,只保留浮卡与兜底侧板')
						try {
							reportDiag({ slotReport, note: 'no slots service' })
						} catch {
							/* ignore */
						}
						return
					}

					const injectSlot = typeof slots.inject === 'function' ? slots.inject.bind(slots) : null
					reportPhase('slots:inject-available', `inject=${!!injectSlot}`)
					if (!injectSlot) slotReport.errors.push('slots.inject 不存在,改为直接 register（可能 throw）')

					// —— 一级设置页(与壁纸引擎并列在设置面板左侧导航)——
					try {
						reportPhase('slots:settings-begin')
						const d = injectSlot
							? injectSlot('settings.section', () => {
									try {
										slots.register({ name: 'settings.section', id: PKG, order: 560, label: '术语透镜' }, () => h(SettingsSection))
										slotReport.settings = 'registered'
										reportPhase('slots:settings-registered', 'settings.section')
										log('设置页已注册到 Settings')
									} catch (err) {
										slotReport.settings = `threw: ${err.message}`
										slotReport.errors.push(`settings.section: ${err.message}`)
										reportPhase('slots:settings-threw', err?.message)
										warn('设置页注册失败', err)
									}
								})
							: (() => {
									slots.register({ name: 'settings.section', id: PKG, order: 560, label: '术语透镜' }, () => h(SettingsSection))
									slotReport.settings = 'registered-direct'
								})()
						void d
						if (slotReport.settings === 'pending') slotReport.settings = 'waiting-declaration'
						reportPhase('slots:settings-done', slotReport.settings)
					} catch (err) {
						slotReport.settings = `inject-threw: ${err.message}`
						slotReport.errors.push(`settings.section inject: ${err.message}`)
						reportPhase('slots:settings-inject-threw', err?.message)
						warn('设置页 inject 失败', err)
					}

					// —— 右栏 tab 类型 ——
					try {
						const tabs = service(ctx, 'sidebarRightTabs')
						if (tabs && typeof tabs.register === 'function') {
							tabs.register({
								id: PKG,
								kind: TAB_KIND,
								priority: 'extension',
								title: () => '术语透镜',
								// icon 是一个 React 组件（对照 ui-sidebar-terminal 的
								// `icon: PluginArtworkTerminal`）。不注册时引导页会用
								// 一个更浅的立方体占位符 —— 那就是我们要换掉的默认图标。
								guide: [{ id: `${PKG}-guide`, title: '术语透镜', description: '选中术语即可查', icon: SearchIcon }],
								keepMounted: true,
							})
							slotReport.sidebarType = 'registered'
						} else {
							slotReport.sidebarType = 'no-service'
						}
					} catch (err) {
						slotReport.sidebarType = `threw: ${err.message}`
						slotReport.errors.push(`sidebarRightTabs: ${err.message}`)
					}

					// —— 右栏 tab 正文 ——
					try {
						const body = () => {
							const s = useStore()
							return h(PanelContent, {
								state: s.card,
								entries: s.entries,
								onPick: (t) => requestExplain(t, { context: '', scene: 'chat', force: true }),
								onChain: (t) => requestExplain(t, { context: '', scene: 'chat', force: true }),
								onChat: () => sendToChat(s.card),
								onWeb: () => requestExplain(s.card?.term, { ...(s.card ?? {}), web: true, refresh: true }),
								onRetry: () => requestExplain(s.card?.term, { ...(s.card ?? {}), refresh: true }),
							})
						}
						const doRegister = () => {
							try {
								slots.register({ name: 'sidebar.right.pane.tab', key: PKG }, body)
								slotReport.sidebarBody = 'registered'
								log('右栏 tab 已注册')
							} catch (err) {
								slotReport.sidebarBody = `threw: ${err.message}`
								slotReport.errors.push(`sidebar.right.pane.tab: ${err.message}`)
								warn('右栏 tab 正文注册失败', err)
							}
						}
						if (injectSlot) {
							injectSlot('sidebar.right.pane.tab', doRegister)
							if (slotReport.sidebarBody === 'pending') slotReport.sidebarBody = 'waiting-declaration'
						} else {
							doRegister()
						}
					} catch (err) {
						slotReport.sidebarBody = `inject-threw: ${err.message}`
						slotReport.errors.push(`sidebar.right.pane.tab inject: ${err.message}`)
					}

					// 稍后再回传一次:此时 inject 的回调（若插槽已声明）应当已经跑过
					setTimeout(() => reportDiag({ slotReport, phase: 'settled' }), 1200)
				}

				/* —— ⑨ 提示条 —— */
				let toastEl = null
				let toastTimer = null
				function toast(message) {
					if (!toastEl) {
						toastEl = document.createElement('div')
						toastEl.id = TOAST_ID
						Object.assign(toastEl.style, {
							position: 'fixed',
							left: '50%',
							bottom: '38px',
							transform: 'translateX(-50%)',
							zIndex: '2147483002',
							padding: '8px 14px',
							borderRadius: '9px',
							background: 'var(--dsw-specific-menu, rgba(40,40,40,.78))',
							backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(16px))',
							WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(16px))',
							color: 'var(--dsw-alias-label-primary,#ededed)',
							border: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-border-l1, rgba(255,255,255,.14)))',
							boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.35))',
							font: '500 12.5px/1.5 var(--dsw-font-family,system-ui,sans-serif)',
							opacity: '0',
							transition: 'opacity .15s ease',
						})
						document.body.appendChild(toastEl)
						onCleanup(() => toastEl?.remove())
					}
					toastEl.textContent = message
					void toastEl.offsetWidth
					toastEl.style.opacity = '1'
					if (toastTimer) clearTimeout(toastTimer)
					toastTimer = setTimeout(() => {
						if (toastEl) toastEl.style.opacity = '0'
					}, 2400)
				}
				onCleanup(() => {
					if (toastTimer) clearTimeout(toastTimer)
				})

				/* —— ⑩ 选区监听 —— */
				let settleTimer = null
				// lastTerm / dismissedTerm / hideChip / closeCard 已在上面声明
				// （它们被前面的代码引用，声明放这里会踩暂时性死区）

				/** 按快捷键触发时用:清掉抑制并收起按钮,然后解释。 */
				function triggerByUser(term, opts) {
					dismissedTerm = null
					dismissedAt = 0
					if (settleTimer) {
						clearTimeout(settleTimer)
						settleTimer = null
					}
					hideChip()
					requestExplain(term, opts)
				}

				function readSelection() {
					const sel = window.getSelection()
					if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
					const range = sel.getRangeAt(0)
					if (!isExplainableNode(range.commonAncestorContainer)) return null
					const term = acceptableTerm(sel.toString(), trigger)
					if (!term) return null
					const rect = range.getBoundingClientRect()
					if (!rect || (rect.width === 0 && rect.height === 0)) return null
					const { context, scene } = contextAround(range)
					return { term, context, scene, x: rect.left + rect.width / 2, y: rect.bottom, yTop: rect.top }
				}

				function onSelectionSettled() {
					// 选中后短暂延迟:等浏览器把 selection 稳定下来(双击选词会走两次)
					if (settleTimer) clearTimeout(settleTimer)
					settleTimer = setTimeout(() => {
						settleTimer = null
						const next = readSelection()
						if (!next) {
							if (state.chip) hideChip()
							return
						}
						const unchanged = next.term === lastTerm && state.chip
						lastTerm = next.term
						if (unchanged) return

						// 刚被关掉的词：只在抑制窗口内挡住。
						//
						// 这条原先没有时效，导致「关过一次的词再也浮不出按钮」。
						// 现在只吸收关卡片紧跟而来的杂散事件；窗口过后用户再选中
						// 同一个词，就正常浮出按钮 —— 「反复检索同一个词」是常见操作。
						if (next.term === dismissedTerm && Date.now() - dismissedAt < DISMISS_SUPPRESS_MS) return

						// 不浮按钮时只有开着「立刻解释」才有意义,否则什么都不做
						if (!trigger.showFloatingChip) {
							if (trigger.autoOpenCard) requestExplain(next.term, next)
							return
						}

						// —— 浮出「解释」按钮 ——
						// 先按测量到的尺寸定位,拿不到就用估算值,避免第一帧跳位
						const cw = chipHost.offsetWidth || 64
						const ch = chipHost.offsetHeight || 24
						const left = Math.min(Math.max(4, next.x - cw / 2), window.innerWidth - cw - 4)
						const above = trigger.chipPlacement !== 'below'
						chipHost.style.left = `${left}px`
						chipHost.style.top = `${above ? Math.max(4, next.yTop - ch - 6) : next.y + 6}px`
						chipHost.style.display = 'flex'
						void chipHost.offsetWidth // 强制 reflow,让过渡生效
						chipHost.setAttribute('data-shown', '1')
						setState({ chip: next })

						// 默认 false:等用户点按钮或按快捷键,不擅自跑模型
						if (trigger.autoOpenCard) requestExplain(next.term, next)
					}, 140)
				}

				const inOwnUi = (target) =>
					chipHost.contains(target) || cardHost.contains(target) || panelHost?.contains(target) === true

				// 点击卡片外部关闭。放在 mousedown 而不是 click:
				// 用户在卡片外按下鼠标时,那一刻的意图就已经确定是「关掉」了。
				//
				// 例外：被**固定**的卡片不关。固定的意思就是「钉在页面上」，
				// 让用户可以对照着它去读别的、去操作别的地方。只有 ✕ 或 Esc 才关它。
				const onDocMouseDown = (e) => {
					if (inOwnUi(e.target)) return
					if (state.card) {
						if (state.card.pinned) {
							hideChip()
							return
						}
						closeCard()
						return
					}
					hideChip()
				}
				const onDocMouseUp = (e) => {
					if (inOwnUi(e.target)) return
					// 卡片开着的时候不要因为选区事件又去读一遍选区
					if (state.card) return
					onSelectionSettled()
				}
				const onKeyUp = (e) => {
					// 键盘选词(Shift+方向键等)
					if (state.card) return
					if (e.shiftKey || e.key === 'Shift') onSelectionSettled()
				}
				const onScroll = () => {
					// 滚动后选区位置失效:收起按钮。但不动已经打开的卡片,用户可能正在读。
					// 卡片被拖到别处后,滚动不该把它关掉。
					if (state.chip) hideChip()
				}

				/** 解析 "Ctrl+Shift+E" 这类快捷键描述 */
				function parseShortcut(spec) {
					const parts = String(spec ?? '')
						.toLowerCase()
						.split('+')
						.map((s) => s.trim())
						.filter(Boolean)
					return {
						ctrl: parts.includes('ctrl') || parts.includes('cmd') || parts.includes('meta'),
						shift: parts.includes('shift'),
						alt: parts.includes('alt'),
						key: parts.find((p) => !['ctrl', 'shift', 'alt', 'meta', 'cmd'].includes(p)) ?? null,
					}
				}

				const onShortcutKey = (e) => {
					const sc = parseShortcut(trigger.shortcut)
					if (!sc.key) return
					// Ctrl 与 Cmd 视为同一个修饰键:同一份配置在 Windows/macOS 都能用
					if ((e.ctrlKey || e.metaKey) !== sc.ctrl) return
					if (e.shiftKey !== sc.shift) return
					if (e.altKey !== sc.alt) return
					if (String(e.key).toLowerCase() !== sc.key) return
					const sel = readSelection()
					if (!sel) {
						toast('先选中一个词,再按快捷键')
						return
					}
					e.preventDefault()
					triggerByUser(sel.term, sel)
				}

				/**
				 * 历史记录的快捷键：Alt+H。
				 *
				 * 为什么需要它：反复查同一个词是常见操作，但光靠「选中 → 按钮」
				 * 这条路有时不顺手（比如想回看之前查过的某个词）。给一个直接
				 * 打开历史面板的入口，就不用再去瞄准那个小图标。
				 *
				 * 选 Alt+H 而不是 Ctrl+H：
				 *   - Ctrl+H 在多数浏览器/Electron 里是「后退」，会被抢走
				 *   - Ctrl+Shift+H 之类容易和其他插件的命令撞车
				 *   - Alt+H 组合在 DSH 里没被占用，且单手可按
				 *
				 * 用 e.code === 'KeyH' 而不是 e.key：后者会受输入法和
				 * 键盘布局影响（中文输入法下 e.key 可能不是 'h'）。
				 */
				const onHistoryKey = (e) => {
					if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
					if (e.code !== 'KeyH') return
					// 正在输入框里打字时不抢：Alt+H 在编辑器里可能是有意义的组合
					const t = e.target
					if (t?.matches?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return
					e.preventDefault()
					reportPhase('history:shortcut', 'Alt+H')
					toggleHistoryPanel()
				}

				chipHost.addEventListener('mousedown', (e) => {
					e.preventDefault() // 保住选区,否则 click 之前选区就没了
					e.stopPropagation()
					const chip = state.chip
					if (!chip) return
					triggerByUser(chip.term, chip)
				})

				document.addEventListener('mouseup', onDocMouseUp, true)
				document.addEventListener('mousedown', onDocMouseDown, true)
				document.addEventListener('keyup', onKeyUp, true)
				document.addEventListener('keydown', onShortcutKey, true)
				document.addEventListener('keydown', onHistoryKey, true)
				window.addEventListener('scroll', onScroll, true)
				window.addEventListener('resize', hideChip)
				onCleanup(() => {
					document.removeEventListener('mouseup', onDocMouseUp, true)
					document.removeEventListener('mousedown', onDocMouseDown, true)
					document.removeEventListener('keyup', onKeyUp, true)
					document.removeEventListener('keydown', onShortcutKey, true)
					document.removeEventListener('keydown', onHistoryKey, true)
					window.removeEventListener('scroll', onScroll, true)
					window.removeEventListener('resize', hideChip)
					runner.cancel()
				})

				/* —— ⑪ 初始化:拉配置、模型列表、侧栏注册 —— */
				;(async () => {
					try {
						reportPhase('init:start', 'fetching /status')
						try {
							const status = await getStatus()
							reportPhase('init:status-ok', `model=${status?.config?.model ?? '?'} ollamaOk=${status?.ollama?.ok}`)
							if (status?.config?.trigger) trigger = { ...trigger, ...status.config.trigger }
							// 注意键名：这一项在配置里属于 prompt.followUp，不在 trigger 里。
							// 只有明确是 false 才关闭；读不到（老宿主 / 请求失败）时保持开启，
							// 否则一个字段缺失就会让功能整个用不了。
							if (status?.config?.followUp === false) followUpEnabled = false
							reportPhase('init:followUp', `enabled=${followUpEnabled}`)
							if (!state.model && status?.config?.model) setState({ model: status.config.model })
							if (status?.ollama && status.ollama.ok === false) {
								warn('Ollama 不可用:', status.ollama.error)
								// 提示要能照做：说清是「没装」还是「没启动」，并给命令
								toast('术语透镜: 连不上 Ollama，请确认已安装并运行 `ollama serve`（详见设置页）')
							} else if (status?.readiness?.modelReady === false) {
								// 装了但没 pull 默认模型 —— 这类问题原先完全没有提示
								warn('默认模型未安装:', status.readiness.wantedModel)
								toast(`术语透镜: 还没 pull 模型「${status.readiness.wantedModel}」，请执行 ${status.readiness.pullCommand}`)
							}
						} catch (err) {
							reportPhase('init:status-failed', err?.message)
							warn('读取状态失败', err)
						}
						try {
							const res = await getModels()
							setState({ models: res.models ?? [] })
							reportPhase('init:models-ok', `count=${(res.models ?? []).length}`)
						} catch (err) {
							reportPhase('init:models-failed', err?.message)
							warn('读取模型列表失败', err)
						}
						reportPhase('init:registering-slots')
						registerSlots()
						reportPhase('init:done', 'async init finished')
					} catch (err) {
						// 这个 catch 以前是缺的 —— 异步块里抛的异常会被 Promise 静默吞掉,
						// 表现就是「init:done 不见了」而完全看不到原因。
						reportPhase('init:threw', err?.message ?? String(err))
						warn('初始化异常', err)
					}
				})()

				reportPhase('mount:done', `shortcut=${trigger.shortcut || '(none)'}`)
				log('已挂载。选中任意术语即可解释;快捷键:', trigger.shortcut || '(未设置)')
				return runAll
			} catch (err) {
				// 挂载中途失败:整体回卷,不留半截 DOM
				reportPhase('mount:threw', err?.message ?? String(err))
				warn('挂载失败,正在回卷', err)
				runAll()
				const noop = () => {}
				// 给 apply 一个标记，让它如实报告「这是失败后的空操作」
				noop.__tlFailed = true
				return noop
			}
		}

		/* ══ 插件契约 ═══════════════════════════════════════════════════ */

		const inject = []

		function apply(ctx) {
			reportPhase('apply:enter', `build=${CLIENT_BUILD} ctxKeys=${safeKeys(ctx).length}`)
			try {
				const d = mount(ctx)
				// mount 内部崩了会返回一个 no-op，并已经报过 mount:threw。
				// 这里如实区分，避免「apply:ok」掩盖了内部的失败。
				reportPhase(d.__tlFailed ? 'apply:noop' : 'apply:ok', 'mount returned')
				return d
			} catch (err) {
				reportPhase('apply:threw', err?.message ?? String(err))
				console.error(LOG, 'apply 失败', err)
				return () => {}
			}
		}

		exports.apply = apply
		exports.inject = inject
		// 必须 return:加载器取 factory 的返回值作为 exports,不读 module.exports
		return module.exports
	},
})
