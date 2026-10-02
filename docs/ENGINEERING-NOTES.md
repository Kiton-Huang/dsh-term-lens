# 工程笔记

> 这些是开发 dsh-term-lens 时实测踩出来的坑，不是理论推测。
> 改这个插件的代码之前值得读一遍 —— 每一条都对应一次真实的返工。
>
> 返回 [README](../README.md)

这几条都是实测出来的，不是理论推测。改这个插件前值得读一遍。

### 1. `format: 'json'` 不够，必须给 JSON Schema

只给 `format: 'json'` 时 qwen3:4b 会**复读同一串 token** 直到撞上预测上限，
Ollama 直接报 `prediction aborted, token repeat limit reached`。
改成传 schema 对象（约束解码）后就没问题了，且强制了必填字段。

### 2. 把 `inContext` 放进 schema 的 `required` 是关键

**只在提示词里要求「必须填写 inContext」，4B 模型 4/5 的情况会合法地输出空串**
（它没违反任何约束 —— 字段存在，只是值为 `""`）。一旦进 `required`，约束解码
就强制它非空，5/5 通过。

这是本插件最核心的字段，不能靠提示词祈求。对照实验见
`test/experiment-incontext.mjs`。

### 3. 语言锁定要写死

上下文是英文时，模型会**跟着用英文回答**，无视 `language: 'zh-CN'`。
提示词里必须明确「即使用户给的上下文是英文，你的每一个字段也要用中文写」，
并且用 `test/quality.mjs` 的中文占比断言盯住它。

### 4. 样式表必须打 `data-plugin` 归属标记

`dsh-client-modules` 的 `claimStyles()` 在**每个**插件物化时，会把 DOM 里所有
**没有 `data-plugin` 属性**的 `<style>` 统统盖成那个插件的 id，之后那个插件卸载
就会把它们删掉。不打标记的样式迟早会莫名消失。

```js
el.dataset.plugin = 'dsh-term-lens'
el.dataset.pluginCss = 'dsh-term-lens/styles.css'
```

因为我们的浮卡挂在 `document.body` 上（不在 DSH 的插槽树里），加载器会认为这个
bundle 仍被占用、不会替我们清理，所以卸载时按标记自己精确移除。

### 5. 顶层 `inject` 声明空数组

插件的硬依赖会让 cordis fiber 一直等，只要宿主少了其中一个，**整个插件（包括
「选中即解释」这个主功能）就完全不加载**。而 `slots` / `sidebarRight` 只是锦上
添花的侧栏能力。

所以 `exports.inject = []`，侧栏能力改用运行时特性探测，拿不到就退化成自带的
兜底侧板 —— 功能不丢。

### 6. 客户端 bundle 的四条硬约束

- 必须是 **classic script**：加载器建 `<script>` 时不设 `type="module"`，
  所以 `import`/`export` 非法，用 CommonJS 风格的 shell
- `factory(require)` **必须 `return module.exports`** —— 加载器取返回值当 exports
- 注册的 `id` 必须**等于** `package.json` 的 `name`
- `require()` 只能要**冻结表**里的 key：`react`、`react/jsx-runtime`、`react-dom`、
  `react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`。没有 clsx、没有 zod。

### 7. 别用 PowerShell 改源文件

`Get-Content`/`Set-Content` 在中文 Windows 上会按 GBK 解读 UTF-8，把中文注释写坏
（而且是有损的：无法解码的序列会变成 `?`）。本插件的 `client.js` 就被这个坑损坏
过一次，只能重写。用编辑器/工具改文件。

### 8. 设置页要用 `settings.section`，并且必须经 `slots.inject`

想要「和壁纸引擎并列在设置导航里」，用的是 `settings.section`（`kind: 'list'`、
`scope: 'root'`、只需 `id`）。想塞进 Plugins 分区里当 tab 才用 `settings.plugins.tab`。

```js
ctx.slots.inject('settings.section', () =>
  ctx.slots.register({ name: 'settings.section', id: 'dsh-term-lens', order: 560, label: '术语透镜' },
    () => React.createElement(SettingsSection)),
)
```

**`slots.inject` 不是可选的**：`settings.section` 只在设置面板挂载期间才被声明
（由 `sidebar.settings` 的条目声明），直接 `register` 到未声明的插槽会 **throw**。
`label` 就是左侧导航上显示的文字。

`order` 决定导航位置：壁纸引擎用 500，term-lens 用 560，排在它后面。

### 9. 测试框架的一个自伤：顶层 `await` 会吞掉断言

契约测试用「先登记、最后统一执行」的结构（`check()` 只 push 进数组，末尾循环里
`await entry.fn()`）。这种情况下**文件里任何顶层 `await` 都会把模块求值卡住**，
使它之后的 `check()` 在循环跑完之后才登记 —— 那些检查永远不执行，而测试还报
「全部通过」。

