/**
 * dsh-term-lens —— 磁盘缓存
 *
 * 设计要点（这是本插件比「网页搜索」强的地方）：
 *   - 缓存键 = sha1(规范化术语 + 模型 + 提示词版本)
 *   - **键里不含上下文** —— 上下文只影响首次生成；同一个词第二次选中是零延迟。
 *   - 一条 entry 内再按「上下文 + 风格」指纹存多个变体，这样同词不同语境、
 *     不同风格各自有解释，但完全相同的 (词, 上下文, 风格) 必然命中。
 *   - 分片目录（前两位十六进制）避免单目录几千文件。
 *
 * ⚠️ **风格必须进指纹。** 这里踩过一个真实的坑：指纹原本只有上下文，
 * 于是把风格从「标准」切到「详细」后，同一个词依然命中同一条缓存 ——
 * 用户看到的解释永远不变，反馈是「解释风格感觉没有生效」。
 * 提示词变了却命中旧结果，缓存键里少一个影响输出的维度就会这样。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE_DIR } from './config.js'

export function normalizeTerm(term) {
  return String(term)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?。，、；：！？]+$/u, '')
    .toLowerCase()
}

export function termKey(term, model, promptVersion) {
  return createHash('sha1')
    .update(`${normalizeTerm(term)}\u0000${model}\u0000v${promptVersion}`)
    .digest('hex')
}

export function contextKey(context) {
  const c = (context ?? '').trim()
  if (!c) return 'none'
  return createHash('sha1').update(c).digest('hex').slice(0, 12)
}

/**
 * 变体指纹 = 上下文 + 风格 + 自定义要求。
 *
 * 凡是**会影响提示词**的东西都必须进来，否则改了设置却命中旧结果。
 * 输出格式保持 `<上下文指纹>` 或 `<上下文指纹>.<后缀>`，
 * 这样纯中文上下文的老条目仍然能被相同的上下文命中。
 */
export function variantKey(context, style, customSystem) {
  const base = contextKey(context)
  const extra = `${style ?? ''}\u0000${customSystem ?? ''}`
  // 没风格也没自定义要求时退回纯上下文指纹（老缓存的键形态）
  if (!extra.replace(/\u0000/g, '')) return base
  return `${base}.${createHash('sha1').update(extra).digest('hex').slice(0, 10)}`
}

function entryPath(key) {
  return join(CACHE_DIR, key.slice(0, 2), `${key}.json`)
}

