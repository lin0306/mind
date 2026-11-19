/**
 * 记忆层（v2.0：三种记忆 + 三个总结点）。
 *
 * 三层各有一条**不同的更新语义**（REQUIREMENTS §9，别混）：
 *   ① 短期 `short`   —— 全量层：整份重新算、整个覆盖（`rewriteShort`）；
 *   ② 会话 `session` —— 日记：**增量追加、永不改写旧条目**（`appendSession`）；
 *   ③ 全局 `global`  —— 全量层：整理成一份、整个覆盖（`organizeGlobal`）。
 *
 * 分工也还是原来那套：短期是"我现在脑子里装着的事"（要注入上下文），
 * 会话/全局是"我大致记得有过这么回事"——**得先想起来**，所以要模型主动调 `recall_memory`。
 *
 * 一条记忆要进全局库，必须过四道闸门（与 DESIGN.md §12 对应）：
 *   ①重要度够   ②不是流水账（有信息量）   ③不与已有条目重复   ④库没满
 * 取回（recall）会加固条目——被想起来的事更不容易掉。
 *
 * 归属（`scope`）取代了 v1.x"靠 ws 四态猜"的写法：`ws` 退回它本来的角色——工作区键。
 */

import { DEFAULT_TUNABLES, type MindTunables } from './config.js'
import { DAY } from './dynamics.js'
import type { MemoryEntry, MemoryState } from './types.js'

/** 记忆分类的中文名（展示用；数据里存英文键，展示永远是中文）。 */
export const KIND_LABEL: Record<MemoryEntry['kind'], string> = {
  fact: '事实',
  agreement: '约定',
  preference: '偏好',
  lesson: '教训',
}

/** 生成一个稳定 id：同一段文本 + 同一个时刻只会有同一个 id。 */
export function makeId(text: string, at: number): string {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return `m${(hash >>> 0).toString(36)}-${Math.floor(at / 1000).toString(36)}`
}

/**
 * 造一条记忆条目（入库前的统一入口）。
 *
 * `ws` 是**弱绑定**的工作区键：空/缺省 = 全局（关于"人"的偏好），
 * 有值 = 只在那个工作区里注入。故意不把 ws 并进 id：id 是"同一段文本 + 同一时刻"的
 * 稳定指纹，遗忘名单与加固都按它认条目，加进工作区只会让同一句话在换目录后认不出来。
 */
export function makeEntry(input: {
  kind: MemoryEntry['kind']
  text: string
  importance?: number
  because?: string
  at: number
  maxChars: number
  ws?: string | null
  /**
   * 写下这条时的会话（只给"没绑工作区"的那一档用）。
   *
   * 有工作区的条目"在哪儿"由 `ws` 说清了，会话是重复信息；
   * 没工作区的条目否则无处可归，面板只能把不同会话的话合成一堆。
   */
  sessionId?: string
  /** 谁写的：`self` = 它自己写的，缺省 = 从用户原话里摘的。见 types.ts 的 `MemoryEntry.origin`。 */
  origin?: MemoryEntry['origin']
  /**
   * 归属层（v2.0）。省略时按 `ws` 的语义推出来（见 `resolveScope`）——
   * 老调用方只传 `ws` 也能得到正确的层，不必逐个改。
   */
  scope?: MemoryEntry['scope']
  /** 会话记忆写在第几个事件上（只有会话层会填，可回到日志）。 */
  seq?: number
}): MemoryEntry {
  const text = clipText(input.text.replace(/\s+/g, ' ').trim(), input.maxChars)
  const scope = resolveScope(input.scope, input.ws)
  // 会话只在"没绑工作区"（ws 为 null）时才留：有 ws 的条目位置已经说清楚了，
  // 再存一份会话就是同一件事记两遍。
  const session =
    input.ws === null && typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : undefined
  // 三种"在哪儿"必须能分辨，所以**逐字保留**：
  //   `null` = 写下的时候不在任何项目里（未分组会话）；
  //   `''`   = 显式全局，就是"关于人、跨项目"的那一类（偏好）；
  //   缺省    = 当年还没有这个字段（老档案）——只有它算"不知道"。
  // 以前把 `''` 折成缺省，于是面板上「全局（关于你，跨项目）」这一组**永远出不来**，
  // 偏好全被算进"未标注"，读的人分不清"这是我不绑定项目的偏好"还是"这是老数据"。
  return {
    id: makeId(text, input.at),
    kind: input.kind,
    text,
    importance: Math.min(Math.max(input.importance ?? 0.5, 0), 1),
    hits: 0,
    createdAt: input.at,
    lastAt: input.at,
    because: input.because ?? '',
    scope,
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    ...(input.ws === null ? { ws: null } : input.ws === undefined ? {} : { ws: input.ws }),
    ...(session === undefined ? {} : { sessionId: session }),
    // 缺省 = "听来的"（自动摘句），所以只在 `self` 时写字段：老条目读出来没有它，
    // 按缺省算就是对的，不需要为历史数据补一遍。
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  }
}

/**
 * 归属层怎么定（v2.0）。
 *
 * 显式给了就用给的；没给就按 `ws` 推——**这是给老调用方与老档案用的降级路径**，
 * 新代码应当直接给 `scope`：
 * - `ws` 是非空字符串 → `workspace`（绑在那个工作区上）；
 * - `ws === null`      → `session`（写的时候没绑工作区，那就是本会话日记的事）；
 * - `ws` 缺省 / 空串   → `global`（关于"人"、跨项目通用；缺省那一档正是"当年没记"的老档案）。
 */
function resolveScope(scope: MemoryEntry['scope'] | undefined, ws: string | null | undefined): MemoryEntry['scope'] {
  if (scope !== undefined) return scope
  if (typeof ws === 'string' && ws !== '') return 'workspace'
  if (ws === null) return 'session'
  return 'global'
}

/**
 * 一条记忆在当前工作区里算不算"本处可见"（v2.0 改成按 `scope` 判，不再猜 ws 的四态）。
 *
 * - `global`：关于"人"、跨项目通用的东西，哪里都可见；
 * - `workspace`：只在它绑定的那个工作区里可见；**工作区未知（`ws` 为空串）时一律不放行**——
 *   宁可少说，也不要把别的项目的细节当成"本处"的；
 * - `session`：本会话日记。它天然只属于一个会话，而 `MemoryState` 本身就是按会话隔离的，
 *   所以这里放行；跨会话要看得见，只能由调用方显式把别的会话的条目传进 `recall`（并会被标 `foreign`）。
 */
