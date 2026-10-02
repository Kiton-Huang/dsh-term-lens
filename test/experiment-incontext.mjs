/**
 * inContext 提示词对照实验。
 *
 * 观察：qwen3:4b 在「一次生成全部字段」时会偷懒把 inContext 留空 —— 即便提示词
 * 已经明确要求填。这个脚本横向对比几种策略，找出真正能让它读上下文的那种。
 *
 *   node test/experiment-incontext.mjs
 */
import { loadConfig } from '../lib/config.js'
import { EXPLANATION_SCHEMA } from '../lib/prompt.js'
import { chat } from '../lib/ollama.js'

const config = loadConfig()
const model = process.env.SMOKE_MODEL || config.ollama.model

const TERM = 'backpressure'
const CONTEXT = 'The readable stream applies backpressure when the consumer is slower than the producer.'

const SCHEMA_WITH_CTX_REQUIRED = {
  type: 'object',
  properties: {
    term: { type: 'string' },
    reading: { type: 'string' },
    oneLine: { type: 'string' },
    inContext: { type: 'string' },
    bullets: { type: 'array', items: { type: 'string' } },
    pitfalls: { type: 'array', items: { type: 'string' } },
    related: {
      type: 'array',
      items: { type: 'object', properties: { term: { type: 'string' }, why: { type: 'string' } }, required: ['term', 'why'] },
    },
    example: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['term', 'oneLine', 'inContext', 'bullets', 'related', 'confidence'],
}

/** 只问语境含义，其余字段留空 —— 把模型的全部注意力压到这一个问题上。 */
const CONTEXT_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    inContext: { type: 'string' },
    bullets: { type: 'array', items: { type: 'string' } },
    pitfalls: { type: 'array', items: { type: 'string' } },
    related: {
      type: 'array',
      items: { type: 'object', properties: { term: { type: 'string' }, why: { type: 'string' } }, required: ['term', 'why'] },
    },
    example: { type: 'string' },
  },
  required: ['inContext'],
}

const STRATEGIES = [
  {
    name: 'A 现状基线（一次生成全部字段，inContext 仅"要求填"）',
    schema: EXPLANATION_SCHEMA,
    system: `你是一个给程序员做术语速查的解释器。严格输出 JSON。解释语言用简体中文。
字段：term, reading, oneLine, inContext, bullets, pitfalls, related, example, confidence。
inContext: 结合用户给出的上下文,说明在这个具体场景里它指什么。`,
    user: `术语: ${TERM}\n\n它出现的上下文:\n\`\`\`\n${CONTEXT}\n\`\`\``,
  },
  {
    name: 'B schema 里把 inContext 列为必填',
    schema: SCHEMA_WITH_CTX_REQUIRED,
    system: `你是一个给程序员做术语速查的解释器。严格输出 JSON。解释语言用简体中文。
字段：term, reading, oneLine, inContext, bullets, pitfalls, related, example, confidence。
inContext 必须填写,不许留空:结合用户给出的上下文,说明在这个具体场景里它指什么。`,
    user: `术语: ${TERM}\n\n它出现的上下文:\n\`\`\`\n${CONTEXT}\n\`\`\``,
  },
  {
    name: 'C 把上下文要求放进 user 消息的最后一句',
    schema: EXPLANATION_SCHEMA,
    system: `你是一个给程序员做术语速查的解释器。严格输出 JSON。解释语言用简体中文。`,
    user: `术语: ${TERM}\n\n它出现的上下文:\n\`\`\`\n${CONTEXT}\n\`\`\`\n\n请在 inContext 字段里说明:在这个上下文里,${TERM} 具体指什么、为什么这里会出现它。这个字段必须填写,不能留空。`,
  },
  {
    name: 'D 两阶段：第二次只问语境（CONTEXT_ONLY schema）',
    schema: CONTEXT_ONLY_SCHEMA,
    system: `你在读一段程序员的代码或文档。用户选中了其中的一个词,想知道它在这句话里具体是什么意思。
严格输出 JSON。解释语言用简体中文。
只解释这个词在【给定上下文】中的含义,不要给出通用的词典释义。
inContext 必须是一句具体的、引用上下文的说明,不许留空。`,
    user: `选中的词: ${TERM}\n\n上下文:\n\`\`\`\n${CONTEXT}\n\`\`\``,
  },
  {
    name: 'E 让模型先复述上下文再解释（强制注意力落到上下文）',
    schema: EXPLANATION_SCHEMA,
    system: `你是一个给程序员做术语速查的解释器。严格输出 JSON。解释语言用简体中文。
工作步骤:先在心里读懂用户给的上下文,然后填写 inContext —— 它要说明这个词在这段上下文里扮演什么角色。
不要把通用定义抄进 inContext。`,
    user: `术语: ${TERM}\n\n它出现的上下文:\n\`\`\`\n${CONTEXT}\n\`\`\`\n\n填空:在这段话里,"${TERM}" 指的是 ______。把这句话补完的结果写进 inContext。`,
  },
]

console.log(`== inContext 提示词对照实验 ==`)
console.log(`model=${model}`)
console.log(`term=${TERM}`)
console.log(`context=${CONTEXT}\n`)

const results = []

for (const [i, s] of STRATEGIES.entries()) {
  process.stdout.write(`[${i + 1}/${STRATEGIES.length}] ${s.name}\n`)
  const started = Date.now()
  try {
    const { text, stats } = await chat(config, { system: s.system, user: s.user }, { schema: s.schema, model })
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      const a = text.indexOf('{')
      const b = text.lastIndexOf('}')
      if (a >= 0 && b > a) parsed = JSON.parse(text.slice(a, b + 1))
    }
    const hasCtx = !!(parsed?.inContext && String(parsed.inContext).trim())
    results.push({ name: s.name, hasCtx, chars: String(parsed?.inContext ?? '').length })
    console.log(`   ${hasCtx ? '✓ 有 inContext' : '✗ inContext 仍为空'}  (${Date.now() - started}ms, ttft=${stats?.ttftMs}ms)`)
    if (hasCtx) console.log(`   → ${parsed.inContext}`)
    else console.log(`   → oneLine: ${parsed?.oneLine ?? '(解析失败)'}`)
  } catch (err) {
    results.push({ name: s.name, hasCtx: false, chars: 0, error: err.message })
    console.log(`   ✗ 失败: ${err.message}`)
  }
  console.log('')
}

console.log('== 汇总 ==')
for (const r of results) {
  console.log(`  ${r.hasCtx ? '✓' : '✗'} ${r.name}${r.error ? ` (${r.error})` : r.hasCtx ? ` — ${r.chars} 字` : ''}`)
}

const winners = results.filter((r) => r.hasCtx)
console.log(`\n有效的策略: ${winners.length === 0 ? '无' : winners.map((w) => w.name.slice(0, 2)).join(', ')}`)
