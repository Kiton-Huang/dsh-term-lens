/**
 * dsh-term-lens —— 提示词工程
 *
 * 核心难点：4B 小模型自由发挥会跑偏。所以
 *   1) 用 Ollama 的 format:'json' 强制结构化输出
 *   2) promptVersion 参与缓存键 —— 改提示词自动失效旧缓存
 *   3) 明确要求「结合用户给的上下文」，这是网页搜索做不到的部分
 */

/** 改这个数字会让所有磁盘缓存失效（缓存键里含它） */
export const PROMPT_VERSION = 7

/** 模型在「确实没有上下文」时应当原样抄回的哨兵串。 */
export const NO_CONTEXT_SENTINEL = '（未提供上下文）'

/**
 * 传给 Ollama `format` 的 JSON Schema —— 约束解码用。
 *
 * 这不是装饰,它解决两个实测问题:
 *
 * 1. 只给 `format: 'json'` 时 qwen3:4b 会复读同一串 token 直到撞上预测上限
 *    (Ollama 直接报 "token repeat limit reached")。给上 schema 后每个字段的
 *    取值被语法约束住,复读无从发生。
 *
 * 2. **把 inContext 放进 required 是让模型真的读上下文的关键。** 实测:只在
 *    提示词里要求「必须填写 inContext」,4B 模型 4/5 的情况会合法地输出空串;
 *    一旦进 required,约束解码就强制它非空 —— 5/5 通过。这是本项目最核心的
 *    字段,不能靠提示词祈求。
 *
 * ══ 所以 schema 要分两种 ═════════════════════════════════════════════
 *
 * 上面第 2 条只在**有上下文**时成立。没有上下文时，required 反而变成了
 * 「必须编点什么」的压力 —— 实测同一个「死锁」用例（不给上下文）：
 *
 *     1. "（未提供上下文）"                              ← 守规矩
 *     2. "当前无明确上下文，请使用默认说明：（未提供上下文）"  ← 包了一层废话
 *     3. "当多个线程相互持有并等待对方释放不同资源时会导致系统无响应"  ← 直接编造
 *
 * 第 3 种占了大约一半（连跑 5 次命中 2 次）。**这是我们自己造成的**：
 * 模型没法输出空串，只好拿通用定义来填。靠提示词打补丁治不了这种结构性压力，
 * 得按情况换 schema。
 *
 * - `EXPLANATION_SCHEMA`          —— 有上下文：inContext 必须非空
 * - `EXPLANATION_SCHEMA_NO_CTX`   —— 没上下文：inContext 不在 required 里，
 *   模型可以合法地给空串，就不用编了
 */
export const EXPLANATION_SCHEMA = {
  type: 'object',
  properties: {
    term: { type: 'string' },
    reading: { type: 'string' },
    oneLine: { type: 'string' },
    inContext: {
      type: 'string',
      description: '结合上下文说明它在这个具体场景里指什么，不要复述通用定义。',
    },
    bullets: { type: 'array', items: { type: 'string' } },
    pitfalls: { type: 'array', items: { type: 'string' } },
    related: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['term', 'why'],
      },
    },
    example: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  // inContext 必须在列:否则模型会合法地把它留空(实测 4/5 失败 → 0/5)
  required: ['term', 'oneLine', 'inContext', 'bullets', 'related', 'confidence'],
}

/** 没有上下文时用这个：inContext 允许为空，模型就不必编造。 */
export const EXPLANATION_SCHEMA_NO_CTX = {
  ...EXPLANATION_SCHEMA,
  properties: {
    ...EXPLANATION_SCHEMA.properties,
    inContext: {
      type: 'string',
      description: `用户没有提供上下文，这里留空字符串即可，不要编造场景。`,
    },
  },
  required: EXPLANATION_SCHEMA.required.filter((k) => k !== 'inContext'),
}

/** 按有没有上下文挑 schema。 */
export function schemaFor(context) {
  return context && context.trim() ? EXPLANATION_SCHEMA : EXPLANATION_SCHEMA_NO_CTX
}

const SCHEMA = `{
  "term": "规范化的术语原文(保留原大小写)",
  "reading": "音标或读音,没有就空串",
  "oneLine": "一句话说清它是什么(不超过40字,这是浮卡首屏唯一显示的内容)",
  "inContext": "结合用户给出的上下文,说明在这个具体场景里它指什么/起什么作用。如果用户没有给出上下文,必须原样输出这七个字:${NO_CONTEXT_SENTINEL}",
  "bullets": ["2到4条要点,每条不超过40字,讲清关键性质"],
  "pitfalls": ["0到3条常见误解或坑,没有就给空数组"],
  "related": [{"term": "相关术语", "why": "为什么相关(不超过20字)"}],
  "example": "一个最小代码示例(带语言标注的markdown代码块),与编程无关的术语给空串",
  "confidence": "high | medium | low"
}`

