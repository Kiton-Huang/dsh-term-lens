/**
 * 解释质量测试：真的调本地模型，检查几个关键质量指标。
 *   node test/quality.mjs
 *   SMOKE_MODEL=deepseek-r1:8b node test/quality.mjs
 *
 * 重点验证 inContext —— 这是本插件区别于「网页查词」的核心字段。
 * 术语查询是高频短任务，所以这里同时记录首字延迟与总耗时。
 */
import { loadConfig } from '../lib/config.js'
import { buildMessages, normalizeExplanation, schemaFor } from '../lib/prompt.js'
import { chatStream } from '../lib/ollama.js'

const config = loadConfig()
const model = process.env.SMOKE_MODEL || config.ollama.model
config.ollama.model = model

/** 每个 case 都是真实 coding 时会碰到的场景。 */
const CASES = [
  {
    term: 'backpressure',
    context: 'The readable stream applies backpressure when the consumer is slower than the producer.',
    scene: 'code',
    expectContext: true,
  },
  {
    term: 'idempotent',
    context: 'await db.upsert({ id, ...payload }) // idempotent',
    scene: 'code',
    expectContext: true,
  },
  {
    term: 'CQRS',
    context: 'We split the write model from the read model following CQRS.',
    scene: 'code',
    expectContext: true,
  },
  {
    term: '闭包',
    context: 'for (var i = 0; i < 3; i++) { setTimeout(() => console.log(i)) }',
    scene: 'code',
    expectContext: true,
  },
  {
    // 语言锁定:上下文是英文,但解释必须仍然是中文。
    // 实测过模型会「跟着上下文说英文」,这个 case 专门盯住它。
    term: 'watermark',
    context: 'The stream drops events below the watermark to bound memory usage.',
    scene: 'code',
    expectContext: true,
    expectChinese: true,
  },
  {
    term: '死锁',
    context: '',
    scene: 'chat',
    expectContext: false, // 没有上下文就不该编造
  },
]

function bar(n, total) {
  const filled = Math.round((n / total) * 24)
  return '█'.repeat(filled) + '░'.repeat(24 - filled)
}

console.log(`== dsh-term-lens 解释质量测试 ==`)
console.log(`model=${model}  style=${config.prompt.style}  language=${config.prompt.language}\n`)

const rows = []
let failures = 0

for (const [i, c] of CASES.entries()) {
  process.stdout.write(`[${i + 1}/${CASES.length}] ${c.term} … `)
  const messages = buildMessages({ term: c.term, context: c.context, scene: c.scene, prompt: config.prompt })
  const started = Date.now()
  let firstAt = null
  let text = ''
  let stats = null
  let err = null
  try {
    for await (const ev of chatStream(config, messages, { schema: schemaFor(c.context), model })) {
      if (ev.type === 'delta') {
        if (firstAt === null) firstAt = Date.now()
        text += ev.text
      } else if (ev.type === 'done') {
        text = ev.text || text
        stats = ev.stats
      }
    }
  } catch (e) {
    err = e
  }
  const totalMs = Date.now() - started

  if (err) {
    failures++
    console.log(`失败 (${err.message})`)
    rows.push({ term: c.term, ok: false, err: err.message })
    continue
  }

  const exp = normalizeExplanation(text, c.term)
  const problems = []
  if (!exp.oneLine) problems.push('oneLine 为空')
  if (exp.unparsed) problems.push('未能解析成 JSON')
  if (c.expectContext && !exp.inContext) problems.push('inContext 为空(但给了上下文)')
  if (!c.expectContext && exp.inContext) {
    // 把模型实际写的东西打出来 —— 只说「编了」没法判断是哨兵串没被识别，
    // 还是它真的编了一段通用定义（这两种情况的修法完全不同）
    problems.push(`没给上下文却编了 inContext -> ${JSON.stringify(exp.inContext.slice(0, 80))}`)
  }
  if (exp.confidence !== 'high' && exp.confidence !== 'medium' && exp.confidence !== 'low') problems.push('confidence 非法')
  if (c.expectChinese) {
    // 中文占比过低 = 模型跟着英文上下文说英文了
    const cjk = (exp.oneLine.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (cjk < 4) problems.push(`语言锁定失效:oneLine 不是中文 -> "${exp.oneLine.slice(0, 40)}"`)
    const ctxCjk = (exp.inContext.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (exp.inContext && ctxCjk < 4) problems.push('语言锁定失效:inContext 不是中文')
  }
  if (problems.length) failures++

  console.log(problems.length ? `⚠ ${problems.join('; ')}` : '✓')
  console.log(`   首字 ${stats?.ttftMs ?? (firstAt ? firstAt - started : '?')}ms · 总 ${totalMs}ms · ${stats?.evalCount ?? '?'} tokens · confidence=${exp.confidence}`)
  console.log(`   oneLine : ${exp.oneLine}`)
  if (c.expectContext) console.log(`   inCtx   : ${exp.inContext || '(空 ⚠)'}`)
  console.log(`   bullets : ${exp.bullets.length} 条  pitfalls: ${exp.pitfalls.length} 条  related: ${exp.related.length} 条  example: ${exp.example ? '有' : '无'}`)
  console.log('')

  rows.push({
    term: c.term,
    ok: problems.length === 0,
    problems,
    ttftMs: stats?.ttftMs ?? null,
    totalMs,
    confidence: exp.confidence,
    oneLine: exp.oneLine,
    inContext: exp.inContext,
  })
}

/* ── 汇总 ─────────────────────────────────────────────────────────── */

const ok = rows.filter((r) => r.ok)
const ttfts = rows.map((r) => r.ttftMs).filter((v) => typeof v === 'number')
const totals = rows.map((r) => r.totalMs).filter((v) => typeof v === 'number')
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null)

console.log('== 汇总 ==')
console.log(`通过 ${ok.length}/${rows.length}   平均首字 ${avg(ttfts)}ms   平均总耗时 ${avg(totals)}ms`)
for (const r of rows) {
  console.log(`  ${r.ok ? '✓' : '⚠'} ${r.term.padEnd(14)} ${String(r.ttftMs ?? '?').padStart(5)}ms  ${r.confidence ?? '-'}${r.problems?.length ? `   ${r.problems.join('; ')}` : ''}`)
}

process.exit(failures === 0 ? 0 : 1)