function inScope(entry: MemoryEntry, ws: string): boolean {
  if (entry.scope === 'global') return true
  if (entry.scope === 'session') return true
  return ws !== '' && entry.ws === ws
}

/** 统一清洗：去掉空白与标点，只留下实词字符。 */
function clean(text: string): string {
  return text.replace(/[\s，。；：、！？"'（）()【】\[\]—…·,.;:!?'"]/g, '')
}

/** 中文按字取二元组（没有分词器也能做重叠度）。 */
function bigrams(text: string): string[] {
  const cleaned = clean(text)
  const out: string[] = []
  for (let i = 0; i < cleaned.length - 1; i += 1) out.push(cleaned.slice(i, i + 2))
  if (out.length === 0 && cleaned.length === 1) out.push(cleaned)
  return out
}

/** 常用虚词：做单字匹配时必须跳过，否则"的/了/是"会让任意两句话都显得相关。 */
const STOP_CHARS = new Set('的了是在有和与或吗呢吧啊呀什么怎哪这那我你他她它们会要能就都很也还把被给让从到对一个些里上下中之以其该')

/** 中文单字（去虚词），用来兜住"换了个说法就查不到"的情况。 */
function singles(text: string): string[] {
  const out: string[] = []
  for (const ch of clean(text)) {
    if (/[\u4e00-\u9fff]/.test(ch) && !STOP_CHARS.has(ch)) out.push(ch)
  }
  return out
}

/**
 * 查询与条目的重合度 0..1。
 * 二元组打底（权重 1.5），中文单字兜底（权重 1）：只做二元组时，
 * "用户的工作区在哪" 与 "用户的工作区在 E 盘" 会因为"的/标点"错位而漏掉，单字层能救回来。
 */
export function overlap(query: string, text: string): number {
  const q = bigrams(query)
  const qs = singles(query)
  if (q.length === 0 && qs.length === 0) return 0
  const set = new Set(bigrams(text))
  const singleSet = new Set(singles(text))
  let hit = 0
  let total = 0
  for (const gram of q) {
    total += 1.5
    if (set.has(gram)) hit += 1.5
  }
  for (const ch of qs) {
    total += 1
    if (singleSet.has(ch)) hit += 1
  }
  return total === 0 ? 0 : hit / total
}

/** 一条文本的全部分词（二元组打底 + 去虚词中文单字兜底）。 */
function terms(text: string): string[] {
  return [...bigrams(text), ...singles(text)]
}

/**
 * BM25 检索打分。**故意不归一化**（无上界，IDF 加权）。
 *
 * 为什么换掉单纯的"重合度"：`overlap` 是**对称**的——查询里出现的每个词都同权，
 * 于是"这/个/一"这种满库都有的词和一个只出现过一次的专有名词一样值钱。
 * BM25 的三处不同正好治这个病：
 *   ① **IDF**：满库都有的词权重趋近 0，罕见的词权重高（"pnpm" 比"用"值钱得多）；
 *   ② **词频饱和 + 长度归一**：同一个词重复十遍不等于十遍相关，长文本也不天然占优；
 *   ③ **词比字值钱**：单字只算半个词（见 `termWeight`）——中文里单字重合最容易凑出来。
 *
 * 为什么不归一化：试过"除以查询里所有词的 IDF 之和"，结果**惩罚提问的人**——
 * 真实查询总带几个库里没有的词（"包管理器 pnpm npm yarn"），分母被它们撑大，
 * 明明命中了 `pnpm` 却压到阈值以下。分数保持 BM25 原样，要阈值就走 `bm25Text()`。
 * 一处故意的退化：库很小（几条）时 IDF 不稳，这是 BM25 的本性，不是 bug。
 */
export function bm25Scores(
  query: string,
  docs: string[],
  k1 = DEFAULT_TUNABLES.bm25K1,
  b = DEFAULT_TUNABLES.bm25B,
): number[] {
  const all = [...new Set(terms(query))]
  // 查询里有二元组时，**单个字不算证据**：只跟库里的一个「不」字重合也能凑出分来，
  // 那正是"硬凑"。只有查询本身就是单字（"钱"）时，才退回用单字。
  const words = all.filter((term) => term.length >= 2)
  const qTerms = words.length > 0 ? words : all
  if (qTerms.length === 0 || docs.length === 0) return docs.map(() => 0)

  const docTerms = docs.map((doc) => terms(doc))
  const lens = docTerms.map((list) => list.length)
  const total = lens.reduce((sum, n) => sum + n, 0)
  const avg = total > 0 ? total / docs.length : 1

  const df = new Map<string, number>()
  for (const list of docTerms) {
    for (const term of new Set(list)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const n = docs.length
  const idf = (term: string): number => {
    const d = df.get(term) ?? 0
    return Math.log(1 + (n - d + 0.5) / (d + 0.5))
  }
  return docTerms.map((list, i) => {
    const tf = new Map<string, number>()
    for (const term of list) tf.set(term, (tf.get(term) ?? 0) + 1)
    const len = lens[i] ?? 0
    let raw = 0
    for (const term of qTerms) {
      const f = tf.get(term) ?? 0
      if (f === 0) continue
      raw += termWeight(term) * idf(term) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avg)))
    }
    return raw
  })
}

/** 单字只算半个词：中文里"这/个/用"这种单字重合太容易凑，二元组才是"词"的近似。 */
function termWeight(term: string): number {
  return term.length >= 2 ? 1 : 0.45
}

/**
 * 把无上界的 BM25 分压进 0..1，给阈值与权重组合用。
 *
 * 用**饱和映射**而不是"除以最大值"：除以最大值会让库里最好的一条永远是 1.0，
 * 于是再无关的查询也能"凑"出一条来——那正好违背"宁可说记不清"的纪律。
 * `raw / (raw + half)` 单调、有界，并且**不看查询里有多少没命中的词**。
 */
export function bm25Text(raw: number, t: MindTunables = DEFAULT_TUNABLES): number {
  if (!(raw > 0)) return 0
  const half = t.bm25Half > 0 ? t.bm25Half : 1
  return raw / (raw + half)
}

// ─────────────────────────────────────────────────────────
// 敏感信息闸门：密钥与证件号**绝不入库**
// ─────────────────────────────────────────────────────────

