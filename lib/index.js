/**
 * dsh-term-lens — host half.
 *
 * A Cordis plugin (loaded as an out-of-tree bundle row, see cordis.patch.yml)
 * that gives the DSH web GUI a "select a term, get it explained" path without
 * leaving the app, without touching the conversation, and without spending a
 * single API token.
 *
 * Responsibilities:
 *   1. Own the ~/.dsh-term-lens/ config + cache + history on disk.
 *   2. Register the `/term-lens/*` routes on the DSH webserver service
 *      (`ctx.webServer`) — same-origin, so the browser half can just fetch them.
 *   3. Talk to a local Ollama instance (default http://127.0.0.1:11434) and
 *      stream the explanation back over SSE.
 *   4. Fall back to web search + synthesis when the local model is unsure.
 *
 * Everything here is deliberately independent of the harness LLM service: term
 * lookup must not disturb the agent's model, its KV cache, or its credit.
 */
import { loadConfig, ensureDirs, storageStatus, DEFAULT_CONFIG, CONFIG_VERSION, CONFIG_PATH, ROOT, CACHE_DIR } from './config.js'
import { registerRoutes } from './routes.js'
import { probe, warmUp } from './ollama.js'
import { installClientSync } from './client-sync.js'

/** Service dependencies. `webServer` must exist before we register routes. */
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx) {
  const logger = ctx.logger ?? console

  // ⚠️ 从这里往下**任何一步失败都不能让插件消失**。
  //
  // 原来 ensureDirs() 是裸的 mkdirSync：家目录只读、磁盘满、`~/.dsh-term-lens`
  // 被一个同名文件占住 —— 任一情况下异常都会冒出去，整个插件不加载，
  // 用户看到的是「插件装了但什么都不发生」，而且界面上没有任何原因。
  // 现在目录/配置的失败都被降级成「带着问题继续加载」，原因通过 /status 报给设置页。
  const storage = ensureDirs()
  if (!storage.ok) {
    logger.warn('[term-lens] 数据目录不可用(%s): %s', ROOT, storage.error)
    logger.warn('[term-lens] 插件仍会加载,但配置、缓存、查词历史都无法落盘')
  }

  let config
  try {
    config = loadConfig(logger)
  } catch (err) {
    // 兜底：连读配置都抛了，就用内存里的默认值把插件拉起来
    logger.warn('[term-lens] 读取配置失败,改用内存默认值: %s', err?.message ?? err)
    config = structuredClone(DEFAULT_CONFIG)
    config.configVersion = CONFIG_VERSION
  }
  logger.info('[term-lens] 配置: %s (model=%s, ollama=%s)', CONFIG_PATH, config.ollama.model, config.ollama.baseURL)

  // 让本地模型常驻显存。首次加载 4B 模型要好几秒,预热能把这段等待挪到插件启动时。
  // 失败不影响插件启动:用户可能只是还没启动 Ollama,状态接口会把这件事告诉 UI。
  const health = await probe(config)
  if (health.ok) {
    logger.info('[term-lens] Ollama 就绪 (v%s, %dms)', health.version ?? '?', health.latencyMs)
    warmUp(config).catch((err) => logger.warn('[term-lens] 预热失败: %s', err.message))
  } else {
    logger.warn(
      '[term-lens] 连不上 Ollama (%s): %s。插件已加载,解释功能会在 Ollama 启动后自动可用。',
      config.ollama.baseURL,
      health.error,
    )
  }

  const disposers = registerRoutes(ctx, config, logger, { storage })

  // 客户端 bundle 版本同步。
  //
  // Desktop 版的主窗口是一个长期存活的页面，而「重新加载页面」菜单项只在
  // development 构建里出现 —— 所以改了 lib/client.js 之后，用户重启应用也
  // 未必能让页面重新拉 bundle，浏览器里跑的还是旧代码。
  // 这里注入一段一次性重载，让宿主(必然是最新的)把页面推进到新版本。
  //
  // 它需要 webserver 的 index 注入能力；拿不到就静默跳过，不影响主功能。
  try {
    const syncDisposer = installClientSync(ctx, logger)
    if (syncDisposer) disposers.push(syncDisposer)
  } catch (err) {
    logger.warn('[term-lens] 客户端版本同步安装失败(不影响主功能): %s', err?.message ?? err)
  }

  logger.info('[term-lens] 已注册 %d 条路由: /term-lens/*   缓存目录: %s', disposers.length, CACHE_DIR)
  logger.info('[term-lens] 数据目录: %s', ROOT)

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    logger.info('[term-lens] 已卸载')
  }
}

export default { inject, apply }
