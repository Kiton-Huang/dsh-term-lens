/**
 * dsh-term-lens —— 配置与路径
 *
 * 所有持久化都落在 ~/.dsh-term-lens/ 下，端口无关（不像 localStorage 会被
 * 每次 Desktop 随机端口重置），也不进任何 DSH 自己的存储以免污染 profile。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

/**
 * 数据根目录。
 *
 * 默认 `~/.dsh-term-lens`；`DSH_TERM_LENS_HOME` 可以整体挪走 ——
 * 测试用它隔离，避免碰到用户的真实配置。
 */
export const ROOT = process.env.DSH_TERM_LENS_HOME || join(homedir(), '.dsh-term-lens')
export const CONFIG_PATH = join(ROOT, 'config.json')
export const CACHE_DIR = join(ROOT, 'cache')
export const HISTORY_DIR = join(ROOT, 'history')

/**
 * 配置结构版本。
 *
 * ⚠️ 每次改动 DEFAULT_CONFIG 里的**默认值**都要 +1。
 *
 * 为什么必需：加载配置是「用文件覆盖默认值」，所以一旦用户磁盘上有一份旧配置，
 * 改代码里的默认值就**等于没改** —— 旧值会一直压制新默认值。
 * 这个坑真实发生过：把 autoOpenCard 默认改成 false（选中只浮按钮、点了才解释），
 * 但用户机器上的 config.json 里存着 true，于是「还没按就弹出来了」。
 *
 * 版本一变就重新生成配置（先把旧文件改名备份，不删）。
 * 代价是用户的自定义设置会被重置一次，所以只在默认值变更时才 +1。
 */
export const CONFIG_VERSION = 1