/**
 * 看起来像密钥 / 证件号的规则表。
 *
 * 为什么必须有这道闸：记忆是要**进提示词、还要落盘**的。用户把一段 API key 贴在
 * 会话里，规则表只看"有没有信息量"，会老老实实把它当"事实"记下来——那等于把秘密
 * 抄进了两个地方（档案 + 每次请求的上下文）。这不是洁癖，是真的会出事。
 *
 * 命中就**整条不记**，而不是脱敏后记：脱敏后的残句没有检索价值，反而占额度。
 * 正则一律不用后行断言（打包目标可能压到更低语法，`(?<=)` 会直接语法错）。
 */
const SENSITIVE_RULES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'sk- 开头的密钥', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: 'GitHub 令牌', re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { label: 'AWS 访问密钥', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'Slack 令牌', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/ },
  { label: 'Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  {
    label: '赋值形式的密钥',
    re: /(?:api[_-]?key|access[_-]?token|secret|passwd|password|口令|密码|令牌)\s*[:=：]\s*['"]?[A-Za-z0-9_\-./+]{12,}/i,
  },
  { label: '身份证号', re: /(?:^|\D)\d{17}[\dXx](?:\D|$)/ },
  { label: '手机号', re: /(?:^|\D)1[3-9]\d{9}(?:\D|$)/ },
  { label: '一长串数字（可能是卡号）', re: /(?:^|\D)\d{16,19}(?:\D|$)/ },
]

/**
 * 这句话像不像不该记住的东西。命中返回它是什么（人话，用于日志），否则 null。
 *
 * 只报"是什么"，**不回显命中的内容**——日志也是会被人看到、被贴出去的地方。
 */
export function sensitiveReason(text: string): string | null {
  for (const rule of SENSITIVE_RULES) {
    if (rule.re.test(text)) return rule.label
  }
  return null
}

/** 记忆三层拉平成一份（找重复、加固、遗忘都要同时看三层）。 */
export function allEntries(memory: MemoryState): MemoryEntry[] {
  return [...memory.short, ...memory.session, ...memory.global]
}

/**
 * 一条条目的**落脚点键**：同一个落脚点里才算"这件事说过一遍"。
 *
 * 为什么要分落脚点：同一句话在别的项目里可能有别的意思
 * （"这个项目用 pnpm" 在这个仓库是约定，在别人的仓库是别人的约定），
 * 会话日记同理——两条不同会话写下的"还差测试没跑"不是同一件事。
 */
export function entryKey(entry: Pick<MemoryEntry, 'scope' | 'ws' | 'sessionId'>): string {
  if (entry.scope === 'session') return `session:${entry.sessionId ?? ''}`
  if (entry.scope === 'workspace') return `ws:${entry.ws ?? ''}`
  return 'global'
}

/** 按"还没落库"的输入算落脚点键（与 `entryKey` 同一口径）。 */
function inputKey(scope: MemoryEntry['scope'], ws: string | null | undefined, sessionId?: string): string {
  if (scope === 'session') return `session:${ws === null && typeof sessionId === 'string' ? sessionId : ''}`
  if (scope === 'workspace') return `ws:${typeof ws === 'string' ? ws : ''}`
  return 'global'
}

/** 老口径的落脚点键：只看工作区（`isDuplicate` 的 `ws` 参数沿用它，保持老调用方行为）。 */
function wsKey(entryWs: string | undefined | null): string {
  if (entryWs === undefined || entryWs === '' || entryWs === null) return ''
  return entryWs
}

/**
 * 是否算重复（同一件事的两种说法）。三层一起比。
 *
 * `ws` 传了就**只在同一个落脚点里**比：同一句话在别的项目里可能有别的意思
 * （"这个项目用 pnpm" 在这个仓库是约定，在别人的仓库是别人的约定）。
 * 省略 `ws` = 全库比，保持老调用方的行为。
 */
export function isDuplicate(
  memory: MemoryState,
  text: string,
  threshold = 0.6,
  ws?: string | null,
): boolean {
  const scope = ws === undefined ? undefined : wsKey(ws)
  return allEntries(memory).some(
    (entry) => (scope === undefined || wsKey(entry.ws) === scope) && overlap(text, entry.text) >= threshold,
  )
}

/** `recall_memory` 的工具名。core 与适配层共用这一处，避免两边拼错。 */
export const RECALL_TOOL_NAME = 'recall_memory'

/** 分类既定，重要度就不该在两条路上各写一套（它自己写的笔记与兜底拼的日记共用这张表）。 */
export const IMPORTANCE_BY_KIND: Record<MemoryEntry['kind'], number> = {
  agreement: 0.85,
  preference: 0.7,
  lesson: 0.65,
  fact: 0.5,
}

/**
 * 记忆规则表：什么样的用户话值得**回头整理**。
 *
 * v2.3 起这张表**不再产出记忆**，只产出一个信号（见 `worthRemembering`）。用户 2026-11-12
 * 明确要求：「所有的记忆，都让 ai 自己整理生成，不要直接引用用户的原话」。抄原话看着"忠实"，
 * 实际是把被长度上限切过的半句话塞进记忆库——过几个月连说话的人都不记得自己指什么，检索时
 * 全是噪声；而且那不是"它记得"，是"它替我存了个片段"。
 *
 * **宁可少打扰，不可瞎打扰。** 命中的词太宽，每一轮都会催着总结，那就不叫提醒了。`fact` 那条
 * 特意收得很紧（必须出现盘符路径、代码文件后缀或明确的技术决定），否则"项目""版本"这种天天
 * 出现的词会让它每轮都点一次。
 */
const MEMORY_RULES: ReadonlyArray<{ kind: MemoryEntry['kind']; re: RegExp }> = [
  { kind: 'agreement', re: /记住|记一下|以后都|以后要|下次要|别再|不要再|约定|规矩|规则是|默认用|一直用|统一用/ },
  { kind: 'preference', re: /我喜欢|我不喜欢|我希望|我想要|我倾向于|我习惯|我更愿意|请用|不要用/ },
  { kind: 'lesson', re: /不对|不是这样|错了|别这样|应该是|改成|坑|踩过/ },
  { kind: 'fact', re: /[A-Za-z]:[\\/]|\.(?:ts|js|mjs|json|md|py|yml|yaml)\b|决定用|选型是|统一用/ },
]

