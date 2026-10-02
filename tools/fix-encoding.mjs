/**
 * 恢复被 PowerShell 编码事故损坏的文本文件。
 *
 * 事故链条：Get-Content -Raw 把 UTF-8 字节按 Latin-1 解成字符 →
 * Set-Content -Encoding UTF8 又把这些字符按 **GBK** 编码写回。
 *
 * 所以还原就是反过来：取每个字符的 GBK 字节 → 按 UTF-8 解码。
 * 对「GBK 里不存在的字符」（换行、制表、纯 ASCII 之外的少量码位），
 * 处理方式是：ASCII 原样保留，其余查 GBK 码表。
 *
 *   node tools/fix-encoding.mjs <file> [--write]
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

const file = process.argv[2]
const write = process.argv.includes('--write')
if (!file) {
  console.error('usage: node tools/fix-encoding.mjs <file> [--write]')
  process.exit(2)
}

const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')

/* 构造「Unicode 字符 → GBK 字节」的反查表。
   Node 的 TextEncoder 只有 UTF-8，所以用一张预生成的 GBK 双字节表来做。
   做法：把 GBK 的所有合法双字节组合都解码一遍，建立 字符→字节 的映射。
   这比引 iconv 依赖可靠，且只需跑一次。 */
function buildGbkReverse() {
  const rev = new Map()
  // GBK 双字节：首字节 0x81-0xFE，次字节 0x40-0xFE（去掉 0x7F）
  const pairs = []
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue
      pairs.push([hi, lo])
    }
  }
  // 用 node 的 gbk 解码能力：Intl 不支持 GBK，所以退回到「逐对尝试 + 调用系统」太慢。
  // 改用一次性方案：把整张表拼成 Buffer，用 TextDecoder('gbk') 解码，建立位置→字符。
  const buf = Buffer.alloc(pairs.length * 2)
  pairs.forEach(([hi, lo], i) => {
    buf[i * 2] = hi
    buf[i * 2 + 1] = lo
  })
  let decoded = null
  try {
    decoded = new TextDecoder('gbk', { fatal: false }).decode(buf)
  } catch {
    return null
  }
  // decoded 里每个「可解码」的 pair 对应一个字符；不可解码的变成 U+FFFD。
  // 注意长度不保证与 pairs 一致（有些 pair 解成 1 个字符，有些可能是 1 个 U+FFFD），
  // 所以逐个 pair 单独解码更稳 —— 但那样要 2 万次调用。这里用位置对齐的近似，
  // 只接受长度一致的情形。
  if (decoded.length !== pairs.length) return { rev: null, decoded, pairs }
  pairs.forEach(([hi, lo], i) => {
    const ch = decoded[i]
    if (ch !== '\uFFFD' && !rev.has(ch)) rev.set(ch, [hi, lo])
  })
  return { rev, decoded, pairs }
}

const { rev } = buildGbkReverse()
if (!rev) {
  console.error('无法构造 GBK 反查表（本机 TextDecoder 不支持 gbk？）')
  process.exit(1)
}

const out = []
const unmapped = new Map()
for (const ch of text) {
  const cp = ch.codePointAt(0)
  if (cp < 0x80) {
    out.push(cp) // ASCII 原样
    continue
  }
  const pair = rev.get(ch)
  if (pair) {
    out.push(pair[0], pair[1])
    continue
  }
  // 单字节 GBK 区（0xA1-0xFE 的部分符号）与无法映射的字符
  unmapped.set(ch, (unmapped.get(ch) ?? 0) + 1)
  out.push(0x3f) // '?' —— 记录后由人工判断
}

const restored = Buffer.from(out).toString('utf8')
const bad = (restored.match(/\uFFFD/g) ?? []).length

console.log(`文件: ${file}`)
console.log(`原始 UTF-8 长度: ${text.length} 字符`)
console.log(`还原后长度: ${restored.length} 字符`)
console.log(`无法映射的字符种类: ${unmapped.size}`)
if (unmapped.size) {
  const list = [...unmapped.entries()].slice(0, 20)
  console.log('  样本:', list.map(([c, n]) => `${JSON.stringify(c)}×${n}`).join(' '))
}
console.log(`还原后仍含 U+FFFD: ${bad}`)

if (write && bad === 0) {
  const backup = `${file}.broken`
  renameSync(file, backup)
  writeFileSync(file, restored, 'utf8')
  console.log(`\n已写入 ${file}（损坏版本备份为 ${backup}）`)
} else if (write) {
  console.log('\n有 U+FFFD，未写入。请检查上面的无法映射字符。')
} else {
  console.log('\n(试运行;加 --write 才真正写入)')
}
