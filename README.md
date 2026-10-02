# dsh-term-lens

> 在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 里选中术语 → 本地模型流式解释 → 词旁浮卡 / 右侧栏卡片。
> **不离开 DSH、不开浏览器、不污染对话上下文、不消耗 API 额度。**

写代码时突然蹦出一个不认识的专业名词，现在不用切浏览器、也不用在对话里问一句
（那既浪费 token，又会把无关内容写进本次任务的 transcript）。选中它，解释就出来了。

**核心差异是「语境感知」**：普通查词只给通用定义，term-lens 会读你选词所在的那段
代码或消息，回答「**在你这儿**它是什么意思」。

```
选中 backpressure ──▶ 词旁浮出「解释」 ──▶ 点一下 ──▶ 边生成边显示
                                              │
                                              ├─ 在这个语境里：下游消费速度跟不上时，上游自动减缓数据速率…
                                              ├─ 要点 / 容易搞错 / 相关术语
                                              └─ ⧉ 固定到页面上 · 追问 · 发进对话
```

## 它解决什么

| 以前 | 现在 |
|---|---|
| 选中词 → 切浏览器 → 搜索/AI → 读一段 → 切回来 | 选中词，词旁浮出小卡片，**首字 100ms 上下** |
| 在对话里问「XX 是什么」，占用上下文、消耗 token | 完全旁路，对话和 Agent 一点都不受影响 |
| 复制到别的 AI 工具，还得补上下文 | 自动把选词所在的段落一起喂给模型 |

## 功能

- **选中即解释** —— 词旁浮出「解释」小按钮（可关），或按 `Ctrl+Shift+E`
- **流式出字** —— 边生成边显示，不用干等
- **语境感知** —— `在这个语境里` 字段真的读你给的上下文（靠 JSON Schema 的
  `required` 强制，不是靠提示词祈求 —— 见[工程笔记](docs/ENGINEERING-NOTES.md)第 2 条）
- **磁盘缓存** —— 同一个词第二次选中是**零延迟、离线可用**（实测 3-4ms）
- **查词历史** —— 本次会话查过的词留在侧栏，可回看、可删除
- **相关术语链式查询** —— 解释里的相关术语点一下继续查
- **追问** —— 看完卡片还能就同一个词继续问（走独立端点、不落缓存）
- **发进对话** —— 一键把解释复制成 markdown，粘到输入框即可（不碰 composer 状态）
- **可固定 / 可拖拽缩放** —— 浮卡能钉在页面上，也能拖八个边角改大小
- **模型可切换** —— 缓存按模型分桶；换模型不会串味
- **联网降级** —— 本地模型 `confidence` 低或你手动点「联网重查」时，**多个搜索后端
  并发竞速**，谁先给出可用结果用谁；一个都没成功时浮卡会**写明原因**

## 前置条件