/**
 * 从用户这一轮的话里认出"值得记的东西"，**只回种类，不回原句**（v2.3）。
 *
 * 它不再是写入路径，而是**提醒的扳机**：命中了就把「该总结了」点起来，下一轮注入点名要它
 * 用自己的话写一条（`inner_note` 的 `remember`）。写不写、写成什么，是它的判断。
 *
 * 为什么不在这里就把话存下来（v2.0–v2.2 的做法）：
 *   · 用户要的是"它记得"，不是"它抄了一段"——原话被 160 字上限切过，读起来是半句；
 *   · 抄进短期池的那一条会跟它自己总结的抢位置（池子只有十几格），而抄来的分还更高；
 *   · 一旦库里混着"用户原话"，就再也分不清哪些条目是它真的理解过的。
 *
 * 一句话只认一类（`MEMORY_RULES` 按重要度从高到低排），一轮最多两类：同一句既像"约定"又像
 * "偏好"时不该催两次。
 */
export function worthRemembering(userText: string): MemoryEntry['kind'][] {
  const text = userText.replace(/\s+/g, ' ').trim()
  if (text.length < 4) return []
  const sentences = text
    .split(/[。！？!?；;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)

  const kinds: MemoryEntry['kind'][] = []
  for (const sentence of sentences) {
    const rule = MEMORY_RULES.find((r) => r.re.test(sentence))
    if (rule === undefined || kinds.includes(rule.kind)) continue
    kinds.push(rule.kind)
    if (kinds.length >= 2) break
  }
  // 逐句都没命中（比如整段话被切成的句子都太短）：整块再试一次，仍然只取最靠前的一类
  if (kinds.length === 0) {
    const rule = MEMORY_RULES.find((r) => r.re.test(text))
    if (rule !== undefined) kinds.push(rule.kind)
  }
  return kinds
}

/**
 * 一条记忆的"材料"（还没落库时的输入）。
 *
 * 三个写入入口（`rememberShort` / `appendSession` / `organizeGlobal`）共用它，
 * 免得同一件事在三处各写一套字段。
 */
export interface MemoryInput {
  kind: MemoryEntry['kind']
  text: string
  importance?: number
  because?: string
  at: number
  ws?: string | null
  /** 写下这条时的会话：只有"没绑工作区"的那一档会落进档案。 */
  sessionId?: string
  /** 谁写的：`self` = 它自己写的，缺省 = 从用户原话里摘的。 */
  origin?: MemoryEntry['origin']
  /** 归属层；省略时按 `ws` 推（见 `resolveScope`）。 */
  scope?: MemoryEntry['scope']
  /** 会话记忆写在第几个事件上（只有会话层会填）。 */
  seq?: number
}

/**
 * 按**子句边界**截断（v2.2）。
 *
 * 早先是 `text.slice(0, max)`——一句话在半个词上断掉，档案里留下"…是不是不"、"…但是"、
 * "…而"这种残句。读者（和它自己）看到的是"记忆坏了"，而不是"这条很长"。
 *
 * 规则：放不下就退到最近的子句边界（。！？；，、换行）；边界离得太靠前（不到一半）才硬切
 * （留半句总比只留一个头强）。**截断了就补一个 `…`**，让人一眼看出这里还有下文。
 */
export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  let cut = -1
  for (const mark of ['。', '！', '？', '；', '，', '\n']) {
    const at = head.lastIndexOf(mark)
    if (at > cut) cut = at
  }
  if (cut < Math.floor(maxChars / 2)) return `${head}…`
  return `${head.slice(0, cut + 1)}…`
}

/**
 * 文本上限按**来源**分档（v2.2）。
 *
 * 听来的原句是"摘一句"，越紧越好；它自己写下的是**已经想过一遍的结论**（结论 + 理由往往
 * 在同一句里），120/160 字会把它切断；收尾兜底拼的一段要装下几件事，最松。
 */
export function capFor(origin: MemoryEntry['origin'], t: MindTunables): number {
  if (origin === 'self') return t.memorySelfMaxChars
  if (origin === 'digest') return t.digestMaxChars
  return t.memoryMaxChars
}

/** 把一条"材料"清洗成可入库的文本；空 / 命中敏感闸门返回 null。 */
function prepareText(text: string, t: MindTunables, maxChars: number = t.memoryMaxChars): string | null {
  const clean = clipText(text.replace(/\s+/g, ' ').trim(), maxChars)
  if (!clean) return null
  // 敏感信息闸门（第二道）：调用方漏查也不能写进去。
  if (sensitiveReason(clean) !== null) return null
  return clean
}

/** 短期区淘汰时给旧条目打分（hits 必须封顶，见 `pruneShort`）。 */
function shortScore(e: MemoryEntry): number {
  return e.importance + Math.min(e.hits, 5) * 0.1
}

/**
 * 短期区满了怎么淘汰（v2.2 重写）。
 *
 * 早先只按 `importance + hits*0.1` 排——在真实数据下那套尺子是**永动机**：旧条目攒了几个月的
 * `hits`（无上限，每被想起来一次加一），分数高到新写的一条永远挤不进来。于是"记忆"看起来
 * 在长，实际上从某一刻起再也长不进去了。
 *
 * 现在分两级：**这一段新长出来的先留下**（它们就是此刻在说的事），剩下的名额才给旧条目按
 * 分数（hits 封顶）竞争。新条目要是自己也超过名额，多出来的按写入顺序丢。
 */
function pruneShort(short: MemoryEntry[], now: number, t: MindTunables): MemoryEntry[] {
  const fresh = short.filter((e) => now - e.createdAt < DAY)
  const rest = short.filter((e) => now - e.createdAt >= DAY).sort((a, b) => shortScore(b) - shortScore(a))
  const keepFresh = fresh.slice(0, t.memoryShortMax)
  return [...keepFresh, ...rest.slice(0, Math.max(0, t.memoryShortMax - keepFresh.length))]
}

