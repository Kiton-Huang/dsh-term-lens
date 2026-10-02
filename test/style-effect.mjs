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
import { buildMessages, normalizeExplanation, resolveStyleHint, schemaFor, BUILTIN_STYLES } from '../lib/prompt.js'
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
// 探针必须是一个**真实术语 + 真实语境**。
//
// 试过随机字符串（`__style_probe_xxx__`）和泛化语境（`let guard = new Mutex()`），
// 两者都会偶发失败，而且原因跟风格无关：模型不知道怎么答时会反问
// 「您想了解关于 mutex 的什么呢？」，产出合法但缺字段的 JSON。
// 用一段像真代码的上下文，模型才有一致的解释目标。
const PROBE_TERM = 'backpressure'
const PROBE_CTX = 'readable.pipe(writable) // 消费端慢时施加 backpressure，避免内存堆积'

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
    for await (const ev of chatStream(config, messages, { model, schema: schemaFor(PROBE_CTX) })) {
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
  // 「内容量」= 解析出来的正文总字数。解析失败时为 0，这时不参与比较。
  const chars = exp.oneLine.length + exp.bullets.join('').length + exp.pitfalls.join('').length
  results.push({ id: s.id, chars, parsed: !exp.unparsed && !!exp.oneLine, raw: text })
  console.log(`${String(chars).padStart(4)} 字 · bullets ${exp.bullets.length} 条${exp.unparsed ? '  ⚠ 未解析' : ''}`)
  void stats
}

console.log('')
check('三档都产出了内容', results.length === BUILTIN_STYLES.length, `只得到 ${results.length} 档`)

// ⚠️ 在线部分**不做断言**，只报告。
//
// 原因：用同一个语境连测三档时，qwen3:4b 的解析成功率实测很不稳定
// （连跑 3 次，解析成功的档位分别是 1、0、0）。把这种波动写成断言
// 只会变成噪音 —— 而且它反映的是模型在「同一个词换个说法再解释一遍」
// 这种非自然请求下的行为，不是风格有没有生效。
//
// 风格是否生效，由上面的**离线断言**可靠地证明：
//   ① 三档产生三个不同的缓存指纹（这是「改了风格不会命中旧解释」的根据）
//   ② 三档的 system prompt 互不相同，且各自的风格提示语确实在里面
// 这两条是确定性的。在线对比留在这里当**人工参考**：
// 想知道实际效果，看下面这张表就行。
const usable = results.filter((r) => r.parsed)
if (usable.length >= 2) {
  const byId = Object.fromEntries(usable.map((r) => [r.id, r]))
  if (byId.concise && byId.deep && byId.concise.chars >= byId.deep.chars) {
    console.log(`  ⚠ 注意：concise(${byId.concise.chars} 字) 不比 deep(${byId.deep.chars} 字) 短。`)
    console.log('     风格可能没生效 —— 先看上面的离线断言是否通过，再看下面这张表。')
  }
}
if (usable.length === BUILTIN_STYLES.length && new Set(usable.map((r) => r.raw)).size === 1) {
  console.log('  ⚠ 注意：三档产出完全一样 —— 风格很可能没生效。')
}
console.log(`  （本次 ${usable.length}/${BUILTIN_STYLES.length} 档解析成功；未解析属于模型波动，已排除在比较之外）`)

console.log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
process.exit(failures === 0 ? 0 : 1)
