/**
 * 静态检查客户端 bundle 里所有「函数引用了在它之后声明的 const/let」的情况。
 *
 * 这类错误只在运行时才炸(暂时性死区),而且往往只在某条路径上出现。
 * 契约测试能覆盖一部分,但把整份文件扫一遍更可靠。
 *   node tools/check-tdz.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const lines = src.split('\n')

/** 收集顶层(缩进 4 个 tab)的 const/let/function 声明及行号。 */
const decls = new Map()
const declRe = /^\t\t\t\t(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^\t\t\t\t(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
lines.forEach((line, i) => {
  const m = declRe.exec(line)
  if (m) {
    const name = m[1] ?? m[2]
    if (!decls.has(name)) decls.set(name, i + 1)
  }
})

/** 收集每个函数体的范围,检查函数体内引用的名字是否在该函数开始之前声明。 */
const problems = []
lines.forEach((line, i) => {
  const start = /\t\t\t\t(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^\t\t\t\tconst\s+([A-Za-z_$][\w$]*)\s*=\s*\(/.exec(line)
  if (!start) return
  const fnName = start[1] ?? start[2]
  const fnLine = i + 1
  // 找函数体结束(按缩进回退到 4 个 tab 的收尾行)
  let end = i + 1
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\t\t\t\t\}/.test(lines[j])) {
      end = j
      break
    }
  }
  const body = lines.slice(i, end + 1).join('\n')
  for (const [name, declLine] of decls) {
    if (declLine <= fnLine) continue // 声明在函数之前,安全
    // 函数体里是否引用了这个名字(排除它自己的名字)
    if (name === fnName) continue
    const used = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)
    if (used) {
      problems.push({ fn: fnName, fnLine, name, declLine, gap: declLine - fnLine })
    }
  }
})

if (problems.length === 0) {
  console.log('没有发现暂时性死区风险 ✓')
  process.exit(0)
}

console.log(`发现 ${problems.length} 处可能的暂时性死区:\n`)
for (const p of problems.sort((a, b) => a.fnLine - b.fnLine)) {
  console.log(`  ${p.fn}() 在 L${p.fnLine} 引用了 ${p.name}（声明在 L${p.declLine}，晚 ${p.gap} 行）`)
}
console.log('\n注意:函数「引用」在声明之前本身是安全的,只要调用发生在声明之后。')
console.log('真正会炸的是【在声明之前就被调用】的函数。请人工确认上面每一条。')
process.exit(0)