function readEntry(key) {
  const p = entryPath(key)
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeEntry(key, entry) {
  const dir = join(CACHE_DIR, key.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  writeFileSync(entryPath(key), JSON.stringify(entry), 'utf8')
}

/**
 * 查缓存。
 * @param {{term:string, model:string, promptVersion:number, context?:string, style?:string, customSystem?:string|null}} q
 * @returns {{hit: true, explanation: object, meta: object} | {hit: false, entry: object|null}}
 */
export function lookup({ term, model, promptVersion, context, style, customSystem }) {
  const key = termKey(term, model, promptVersion)
  const entry = readEntry(key)
  if (!entry) return { hit: false, entry: null }

  // 优先精确命中（上下文 + 风格 + 自定义要求 全部一致）
  const ck = variantKey(context, style, customSystem)
  const exact = entry.variants?.[ck]
  if (exact) {
    exact.hits = (exact.hits ?? 0) + 1
    exact.lastHitAt = new Date().toISOString()
    try {
      writeEntry(key, entry)
    } catch {
      /* 计数失败无所谓 */
    }
    return { hit: true, explanation: exact.explanation, meta: { key, ck, ...exact.meta, cached: true, hits: exact.hits } }
  }

  // 上下文为空时不退而求其次，避免把「代码里的含义」当成通用释义给出去
  return { hit: false, entry }
}

/**
 * 丢掉「当前键空间之外」的变体。
 *
 * 场景：指纹里加了风格之后，老条目（纯上下文指纹，没有 `.后缀`）就永远
 * 命中不到了，却还占着磁盘。这里顺手清掉 —— 只保留以当前上下文指纹开头的
 * 那些变体，也就是这次查询确实可能用到的。
 *
 * @returns {number} 清掉的变体数
 */
export function dropStaleVariants(term, model, promptVersion, context) {
  const key = termKey(term, model, promptVersion)
  const entry = readEntry(key)
  if (!entry?.variants) return 0
  const prefix = contextKey(context)
  const keep = {}
  let removed = 0
  for (const [k, v] of Object.entries(entry.variants)) {
    if (k === prefix || k.startsWith(`${prefix}.`)) keep[k] = v
    else removed++
  }
  if (removed > 0) {
    entry.variants = keep
    try {
      writeEntry(key, entry)
    } catch {
      /* 清理失败无伤大雅 */
    }
  }
  return removed
}

/**
 * 写缓存。entry 里可以带 `found: false`（模型明确说不认识），
 * 这种也要缓存 —— 否则每次都会重跑一遍慢查询。
 */
export function store({ term, model, promptVersion, context, style, customSystem, explanation, meta, found = true }) {
  const key = termKey(term, model, promptVersion)
  const entry = readEntry(key) ?? {
    term,
    model,
    promptVersion,
    createdAt: new Date().toISOString(),
    variants: {},
  }
  const ck = variantKey(context, style, customSystem)
  entry.variants[ck] = {
    explanation,
    found,
    hits: 0,
    createdAt: new Date().toISOString(),
    // 记下这个变体是用什么设置生成的，排查「改了设置没变化」时一眼可见
    style: style ?? null,
    meta: meta ?? {},
  }
  entry.lastWriteAt = new Date().toISOString()
  writeEntry(key, entry)
  return { key, ck }
}

/** 列出最近的缓存条目（按最后写入时间倒序），供「会话历史」之外的全量回看。 */
export function listRecent(limit = 100) {
  const out = []
  if (!existsSync(CACHE_DIR)) return out
  for (const shard of readdirSync(CACHE_DIR)) {
    const dir = join(CACHE_DIR, shard)
    let files
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const p = join(dir, f)
      try {
        const entry = JSON.parse(readFileSync(p, 'utf8'))
        const variants = Object.values(entry.variants ?? {})
        const newest = variants.reduce((a, v) => (v.createdAt > a ? v.createdAt : a), entry.createdAt ?? '')
        const featured = variants.find((v) => v.createdAt === newest) ?? variants[0]
        out.push({
          term: entry.term,
          model: entry.model,
          createdAt: newest,
          variantCount: variants.length,
          oneLine: featured?.explanation?.oneLine ?? '',
          confidence: featured?.explanation?.confidence ?? null,
          found: featured?.found !== false,
          sizeBytes: safeSize(p),
        })
      } catch {
        /* 跳过坏文件 */
      }
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return out.slice(0, limit)
}

function safeSize(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

export function stats() {
  let count = 0
  let bytes = 0
  if (!existsSync(CACHE_DIR)) return { count, bytes }
  for (const shard of readdirSync(CACHE_DIR)) {
    const dir = join(CACHE_DIR, shard)
    let files
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      count++
      bytes += safeSize(join(dir, f))
    }
  }
  return { count, bytes }
}

/** 淘汰：按 lastWriteAt 最旧的先删，直到不超过 maxEntries。 */
export function prune(maxEntries = 2000) {
  const all = []
  if (!existsSync(CACHE_DIR)) return { removed: 0 }
  for (const shard of readdirSync(CACHE_DIR)) {
    const dir = join(CACHE_DIR, shard)
    let files
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const p = join(dir, f)
      let stamp = ''
      try {
        stamp = JSON.parse(readFileSync(p, 'utf8')).lastWriteAt ?? ''
      } catch {
        stamp = ''
      }
      all.push({ p, stamp: stamp || '1970-01-01T00:00:00.000Z' })
    }
  }
  if (all.length <= maxEntries) return { removed: 0 }
  all.sort((a, b) => (a.stamp < b.stamp ? -1 : 1))
  let removed = 0
  for (const item of all.slice(0, all.length - maxEntries)) {
    try {
      unlinkSync(item.p)
      removed++
    } catch {
      /* ignore */
    }
  }
  return { removed }
}
