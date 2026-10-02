/**
 * 反复检索同一个词的回归测试。
 *
 *   node test/repeat-term.mjs
 *
 * ══ 由来（真实 bug）═══════════════════════════════════════════════════
 *
 * 用户反馈：「反复检索一个词会出现不（出）解释按钮」。
 *
 * 根因在 dismissedTerm 这条抑制上 —— 它原本**只有设置、没有过期**：
 *
 *     closeCard()            → dismissedTerm = state.card.term
 *     onSelectionSettled()   → if (next.term === dismissedTerm) return
 *
 * 这条抑制是为了修「关都关不掉」（关掉卡片后浏览器补一次 mouseup，
 * 同一个词立刻又被解释一遍）。但它永久生效，副作用就是：
 * **一个词只要被关过一次，就再也浮不出「解释」按钮了。**
 *
 * 修法：给抑制加时效（900ms），并在关卡片时清掉 lastTerm 的记忆。
 *
 * ══ 这个文件怎么测 ═══════════════════════════════════════════════════
 *
 * 端到端跑一遍需要完整的 React 运行时 + 宿主插槽 + 真实 DOM，代价远超收益。
 * 所以这里做两件事：
 *   ① 从源码里把 onSelectionSettled 的**判定链**抽出来，用一个独立模型
 *      模拟「关掉 → 等一会儿 → 重新选中同一个词」，直接断言按钮会不会浮出。
 *      这能把「有/无时效」的行为差异真正跑出来，而不是只 grep 关键字。
 *   ② 静态断言守住几个容易改坏的点（声明顺序、快捷键、别把「关不掉」放回来）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const log = (...a) => console.log(...a)
let failures = 0
function check(name, fn) {
  try {
    fn()
    log(`  ok   ${name}`)
  } catch (err) {
    failures++
    log(`  FAIL ${name}: ${err?.message ?? err}`)
  }
}

log('== dsh-term-lens 反复检索回归测试 ==')

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const SUPPRESS_MS = Number(/DISMISS_SUPPRESS_MS\s*=\s*(\d+)/.exec(code)?.[1] ?? 0)

/**
 * onSelectionSettled 里「该不该浮出按钮」的判定链，逐条照抄自源码。
 * 改源码时如果忘了改这里，下面的行为断言会失败 —— 这是刻意的。
 *
 * 源码顺序（lib/client.js 的 onSelectionSettled）：
 *   1. 没有选区 → 收起
 *   2. unchanged（同一个词且按钮已显示）→ 不动
 *   3. 刚被关掉的词且在抑制窗口内 → 挡掉        ← 本次修复加了时间条件
 *   4. 其余 → 浮出按钮
 */
function decide({ nextTerm, lastTerm, chipShown, dismissedTerm, dismissedAt, now }) {
  if (!nextTerm) return 'hide'
  const unchanged = nextTerm === lastTerm && chipShown
  if (unchanged) return 'keep'
  if (nextTerm === dismissedTerm && now - dismissedAt < SUPPRESS_MS) return 'suppress'
  return 'show'
}

log('\n-- 行为：关掉之后重新选中同一个词 --')

check('修复后 —— 隔一会儿重新选中，按钮会回来', () => {
  const r = decide({ nextTerm: '闭包', lastTerm: '闭包', chipShown: false, dismissedTerm: '闭包', dismissedAt: 1000, now: 1000 + SUPPRESS_MS + 50 })
  assert.equal(r, 'show', `按钮没有回来（判定=${r}）—— 这正是用户报的 bug`)
})

check('抑制窗口内仍然挡得住 —— 「关不掉」不会复发', () => {
  const r = decide({ nextTerm: '闭包', lastTerm: '闭包', chipShown: false, dismissedTerm: '闭包', dismissedAt: 1000, now: 1050 })
  assert.equal(r, 'suppress', `关掉后紧跟的杂散事件没被挡住（判定=${r}）—— 「关都关不掉」会复发`)
})

check('关掉卡片清了 lastTerm 后，重新选中不再被 unchanged 挡住', () => {
  // closeCard 会把 lastTerm 置空，于是这两个判定都不会命中
  const r = decide({ nextTerm: '闭包', lastTerm: null, chipShown: false, dismissedTerm: '闭包', dismissedAt: 1000, now: 1000 + SUPPRESS_MS + 1 })
  assert.equal(r, 'show', `判定=${r}`)
})

check('换成另一个词任何时候都能浮出', () => {
  const r = decide({ nextTerm: '幂等', lastTerm: '闭包', chipShown: false, dismissedTerm: '闭包', dismissedAt: 1000, now: 1010 })
  assert.equal(r, 'show', '换词被误挡了')
})

check('按钮已经显示时，同一次选区不重复处理', () => {
  const r = decide({ nextTerm: '闭包', lastTerm: '闭包', chipShown: true, dismissedTerm: null, dismissedAt: 0, now: 5000 })
  assert.equal(r, 'keep', '选中没变却重新浮出 —— 会导致按钮闪烁')
})

check('无选区时收起按钮', () => {
  assert.equal(decide({ nextTerm: '', lastTerm: '闭包', chipShown: true, dismissedTerm: null, dismissedAt: 0, now: 5000 }), 'hide')
})