const STYLE_HINT = {
  concise: '解释要极简:oneLine 控制在25字内,bullets 最多2条,pitfalls 留空。',
  standard: '解释要准确且紧凑:oneLine 控制在40字内,bullets 2到4条。',
  deep: '解释要有深度:oneLine 控制在50字内,bullets 3到5条,要讲到原理、与相邻概念的区别,bullets 每条可放宽到60字。',
}

/** 内置风格在设置页里的显示名 */
export const BUILTIN_STYLES = [
  { id: 'concise', label: '精简回答 —— 一两句话说清', hint: STYLE_HINT.concise },
  { id: 'standard', label: '标准回答 —— 完整卡片', hint: STYLE_HINT.standard },
  { id: 'deep', label: '详细回答 —— 含原理与对比', hint: STYLE_HINT.deep },
]

/**
 * 解析成实际使用的风格提示。
 *
 * `prompt.style` 可以是内置 id，也可以是用户在设置里自建的风格**名字**。
 * 自建风格存在 `prompt.styles = [{ name, hint }]`。
 *
 * 为什么让用户能自建：内置三档覆盖不了所有偏好（有人要「多举 Java 例子」、
 * 有人要「只讲在这个项目里的用法」）。把偏好做成可命名的档位，比每次都在
 * 「自定义要求」里重打一遍要好用，也能在不同风格间快速切换。
 */
export function resolveStyleHint(prompt) {
  const want = typeof prompt?.style === 'string' ? prompt.style.trim() : ''
  if (want && STYLE_HINT[want]) return STYLE_HINT[want]
  const custom = Array.isArray(prompt?.styles) ? prompt.styles : []
  const hit = custom.find((s) => s && typeof s.name === 'string' && s.name.trim() === want)
  if (hit && typeof hit.hint === 'string' && hit.hint.trim()) return hit.hint.trim()
  // 名字找不到（比如风格被删了）时退回标准档，而不是让提示词缺一块
  return STYLE_HINT.standard
}

const LANG_NAME = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
}

/**
 * @param {object} opts
 * @param {string} opts.term        用户选中的术语
 * @param {string} [opts.context]   术语所在的上下文片段
 * @param {string} [opts.scene]     场景标签，如 'code' | 'chat' | 'ui'
 * @param {object} opts.prompt      config.prompt
 * @returns {{system: string, user: string}}
 */
export function buildMessages({ term, context, scene, prompt }) {
  const lang = LANG_NAME[prompt?.language] ?? LANG_NAME['zh-CN']
  const style = resolveStyleHint(prompt)

  const sceneLine = {
    code: '这段内容来自用户的源代码。',
    chat: '这段内容来自用户与 AI 的对话记录。',
    ui: '这段内容来自软件的界面文字。',
  }[scene] ?? ''

  let system = [
    '你是一个给程序员做术语速查的解释器。用户会在写代码或读技术文档时选中一个词,你要立刻给出精准、可用的解释。',
    '',
    '硬性要求:',
    `1. 严格输出 JSON,不要有任何解释性文字、不要用 markdown 代码块包裹整个 JSON。字段结构如下:`,
    SCHEMA,
    `2. 解释语言必须是${lang}。即使用户给的上下文是英文或其它语言,你的每一个字段也都要用${lang}写。只有术语本身和代码示例保持原文。`,
    '3. 术语本身保留原文,不要翻译成中文再解释。',
    '4. 如果这个词有多个含义,只解释最可能出现在上述上下文里的那一个,不要罗列所有义项。',
    '5. 宁可少说也不要编造。不确定就把 confidence 设为 low,并且不要虚构 API 名、库名、人名或数字。',
    '',
    '关于 inContext(这是最重要的字段,用户就是为了它才用这个工具):',
    '- inContext 是必填的,不允许空串。它已经被 JSON schema 约束,空着会被拒绝。',
    '- 不要复述通用定义。要说的是:在这个具体场景里,它扮演什么角色、为什么这里会出现它。',
    '- 举例:如果上下文是「消费者太慢时流会施加反压」,那么 inContext 应该是「下游消费速度跟不上时,上游被限速以免内存堆积」,而不是重新解释一遍反压的定义。',
    '- 只有用户完全没有提供上下文时,才写"（未提供上下文）"。',
    '',
    style,
  ].join('\n')

  if (prompt?.customSystem) {
    system += `\n\n用户附加要求:\n${prompt.customSystem}`
  }

  const userParts = [`术语: ${term}`]
  if (context && context.trim()) {
    userParts.push('', `它出现的上下文(请据此判断具体含义):`, '```', context.trim().slice(0, 4000), '```')
  }
  if (sceneLine) userParts.push('', sceneLine)

  return { system, user: userParts.join('\n') }
}

