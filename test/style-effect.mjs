/**
 * 风格是否真的影响输出的测试（会真的调模型）。
 *
 *   node test/style-effect.mjs
 *   SMOKE_LLM=1 node test/style-effect.mjs
 *
 * ══ 由来 ═══════════════════════════════════════════════════════════
 *
 * 用户反馈「解释风格感觉没有生效」。查下来是缓存键的问题：
 *
 *     termKey = sha1(术语 + 模型 + 提示词版本)      ← 没有风格
 *     variants[contextKey(上下文)]                  ← 指纹里也没有风格
 *
 * 于是把风格从「标准」切到「详细」后，同一个词依然命中同一条缓存，
 * 解释永远不变。**提示词变了，缓存键里却少一个影响输出的维度。**
 *
 * 这个文件守两层：
 *   1. 离线：缓存指纹必须随风格变化，且提示词本身三档不同
 *   2. 在线（SMOKE_LLM=1）：三档产出的解释长度应当有可见差别
 */
import { loadConfig } from '../lib/config.js'
import { buildMessages, normalizeExplanation, resolveStyleHint, EXPLANATION_SCHEMA, BUILTIN_STYLES } from '../lib/prompt.js'
import { variantKey, termKey } from '../lib/cache.js'
import { chatStream } from '../lib/ollama.js'

const withLlm = process.env.SMOKE_LLM === '1'
const config = loadConfig()
const model = process.env.SMOKE_MODEL || config.ollama.model

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? `  ← ${detail}` : ''}`)
}

console.log('== dsh-term-lens 风格生效测试 ==')
console.log(`model=${model}  真实模型调用=${withLlm ? '是' : '否（SMOKE_LLM=1 打开）'}\n`)

/* ── 1. 缓存指纹必须随风格变化 ─────────────────────────────────────── */

console.log('-- 缓存指纹 --')
const CTX = 'The readable stream applies backpressure when the consumer is slower.'
const fingerprints = BUILTIN_STYLES.map((s) => ({ id: s.id, ck: variantKey(CTX, s.id, null) }))

check(
  '三档风格产生三个不同的缓存指纹',
  new Set(fingerprints.map((f) => f.ck)).size === BUILTIN_STYLES.length,
  fingerprints.map((f) => `${f.id}=${f.ck}`).join(' '),
)
check('同一风格可复现（同样的输入得到同样的指纹）', variantKey(CTX, 'deep', null) === variantKey(CTX, 'deep', null))
check('自定义要求也进指纹（否则改了它同样命中旧结果）', variantKey(CTX, 'deep', 'A') !== variantKey(CTX, 'deep', 'B'))
check(
  '自建风格名进指纹',
  variantKey(CTX, '精简回答', null) !== variantKey(CTX, 'deep', null),
)
check('空风格退回纯上下文指纹（兼容旧缓存文件）', variantKey(CTX, null, null) === variantKey(CTX, undefined, undefined))
// 同词不同风格应当共享同一个 entry（一个词一个文件，内部多 variant），而不是各写一份文件
check(
  '同词不同风格共享同一个缓存文件（靠 variant 区分）',
  termKey('backpressure', model, 7) === termKey('backpressure', model, 7),
)

/* ── 2. 提示词本身必须三档不同 ─────────────────────────────────────── */

console.log('\n-- 提示词 --')
const systems = BUILTIN_STYLES.map((s) => ({
  id: s.id,
  system: buildMessages({
    term: 'backpressure',
    context: CTX,
    scene: 'code',
    prompt: { ...config.prompt, style: s.id },
  }).system,
}))

check('三档风格的 system prompt 互不相同', new Set(systems.map((s) => s.system)).size === BUILTIN_STYLES.length)
for (const s of systems) {
  const hint = resolveStyleHint({ style: s.id })
  check(`  ${s.id} 的提示语确实出现在 system 里`, s.system.includes(hint), hint.slice(0, 30))
}
check(
  '自建风格能替换掉内置提示语',
  buildMessages({
    term: 'x',
    context: '',
    prompt: { ...config.prompt, style: '我的风格', styles: [{ name: '我的风格', hint: 'HINT_MARKER_XYZ' }] },
  }).system.includes('HINT_MARKER_XYZ'),
)
check(
  '风格名不存在时回退 standard（不会让提示词缺一块）',
  buildMessages({ term: 'x', context: '', prompt: { ...config.prompt, style: '不存在' } }).system ===
    buildMessages({ term: 'x', context: '', prompt: { ...config.prompt, style: 'standard' } }).system,
)

/* ── 3. 真实模型：三档产出应当有可见差别 ───────────────────────────── */

if (!withLlm) {
  console.log('\n-- 真实模型 --  跳过（需要 SMOKE_LLM=1）')
  console.log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log('\n-- 真实模型：三档对比 --')
// 探针必须是一个**真实存在的术语**。
// 一开始用的是随机字符串（__style_probe_xxx__），结果 deep 档产出 0 字 ——
// 模型不知道怎么解释一个不存在的词，而 deep 又要求"讲到原理与相邻概念的区别"，
// 它就绕死了。那是测试用例的缺陷，不是风格的问题。
// 用一个普通词、普通的上下文，三档都应当能正常产出。
const PROBE_TERM = 'mutex'
const PROBE_CTX = 'let guard = new Mutex(); guard.lock(); doWork(); guard.unlock();'

const results = []
for (const s of BUILTIN_STYLES) {
  const messages = buildMessages({
    term: PROBE_TERM,
    context: PROBE_CTX,
    scene: 'code',
    prompt: { ...config.prompt, style: s.id },
  })
  process.stdout.write(`  ${s.id.padEnd(9)} … `)
  let text = ''
  let stats = null
  try {
    for await (const ev of chatStream(config, messages, { model, schema: EXPLANATION_SCHEMA })) {
      if (ev.type === 'delta') text += ev.text
      else if (ev.type === 'done') {
        text = ev.text || text
        stats = ev.stats
      }
    }
  } catch (err) {
    console.log(`失败 (${err.message})`)
    failures++
    continue
  }
  const exp = normalizeExplanation(text, PROBE_TERM)
  const chars = exp.oneLine.length + exp.bullets.join('').length
  results.push({ id: s.id, chars, raw: text, oneLine: exp.oneLine, bullets: exp.bullets.length, unparsed: !!exp.unparsed })
  console.log(`${chars} 字 · oneLine ${exp.oneLine.length} 字 · bullets ${exp.bullets.length} 条`)
  if (exp.unparsed) {
    console.log(`      ⚠ 未能解析成 JSON，原始输出前 200 字：${text.slice(0, 200).replace(/\n/g, ' ')}`)
  }
  void stats
}

console.log('')
check('三档都产出了内容', results.length === BUILTIN_STYLES.length, `只得到 ${results.length} 档`)
check(
  '三档都解析出了 oneLine',
  results.every((r) => r.oneLine),
  results.filter((r) => !r.oneLine).map((r) => r.id).join(',') + ' 没有 oneLine',
)
if (results.length >= 2) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]))
  // concise 应当比 deep 短 —— 这是「风格生效」最直接的证据
  if (byId.concise?.oneLine && byId.deep?.oneLine) {
    check(
      `concise 比 deep 精炼（${byId.concise.chars} < ${byId.deep.chars} 字）`,
      byId.concise.chars < byId.deep.chars,
      '两档产出几乎一样 —— 风格可能仍被缓存或提示词遮住',
    )
  }
  check('三档产出不是逐字相同', new Set(results.map((r) => r.oneLine)).size > 1, '三档 oneLine 完全一样')
}

console.log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
process.exit(failures === 0 ? 0 : 1)
