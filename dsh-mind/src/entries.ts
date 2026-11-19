// v3.0 记忆在磁盘上的形状，以及"记忆简介"的渲染。
//
// 为什么单独一层：**文件格式是契约**——人要能直接打开看、别的工具要能读，
// 而 `mind-core` 里的 `MemoryEntry` 是运行时的状态形状（带打分、去重、fold 语义）。
// 两者字段几乎一样，但职责不同，所以这里只做四件事：
//   1. 把 **快照行**（`.jsonl.zst` 的一行）读成可信的形状（读不懂的**丢掉并报数**，绝不编造字段）；
//   2. 把运行时的条目包成一份快照；
//   3. 读**老布局**（v2 的 `.json`）——只出现在 `archive/` 与迁移路径上；
//   4. 渲染简介（`summary.md`）——"这份记忆都记了些什么、方便快速翻找"。
// 打分、去重、迁移都不在这一层。
//
// ## 一行 = 一份完整快照
//
// 每一行是那一层**当时的全部条目**，不是增量。所以：
// - **最后一行就是当前内容**，读取只取最后一行；
// - "上一次没做完、这一次做完了"可以直接在新快照里改掉或删掉旧条目，
//   而旧快照仍留在文件里可追溯（但**不参与读取**）；
// - 行里带着 `at` / `reason`（必要时还有 `seq`）——后来的人能看出它是哪一次写的。
import { KIND_LABEL, type MemoryEntry } from 'dsh-mind-core'

/** 三种记忆的归属层。与会话/工作区无关的规矩是 `global`。 */
export const SCOPES = ['global', 'workspace', 'session'] as const
export type StoredScope = (typeof SCOPES)[number]

/**
 * 磁盘上的一条记忆。
 *
 * 与 core 的 `MemoryEntry` 的差别只有三处，都是"落地才需要"的：
 * - `scope`：它属于哪一层（core 里由三份状态分开承载，文件里必须自带这个字段）；
 * - `where`：工作区记忆的出处（人看的一行字，不参与检索）；
 * - `legacy`：老档案（v1 之前记的），如实标"当年没记归属"，不替历史编。
 */
export interface StoredEntry {
  id: string
  kind: MemoryEntry['kind']
  text: string
  importance: number
  hits: number
  createdAt: number
  lastAt: number
  /** 为什么记它。core 里是必填（"为什么"是记忆的一部分），文件里也当必填：缺了读成空串。 */
  because: string
  origin: 'self' | 'heard' | 'digest'
  scope: StoredScope
  ws?: string
  sessionId?: string
  seq?: number
  where?: string
  legacy?: boolean
}

/** 现在写盘的是第 3 版形状（快照行）。 */
export const STORE_VERSION = 3

/**
 * 每个记忆文件最多留几份快照。超了就把最老的裁掉再整份重写（静默裁，不额外记一行）。
 *
 * v2.4.x 从 20 提到 50：快照文件是"假删"的**第二层**保证（第一层是回收站），
 * 而 20 行在真机上很容易被写满——满了以后一次清空就把旧内容挤出窗口（实测过）。
 * 代价是文件更大：一份快照是全量条目，50 行 ≈ 50 份历史。
 */
export const SNAPSHOT_KEEP = 50

/** 一份快照为什么被写下。 */
export const SNAPSHOT_REASONS = ['steps', 'compaction', 'final', 'manual', 'migrate'] as const
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number]

/**
 * 一份记忆快照：`.jsonl.zst` 里的**一行**。
 *
 * `entries` 是这一层**当时**的全部条目（全量，不是增量）。
 * `seq` 写"这一行覆盖到会话日志的第几个事件"，只有会话层知道时才带上。
 */
export interface StoredSnapshot {
  version: 3
  scope: StoredScope
  /** 这个文件属于谁：global 无、workspace 是工作区键、session 是会话 id。 */
  owner?: string
  at: number
  seq?: number
  reason: SnapshotReason
  entries: StoredEntry[]
}

/**
 * **上一代（v2）**的文件形状：一个 `.json` 装一份全量条目。
 *
 * v3 不再写它，但 `archive/` 里躺着这种文件，迁移要读得回来，所以形状留在这一层。
 */
export interface StoredFile {
  version: 2
  scope: StoredScope
  owner?: string
  updatedAt: number
  entries: StoredEntry[]
}

/** 四个种类，验证用（顺序与 core 的 KIND_LABEL 一致）。 */
const KINDS = ['fact', 'agreement', 'preference', 'lesson'] as const

function isKind(value: unknown): value is MemoryEntry['kind'] {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

function isScope(value: unknown): value is StoredScope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value)
}