/**
 * 联网搜索结果的综述提示词：把抓到的网页片段喂给模型,让它只提取与术语相关的部分。
 */
export function buildWebMessages({ term, context, prompt, results }) {
  const lang = LANG_NAME[prompt?.language] ?? LANG_NAME['zh-CN']
  const style = resolveStyleHint(prompt)

  const system = [
    '你是一个给程序员做术语速查的解释器。本次你会拿到一些网页搜索结果的片段,请据此给出解释。',
    '',
    '硬性要求:',
    `1. 严格输出 JSON,不要有任何解释性文字、不要用 markdown 代码块包裹整个 JSON。字段结构如下:`,
    SCHEMA,
    '2. 只使用搜索结果里确实出现过的信息,不要用你自己的记忆补充。搜索结果没讲的字段就给空串或空数组。',
    '3. 在 oneLine 的末尾加上" (来源: 网络)"以标明这次是联网得来的。',
    '4. 如果有多个来源冲突,在 pitfalls 里指出分歧。',
    `5. 解释语言必须是${lang}。`,
    `6. 如果搜索结果与术语无关,把 confidence 设为 low,并在 oneLine 里说明"未找到相关网络资料"。`,
    '',
    style,
  ].join('\n')

  const blocks = results.map((r, i) => {
    const body = (r.text ?? '').slice(0, 1200)
    return `[${i + 1}] ${r.title}\n${r.url}\n${body}`
  })

  const user = [
    `术语: ${term}`,
    context?.trim() ? `\n它出现的上下文:\n\`\`\`\n${context.trim().slice(0, 1500)}\n\`\`\`` : '',
    '',
    '网页搜索结果:',
    blocks.join('\n\n---\n\n') || '(没有拿到任何结果)',
  ].join('\n')

  return { system, user }
}

/**
 * 追问的提示词。
 *
 * 为什么要单独做：一次解释不一定够。用户看完卡片还可能有疑问
 * （「那它和 X 有什么区别」「给我看看在这个项目里怎么用」），
 * 重查一次只会得到同一份解释，所以需要围绕**同一个术语 + 已经给出的解释**
 * 追问，并且保留前面几轮问答的上下文。
 *
 * ══ 与首轮解释的关键差别 ═════════════════════════════════════════════
 *
 * 首轮用 JSON schema 约束解码；追问是自由文本，**不能**套 schema
 * （那会把答案挤成碎片）。但实测发现：一旦去掉 schema，qwen3:4b 就会
 * 退回「边想边写」，把推理过程当答案吐出来。真实事故：
 *
 *     首先，用户说："我还是不太懂键"。这表明他对于"键"这个概念的理解还不够清晰。
 *     回顾我已有的信息：
 *     关键点：
 *     最佳响应策略：
 *     草拟回答：
 *
 * 而且稳定地用满 num_predict 被截断（3/3 用例，900/900 tokens）。
 *
 * 三条实测有效的对策，缺一不可：
 *
 *   1. **明确禁止元话语**，并把禁止项列全（分析/复述/思考/策略/草稿…）。
 *      只写「不要复述」不够，模型会换个词继续复盘。
 *
 *   2. **提示词本身要短。** 实测发现模型会**复述系统提示的内容**
 *      （「从系统提示来看：用户正在看「键名」…」）—— 提示词越长、越像一份
 *      任务说明，就越像可抄的素材，泄漏越严重。
 *
 *   3. **给出输出示例**（few-shot）。对 4B 模型来说，「像这样写」比
 *      「不要那样写」有效得多。
 *
 * @param {object} opts
 * @param {string} opts.term
 * @param {string} [opts.context]      术语第一次出现时的上下文
 * @param {object} [opts.explanation]  已经给出的解释（让它知道「你已经说过什么」）
 * @param {Array<{role:'user'|'assistant', content:string}>} [opts.history] 之前的问答
 * @param {object} opts.prompt         config.prompt
 * @returns {{system: string, turns: Array<{role:string, content:string}>}}
 */