比测试失败更危险的是测试假装通过。所有等待都必须放进检查函数内部；`check` 本身
是 async 且被 `await`，所以检查里可以自由 await。

### 10. 声明顺序错了只在运行时炸（暂时性死区）

重构时把 `closeCard` 上移，它引用了声明在**它后面**的 `runner` 和 `chipHost` ——
一调用就 `ReferenceError`，而契约测试没覆盖那条路径。

`tools/check-tdz.mjs` 会静态扫出「函数引用了在它之后声明的 const/let」，
并给出相差行数。带 `const` 的函数表达式（不是 `function` 声明）尤其危险。

### 11. Desktop 版的页面不会自己重新加载

主窗口是长期存活的页面，而「重新加载页面」菜单项只在 development 构建里存在，
也没有 `F5` / `Ctrl+R`。所以改了客户端 bundle 之后，重启应用不一定能让页面重新拉取，
你会看到「改了没生效」，且从外部完全看不出来。

`lib/client-sync.js` 通过 `webserver/index-inject` 注入一段一次性重载来解决这个问题。
两个要点：

- **注入必须用内联 `script` 行，不能用 `script-src`** —— 桌面端的注入表是一次性
  收集的，`script-src` 加载失败会 reject `__DSH_BOOT_READY__`，让整个应用起不来
- **重载守卫必须先把新 stamp 写进 localStorage 再 reload** —— 顺序反了就是无限刷新

### 12. 桌面版的主窗口是 HTTP 页面，不是 `file://`

`dsh-host-webserver` 的 README 说「Electron loads dist over `file://`」，但实测
0.2.0-rc.2 的桌面版主窗口是 `loadURL('http://127.0.0.1:<随机端口>/')`。
所以插件路由是同源的，`fetch('/term-lens/...')` 正常工作。

另外根路径 `/` 返回 **401**（要鉴权），而插件自己注册的路由不带鉴权 —— 这正是
`/term-lens/status` 能用、`Invoke-WebRequest http://127.0.0.1:19387/` 拿到 401 的原因。
排查时别把这两件事搞混。

### 13. 缓存键必须包含「所有影响输出的设置」

用户反馈「解释风格感觉没有生效」。查下来缓存键是这样：

```js
termKey   = sha1(术语 + 模型 + 提示词版本)   // ← 没有风格
variants[contextKey(上下文)]                 // ← 指纹里也没有风格
```

于是把风格从「标准」切到「详细」后，同一个词**依然命中同一条缓存** ——
提示词变了却拿到旧结果，用户看到的解释永远不变。

修法：`variantKey(上下文, 风格, 自定义要求)`，凡是进提示词的东西都要进指纹。
输出格式保持 `<上下文指纹>` 或 `<上下文指纹>.<后缀>`，这样干净上下文的老条目
仍能被相同上下文命中。

配套两件事，缺一个都会留下隐患：

- **`dropStaleVariants()`** —— 指纹变了之后，老条目永远命中不到却一直占磁盘。
  每次查缓存未命中时顺手清掉当前上下文下用不到的变体。
- **`routes-smoke.mjs` 里预置缓存的那段也要带上 style** —— 否则测试自己造出的
  缓存命中不了，表现为「缓存短路」那条测试莫名其妙地失败。

这条的通用教训：**加了会影响输出的设置项，就回去检查缓存键。** 遗漏不会报错，
只会安静地让设置失效。

### 14. schema 要分两种：有没有上下文不能用同一份

`inContext` 放进 `required` 是让模型真的读上下文的关键（实测 4/5 失败 → 0/5）。
但**只在有上下文时成立** —— 没有上下文时，`required` 变成了「必须编点什么」的压力。
同一个「死锁」用例（不给上下文）实测有三种行为：

```
1. "（未提供上下文）"                                   ← 守规矩
2. "当前无明确上下文，请使用默认说明：（未提供上下文）"     ← 包了一层废话
3. "当多个线程相互持有并等待对方释放不同资源时会导致系统无响应"  ← 直接编造
```

第 3 种约占一半（连跑 5 次命中 2 次）。**这是 schema 自己造成的**：模型没法输出
空串，只好拿通用定义来填。

我一开始想靠提示词解决（在 schema 的 `description` 里让它「原样抄哨兵串」），
治不了 —— 那是结构性压力，不是措辞问题。

正确做法：

- `EXPLANATION_SCHEMA` —— 有上下文，`inContext` 必须在 `required` 里
- `EXPLANATION_SCHEMA_NO_CTX` —— 没上下文，把 `inContext` 从 `required` 里去掉，
  模型可以合法地给空串，就不用编了
- `schemaFor(context)` 按情况挑

顺带修了 `cleanInContext`：模型会把哨兵包在句子里（第 2 种），所以判据从
「精确相等」改成「短句内包含」。长度门槛 28 是量出来的 —— 真实 inContext 最短
32 字，带包装的哨兵 25 字。