function isReason(value: unknown): value is SnapshotReason {
  return typeof value === 'string' && (SNAPSHOT_REASONS as readonly string[]).includes(value)
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 把一条磁盘记录读成 `StoredEntry`。
 *
 * 规矩：**id 与 text 缺一不可，kind 必须是那四个之一**，其余字段能用就用、不能用就退回合理默认值；
 * 读不懂的（没有正文、种类不认识）返回 `null` 让调用方丢掉并报数——
 * 一条正文缺失的记忆留着也没有意义，胡乱补一个 kind 等于编造。
 */
export function parseStoredEntry(raw: unknown, scope: StoredScope, owner?: string): StoredEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const id = str(o['id'])
  const text = str(o['text']).trim()
  if (id === '' || text === '') return null
  if (!isKind(o['kind'])) return null

  const ws = typeof o['ws'] === 'string' && o['ws'] !== '' ? o['ws'] : undefined
  const sessionId = typeof o['sessionId'] === 'string' && o['sessionId'] !== '' ? o['sessionId'] : undefined
  const entry: StoredEntry = {
    id,
    kind: o['kind'],
    text,
    importance: Math.min(1, Math.max(0, num(o['importance'], 0.5))),
    hits: Math.max(0, num(o['hits'], 0)),
    createdAt: num(o['createdAt'], 0),
    lastAt: num(o['lastAt'], num(o['createdAt'], 0)),
    origin: o['origin'] === 'self' || o['origin'] === 'digest' ? o['origin'] : 'heard',
    // 归属以**条目自己写的**为准：全局文件里住着带出处的**工作区**条目（§22.8），
    // 只按文件那一层的 scope 读，工作区条目就会被当成"关于全局"的，计数与分组全错。
    // 自己没写（老文件）才退回文件那一层。
    scope: isScope(o['scope']) ? o['scope'] : scope,
    // 缺了就空串，不写 undefined：`because` 在 core 里是必填，这里留个洞的话，
    // 每个消费点都得自己处理"有没有这个字段"，迟早有一处漏掉。
    because: str(o['because']).trim(),
  }
  // 归属信息只在真的知道时才写：老档案没有 ws 就是没有，不许补一个空串
  if (ws !== undefined) entry.ws = ws
  if (sessionId !== undefined) entry.sessionId = sessionId
  else if (scope === 'session' && owner !== undefined) entry.sessionId = owner
  if (typeof o['seq'] === 'number' && Number.isFinite(o['seq'])) entry.seq = o['seq']
  const where = str(o['where']).trim()
  if (where !== '') entry.where = where
  if (o['legacy'] === true) entry.legacy = true
  return entry
}

/**
 * 读一行快照。
 *
 * 丢掉的分两种，都只报数不抛：**坏行**（不是 JSON / 没有 entries 数组）算 1，
 * 行里**读不懂的条目**按条算。行本身能读、只是有几条坏了时，其余条目照旧能用——
 * "能读多少读多少"是底线。
 */
export function parseSnapshotLine(
  raw: string,
  scope: StoredScope,
  owner?: string,
): { snapshot: StoredSnapshot | null; dropped: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { snapshot: null, dropped: 1 }
  }
  if (parsed === null || typeof parsed !== 'object') return { snapshot: null, dropped: 1 }
  const o = parsed as Record<string, unknown>
  if (!Array.isArray(o['entries'])) return { snapshot: null, dropped: 1 }

  const entries: StoredEntry[] = []
  let dropped = 0
  for (const item of o['entries']) {
    const entry = parseStoredEntry(item, scope, owner)
    if (entry === null) dropped += 1
    else entries.push(entry)
  }

  const snapshot: StoredSnapshot = {
    version: STORE_VERSION,
    scope,
    at: num(o['at'], 0),
    // 理由读不懂时不编一个"记得住的"：退回 `manual`，因为人工/程序性写入是不需要额外解释的那一类。
    reason: isReason(o['reason']) ? o['reason'] : 'manual',
    entries,
  }
  if (owner !== undefined && owner !== '') snapshot.owner = owner
  if (typeof o['seq'] === 'number' && Number.isFinite(o['seq'])) snapshot.seq = o['seq']
  return { snapshot, dropped }
}

/**
 * 把条目包成一份快照（准备写成一行）。
 *
 * `seq` 缺省时取条目里最大的那个：那就是"这份快照覆盖到会话日志的第几个事件"，
 * 不必让每个调用点自己再算一遍。
 */
export function wrapSnapshot(
  scope: StoredScope,
  entries: StoredEntry[],
  now: number,
  opts: { reason: SnapshotReason; owner?: string; seq?: number },
): StoredSnapshot {
  const snapshot: StoredSnapshot = { version: STORE_VERSION, scope, at: now, reason: opts.reason, entries }
  if (opts.owner !== undefined && opts.owner !== '') snapshot.owner = opts.owner
  const seq = opts.seq ?? entries.reduce((max, entry) => (entry.seq !== undefined && entry.seq > max ? entry.seq : max), 0)
  if (seq > 0) snapshot.seq = seq
  return snapshot
}