/** 加进短期记忆。重复的只加固，不新增。 */
export function rememberShort(memory: MemoryState, input: MemoryInput, t: MindTunables): MemoryState {
  const cap = capFor(input.origin, t)
  const text = prepareText(input.text, t, cap)
  // 空文本 / 命中敏感闸门都返回**同一个引用**，于是上层的事件折叠不会以为状态变了
  // （状态机靠 Object.is 做第一层闸门）。
  if (text === null) return memory

  // 同一个落脚点里才算"说过一遍"。别的项目里有一句差不多的话，不能把这一句记成它的
  // 第二次（hits 会加到别人那条头上），也不能让这一句因为别处说过就不落了库。
  const key = inputKey(resolveScope(input.scope, input.ws), input.ws, input.sessionId)
  // 只看短期 + 全局：**会话日记一个字都不改**（REQUIREMENTS §9 的"永不改写旧条目"），
  // 所以哪怕日记里已经有一句差不多的话，也不拿它当"这条记过了"去加固。
  const exist =
    [...memory.short, ...memory.global].find((e) => entryKey(e) === key && overlap(text, e.text) >= 0.6) ?? null
  if (exist) {
    const bump = (list: MemoryEntry[]) =>
      list.map((e) =>
        e.id === exist.id
          ? {
              ...e,
              hits: e.hits + 1,
              lastAt: input.at,
              importance: Math.min(e.importance + 0.05, 1),
            }
          : e,
      )
    return { ...memory, short: bump(memory.short), global: bump(memory.global), updatedAt: input.at }
  }

  const entry = makeEntry({ ...input, maxChars: cap })
  let short = [...memory.short, entry]
  // 短期区有上限：超了按 `pruneShort` 的两级规则淘汰（新的先留，旧的按分数竞争）。
  if (short.length > t.memoryShortMax) short = pruneShort(short, input.at, t)
  return { ...memory, short, updatedAt: input.at }
}

/**
 * 按归属层自动挑写入入口：会话层进日记（只增不改），其余进短期池。
 *
 * 折叠层手里只有"这一轮说了什么"，它不知道这条该落哪一层——那是 `resolveScope` 的事。
 * 早先两处写入都直接调 `rememberShort`，于是没选工作区的会话写下的条目被塞进了短期池，
 * 却又带着 `scope: 'session'` 的标签：短期池里混着一条永远不该被全量覆盖的日记，
 * 而真正的日记层是空的（镜头上和面板上看到的就是这样）。
 */
export function rememberAuto(memory: MemoryState, input: MemoryInput, t: MindTunables): MemoryState {
  const scope = input.scope ?? resolveScope(input.scope, input.ws)
  return scope === 'session' ? appendSession(memory, input, t) : rememberShort(memory, input, t)
}

/**
 * 短期是**全量层**：整份重新算、整个覆盖（REQUIREMENTS §9）。
 *
 * 与 `rememberShort` 的区别：那个是"往手边再放一条"（增量），这个是"这就是我现在
 * 手边该装着的东西"（全量）。差值由调用方算好——短期池本来就是从材料重算出来的。
 */
export function rewriteShort(memory: MemoryState, inputs: readonly MemoryInput[], at: number, t: MindTunables): MemoryState {
  const short = buildEntries(inputs, at, t)
    .filter((entry) => entry.scope !== 'session')
    .map((entry) => ({ entry, score: entry.importance + entry.hits * 0.1 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, t.memoryShortMax)
    .map((x) => x.entry)
  return { ...memory, short, updatedAt: at }
}

/**
 * 把一批"材料"洗净、去重成条目（全量层的公共零件）。
 *
 * 去重只在**同一个落脚点**里比，后到的近重复直接丢掉；`importance` 高的排前面，
 * 保证"同一件事两种说法"留下来的是更重要的那个说法。
 */
function buildEntries(inputs: readonly MemoryInput[], at: number, t: MindTunables): MemoryEntry[] {
  const out: MemoryEntry[] = []
  for (const input of [...inputs].sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5))) {
    // 上限也按来源分档：全量层（全局整理 / 短期重算）不许把一条自家总结再切回 160 字
    const cap = capFor(input.origin, t)
    const text = prepareText(input.text, t, cap)
    if (text === null) continue
    const scope = resolveScope(input.scope, input.ws)
    const key = inputKey(scope, input.ws, input.sessionId)
    if (out.some((e) => entryKey(e) === key && overlap(text, e.text) >= 0.6)) continue
    out.push(makeEntry({ ...input, text, at: input.at ?? at, maxChars: cap }))
  }
  return out
}

/**
 * 会话记忆的**追加**入口（v2.0 的核心写入腿之一）。
 *
 * 语义只有一句：**只 push，绝不改已有条目**（REQUIREMENTS §9：会话记忆是增量追加、永不改写）。
 *
 * 所以这里没有"加固"那一套：同一个落脚点里已经有一句差不多的话，就**直接不写**
 * （返回同一个引用），而不是把旧条目的 hits 加一——旧的那个字，一个都不许动。
 * 重复判定沿用全库同一把尺（二元组重合 ≥ 0.6）。
 */
export function appendSession(memory: MemoryState, input: MemoryInput, t: MindTunables): MemoryState {
  // 兜底拼的一段用 `digestMaxChars`（600），不是 `memoryMaxChars`（160）：
  // 日记里那段话要装下几件事，按 160 切会在半句上断掉。
  const cap = capFor(input.origin, t)
  const text = prepareText(input.text, t, cap)
  if (text === null) return memory
  const entry = makeEntry({ ...input, text, scope: 'session', maxChars: cap })
  const key = entryKey(entry)
  if (memory.session.some((e) => entryKey(e) === key && overlap(text, e.text) >= 0.6)) return memory
  return { ...memory, session: [...memory.session, entry], updatedAt: input.at }
}

/**
 * 全局记忆的**整理**入口（v2.0 的另一条写入腿）。
 *
 * 语义是"全量整理成一份"（REQUIREMENTS §9）：传进来的就是整理之后该有的全部，
 * 整份覆盖，不做增量。所以调用方每次给的都是完整清单，不是"这一轮新发现的几条"。
 *
 * 会话层的材料不从这里进（那是 `appendSession` 的事），会直接跳过。
 */
export function organizeGlobal(
  memory: MemoryState,
  inputs: readonly MemoryInput[],
  at: number,
  t: MindTunables,
): MemoryState {
  const next = pruneLongList(
    buildEntries(inputs, at, t).filter((entry) => entry.scope !== 'session'),
    t,
  )
  return { ...memory, global: next, updatedAt: at }
}

/**
 * 落进记忆库（按归属层路由）——`rememberLong` 的直白名字。
 *
 * v1.x 只有一档"长期库"，所以叫 long；v2.0 分成会话 / 全局两层之后，
 * 这条材料该去哪一层由 `scope` 决定：会话层的进日记，其余进全局库。
 * `rememberLong` 保留为它的别名，免得老调用方集体改名。
 */