export function buildFollowUpMessages({ term, explanation, history, prompt }) {
  const lang = LANG_NAME[prompt?.language] ?? LANG_NAME['zh-CN']

  const known = []
  if (explanation?.oneLine) known.push(explanation.oneLine)
  if (Array.isArray(explanation?.bullets) && explanation.bullets.length) known.push(...explanation.bullets.slice(0, 4))

  const system = [
    `你在给程序员解释「${term}」。已经讲过：${known.length ? known.join('；') : '（略）'}。`,
    `现在用户追问。用${lang}直接回答他问的那一点。`,
    '',
    '只输出回答本身。不要写任何关于「我要怎么回答」的内容 —— 不分析用户意图、不复述我这段话、不列提纲、不写草稿、不出现「首先/关键点/最佳策略/最终回答」这类字样。',
    '不要重复已经讲过的内容。不确定就直说，不要编造 API 名或数字。',
    '默认 3 到 6 句。需要代码就给最小片段。可以用短列表和行内代码，不要用大标题。',
  ].join('\n')

  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6) // 只带最近 6 轮：小模型上下文宝贵，历史越长越容易诱发复述
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))

  // few-shot：让模型看到「一问一答」该长什么样。示例与当前术语无关，
  // 避免它把这套内容也抄进答案。
  if (turns.length === 0) {
    turns.push(
      { role: 'user', content: '它和缓存有什么区别？' },
      {
        role: 'assistant',
        content:
          '缓存是「把结果存起来下次直接复用」，而这个说的是「同一操作重复执行不会产生额外影响」——前者关心快不快，后者关心重复执行安不安全。',
      },
    )
  }

  // context 不重复塞入：首轮解释已经体现了它，再塞一遍只会拉长提示词、
  // 而提示词越长越容易诱发复述（见上面第 2 条）。
  return { system, turns }
}

/** 模型在「确实没有上下文」时会写的占位串,规整时清掉,别让它显示成一句话。 */
const NO_CONTEXT_MARKERS = ['（未提供上下文）', '(未提供上下文)', '未提供上下文', '无上下文', 'N/A', 'n/a']
/**
 * 规整 inContext，把「其实没有上下文」的情况清成空串。
 *
 * ⚠️ 用**包含**判断而不是精确相等。实测模型会把自己的判断包在句子里：
 *
 *     当前无明确上下文，请使用默认说明：（未提供上下文）
 *
 * 精确匹配清不掉这一句，于是它作为一条「解释」显示在卡片上 ——
 * 用户看到的就是一句关于「有没有上下文」的废话。
 *
 * 为了不误伤真的有上下文的回答，加一道长度门槛。这个数字是量出来的，
 * 不是猜的 —— 实测（5 个有上下文的用例）真实 inContext 的长度分布：
 *
 *     32 / 32 / 32 / 33 / 37 / 41 字      最短 32
 *     带包装的哨兵：「当前无明确上下文，请使用默认说明：（未提供上下文）」= 25 字
 *
 * 取 28 作分界，两边各留 3~4 字余量。
 */
const NO_CONTEXT_MAX_LEN = 28

function cleanInContext(value) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return ''
  if (NO_CONTEXT_MARKERS.some((m) => v.includes(m)) && v.length <= NO_CONTEXT_MAX_LEN) return ''
  return v
}

/** 把模型返回的 JSON 规整成卡片能直接渲染的形状,缺失字段一律补空。 */
export function normalizeExplanation(raw, term) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [])
  const out = typeof raw === 'string' ? tryParse(raw) : raw
  if (!out || typeof out !== 'object') {
    return {
      term,
      reading: '',
      oneLine: typeof raw === 'string' ? raw.trim().slice(0, 400) : '模型没有返回可解析的结果。',
      inContext: '',
      bullets: [],
      pitfalls: [],
      related: [],
      example: '',
      confidence: 'low',
      unparsed: true,
    }
  }
  const related = Array.isArray(out.related)
    ? out.related
        .map((r) => (typeof r === 'string' ? { term: r, why: '' } : r))
        .filter((r) => r && typeof r.term === 'string' && r.term.trim())
        .map((r) => ({ term: r.term.trim(), why: typeof r.why === 'string' ? r.why.trim() : '' }))
    : []

  const confidence = ['high', 'medium', 'low'].includes(out.confidence) ? out.confidence : 'medium'

  return {
    term: typeof out.term === 'string' && out.term.trim() ? out.term.trim() : term,
    reading: typeof out.reading === 'string' ? out.reading.trim() : '',
    oneLine: typeof out.oneLine === 'string' ? out.oneLine.trim() : '',
    inContext: cleanInContext(out.inContext),
    bullets: arr(out.bullets),
    pitfalls: arr(out.pitfalls),
    related,
    example: typeof out.example === 'string' ? out.example.trim() : '',
    confidence,
  }
}

function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    // 小模型偶尔会用 ```json 包裹或前后带废话,退一步抽最外层花括号
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}
