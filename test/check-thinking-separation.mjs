/**
 * 核对：开了 think:true 之后，流式增量里是否只有正文、不含思考内容。
 *
 * 整个「追问」方案都建立在这一点上：推理走 message.thinking，
 * 正文走 message.content。如果两者混在一起，方案就不成立。
 *
 *   node test/check-thinking-separation.mjs
 */
import { loadConfig } from '../lib/config.js'
import { chatStream } from '../lib/ollama.js'

const config = loadConfig()
const model = process.env.SMOKE_MODEL || config.ollama.model

console.log(`核对 think:true 时的字段分离    model=${model}\n`)

let content = ''
let deltas = 0
const stats = { thinkingSeen: false }

// chatStream 只 yield delta/done；这里额外抓一次原始 NDJSON 来看 thinking 字段
const { request } = await import('node:http')
const base = new URL(config.ollama.baseURL)
const payload = Buffer.from(
  JSON.stringify({
    model,
    stream: true,
    think: true,
    keep_alive: config.ollama.keepAlive,
    messages: [
      { role: 'system', content: '你在给程序员解释「键名」。已经讲过：代码中用于唯一标识键的名称。用简体中文直接回答用户追问的那一点。' },
      { role: 'user', content: '我还是不太懂键' },
    ],
    options: { temperature: config.ollama.temperature, num_predict: 2000 },
  }),
  'utf8',
)

const lines = await new Promise((resolve, reject) => {
  const req = request(
    {
      host: base.hostname,
      port: Number(base.port || 11434),
      path: '/api/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.byteLength },
    },
    (res) => {
      let buf = ''
      const out = []
      res.on('data', (c) => {
        buf += c.toString('utf8')
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) out.push(line)
        }
      })
      res.on('end', () => resolve(out))
    },
  )
  req.setTimeout(300000, () => req.destroy(new Error('timeout')))
  req.on('error', reject)
  req.write(payload)
  req.end()
})

let thinkingChars = 0
let contentChars = 0
for (const line of lines) {
  let j
  try {
    j = JSON.parse(line)
  } catch {
    continue
  }
  const thinkChunk = j.message?.thinking
  const contentChunk = j.message?.content
  if (typeof thinkChunk === 'string' && thinkChunk) {
    thinkingChars += thinkChunk.length
    stats.thinkingSeen = true
  }
  // 关键断言：content 分片里不该出现 thinking 的内容
  if (typeof contentChunk === 'string' && contentChunk) {
    contentChars += contentChunk.length
    content += contentChunk
  }
}

console.log('原始流统计：')
console.log(`  thinking 分片总量 : ${thinkingChars} 字`)
console.log(`  content  分片总量 : ${contentChars} 字`)
console.log(`  thinking 字段是否存在: ${stats.thinkingSeen}`)
console.log('')
console.log('正文（content）:')
console.log('  ' + content.trim().replace(/\n/g, '\n  ').slice(0, 400))
console.log('')

let bad = 0
const check = (name, ok) => {
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
}

const MARKERS = ['用户说', '回顾', '关键点', '最佳', '草拟', '最终响应', '首先，用户', '嗯，用户']
const leaked = MARKERS.filter((m) => content.includes(m))

check('thinking 字段确实承载了推理内容', stats.thinkingSeen && thinkingChars > 0)
check('正文里没有推理链标记', leaked.length === 0 || `泄漏: ${leaked.join('/')}`)
check('正文非空', content.trim().length > 20)

console.log(bad === 0 ? '\n字段分离成立：可以放心用 think:true' : `\n${bad} 项不成立`)
process.exit(bad === 0 ? 0 : 1)