export function rememberGlobal(memory: MemoryState, input: MemoryInput, t: MindTunables): MemoryState {
  const text = prepareText(input.text, t)
  if (text === null) return memory
  const scope = resolveScope(input.scope, input.ws)
  // 会话层的材料走追加那条腿（语义不同：一个只增不改，一个允许去重/剪枝）
  if (scope === 'session') return appendSession(memory, { ...input, scope: 'session' }, t)
  // 去重按落脚点算：别的项目里有一句差不多的话，不该拦住这里再记一遍。
  // 会话日记不参与判定：它不许被改写，也不该拦住"这件事在全局库里存一份"。
  if (isDuplicate({ ...memory, session: [] }, text, 0.6, input.ws)) return memory
  const entry = makeEntry({ ...input, text, scope, maxChars: t.memoryMaxChars })
  const global = [...memory.global, entry]
  return { ...memory, global: pruneLongList(global, t), updatedAt: input.at }
}

/** 老名字：落进全局库（会话层的材料会自动改走日记那条腿）。 */
export function rememberLong(memory: MemoryState, input: MemoryInput, t: MindTunables): MemoryState {
  return rememberGlobal(memory, input, t)
}

/** 库满了就丢最不重要的（被取回过的、重要的、新的留下）。 */
export function pruneLongList(long: MemoryEntry[], t: MindTunables): MemoryEntry[] {
  if (long.length <= t.memoryLongMax) return long
  return long
    .map((e) => ({ e, score: e.importance * 2 + e.hits * 0.2 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, t.memoryLongMax)
    .map((x) => x.e)
}

/**
 * 固化：把够格的条目沉淀进跨会话库。这是记忆从"这一段"变成"存起来"的唯一路径。
 *
 * **层源（v2.4 起）：手边 + 本会话日记。**
 * 早先只收手边（`scope !== 'session'`），理由是"日记就是日记，别跑到全局库里串味"；
 * 代价是"在这个会话里被反复取用、或被明确要求记住的事"**永远到不了跨会话库**，
 * 下个会话就真没了——用户把这条列为 v2.4 要做的事（「会话记忆 → 全局的固化
 * （反复出现、或用户明确要求时升级）」）。
 * 防串味的办法不是不收，而是**把出处一起带过去**：升格只改 `scope`，
 * `sessionId` / `ws` / `seq` / 正文一个字都不动——到了跨会话库里，它照样写着这话出自哪个会话。
 *
 * 闸门（DESIGN §22.4「反复被用到、带强烈情绪、或被显式要求」）：
 *   ① 被反复取用：`hits >= 2`（`recall_memory` 取回会加固）；
 *   ② 重要度高 / 显式要求：`importance >= 0.75`（"记住…"这类 agreement 天生 0.85）。
 * 已经在库里的（同 id，或正文重合 ≥0.6）不重复收——**"同一个事实换个说法又写一遍"也算重复**：
 * 那种反复目前只防重、不加固（想加固得靠被取回）。这是已知的留白，不是漏掉的 bug。
 */
export function solidify(memory: MemoryState, at: number, t: MindTunables): MemoryState {
  const ready = [...memory.short, ...memory.session].filter((e) => e.hits >= 2 || e.importance >= 0.75)
  if (ready.length === 0) return memory

  const forgotten = new Set(memory.forgotten)
  let global = [...memory.global]
  const promoted = new Set<string>()
  for (const entry of ready) {
    if (forgotten.has(entry.id)) continue
    // 库里已经有同一条（或同一个事实换个说法）：照样把手边那份收走，但不再写第二份。
    if (!global.some((e) => e.id === entry.id || overlap(e.text, entry.text) >= 0.6)) {
      global.push({ ...entry, scope: 'global' })
    }
    promoted.add(entry.id)
  }
  global = pruneLongList(global, t)
  // **升格是搬走，不是复制**（v2.4.y，用户定的语义）。
  //
  // 两层是两种**用途**，不是两份数据：
  //   · 手边（short）= 每次说话都要装载进上下文的那几条；
  //   · 跨会话库（global）= 不装载，它想用得自己去查（`recall_memory`）。
  // 同一条留在两处，会造成三件事：面板上重复出现、额度被占两份、召回时撞见两次。
  // 之前那版为了让"按层遗忘"分得清而给库里的复制品换了个新 id——那是拿数据重复
  // 换一个命令的实现便利，代价太大，现在改回"一条记忆只有一个身份"。
  const keep = (list: MemoryEntry[]): MemoryEntry[] =>
    promoted.size === 0 ? list : list.filter((entry) => !promoted.has(entry.id))
  return { ...memory, global, short: keep(memory.short), updatedAt: at }
}

/** 记忆来自哪一层（检索结果要能说出处，DESIGN §22.6）。 */
export type MemoryLayer = 'short' | 'session' | 'global'

/** 记忆的检索结果。 */
export interface RecallHit {
  entry: MemoryEntry
  score: number
  /** 这条是从哪一层捞出来的：短期 / 会话 / 全局。 */
  layer: MemoryLayer
  /**
   * 这条来自**别处**。
   *
   * 两种情形：别的工作区（跨工作区），或别的会话（`scope='all'` 时带进来的会话日记）。
   * 跨区的条目仍然可查（硬切两半一定丢东西——"先调研再动手"跟哪个项目都有关），
   * 但降权并标出来源：别处的细节不该和本处的记忆一样可信。
   */
  foreign?: boolean
}

/** `recall_memory` 的检索范围。 */
export type RecallScope =
  /** 本会话 + 全局（默认）：日常该看的都在这儿。 */
  | 'this'
  /** 只看全局库。 */
  | 'global'
  /** 再加别的会话的日记（要模型显式要，绝不静默串味）。 */
  | 'all'

/**
 * 检索记忆（DESIGN §22.6 的"它自己想起来"那条路，跨库检索）。
 * 打分 = 文本相关（BM25 饱和映射）0.6 + 重要度 0.25 + 新鲜度 0.15（30 天半衰期）。
 * 全部没重合并给一个很低的分时，会返回"想不起来"，而不是硬凑几条。
 *
 * `scope` 决定检索范围（v2.0，默认只读本处，绝不静默串味）：
 * - `'this'`（默认）= 本会话日记 + 全局库；
 * - `'global'` = 只看全局库；
 * - `'all'` = 再加 `others` 里**别的会话**的日记（跨会话必须显式要）。
 * 短期池不在检索范围内：它本来就会被注入，不需要"想起来"。
 *
 * `ws` 传了才做跨工作区判定（省略 = 不过滤、不降权，保持与老调用方兼容）：
 * 别的项目的条目分数乘 0.55 并标 `foreign`——**留着可查**，只是排在后面。
 * `ws` 为空串 = 工作区未知：同样**不降权**（不知道自己在哪的时候，
 * 宁可当全局，也不要把一条还没确认属于别处的记忆压下去）。
 */
export function recall(
  memory: MemoryState,
  query: string,
  now: number,
  t: MindTunables,
  ws?: string,
  scope: RecallScope = 'this',
  others: readonly MemoryEntry[] = [],
): RecallHit[] {
  // 先按 scope 选出候选池，并记住每条来自哪一层（结果要能报出处）
  const pool: Array<{ entry: MemoryEntry; layer: MemoryLayer; foreign: boolean }> = []
  if (scope !== 'global') {
    for (const entry of memory.session) pool.push({ entry, layer: 'session', foreign: false })
  }
  for (const entry of memory.global) pool.push({ entry, layer: 'global', foreign: false })
  if (scope === 'all') {
    // 别的会话的日记由调用方（适配层读文件）传进来；它们一律算"外来的"。
    for (const entry of others) pool.push({ entry, layer: 'session', foreign: true })
  }
  if (pool.length === 0) return []

  const hits: RecallHit[] = []
  // 文本分一次把**整个候选池**当语料算：BM25 的 IDF 需要"库"这个分母，逐条算会退化成自造词频
  const textScores = bm25Scores(query, pool.map((x) => x.entry.text), t.bm25K1, t.bm25B)
  for (let i = 0; i < pool.length; i += 1) {
    const { entry, layer, foreign: fromElsewhere } = pool[i] as {
      entry: MemoryEntry
      layer: MemoryLayer
      foreign: boolean
    }
    const textScore = bm25Text(textScores[i] ?? 0, t)
    // 先过文本关：对不上就是"想不起来"。绝不靠重要度和新鲜度硬凑一条出来——
    // 那会让人以为它记得，实际答非所问。
    if (textScore < 0.15) continue
    const fresh = Math.pow(0.5, Math.max(now - entry.lastAt, 0) / (30 * DAY))
    let score = textScore * 0.6 + entry.importance * 0.25 + fresh * 0.15
    // 「够不够相关」这道闸用**罚之前**的分。
    // 放在罚之后错了：0.55 一乘，别人项目里明明相关的一条就掉到 0.25 以下、被整个删掉，
    // 于是"弱绑定：别的项目也查得到、只是排在后面并标出来源"这条设计等于没实现
    // （真机上跑 recall_memory 一条跨工作区的都看不见，就是这么来的）。
    // 降权只负责**排序与展示**，不负责**判定有无**。
    if (score < 0.25) continue
    // ws 省略或为空串（未知）都不判跨区：只有"确实知道自己在别的某个工作区"时才降权
    const foreign = fromElsewhere || (ws !== undefined && ws !== '' && !inScope(entry, ws))
    if (foreign) score *= 0.55
    hits.push(foreign ? { entry, score, layer, foreign: true } : { entry, score, layer })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, t.recallLimit)
}

/**
 * 记忆分布：本工作区 / 全局 / 其他工作区各多少条。
 *
 * 数的是**长期库**——那一份才是"能被想起来"的库存，注入里那行数量索引说的就是它。
 * （手边记忆本来就会列出来，不需要再报数。）
 *
 * `ws` 为空串（工作区未知）时：全局算全局，带 ws 的一律算"其他"——宁可少说，
 * 也不要把别的工作区的东西算成"本工作区"；`unknown` 单独数（老档案 + 未分组会话写下的），
 * 它们哪儿都看得见，但都不算"关于人"。
 */
export function memoryCounts(
  memory: MemoryState,
  ws: string,
): { here: number; global: number; other: number; unknown: number } {
  let here = 0
  let global = 0
  let other = 0
  let unknown = 0
  for (const entry of memory.global) {
    // v2.0 直接看 `scope`，不再猜 ws 的四态：
    //   global   = 关于"人"的（老档案的 ws 缺省也归这类，但**如实算进 unknown**——
    //              它哪儿都可见，却不算"我说的关于你"）；
    //   workspace= 绑了工作区：本工作区的算"这儿"，其余算"其他"；
    //   session  = 会话层的东西不该出现在全局库里，遇到就跳过（真出现了也不报数）。
    if (entry.scope === 'global') {
      if (entry.ws === undefined) unknown += 1
      else global += 1
    } else if (entry.scope === 'workspace') {
      if (ws !== '' && entry.ws === ws) here += 1
      else other += 1
    }
  }
  return { here, global, other, unknown }
}

/**
 * 取回之后加固（被想起来的事更不容易掉）。
 *
 * 只作用于短期与全局：**会话日记不加固**——加固会改写旧条目，
 * 而日记那条腿的语义是"只增不改"（写进去的那个字，一个都不许动）。
 */
export function reinforce(memory: MemoryState, ids: string[], at: number): MemoryState {
  if (ids.length === 0) return memory
  const idSet = new Set(ids)
  const bump = (list: MemoryEntry[]) =>
    list.map((e) =>
      idSet.has(e.id)
        ? { ...e, hits: e.hits + 1, lastAt: at, importance: Math.min(e.importance + 0.05, 1) }
        : e,
    )
  // **三层都要过**（v2.4 补）：早先只加固 global 与 short，于是"会话日记里的条目被想起来"
  // 从来没记过账——`hits` 永远是 0，而 v2.4 的"被反复取用才升格"正靠它。同一类事故
  // （少写一层就静默失效）在这个项目里出过三次了，改这里时照 `withoutForgotten` 的写法三层都列出来。
  return {
    ...memory,
    short: bump(memory.short),
    session: bump(memory.session),
    global: bump(memory.global),
    updatedAt: at,
  }
}

/**
 * 短期记忆的展示文本（进提示词与 /mind）。
 *
 * `ws` 传了就只给"本工作区 + 全局"的条目——别的项目的细节不该在注入里串味；
 * 省略 `ws` = 不过滤（向后兼容：`/mind` 这类"我全都要看"的地方仍然看得到全部）。
 *
 * `rotation` 治的是"别每轮都看同几条"：前 `pinned` 条**常驻**（按分数取，实际就是约定与偏好
 * 这类每轮都得知道的事），剩下的名额在其余条目里做**滑动窗口**——`offset` 传这个会话的回合数，
 * 每回合窗口往前挪一格，一轮一轮地翻，总能翻到。不轮换的话，库里剩下的条目永远不会出现在模型眼前。
 * 省略 `rotation` = 老的"取前 limit 条"（`/mind`、面板概览这类要看"最重要的几条"的地方）。
 */
export function describeShort(
  memory: MemoryState,
  limit: number,
  ws?: string,
  rotation?: { offset?: number; pinned?: number },
): string[] {
  const visible = memory.short
    .filter((e) => ws === undefined || inScope(e, ws))
    .map((e) => ({ e, score: e.importance + e.hits * 0.1 }))
    .sort((a, b) => b.score - a.score)

  const pinned = Math.max(0, Math.min(rotation?.pinned ?? 0, limit))
  const head = visible.slice(0, pinned)
  const rest = visible.slice(pinned)
  const room = Math.max(0, limit - head.length)
  let windowed = rest.slice(0, room)
  if (room > 0 && rest.length > room) {
    const span = rest.length
    const start = (((rotation?.offset ?? 0) % span) + span) % span
    windowed = [...rest.slice(start), ...rest.slice(0, start)].slice(0, room)
  }
  return [...head, ...windowed].map((x) => `[${KIND_LABEL[x.e.kind]}] ${x.e.text}`)
}

/** 记忆层概览。 */
export function describeMemory(memory: MemoryState): string[] {
  const byKind = new Map<MemoryEntry['kind'], number>()
  for (const e of memory.global) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
  const parts = [...byKind.entries()].map(([k, n]) => `${KIND_LABEL[k]} ${n}`)
  const lines = [
    `短期（会注入）：${memory.short.length} 条`,
    `本会话（日记，只增不改）：${memory.session.length} 条`,
    `全局（要主动查）：${memory.global.length} 条${parts.length > 0 ? `（${parts.join('、')}）` : ''}`,
  ]
  // 划掉过几条也如实说：遗忘是它的一部分，不该看不见
  if (memory.forgotten.length > 0) lines.push(`已遗忘：${memory.forgotten.length} 条`)
  return lines
}

// ─────────────────────────────────────────────────────────
// 遗忘与查看（v1.1 的另一半：能记，也要能看、能忘）
// ─────────────────────────────────────────────────────────

/** 遗忘工具名。和 `recall_memory` 一样走工具调用 → 落在会话日志里 → 可重放。 */
export const FORGET_TOOL_NAME = 'forget_memory'

/** 时间单位（不引 dynamics 的常量，免得记忆模块反过来依赖时间模块）。 */
const MINUTE_MS = 60_000

/** 人话的时间差（`/mind remember` 用）。 */
export function agoText(ms: number): string {
  const diff = Math.max(ms, 0)
  const minutes = Math.floor(diff / MINUTE_MS)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months} 个月前` : `${Math.floor(months / 12)} 年前`
}

/**
 * 一条记忆的完整说明。
 *
 * 这一半是给**人**看的：记忆最招人烦的地方就是"它凭什么记着这个"。
 * 所以每条都要能答出来：什么类型、重要到什么程度、被取回过几次、什么时候记的、为什么记。
 */
export function describeEntry(entry: MemoryEntry, index: number, now: number): string {
  // 给人看的说明：用"被翻到"，不用内部动词"取回"
  const used = entry.hits > 0 ? `被翻到 ${entry.hits} 次` : '还没被翻到过'
  const last = entry.lastAt > entry.createdAt ? `，最近 ${agoText(now - entry.lastAt)}` : ''
  const why = entry.because !== '' ? `｜因为：${entry.because}` : ''
  const age = agoText(now - entry.createdAt)
  return `${index}. [${KIND_LABEL[entry.kind]}] ${entry.text}（重要度 ${entry.importance.toFixed(2)}｜${used}${last}｜记于 ${age}）${why}`
}

/**
 * 按关键词找长期记忆——给人用的那一半（`/mind remember` 与 `/mind forget` 共用）。
 *
 * 与模型用的 `recall` 有两处**故意不同**：
 * - 阈值更低（0.12 而不是 0.15）：人手打的词短，卡太严就总是"没找到"；
 * - 空关键词就列前几条：人只是想看一眼里面有什么。
 */
export function findEntries(memory: MemoryState, query: string, limit: number): RecallHit[] {
  const q = query.trim()
  // 人与机器看的是同一批库：会话日记 + 全局。短期池不进这里——它本来就会被注入，
  // 人要"看看里面有什么"看的也不是手边那几条。
  const pool: Array<{ entry: MemoryEntry; layer: MemoryLayer }> = [
    ...memory.session.map((entry) => ({ entry, layer: 'session' as MemoryLayer })),
    ...memory.global.map((entry) => ({ entry, layer: 'global' as MemoryLayer })),
  ]
  // 空关键词 = "我就想看看里面有什么"：按重要度列出来，不做检索
  if (q === '') {
    const all = pool.map((x) => ({ ...x, score: x.entry.importance + x.entry.hits * 0.1 }))
    all.sort((a, b) => b.score - a.score)
    return all.slice(0, limit)
  }
  const scores = bm25Scores(q, pool.map((x) => x.entry.text))
  const hits = pool
    .map((x, i) => ({ ...x, score: bm25Text(scores[i] ?? 0) }))
    .filter((hit) => hit.score >= 0.12)
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/**
 * 遗忘：把这些 id 从短期与长期里都删掉，并记进遗忘名单。
 *
 * 主动遗忘是"像人"的一部分（有些事就是不该一直记着），但它必须**可重放**：
 * 模型通过 `forget_memory` 工具说忘掉，那次调用就在日志里，折叠时删掉即可。
 */
export function forgetEntries(memory: MemoryState, ids: string[], at: number): MemoryState {
  if (ids.length === 0) return memory
  const idSet = new Set(ids)
  const short = memory.short.filter((entry) => !idSet.has(entry.id))
  const session = memory.session.filter((entry) => !idSet.has(entry.id))
  const global = memory.global.filter((entry) => !idSet.has(entry.id))
  const changed =
    short.length !== memory.short.length ||
    session.length !== memory.session.length ||
    global.length !== memory.global.length
  // 名单也要更新：那条可能已经不在库里了，但记下来能让"同一份档案被别的会话接管"时不再长回来
  const forgotten = [...new Set([...memory.forgotten, ...ids])].slice(-500)
  if (!changed && forgotten.length === memory.forgotten.length) return memory
  return { ...memory, short, session, global, forgotten, updatedAt: at }
}
