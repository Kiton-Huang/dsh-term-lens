/**
 * 宿主半离线自测：不起 DSH，直接跑纯逻辑与 Ollama 连通性。
 *   node test/host-smoke.mjs
 */
import { strict as assert } from 'node:assert'
import { loadConfig, ensureDirs, ROOT } from '../lib/config.js'
import { buildMessages, normalizeExplanation, PROMPT_VERSION, EXPLANATION_SCHEMA } from '../lib/prompt.js'
import * as cache from '../lib/cache.js'
import { probe, listModels, chat } from '../lib/ollama.js'

const log = (...a) => console.log(...a)
let failures = 0
function check(name, fn) {
  try {
    fn()
    log(`  ok   ${name}`)
  } catch (err) {
    failures++
    log(`  FAIL ${name}: ${err.message}`)
  }
}

log('== dsh-term-lens host smoke ==')
log(`DSH_HOME=${process.env.DSH_HOME ?? '(unset)'}  ROOT=${ROOT}`)

ensureDirs()
const config = loadConfig()
log(`config: model=${config.ollama.model} baseURL=${config.ollama.baseURL} webMode=${config.web.mode}`)

log('\n-- 1. 提示词 --')
check('buildMessages 含术语与上下文', () => {
  const m = buildMessages({ term: 'idempotent', context: 'await db.upsert(...)', scene: 'code', prompt: config.prompt })
  assert.match(m.system, /JSON/)
  assert.match(m.user, /idempotent/)
  assert.match(m.user, /db\.upsert/)
})
check('buildMessages 无上下文时不产生空代码块', () => {
  const m = buildMessages({ term: 'backpressure', prompt: config.prompt })
  assert.ok(!m.user.includes('```'), '不该出现在空的上下文档')
})

log('\n-- 2. 结果规整 --')
check('normalizeExplanation 补全缺失字段', () => {
  const out = normalizeExplanation({ oneLine: 'x' }, 'term')
  assert.equal(out.term, 'term')
  assert.deepEqual(out.bullets, [])
  assert.equal(out.confidence, 'medium')
})
check('normalizeExplanation 能从 ```json 包裹里抽出来', () => {
  const out = normalizeExplanation('```json\n{"oneLine":"同一操作重复执行结果一致","confidence":"high"}\n```', 'idempotent')
  assert.equal(out.oneLine, '同一操作重复执行结果一致')
  assert.equal(out.confidence, 'high')
  assert.ok(!out.unparsed, '不该标记为 unparsed')
})
check('normalizeExplanation 抗住完全非 JSON 的输出', () => {
  const out = normalizeExplanation('抱歉我不知道', 'x')
  assert.equal(out.confidence, 'low')
  assert.equal(out.unparsed, true)
})
check('normalizeExplanation 规整 related 的字符串写法', () => {
  const out = normalizeExplanation({ related: ['CRDT', { term: 'OT', why: '另一种协同算法' }] }, 't')
  assert.equal(out.related.length, 2)
  assert.equal(out.related[0].term, 'CRDT')
  assert.equal(out.related[1].why, '另一种协同算法')
})

log('\n-- 3. 缓存 --')
check('termKey 对大小写与尾标点不敏感', () => {
  const a = cache.termKey('  Idempotent. ', 'm', PROMPT_VERSION)
  const b = cache.termKey('idempotent', 'm', PROMPT_VERSION)
  assert.equal(a, b)
})
check('termKey 对模型与提示词版本敏感', () => {
  assert.notEqual(cache.termKey('x', 'a', 1), cache.termKey('x', 'b', 1))
  assert.notEqual(cache.termKey('x', 'a', 1), cache.termKey('x', 'a', 2))
})
check('store → lookup 精确命中', () => {
  const args = { term: '__smoke_term__', model: 'smoke-model', promptVersion: 999, context: 'ctx A' }
  cache.store({ ...args, explanation: { oneLine: 'hello' }, meta: {} })
  const hit = cache.lookup(args)
  assert.equal(hit.hit, true)
  assert.equal(hit.explanation.oneLine, 'hello')
})
check('不同上下文不误命中', () => {
  const args = { term: '__smoke_term__', model: 'smoke-model', promptVersion: 999, context: 'ctx B' }
  assert.equal(cache.lookup(args).hit, false)
})
check('空上下文不冒用有上下文的解释', () => {
  const args = { term: '__smoke_term__', model: 'smoke-model', promptVersion: 999, context: '' }
  assert.equal(cache.lookup(args).hit, false)
})

log('\n-- 4. Ollama 连通性 --')
const health = await probe(config)
if (health.ok) {
  log(`  ok   probe: v${health.version} in ${health.latencyMs}ms`)
  try {
    const models = await listModels(config)
    log(`  ok   listModels: ${models.length} 个 -> ${models.map((m) => m.name).join(', ')}`)
  } catch (err) {
    failures++
    log(`  FAIL listModels: ${err.message}`)
  }

  if (process.env.SMOKE_LLM === '1') {
    log(`\n-- 5. 真实生成 (SMOKE_LLM=1, model=${config.ollama.model}) --`)
    const messages = buildMessages({ term: 'idempotent', context: 'retry the payment call', scene: 'code', prompt: config.prompt })
    const started = Date.now()
    let firstAt = null
    let text = ''
    try {
      for await (const ev of (await import('../lib/ollama.js')).chatStream(config, messages, { schema: EXPLANATION_SCHEMA })) {
        if (ev.type === 'delta') {
          if (firstAt === null) firstAt = Date.now()
          text += ev.text
        } else if (ev.type === 'done') {
          text = ev.text
          log(`  stats: ttft=${ev.stats?.ttftMs}ms total=${ev.stats?.totalDurationMs}ms eval=${ev.stats?.evalCount} tokens`)
        }
      }
      log(`  首字延迟: ${firstAt ? firstAt - started : '?'}ms   总耗时: ${Date.now() - started}ms`)
      const parsed = normalizeExplanation(text, 'idempotent')
      log(`  解析结果: term=${parsed.term} confidence=${parsed.confidence} unparsed=${!!parsed.unparsed}`)
      log(`  oneLine: ${parsed.oneLine}`)
      log(`  bullets: ${parsed.bullets.length} 条, related: ${parsed.related.length} 条`)
      assert.ok(parsed.oneLine, 'oneLine 不该为空')
      log('  ok   真实生成与解析')
    } catch (err) {
      failures++
      log(`  FAIL 真实生成: ${err.message}`)
    }
  } else {
    log('  (跳过真实生成;加 SMOKE_LLM=1 开启)')
  }
} else {
  log(`  WARN 连不上 Ollama: ${health.error}`)
}

log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
process.exit(failures === 0 ? 0 : 1)
