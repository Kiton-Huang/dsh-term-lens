/**
 * 跑全部测试。
 *   node test/run-all.mjs
 *   SMOKE_LLM=1 node test/run-all.mjs    # 加上真实生成与真实 SSE
 *
 * 契约测试和纯逻辑测试永远跑;依赖模型的那部分由 SMOKE_LLM 控制。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const withLlm = process.env.SMOKE_LLM === '1'

const SUITES = [
  { name: '宿主逻辑 + Ollama 连通性', file: 'host-smoke.mjs', llm: false },
  { name: '配置结构迁移', file: 'config-migration.mjs', llm: false },
  { name: '路由集成（真 http 服务）', file: 'routes-smoke.mjs', llm: false, llmOptional: true },
  { name: '诊断通道 /diag', file: 'diag-check.mjs', llm: false },
  { name: '客户端投递（崩溃安全）', file: 'client-sync.mjs', llm: false },
  { name: '客户端 bundle 契约', file: 'client-contract.mjs', llm: false },
  // 离线部分是缓存指纹与提示词断言；SMOKE_LLM=1 时会真的跑三档风格做对比
  { name: '风格生效（缓存指纹 + 提示词）', file: 'style-effect.mjs', llm: false, llmOptional: true },
  { name: '解释质量（inContext / 语言锁定）', file: 'quality.mjs', llm: true },
  // 这一条盯的是「追问把推理链写进正文」那次真实事故，比较慢（三个用例各带思考链）
  { name: '追问质量（不泄漏推理 / 不被截断）', file: 'followup-quality.mjs', llm: true },
]

console.log(`\n${'='.repeat(66)}`)
console.log(`  dsh-term-lens 测试${withLlm ? '（含真实模型调用）' : '（SMOKE_LLM=1 可加上真实模型调用）'}`)
console.log(`${'='.repeat(66)}\n`)

const results = []
for (const suite of SUITES) {
  if (suite.llm && !withLlm) {
    console.log(`— 跳过: ${suite.name}  (需要 SMOKE_LLM=1)\n`)
    results.push({ ...suite, status: 'skip' })
    continue
  }
  console.log(`─ ${suite.name}`)
  const res = spawnSync(process.execPath, [join(here, suite.file)], {
    stdio: 'inherit',
    env: { ...process.env, SMOKE_LLM: suite.llmOptional && !withLlm ? '' : process.env.SMOKE_LLM },
  })
  const ok = res.status === 0
  results.push({ ...suite, status: ok ? 'pass' : 'fail', code: res.status })
  console.log('')
}

console.log(`${'='.repeat(66)}`)
for (const r of results) {
  const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '—' : '✗'
  console.log(`  ${mark} ${r.name}${r.status === 'fail' ? `  (exit ${r.code})` : ''}`)
}
const failed = results.filter((r) => r.status === 'fail')
console.log(`${'='.repeat(66)}\n`)

process.exit(failed.length === 0 ? 0 : 1)
