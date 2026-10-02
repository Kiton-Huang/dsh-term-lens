// Minimal asar reader: list / extract files from an Electron .asar archive.
// Usage:
//   node asar-ls.mjs list <archive> [prefixFilter] [--limit N]
//   node asar-ls.mjs extract <archive> <outDir> [prefixFilter]
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [, , cmd, archivePath, ...rest] = process.argv
if (!cmd || !archivePath) {
  console.error('usage: asar-ls.mjs <list|extract> <archive> [arg] [prefix]')
  process.exit(2)
}

const fd = readFileSync(archivePath)
// header: u32 pickleSize | u32 headerJsonSize | headerJson | data
// pickleSize includes its own trailing padding, so the JSON payload may carry
// a short whitespace tail — trim it before parsing.
const headerJsonSize = fd.readUInt32LE(8)
let headerJson = fd.subarray(16, 16 + headerJsonSize).toString('utf8')
const brace = headerJson.lastIndexOf('}')
if (brace >= 0) headerJson = headerJson.slice(0, brace + 1)
const header = JSON.parse(headerJson)
const dataOffset = 16 + headerJsonSize

function walk(node, path, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = path ? `${path}/${name}` : name
    if (child.files) walk(child, p, out)
    else out.push({ path: p, size: child.size ?? 0, offset: child.offset, unpacked: !!child.unpacked })
  }
}

const all = []
walk(header, '', all)

if (cmd === 'list') {
  let limit = 400
  const li = rest.indexOf('--limit')
  if (li >= 0) limit = Number(rest[li + 1])
  const positional = rest.filter((a, i) => a !== '--limit' && i !== li + 1)
  const prefix = positional[0] ?? ''
  const hits = all.filter((f) => f.path.startsWith(prefix))
  console.log(`# total ${all.length} files, ${hits.length} match "${prefix}"`)
  for (const f of hits.slice(0, limit)) console.log(`${String(f.size).padStart(10)}  ${f.path}`)
  if (hits.length > limit) console.log(`... ${hits.length - limit} more`)
} else if (cmd === 'extract') {
  const outDir = resolve(rest[0])
  const prefix = rest[1] ?? ''
  const hits = all.filter((f) => f.path.startsWith(prefix) && !f.unpacked)
  let n = 0
  for (const f of hits) {
    const dest = join(outDir, f.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, fd.subarray(dataOffset + Number(f.offset), dataOffset + Number(f.offset) + f.size))
    n++
  }
  console.log(`extracted ${n} files to ${outDir}`)
} else {
  console.error('unknown cmd', cmd)
  process.exit(2)
}
