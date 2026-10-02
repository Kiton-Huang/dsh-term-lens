/**
 * 实验：追问到底该怎么抑制「边想边写」。
 *
 * 背景：追问不能用 JSON schema（会把答案挤成碎片），但去掉 schema 后
 * qwen3:4b 就退回把推理过程写进正文。调过提示词，只解决了一部分，
 * 而且模型开始复述我给的 few-shot 示例。
 *
 * 这里并列比较几种做法，用同一个事故用例（「我还是不太懂键」）。
 *   node test/experiment-followup.mjs
 */
import { loadConfig } from '../lib/config.js'
import { request as httpRequest } from 'node:http'

const config = loadConfig()
const model = process.env.SMOKE_MODEL || config.ollama.model
const base = new URL(config.ollama.baseURL)

/** 直接打 Ollama，返回 { content, thinking, evalCount } —— 要看 thinking 字段有没有东西。 */
async function rawChat(messages, { think, numPredict = 900, format } = {}) {
  const body = {
    model,
    stream: false,
    think: think === true,
    keep_alive: config.ollama.keepAlive,
    messages,
    options: { temperature: config.ollama.temperature, num_predict: numPredict, repeat_penalty: 1.15, repeat_last_n: 256 },
  }
  if (format) body.format = format

  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const json = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: base.hostname,
        port: Number(base.port || 11434),
        path: '/api/chat',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.byteLength },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.setTimeout(300000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
  if (json.error) throw new Error(json.error)
  return {
    content: json.message?.content ?? '',
    thinking: json.message?.thinking ?? '',
    evalCount: json.eval_count ?? null,
    doneReason: json.done_reason ?? null,
  }
}

const TERM = '键名'
const EXPL = '代码中用于唯一标识键的名称'
const QUESTION = '我还是不太懂键'

const baseSystem = `你在给程序员解释「${TERM}」。已经讲过：${EXPL}。\n现在用户追问。用简体中文直接回答他问的那一点。`

const strictSystem = [
  baseSystem,
  '',
  '只输出回答本身。不要写任何关于「我要怎么回答」的内容 —— 不分析用户意图、不复述我这段话、不列提纲、不写草稿。',
  '不要重复已经讲过的内容。默认 3 到 6 句。',
].join('\n')

const MARKERS = ['用户说', '回顾', '关键点', '最佳', '草拟', '最终响应', '我的回答目标', '首先，用户', '我得', '嗯，用户', '总结']

const leakCount = (t) => MARKERS.filter((m) => t.includes(m)).length
const preview = (t, n = 150) => t.trim().slice(0, n).replace(/\n/g, ' ') + (t.length > n ? ' …' : '')

const VARIANTS = [
  {
    name: 'A. think:false（现在的做法）+ 宽松提示词',
    run: () => rawChat([{ role: 'system', content: baseSystem }, { role: 'user', content: QUESTION }], { think: false }),
  },
  {
    name: 'B. think:false + 严格禁元话语',
    run: () => rawChat([{ role: 'system', content: strictSystem }, { role: 'user', content: QUESTION }], { think: false }),
  },
  {
    name: 'C. think:true（推理走 thinking 字段）',
    run: () => rawChat([{ role: 'system', content: baseSystem }, { role: 'user', content: QUESTION }], { think: true, numPredict: 2000 }),
  },
]

console.log(`实验：追问的推理链泄漏    model=${model}\n`)

for (const v of VARIANTS) {
  process.stdout.write(`${v.name}\n`)
  try {
    const started = Date.now()
    const r = await v.run()
    const ms = Date.now() - started
    console.log(`  content  : ${preview(r.content)}`)
    console.log(`  thinking : ${r.thinking ? preview(r.thinking, 90) : '(空)'}`)
    console.log(`  泄漏标记 ${leakCount(r.content)} 个 · ${r.evalCount} tokens · ${ms}ms · done_reason=${r.doneReason}`)
  } catch (err) {
    console.log(`  失败: ${err.message}`)
  }
  console.log('')
}
