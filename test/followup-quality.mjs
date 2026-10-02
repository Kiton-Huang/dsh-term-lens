/**
 * 追问质量测试：真的调本地模型，验证追问不会「边想边写」。
 *   node test/followup-quality.mjs
 *   SMOKE_MODEL=deepseek-r1:8b node test/followup-quality.mjs
 *
 * ══ 为什么要有这个文件 ═══════════════════════════════════════════════
 *
 * 真实事故：用户看「键名」的解释后追问「我还是不太懂键」，
 * 模型把**推理过程**当答案吐了出来：
 *
 *     首先，用户说："我还是不太懂键"。这表明他对于"键"这个概念的理解还不够清晰。
 *     回顾我已有的信息：
 *     我作为术语答疑助手，在处理"键名"这个词时。
 *     关键点：
 *     最佳响应策略：
 *     草拟回答：
 *     最终响应想法：
 *
 * 而且停在 2000 字左右 —— 正是 num_predict 用尽的地方（中文约 2 token/字）。
 *
 * 根因：首轮解释靠 JSON schema 把输出框住，追问为了「自由文本」把 schema 去掉了。
 * 对 qwen3:4b 来说 schema 就是唯一有效的作文约束，去掉之后它就退回边想边写。
 *
 * 所以这里死盯两件事：
 *   1. 不能泄漏推理链（这是用户直接看到的失败）
 *   2. 必须在 token 预算内收尾（不能被截断）
 */
import { loadConfig } from '../lib/config.js'
import { buildFollowUpMessages } from '../lib/prompt.js'
import { chatStream } from '../lib/ollama.js'

const config = loadConfig()
const model = process.env.SMOKE_MODEL || config.ollama.model
config.ollama.model = model

/** 推理链泄漏的典型标记。模型一旦开始「复盘任务」，就会出现这些词。 */
const REASONING_MARKERS = [
  '用户说',
  '回顾我',
  '我已有的信息',
  '关键点：',
  '最佳响应',
  '草拟回答',
  '最终响应',
  '我的回答目标',
  '潜在风险',
  '检查要求',
  '作为术语答疑助手',
  '让我想想',
  '首先，用户',
  '回答策略',
  '思路：',
]

const CASES = [
  {
    name: '模糊追问（复现事故）',
    term: '键名',
    context: 'const obj = { name: "Alice" } // name 就是键名',
    explanation: {
      oneLine: '代码中用于唯一标识键的名称',
      inContext: '在这个对象字面量里，name 是键名',
      bullets: ['代码对象属性名'],
    },
    question: '我还是不太懂键',
  },
  {
    name: '对比型追问',
    term: 'backpressure',
    context: 'The readable stream applies backpressure when the consumer is slower than the producer.',
    explanation: {
      oneLine: '消费端变慢时对生产端施加的减速机制',
      inContext: '这里指上游被限速，防止内存里堆积未消费的数据',
      bullets: ['防止内存无限增长', '由消费速率驱动'],
    },
    question: '它和限流（rate limiting）有什么区别？',
  },
  {
    name: '要例子型追问',
    term: 'idempotent',
    context: 'await db.upsert({ id, ...payload }) // idempotent',
    explanation: {
      oneLine: '重复执行多次，结果与执行一次相同',
      inContext: '这里指重试 upsert 不会产生重复记录',
      bullets: ['重试安全'],
    },
    question: '给我一个具体点的例子',
  },
]

const log = (...a) => console.log(...a)
let failures = 0

/** 追问的 token 预算：思考链也要算进去，所以比首轮解释宽 */
const FOLLOWUP_NUM_PREDICT = 2000

log('== dsh-term-lens 追问质量测试 ==')
log(`model=${model}  language=${config.prompt.language}  think=true  numPredict=${FOLLOWUP_NUM_PREDICT}\n`)

for (const [i, c] of CASES.entries()) {
  const { system, turns } = buildFollowUpMessages({
    term: c.term,
    context: c.context,
    explanation: c.explanation,
    history: [],
    prompt: config.prompt,
  })

  process.stdout.write(`[${i + 1}/${CASES.length}] ${c.name} … `)
  const started = Date.now()
  let text = ''
  let stats = null
  let err = null
  try {
    // 与 handleChat 用同一套参数：追问必须开思考链（见 lib/ollama.js 的说明）。
    // 这条测试如果跑成 think:false，就会复现「推理链写进正文」的事故 ——
    // 所以它同时也是那个配置的回归防线。
    for await (const ev of chatStream(
      config,
      { system, turns: [...turns, { role: 'user', content: c.question }] },
      { model, think: true, numPredict: FOLLOWUP_NUM_PREDICT },
    )) {
      if (ev.type === 'delta') text += ev.text
      else if (ev.type === 'done') {
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
    log(`失败 (${err.message})`)
    continue
  }

  const answer = text.trim()
  const problems = []

  // 1. 推理链泄漏 —— 这是用户直接看到的那次失败
  const leaked = REASONING_MARKERS.filter((m) => answer.includes(m))
  if (leaked.length) problems.push(`泄漏了推理过程: ${leaked.slice(0, 4).join(' / ')}`)

  // 2. 被截断：evalCount 顶到预算就说明没写完
  const budget = FOLLOWUP_NUM_PREDICT
  if (stats?.evalCount != null && stats.evalCount >= budget * 0.97) {
    problems.push(`答案被截断（用满 ${stats.evalCount}/${budget} tokens）`)
  }

  // 3. 空答案
  if (!answer) problems.push('答案为空')

  // 4. 语言锁定：中文提问必须中文回答
  if (config.prompt.language === 'zh-CN') {
    const cjk = (answer.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (cjk < 10) problems.push(`语言锁定失效（中文占比过低）`)
  }

  // 5. 啰嗦：追问应当短。"边想边写"的典型特征就是写成长文
  if (answer.length > 700) problems.push(`答案过长（${answer.length} 字，追问应当简短）`)

  if (problems.length) failures++

  log(problems.length ? `⚠ ${problems.join('; ')}` : '✓')
  log(`   总 ${totalMs}ms · ${stats?.evalCount ?? '?'} tokens · ${answer.length} 字`)
  log(`   答案 : ${answer.slice(0, 240).replace(/\n/g, '\n          ')}${answer.length > 240 ? '\n          …' : ''}`)
  log('')
}

log('== 汇总 ==')
log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