export const DEFAULT_CONFIG = {
  /** 'ollama' = 宿主直连本地模型；'harness' = 走 DSH 当前模型（慢速兜底，P4 才实现） */
  provider: 'ollama',

  ollama: {
    baseURL: 'http://127.0.0.1:11434',
    /**
     * 默认 qwen3:4b：首字延迟低，适合「一眼看懂」的场景。
     * deepseek-r1:8b 更准但明显更慢，用户在浮卡上可即时切换（缓存按模型分桶）。
     */
    model: 'qwen3:4b',
    /** qwen3 系列默认带思考链，术语速解不需要，关掉能显著降低首字延迟 */
    think: false,
    /** 让模型常驻显存，避免每次查询都要重新加载（首次加载要好几秒） */
    keepAlive: '30m',
    /** 术语解释不需要长输出 */
    numPredict: 900,
    temperature: 0.2,
  },

  /** 联网搜索降级：模型 confidence 低、或用户手动点「联网」时触发 */
  web: {
    enabled: true,
    /** 'auto' = confidence 低时自动联网；'manual' = 只在用户点按钮时联网；'off' */
    mode: 'auto',
    /**
     * 用哪个搜索后端。取值见 websearch.js 的 ENGINE_CHOICES：
     *   auto        国际 + 国内各一个，**并发竞速**，谁先给出可用结果用谁（默认）
     *   duckduckgo  国际网络下结果最完整（有链接有摘要）；国内通常连不上
     *   so360       国内实测最稳（连续查询不被拦），部分结果能抓到正文
     *   bing        国际可用；存在「返回一堆无关结果」的形态，会被相关性自检挡下
     *   baidu       国内标题相关性最好，但几次之后会要求人机验证，且链接抓不到正文
     *   sogou       国内，标题+摘要可用；连续请求几次后会被拦
     *   off         完全关掉联网（选中术语只走本地模型）
     */
    engine: 'auto',
    /** 自动联网时 confidence 低于此值才触发 */
    autoBelowConfidence: 'low',
    maxResults: 5,
    timeoutMs: 8000,
  },

  trigger: {
    minLength: 2,
    maxLength: 80,
    /** 选中后浮出小按钮 */
    showFloatingChip: true,
    /**
     * 选中后是否【立刻】开始解释。
     *
     * 默认 false —— 要的是「选中 → 浮出按钮 → 点了才解释」。
     * 立刻解释会在用户只是随手选中（复制、定位光标）时白跑一次模型,
     * 还把卡片糊在脸上。想恢复旧行为可在设置里打开。
     */
    autoOpenCard: false,
    /** 按钮浮在选区的哪一侧:above（默认）| below */
    chipPlacement: 'above',
    /** 快捷键（DSH 键盘格式）；空串表示只靠浮出按钮 */
    shortcut: 'Ctrl+Shift+E',
  },

  prompt: {
    /** 解释用的自然语言 */
    language: 'zh-CN',
    /**
     * 解释风格。取值可以是下列之一：
     *   - 内置 id：'concise' | 'standard' | 'deep'
     *   - `styles` 里某个自建风格的 **name**
     * 名字都找不到时退回 standard（见 prompt.js 的 resolveStyleHint）。
     */
    style: 'standard',
    /**
     * 用户自建的风格档位。每项 { name, hint }：
     *   name —— 设置页下拉里显示的名字，也是 style 的取值
     *   hint —— 追加到 system prompt 里的实际要求
     * 做成可命名档位而不是一个自由文本框，是为了能在几套偏好之间快速切换
     * （比如「精简」「带 Java 例子」「只讲本项目用法」）。
     */
    styles: [],
    /** 追加到 system prompt 末尾的自定义指令（对所有风格都生效） */
    customSystem: null,
    /**
     * 追问（继续对话）是否允许。关掉后浮卡里不显示追问输入框 ——
     * 追问不走缓存、每次都要真实推理，慢机器上可以关掉。
     */
    followUp: true,
  },

  cache: {
    enabled: true,
    /** 缓存条目上限，超出后按最久未用淘汰 */
    maxEntries: 2000,
  },
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

/**
 * 建目录。
 *
 * ⚠️ **绝不抛错**。原来这里是裸的 mkdirSync，一旦失败（家目录只读、磁盘满、
 * `~/.dsh-term-lens` 恰好被一个同名文件占住、被安全软件拦），异常会冒到
 * index.js 的 apply() 里，结果是**整个插件不加载** —— 路由没有、设置页没有、
 * 选中术语毫无反应，而用户在界面上看不到任何解释「为什么」。实测确认过：
 * ENOTDIR 一路冒到 cordis，插件静默消失。
 *
 * 现在改成「记下失败原因并继续」：插件照常加载，/status 把 storage.ok=false
 * 和具体原因报给设置页，用户至少知道发生了什么。
 */
export function ensureDirs() {
  try {
    mkdirSync(ROOT, { recursive: true })
    mkdirSync(CACHE_DIR, { recursive: true })
    mkdirSync(HISTORY_DIR, { recursive: true })
    storageError = null
  } catch (err) {
    storageError = err
  }
  return storageStatus()
}

/** 最近一次目录准备的结果，供 /status 与设置页显示。 */
export function storageStatus() {
  return {
    ok: !storageError,
    root: ROOT,
    error: storageError ? String(storageError.message ?? storageError) : null,
  }
}

let storageError = null

export function loadConfig(logger) {
  ensureDirs()
  let raw = null
  let parseError = null
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (err) {
    if (err && err.code !== 'ENOENT') parseError = err
  }

  // —— 坏配置先备份再重建 ——
  //
  // 版本迁移那条路会把旧配置改名成 `.v<N>.bak`，但**解析失败**这条路原来是直接
  // 用默认值把原文件覆盖掉 —— 用户手动编辑写坏一个逗号，自己写的东西就无声没了。
  // 现在同样留一份 `.corrupt-<时间戳>.bak`。
  if (parseError) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${CONFIG_PATH}.corrupt-${stamp}.bak`
    try {
      renameSync(CONFIG_PATH, backup)
      logger?.warn?.(
        `[term-lens] config.json 解析失败(${parseError.message}),已改用默认值;原文件备份在 ${backup}`,
      )
    } catch (err) {
      logger?.warn?.(`[term-lens] config.json 解析失败,且备份失败(${err.message});将直接用默认值`)
    }
    raw = null
  }

  // —— 结构版本迁移 ——
  //
  // 磁盘上那份配置如果来自旧的默认值，会一直压制代码里的新默认值。
  // 版本对不上就重新生成，并把旧文件改名备份（不删，用户可自行找回）。
  const stale = raw !== null && raw.configVersion !== CONFIG_VERSION
  if (stale) {
    const backup = `${CONFIG_PATH}.v${raw.configVersion ?? 0}.bak`
    try {
      renameSync(CONFIG_PATH, backup)
      logger?.info?.(
        `[term-lens] 配置结构版本 ${raw.configVersion ?? 0} → ${CONFIG_VERSION},已用新默认值重建;旧配置备份在 ${backup}`,
      )
    } catch (err) {
      logger?.warn?.(`[term-lens] 备份旧配置失败(仍会用新默认值): ${err.message}`)
    }
    raw = null
  }

  const config = deepMerge(DEFAULT_CONFIG, raw ?? {})
  config.configVersion = CONFIG_VERSION

  // 首次运行（或刚迁移完）把配置写出去,方便用户直接编辑
  if (raw === null) {
    try {
      writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    } catch (err) {
      logger?.warn?.(`[term-lens] 写入默认 config.json 失败: ${err.message}`)
    }
  }
  return config
}
