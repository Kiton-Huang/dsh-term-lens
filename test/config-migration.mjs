/**
 * 配置结构迁移测试。
 *
 * 起因是一个真实的 bug：把 `autoOpenCard` 的默认值改成 false（选中只浮按钮、
 * 点了才解释），但用户机器上的 `config.json` 里存着旧值 true ——
 * 加载是「用文件覆盖默认」，于是**改代码里的默认值等于没改**，
 * 用户看到的现象是「还没按就弹出来了」。
 *
 * 修法是给配置加结构版本，版本对不上就重建（旧文件改名备份）。
 * 这里守着那条路径。
 *
 *   node test/config-migration.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const log = (...a) => console.log(...a)
let failures = 0
function check(name, fn) {
  try {
    fn()
    log(`  ok   ${name}`)
  } catch (err) {
    failures++
    log(`  FAIL ${name}: ${err?.message ?? err}`)
  }
}

/** 在一个隔离目录里跑一遍 loadConfig（用 DSH_TERM_LENS_HOME 覆盖根目录）。 */
async function loadIn(dir, logger) {
  process.env.DSH_TERM_LENS_HOME = dir
  // 每轮换一个 query 串来绕过 ESM 模块缓存
  const mod = await import(`../lib/config.js?dir=${encodeURIComponent(dir)}&t=${Date.now()}`)
  return mod.loadConfig(logger)
}

const silent = { info() {}, warn() {}, error() {}, debug() {} }
const dirs = []
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'tl-cfg-'))
  dirs.push(d)
  return d
}

const OLD_CONFIG = {
  provider: 'ollama',
  ollama: { baseURL: 'http://127.0.0.1:11434', model: 'qwen3:4b', think: false, keepAlive: '30m', temperature: 0.2 },
  web: { enabled: true, mode: 'auto', autoBelowConfidence: 'low', maxResults: 5 },
  // 关键：旧默认值
  trigger: { minLength: 2, maxLength: 80, showFloatingChip: true, autoOpenCard: true, shortcut: 'Ctrl+Shift+E' },
  prompt: { language: 'zh-CN', style: 'standard', customSystem: null },
  cache: { enabled: true, maxEntries: 2000 },
  // 注意：没有 configVersion —— 这正是「旧配置」的标志
}

log('== dsh-term-lens 配置迁移测试 ==')

log('\n-- 首次运行 --')
const d1 = freshDir()
let cfg = await loadIn(d1, silent)
check('生成的配置带当前结构版本', () => {
  assert.equal(typeof cfg.configVersion, 'number', '缺少 configVersion')
  assert.ok(cfg.configVersion >= 1)
})
check('新配置的 autoOpenCard 是新默认值 false', () => {
  assert.equal(cfg.trigger.autoOpenCard, false, `期望 false，实际 ${cfg.trigger.autoOpenCard}`)
})
check('新配置被写到磁盘', () => {
  const onDisk = JSON.parse(readFileSync(join(d1, 'config.json'), 'utf8'))
  assert.equal(onDisk.trigger.autoOpenCard, false)
  assert.equal(onDisk.configVersion, cfg.configVersion)
})

log('\n-- 旧配置（没有 configVersion、autoOpenCard=true）必须被迁移 --')
const d2 = freshDir()
writeFileSync(join(d2, 'config.json'), JSON.stringify(OLD_CONFIG, null, 2), 'utf8')

const messages = []
cfg = await loadIn(d2, { ...silent, info: (...a) => messages.push(a.join(' ')), warn: (...a) => messages.push('WARN ' + a.join(' ')) })

check('旧值不再压制新默认值', () => {
  assert.equal(cfg.trigger.autoOpenCard, false, `迁移后仍是 ${cfg.trigger.autoOpenCard} —— 这就是那个 bug`)
})
check('迁移后带上结构版本', () => {
  assert.equal(cfg.configVersion, 1)
})
check('旧配置被改名备份（不删，用户可找回）', () => {
  const files = readdirSync(d2)
  const backup = files.find((f) => f.startsWith('config.json.v') && f.endsWith('.bak'))
  assert.ok(backup, `没有生成备份，实际文件: ${files.join(', ')}`)
  const saved = JSON.parse(readFileSync(join(d2, backup), 'utf8'))
  assert.equal(saved.trigger.autoOpenCard, true, '备份里应当保留用户原来的值')
})
check('迁移会打日志说明去向', () => {
  assert.ok(
    messages.some((m) => m.includes('配置结构版本')),
    `应当记录迁移，实际: ${messages.join(' | ') || '(无)'}`,
  )
})

log('\n-- 已是当前版本时不该再次迁移 --')
const d3 = freshDir()
// 先正常生成一次
cfg = await loadIn(d3, silent)
const versionNow = cfg.configVersion
// 用户手动改一个值
const p3 = join(d3, 'config.json')
const edited = JSON.parse(readFileSync(p3, 'utf8'))
edited.trigger.shortcut = 'Ctrl+Alt+T'
edited.prompt.style = 'deep'
writeFileSync(p3, JSON.stringify(edited, null, 2), 'utf8')
// 再加载
cfg = await loadIn(d3, silent)
check('同版本时保留用户的自定义值', () => {
  assert.equal(cfg.trigger.shortcut, 'Ctrl+Alt+T', '用户设置被重置了 —— 迁移条件写错了')
  assert.equal(cfg.prompt.style, 'deep')
})
check('同版本时不再产生备份', () => {
  const backups = readdirSync(d3).filter((f) => f.endsWith('.bak'))
  assert.equal(backups.length, 0, `不该有新备份: ${backups.join(', ')}`)
})
check('结构版本仍是当前值', () => {
  assert.equal(cfg.configVersion, versionNow)
})

log('\n-- 损坏的配置不该让插件起不来 --')
const d4 = freshDir()
writeFileSync(join(d4, 'config.json'), '{ 这不是合法 JSON', 'utf8')
cfg = await loadIn(d4, silent)
check('解析失败时退回默认值并继续', () => {
  assert.equal(cfg.trigger.autoOpenCard, false)
  assert.equal(cfg.configVersion, 1)
})

log('\n-- 结构版本必须原样保存（否则每次改设置都会触发迁移）--')
const d5 = freshDir()
cfg = await loadIn(d5, silent)
const { mergeConfigForTest } = await import(`../lib/routes.js?t=${Date.now()}`).catch(() => ({}))
check('routes.js 的 mergeConfig 认识 configVersion（源码层校验）', () => {
  const src = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  assert.ok(
    /patch\.configVersion/.test(src),
    'mergeConfig 没有保留 configVersion —— 保存设置后会丢掉版本，下次加载就会重置用户配置',
  )
})
void mergeConfigForTest

// 收尾
for (const d of dirs) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

log(`\n== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ==`)
process.exit(failures === 0 ? 0 : 1)