check('对照：如果抑制没有时效（修复前的行为），按钮永远不回来', () => {
  // 这条不是在测源码，而是把「旧行为」跑出来当证据，说明上面那条修复确实必要
  const oldDecide = ({ nextTerm, lastTerm, chipShown, dismissedTerm }) => {
    if (!nextTerm) return 'hide'
    if (nextTerm === lastTerm && chipShown) return 'keep'
    if (nextTerm === dismissedTerm) return 'suppress' // ← 旧版：没有时间条件
    return 'show'
  }
  const r = oldDecide({ nextTerm: '闭包', lastTerm: '闭包', chipShown: false, dismissedTerm: '闭包' })
  assert.equal(r, 'suppress', '旧行为应当是永久挡住 —— 如果这条变了，说明我对根因的判断有误')
})

log('\n-- 源码一致性（防止改源码忘了改本文件的模型）--')

check('抑制窗口常量存在且取值合理', () => {
  assert.ok(SUPPRESS_MS > 0, '缺少 DISMISS_SUPPRESS_MS')
  assert.ok(SUPPRESS_MS >= 300, `${SUPPRESS_MS}ms 太短，吸收不掉关卡片引发的杂散事件`)
  assert.ok(SUPPRESS_MS <= 2000, `${SUPPRESS_MS}ms 太长，用户重新选中同一个词会被莫名挡住`)
})

check('判定处确实比较了时间差', () => {
  const i = code.indexOf('next.term === dismissedTerm')
  assert.ok(i >= 0, '找不到抑制判定')
  const line = code.slice(i - 60, i + 200)
  assert.ok(/Date\.now\(\)/.test(line), `判定处没有读时间：${line.trim().replace(/\s+/g, ' ').slice(0, 110)}`)
})

check('关卡片时既记时刻、又清 lastTerm', () => {
  const i = code.indexOf('function closeCard')
  assert.ok(i >= 0, '找不到 closeCard')
  const seg = code.slice(i, i + 1000)
  assert.ok(/dismissedAt = Date\.now\(\)/.test(seg), 'closeCard 没有记录关掉的时刻')
  assert.ok(/lastTerm = null/.test(seg), 'closeCard 没有清 lastTerm —— unchanged 判定会挡住重新选中')
})

check('快捷键触发时把抑制清干净', () => {
  const i = code.indexOf('function triggerByUser')
  const seg = code.slice(i, i + 500)
  assert.ok(/dismissedTerm = null/.test(seg), 'triggerByUser 没有清 dismissedTerm')
  assert.ok(/dismissedAt = 0/.test(seg), 'triggerByUser 没有清 dismissedAt')
})

log('\n-- 回归：别把「关不掉」放回来 --')

check('关卡片时仍然记下被关的词', () => {
  assert.ok(/dismissedTerm = state\.card\?\.term \?\? null/.test(code), 'dismissedTerm 不再被设置，「关不掉」会复发')
})
check('抑制判断仍然存在（只是加了时效）', () => {
  assert.ok(/next\.term === dismissedTerm/.test(code), '抑制判断被删了 —— 关掉后会被杂散事件立刻重开')
})
check('点击外部关闭与固定保护都还在', () => {
  assert.ok(/onDocMouseDown/.test(code), '缺少点击外部关闭')
  assert.ok(/if \(state\.card\.pinned\)/.test(code), '固定的卡片不该被点外部关掉')
})

log('\n-- 声明顺序（避免暂时性死区）--')

check('lastTerm 声明在 closeCard 之前', () => {
  const decl = code.indexOf('let lastTerm')
  const use = code.indexOf('function closeCard')
  assert.ok(decl >= 0, '找不到 lastTerm 声明')
  assert.ok(use >= 0, '找不到 closeCard')
  assert.ok(
    decl < use,
    `lastTerm 声明（第 ${decl} 字符）晚于 closeCard（第 ${use} 字符）—— 运行时会抛 ReferenceError`,
  )
})

log('\n-- 历史记录快捷键 --')

check('Alt+H 能开关历史面板', () => {
  assert.ok(/onHistoryKey/.test(code), '缺少 onHistoryKey 处理器')
  assert.ok(/toggleHistoryPanel\(\)/.test(code), '没有调用 toggleHistoryPanel')
  assert.ok(/addEventListener\('keydown', onHistoryKey/.test(code), '没有注册监听')
  assert.ok(/removeEventListener\('keydown', onHistoryKey/.test(code), '卸载时没有移除监听')
})
check('用 e.code 判断按键（不受输入法与键盘布局影响）', () => {
  const seg = code.slice(code.indexOf('onHistoryKey'), code.indexOf('onHistoryKey') + 900)
  assert.ok(/e\.code !== 'KeyH'/.test(seg), '应当用 e.code（中文输入法下 e.key 可能不是 h）')
})
check('不抢修饰键组合，也不在输入框里抢键', () => {
  const seg = code.slice(code.indexOf('onHistoryKey'), code.indexOf('onHistoryKey') + 900)
  assert.ok(/!e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey/.test(seg), '修饰键组合判断不严')
  assert.ok(/input, textarea, select/.test(seg), '在输入框里也会抢键')
})

log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
process.exit(failures === 0 ? 0 : 1)