| 需要 | 说明 |
|---|---|
| DSH | 在 **0.2.0-rc.2**（Desktop 构建）上开发与验证 |
| Node.js | **>= 18**（`dsh plugin add` 走 pnpm，需要全局 `fetch`） |
| [Ollama](https://ollama.com) | 本机跑着，默认地址 `http://127.0.0.1:11434` |
| 一个模型 | 默认 `qwen3:4b`（快）；`deepseek-r1:8b` 更准但明显更慢 |

**这个插件不调用任何云模型，也不花你的 API 额度。** 默认只有一个例外：`web.mode`
不为 `off` 时，你选中的**术语**会被发到搜索引擎（仅术语 + 「含义 原理」，
不发上下文、不发对话内容）。详见[联网搜索用哪个后端](#联网搜索用哪个后端)。

## 安装

### 1. 装 Ollama 和模型

```powershell
ollama serve                # 或者直接启动 Ollama 应用
ollama pull qwen3:4b        # 默认模型,快
ollama pull deepseek-r1:8b  # 可选,更准但更慢
```

### 2. 装插件

```powershell
git clone https://github.com/Kiton-Huang/dsh-term-lens.git
dsh plugin --profile desktop add link:<clone 下来的绝对路径>
```

把 `--profile desktop` 换成你自己的 profile 名（`.dsh/profiles/` 下的目录名）。
Windows 路径写成 `link:D:\code\dsh-term-lens`（不加引号，也不要写成 `/d/...`）。

<details>
<summary>其他安装方式</summary>

- **git 依赖**：`dsh plugin --profile desktop add github:Kiton-Huang/dsh-term-lens`
  （pnpm 的 git 依赖写法，本次发布未验证）
- **本地开发**：把仓库 clone 到任意位置后用上面的 `link:` 安装，改代码不用重装

</details>

### 3. 重启 DSH

宿主半（`lib/index.js`）在启动时加载，**必须重启才生效**。客户端半（`lib/client.js`）
由宿主在页面里注册 —— 而 Desktop 版的主窗口是一个长期存活的页面，不会自己重新加载，
所以同样需要重启。

### 4. 验证

```powershell
Invoke-RestMethod http://127.0.0.1:19387/term-lens/status
```

端口换成你自己的（DSH Desktop 每次启动的端口可能不同，看主窗口地址栏）。
`ollama.ok` 为 `true` 且 `readiness.modelReady` 为 `true` 就通了。

然后随便选中一个词试一下。默认是「选中浮出按钮、点了才解释」——
不会在你只是随手选中复制时白跑一次模型。

## 配置

### 图形界面（推荐）

**设置 → 术语透镜**（和「Wallpaper Engine」并列在设置面板左侧导航里）。
能改模型、Ollama 地址、触发方式、快捷键、联网模式与搜索后端、解释风格与语言、
自定义要求、缓存上限；还能看运行状态、清空缓存、看到配置文件的实际路径。

保存时如果某个值不合法（比如地址忘了写 `http://`），设置页会**逐条告诉你哪一项
没保存成功、为什么**，而不是笼统地提示「已保存」。

### 配置文件

也可以直接编辑 `~/.dsh-term-lens/config.json`（改完重启 DSH 生效）：

```jsonc
{
  "provider": "ollama",
  "ollama": {
    "baseURL": "http://127.0.0.1:11434",
    "model": "qwen3:4b",       // 默认;deepseek-r1:8b 更准但更慢
    "think": false,            // 关掉思考链,显著降低首字延迟
    "keepAlive": "30m",        // 让模型常驻显存,避免每次重新加载
    "numPredict": 900,         // 单次生成上限(只能手改文件,设置页没有这一项)
    "temperature": 0.2
  },
  "web": {
    "enabled": true,
    "mode": "auto",            // auto = confidence 低时自动联网 | manual | off
    "engine": "auto",          // auto | duckduckgo | bing | so360 | baidu | sogou | off
    "autoBelowConfidence": "low",
    "maxResults": 5,
    "timeoutMs": 8000
  },
  "trigger": {
    "minLength": 2,
    "maxLength": 80,
    "showFloatingChip": true,  // 选中后在文本旁浮出「解释」按钮
    "autoOpenCard": false,     // 默认 false = 点了才解释;true = 选中就跑模型
    "chipPlacement": "above",  // above（默认,不遮住下一行）| below
    "shortcut": "Ctrl+Shift+E"
  },
  "prompt": {
    "language": "zh-CN",
    "style": "standard",       // concise | standard | deep,或你自己建的风格名
    "styles": [],              // 自建风格:[{ name, hint }]
    "customSystem": null,      // 追加到 system prompt 的自定义要求
    "followUp": true           // 关掉后浮卡里不显示追问输入框
  },
  "cache": { "enabled": true, "maxEntries": 2000 },
  "configVersion": 1
}
```

数据都在 `~/.dsh-term-lens/`：`config.json`、`cache/`、`history/`。
设置页读写的就是这个文件 —— **不占用 DSH 的 profile 设置**，也不会污染
`cordis.patch.yml`。

> `config.json` 里有个 `configVersion`。插件改了**默认值**时它 +1，版本对不上就用新
> 默认值重建，并把旧文件改名成 `config.json.v<N>.bak` 备份（不删）。如果你手改配置
> 写坏了 JSON，原文件会先备份成 `config.json.corrupt-<时间戳>.bak` 再重建 ——
> 不会无声丢掉你写的东西。

## 三级降级

```
① 磁盘缓存  →  零延迟、离线可用（同词同上下文实测 3-4ms）
② 本地模型  →  qwen3:4b，首字 ~100ms
③ 联网搜索  →  只在 confidence 低或你手动点「联网」时触发
```

这样既拿到「本地秒回」的好处，又不会因为 4B 模型不认识某个新词而卡住。

### 联网搜索用哪个后端

`web.engine` 决定问谁，默认 `auto` = **DuckDuckGo + 360搜索 并发竞速**：
谁先给出「可用」结果就用谁，其余的立刻取消 —— 而不是串行等满超时。

「可用」有一道**相关性自检**：结果的标题或摘要里必须出现查询词中的某个词。
这不是洁癖：实测 Bing 在部分网络下对任何查询都返回一堆无关页面（查
`backpressure` 回来的是校园招聘、CCTV-5、Steam 游戏页），不做自检就会把垃圾
喂给模型 —— 那比「什么都没搜到」更糟。

各后端实测（2026-10，国内网络、无代理）：

| 后端 | 可达性 | 备注 |
|---|---|---|
| DuckDuckGo | 国内连不上（8s 超时） | 国际网络下结果最完整：有链接、有摘要，能抓正文 |
| 360搜索 | 连续 6 次全部成功，615-916ms | **国内最稳**；部分结果是直链，能抓正文 |
| 百度 | 第 5 次左右开始要求人机验证 | 标题相关性最好；结果链接是 JS 跳转，抓不到正文 |
| 搜狗 | 第 5 次被拦 | 标题+摘要可用，链接同样是 JS 跳转 |
| Bing | 可达，但结果常与查询无关 | 靠相关性自检挡住 |

失败**不会静默**：`/explain` 会发 `web-error` 事件，浮卡顶部显示一行
「联网搜索没有拿到可用资料：DuckDuckGo 超时」，同时 `done.viaWeb` 保持 `false`
（没真的用上网络材料，就不打「联网」标记）。想彻底不碰第三方，把 `web.mode`
设为 `off`。

## 端点

插件在 DSH 的 webserver 上注册一条 `/term-lens/*` 前缀路由（同源，所以浏览器半
直接 `fetch` 即可）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/term-lens/status` | 插件 + Ollama 健康状态、配置摘要、缓存统计、`storage`（数据目录是否可写） |
| GET | `/term-lens/models` | 本机 Ollama 模型列表 |
| POST | `/term-lens/explain` | 解释一个术语（SSE 流式） |
| POST | `/term-lens/chat` | 围绕同一术语追问（SSE 流式，纯文本，**不落缓存**） |
| POST | `/term-lens/warmup` | 预热模型（切模型后调用） |
| GET/POST/DELETE | `/term-lens/history` | 会话查词历史（DELETE 给 `term` 删单条、不给则清空） |
| GET | `/term-lens/cache` | 缓存统计 + 最近条目 |
| POST | `/term-lens/cache/clear` | 清空缓存 |
| GET/POST | `/term-lens/config` | 读/改配置（白名单字段；响应里带 `ignored`：被丢弃或钳制的字段及原因） |
| GET | `/term-lens/diag` | 客户端回传的宿主能力探测报告 |
| GET | `/term-lens/client-bundle.js` | 宿主自供的客户端 bundle（兜底） |
| GET | `/term-lens/env`、`/term-lens/client-ping` | 页面环境探测与注入脚本回执（排障用） |

`/explain` 的 SSE 事件：`meta` → `delta`×N →（`web-start` → `web-done` / `web-error`）→ `done`，
出错时是 `error`。`web-error` 的 data 是 `{ message, attempts }`，`attempts` 逐个后端给出
`{ engine, ok, reason, ms, count }`，`reason` 取值
`ok | timeout | unreachable | blocked | empty | irrelevant | cancelled`。

## 出问题先看诊断

Desktop 版没有可用的 DevTools，浏览器里的 console 看不到。所以客户端会把**它探测到的
宿主能力**回传给宿主：

```powershell
Invoke-RestMethod http://127.0.0.1:19387/term-lens/diag | ConvertTo-Json -Depth 8
```

它会告诉你：

- `clientBuild` —— **浏览器里跑的客户端版本号**。和 `lib/client.js` 里的
  `CLIENT_BUILD` 对不上，就说明浏览器加载的是旧 bundle。这是排查「改了没生效」的
  第一步，比任何猜测都直接
- `keys` —— `ctx` 上实际挂了哪些服务（判断宿主到底有没有 `slots` / `sidebarRightTabs`）
- `checks` —— 每个服务在不在、有没有我们要调的方法
- `slotReport` —— 每一项插槽注册的结果：`registered` / `waiting-declaration` / `threw: ...`
- `errors` —— 注册过程中抛出的具体错误

**返回 `null` 说明客户端从来没跑过诊断回传** —— 那基本可以断定 bundle 是旧的。

`stats` 把三种情况分开记：

| 字段 | 含义 |
|---|---|
| `posts` | 客户端 POST 过几次诊断。`0` = 客户端从没跑起来 |
| `clientPings` | **注入脚本回执过几次。`0` = 宿主注入的脚本根本没到达渲染进程** |
| `gets` | 查询过几次（含你自己这次） |

- `posts: 0` **且** `clientPings: 0` → 注入通道不通
- `posts: 0` **但** `clientPings > 0` → 注入通了、页面也重载了，但客户端 bundle 仍没加载
  → 问题在 bundle 供给，不在重载

「设置页没出现」「右栏没接管」这类问题，答案都在这份报告里。

### 改了客户端代码却没生效？

**Desktop 版有个特殊约束**（实测）：主窗口是一个长期存活的页面，通过
`loadURL('http://127.0.0.1:<随机端口>/')` 加载；而「重新加载页面」菜单项被包在
`development ? [...] : []` 里，**正式版不显示**，也没有注册 `F5` / `Ctrl+R`。

所以改了 `lib/client.js` 之后**重启 DSH**。改客户端代码时记得把 `CLIENT_BUILD`
加一 —— 否则你无法从外部判断新版有没有送达（对比 `/diag` 里的 `clientBuild`）。

## 开发

```powershell
# 一键跑全部（依赖真实模型的那些会自动跳过）
node test/run-all.mjs

# 加上真实生成（会真的调本地模型）
$env:SMOKE_LLM="1"; node test/run-all.mjs

# 单独跑某一个
node test/host-smoke.mjs         # 纯逻辑 + Ollama 连通性（不启 DSH）
node test/config-migration.mjs   # 配置结构版本迁移
node test/routes-smoke.mjs       # 路由集成（起真 http 服务跑完整链路）
node test/diag-check.mjs         # 诊断通道 /diag
node test/client-sync.mjs        # 客户端投递（崩溃安全）
node test/client-contract.mjs    # 客户端 bundle 契约（用 DOM/React 替身真的执行 client.js）
node test/style-effect.mjs       # 风格是否真的进了缓存指纹
node test/quality.mjs            # 解释质量（inContext 命中率、语言锁定、延迟）
node test/followup-quality.mjs   # 追问质量（不泄漏推理链、不被截断）
```

> ⚠️ 测试会写**真实的** `~/.dsh-term-lens/`（往缓存和历史里加条目）。
> 只有 `test/config-migration.mjs` 是隔离的。想全部隔离，跑之前设一下：
> `$env:DSH_TERM_LENS_HOME="$env:TEMP\term-lens-test"`

代码结构：

```
lib/index.js       宿主半入口（cordis 插件：注册路由 + 客户端版本同步）
lib/routes.js      /term-lens/* 全部端点 + 配置白名单与校验
lib/ollama.js      Ollama 客户端（node:http，流式 NDJSON）
lib/prompt.js      提示词与 JSON Schema（有没有上下文用两份 schema）
lib/cache.js       磁盘缓存（termKey × variantKey 两级指纹）
lib/websearch.js   联网降级（多后端并发竞速 + 相关性自检）
lib/client.js      浏览器半（整个 UI：浮卡 / 侧栏 / 设置页，classic script）
lib/client-sync.js 宿主往页面注入的只读观测脚本
lib/config.js      配置与路径（含版本迁移）
```

## 已知限制

- **选区监听依赖非公开 DOM** —— 插槽是预留渲染位，不是 DOM 事件，「任意位置选中即用」
  只能自己挂 `selectionchange` / `mouseup`。这是本插件唯一依赖非公开 DOM 的部分，
  已在滚动/重排时做收起处理，但 DSH 大改版时这里最可能先坏。
- **「发进对话」是复制到剪贴板**，不是直接插入 composer —— DSH 没暴露公开的插入 API，
  所以需要你手工 `Ctrl+V`。
- **侧栏 tab 的注册是尽力而为** —— `sidebarRightTabs` / `slots` 的第三方用法没有官方
  文档和先例，注册失败会退化成自带的兜底侧板（功能不丢）。
- **联网降级依赖第三方结果页** —— 是 HTML 抓取，没有 API 契约，改版就可能失效；
  国内几个后端连续查询后还会要求人机验证（届时会明确提示「被反爬拦下」）。
- **缓存键的取舍** —— 同词不同语境各存一个变体，只有完全相同的
  (词, 上下文, 风格) 才会命中。这是「同词秒回」和「语境准确」之间的取舍。
- **提示词一改，全部缓存失效** —— 缓存键里含 `PROMPT_VERSION`，这是刻意的。

更多设计与踩坑记录见 **[docs/ENGINEERING-NOTES.md](docs/ENGINEERING-NOTES.md)**。

## 许可

[MIT](LICENSE)