修完之后连跑 6 次 6/6（之前 4 次里失败 2 次）。

### 15. 追问必须开 `think: true`，否则模型会把推理链写进正文

首轮解释用 JSON Schema 约束解码，所以能安全地 `think: false`（首字延迟更低）。
追问是自由文本、不能套 schema —— 但**去掉 schema 之后 `qwen3:4b` 就退回「边想边写」**，
把推理过程当答案吐出来。真实事故：

```
首先，用户说："我还是不太懂键"。这表明他对于"键"这个概念的理解还不够清晰。
回顾我已有的信息：
关键点：
最佳响应策略：
草拟回答：
```

并且稳定用满 `num_predict` 被截断。实测对比（`test/experiment-followup.mjs`）：

| 做法 | 正文里的推理标记 | 收尾 |
|---|---|---|
| `think:false` + 宽松提示词 | 4 个 | `done_reason=length`（截断） |
| `think:false` + **严格**禁元话语 | **5 个（更糟）** | `done_reason=length` |
| **`think:true`** | **1 个** | **`done_reason=stop`** |

第二行是这条笔记最有价值的部分：**在提示词里描述「不要做什么」，模型会把它当成
待办清单来复述。** 我在这上面白调了两轮。正确做法不是堵，而是让模型照它本来的
方式思考 —— 推理走 `message.thinking`，正文走 `message.content`，两者天然分开
（`test/check-thinking-separation.mjs` 专门核实这一点：thinking 2068 字 / content 213 字）。

代价是要给思考链留 token 预算（`numPredict: max(config, 2000)`），追问比首轮慢一些。
这是功能正确性的取舍，不是性能偏好。

### 16. 一个后端连不上，不能让整个降级链「静默消失」

联网降级原来只接 DuckDuckGo。国内网络下它必然超时（实测 8s），而
`searchWeb` 把所有异常都 `catch` 成空数组，`routes.js` 再判断
`materials.length > 0` 才继续 —— 于是**整段联网被无声跳过**：

> 用户点「联网重查」→ 等 11 秒 → 看到和刚才一模一样的解释 → 界面上一个字都没变。
> 他唯一能得出的结论是「这个按钮坏了」。

这一类问题的通用形状是：**降级链路失败 ≠ 主流程失败，但失败必须可见**。
修法分三层，缺一层都不完整：

1. **多后端并发竞速**（不是串行重试）—— 串行时一个 8s 超时的后端会把整体拖到
   8s 起步；并发的话最快的那个（实测 300-600ms）就决定体验
2. **上游结果要过相关性自检** —— 搜索引擎在异常/反爬时会返回**与查询无关**的结果页
   （Bing 实测：查 backpressure 返回校园招聘、CCTV-5、Steam）。这种垃圾进提示词
   比没有结果更糟，模型会拿它编答案。所以「有结果」不等于「可用」
3. **失败原因必须回到用户眼前** —— `web-error` 事件 + 浮卡上的提示条。
   只写进宿主日志是不够的：Desktop 版用户看不到日志

识别「被反爬拦下」也要单独处理：百度/搜狗在连续请求后会返回 **HTTP 200 + 一个
1.4KB 的「安全验证」页**。不识别的话会被当成「没有结果」，提示就变成了
「百度 没有结果」—— 而真相是「被拦了，换个后端或等一会儿」。

### 17. 插件的初始化不能让插件自己消失

`apply()` 里原来是裸的 `ensureDirs()`。家目录只读、磁盘满、`~/.dsh-term-lens`
被一个同名文件占住 —— 任一情况都会让 `mkdirSync` 抛异常，一路冒到 cordis，
**整个插件不加载**：路由没有、设置页没有、选中术语毫无反应，而界面上没有任何
解释「为什么」。实测（把数据目录指到一个被文件占住的路径）确认了这条路径。

现在目录/配置的失败都被降级成「带着问题继续加载」，原因通过 `/status` 的
`storage` 字段报给设置页。原则是：**能做的事照做，做不了的事说清楚**。

同一类问题的另外三处：

- **`config.json` 解析失败**原来是直接用默认值覆盖原文件 —— 用户手滑写坏一个
  逗号，自己写的一整份配置就无声没了。现在先改名成 `.corrupt-<时间戳>.bak` 再重建
  （版本迁移那条路本来就会备份，解析失败这条路漏了）
- **设置页写入非法值**原来是静默忽略、接口照样回 `200 {ok:true}`，设置页显示
  「已保存」而值根本没生效（比如地址忘了写 `http://`）。现在 `POST /config` 会返回
  `ignored: [{ path, reason, kind }]`，`kind` 区分「丢弃」和「已钳制」，设置页原样列出来
- **联网被关掉时点「联网重查」**也有反馈，而不是什么都不发生