/** 读一份**老布局**（v2 的 `.json`）的内容：容忍"只有数组"的写法，返回条目与丢掉的数量。 */
export function parseStoredFile(raw: unknown, scope: StoredScope, owner?: string): { entries: StoredEntry[]; dropped: number } {
  const list = Array.isArray(raw)
    ? { entries: raw as unknown[] }
    : raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : undefined
  if (list === undefined) return { entries: [], dropped: 0 }

  const rawEntries = Array.isArray(list.entries) ? list.entries : []
  const entries: StoredEntry[] = []
  let dropped = 0
  for (const item of rawEntries) {
    const parsed = parseStoredEntry(item, scope, owner)
    if (parsed === null) dropped += 1
    else entries.push(parsed)
  }
  return { entries, dropped }
}

/** 日期：只到天，写给人看。 */
function day(at: number): string {
  if (!(at > 0)) return '日期不明'
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 给一条目写一行摘要（简介里用）：`[约定] 这个项目用 pnpm（重要度 0.85｜取回 2 次｜2026-11-06）`。 */
export function entryLine(entry: StoredEntry): string {
  const bits = [`重要度 ${entry.importance.toFixed(2)}`, `取回 ${entry.hits} 次`, day(entry.createdAt)]
  if (entry.origin === 'self') bits.push('它自己写的')
  if (entry.origin === 'digest') bits.push('收尾时按规则拼的')
  if (entry.legacy === true) bits.push('当年没记归属')
  return `- [${KIND_LABEL[entry.kind]}] ${entry.text}（${bits.join('｜')}）`
}

/**
 * 全局记忆简介。
 *
 * 目的很具体：让人（和它自己）**不用翻 JSON 就知道这份记忆里有什么**，
 * 所以先给"有什么种类的多少条"，再按种类列出全部条目——全局记忆本来就不该很大。
 */
export function renderGlobalSummary(entries: StoredEntry[], now: number): string {
  const lines: string[] = ['# 全局记忆简介', '']
  if (entries.length === 0) {
    lines.push('（还空着。规矩、关于人的偏好这类"走到哪都成立"的事才会记在这里。）')
    lines.push('', `更新时间：${day(now)}`, '')
    return lines.join('\n')
  }

  const byKind = new Map<MemoryEntry['kind'], StoredEntry[]>()
  for (const entry of entries) {
    const list = byKind.get(entry.kind) ?? []
    list.push(entry)
    byKind.set(entry.kind, list)
  }
  const countText = [...byKind.entries()].map(([kind, list]) => `${KIND_LABEL[kind]} ${list.length} 条`).join('｜')
  lines.push(`共 ${entries.length} 条：${countText}`, '')

  for (const [kind, list] of byKind) {
    lines.push(`## ${KIND_LABEL[kind]}（${list.length} 条）`, '')
    for (const entry of list) {
      lines.push(entryLine(entry))
      if (entry.where !== undefined) lines.push(`  · 出处：${entry.where} 这个工作区里说的`)
    }
    lines.push('')
  }
  lines.push(`更新时间：${day(now)}`, '')
  return lines.join('\n')
}

/**
 * 会话记忆简介。
 *
 * 会话记忆是日记式的，但**可修订**（每次写入一整份快照，旧条目该改就改、该删就删），
 * 所以这里渲染的就是"当前这一份日记长什么样"，按**天**分段：
 * 先给"这份记忆覆盖了哪一段时间、一共几条"，再一天一段列出当天记下的事。
 */
export function renderSessionSummary(entries: StoredEntry[], now: number, sessionId?: string): string {
  const head = sessionId === undefined ? '# 会话记忆简介' : `# 会话记忆简介 · ${sessionId}`
  const lines: string[] = [head, '']
  if (entries.length === 0) {
    lines.push('（这一段还没有值得留下的。日记式地记：发生过什么、定下了什么。）')
    lines.push('', `更新时间：${day(now)}`, '')
    return lines.join('\n')
  }

  const first = entries.reduce((min, entry) => (entry.createdAt < min ? entry.createdAt : min), entries[0]?.createdAt ?? 0)
  const last = entries.reduce((max, entry) => (entry.createdAt > max ? entry.createdAt : max), 0)
  lines.push(`共 ${entries.length} 条，覆盖 ${day(first)} ～ ${day(last)}。`, '')

  // 按天分段：同一件事隔几天又发生，是要能看出来的
  const days = new Map<string, StoredEntry[]>()
  for (const entry of entries) {
    const key = day(entry.createdAt)
    const list = days.get(key) ?? []
    list.push(entry)
    days.set(key, list)
  }
  for (const [key, list] of days) {
    lines.push(`## ${key}（${list.length} 条）`, '')
    for (const entry of list) {
      lines.push(entryLine(entry))
      if (entry.seq !== undefined) lines.push(`  · 出处：会话日志第 ${entry.seq} 条事件`)
    }
    lines.push('')
  }
  lines.push(`更新时间：${day(now)}`, '')
  return lines.join('\n')
}
