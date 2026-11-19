/**
 * v3.0 记忆的读写入口。
 *
 * 分工：`layout.ts` 管路径与原子写，`entries.ts` 管磁盘形状与简介，
 * **本文件管"哪一层该读哪份文件、写入时怎么追加快照"**：
 *
 * | 层 | 文件 | 写入 |
 * |---|---|---|
 * | 短期 `short` | `short/<工作区键>.jsonl.zst` | 每次一整份快照（全量语义） |
 * | 会话 `session` | `sessions/<会话 id>/memory.jsonl.zst` | 每次一整份快照（**可修订**） |
 * | 全局 `global` | `global/memory.jsonl.zst` | 每次一整份快照 |
 * | 人设 / 统计 | `global/persona.jsonl.zst` | 每次一整份快照（读最后一个） |
 *
 * ## v2 的"只追加"为什么被换掉
 *
 * 会话记忆原来是增量追加、永不改写。可同一段会话会写很多次：上一次记下"还没做完"，
 * 这一次做完了——旧条目还躺在文件里，新的又接在后面，读起来就是自相矛盾的两句。
 * v3 换成**顺序快照**：每次写入追加一行"这一层当时的全部条目"，读取只认最后一行。
 * 于是改、删都在新快照里发生（旧快照仍在文件里可追溯），而"当前内容"永远只有一份。
 *
 * 每个文件最多留 `SNAPSHOT_KEEP` 行，超了裁掉最老的再整份重写——静默裁，不额外记一行。
 */
import {
  fileExists,
  globalMemoryFile,
  globalPersonaFile,
  globalSummaryFile,
  listSessionIds,
  listShortFiles,
  readText,
  readZstdLines,
  sessionMemoryFile,
  sessionSummaryFile,
  shortFile,
  trashFile,
  writeTextAtomic,
  writeZstdLines,
} from './layout.js'
import {
  SNAPSHOT_KEEP,
  STORE_VERSION,
  parseSnapshotLine,
  parseStoredEntry,
  renderGlobalSummary,
  renderSessionSummary,
  wrapSnapshot,
  type SnapshotReason,
  type StoredEntry,
  type StoredScope,
  type StoredSnapshot,
} from './entries.js'
import { bm25Scores, type MemoryEntry } from 'dsh-mind-core'

/**
 * 能落盘的条目：结构上兼容 core 的 `MemoryEntry`（v2 的它自带 `scope`/`seq`，
 * 这里只要求最小公共字段，多出来的属性原样带过去）。
 */
export interface WritableEntry {
  id: string
  kind: MemoryEntry['kind']
  text: string
  importance: number
  hits: number
  createdAt: number
  lastAt: number
  because?: string
  origin?: 'self' | 'heard' | 'digest'
  /** 工作区键；`''`/`null`/缺省的含义与 core 一致（显式全局 / 未分组会话 / 不知道）。 */
  ws?: string | null
  sessionId?: string
  /** 这条是从会话日志的第几条事件来的（能追到出处）。 */
  seq?: number
  /** 归属层（回收站按它决定"恢复回哪一层"）。 */
  scope?: MemoryEntry['scope']
}

/** 一次写入的来由：为什么会有这一份新快照。 */
export interface SnapshotWriteOptions {
  reason: SnapshotReason
  /** 会话日志走到第几个事件了（只有会话层有）。 */
  seq?: number
}

/** 把运行时的条目转成磁盘形状。`where` 只对工作区记忆有意义。 */
export function toStored(entry: WritableEntry, scope: StoredScope, extra?: { where?: string; legacy?: boolean }): StoredEntry {
  const stored: StoredEntry = {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    importance: entry.importance,
    hits: entry.hits,
    createdAt: entry.createdAt,
    lastAt: entry.lastAt,
    origin: entry.origin === 'self' || entry.origin === 'digest' ? entry.origin : 'heard',
    scope,
    // 磁盘上的正文里"为什么记它"是记忆的一部分；运行时这边允许没写，落盘时补空串。
    because: entry.because ?? '',
  }
  if (typeof entry.ws === 'string' && entry.ws !== '') stored.ws = entry.ws
  if (entry.sessionId !== undefined && entry.sessionId !== '') stored.sessionId = entry.sessionId
  if (typeof entry.seq === 'number' && Number.isFinite(entry.seq)) stored.seq = entry.seq
  if (extra?.where !== undefined) stored.where = extra.where
  if (extra?.legacy === true) stored.legacy = true
  return stored
}

/** 工作区记忆：留一份在全局文件里，但明写出处（人看的一行字）。 */
export function asWorkspaceEntry(entry: WritableEntry, workspaceKey: string): StoredEntry {
  return toStored({ ...entry, ws: workspaceKey }, 'workspace', { where: workspaceKey })
}

// ---------------------------------------------------------------- 快照的读写

/** 一次读取的结果：条目、丢掉的数量、最后一行快照，以及**原始行**（追加时要拿它重写整份）。 */
interface SnapshotRead {
  entries: StoredEntry[]
  dropped: number
  snapshot: StoredSnapshot | null
  lines: string[]
}

/**
 * 读一份快照文件——**只看最后一行**。
 *
 * 丢掉的数量：文件在但解压不出来算 1（整份丢了，但我们不知道里面本来有几条）；
 * 最后一行坏了、或行里有坏条目，按坏行/坏条数算。**任何情况都不抛**。
 */
function readLastSnapshot(file: string, scope: StoredScope, owner?: string): SnapshotRead {
  const read = readZstdLines(file)
  // 读不动就当没有：文件不在是常态，解压不出来按"丢了一份"报数
  const lines = read.error === undefined ? read.lines : []
  const empty = read.error === 'unreadable' ? 1 : 0
  const last = lines.at(-1)
  if (last === undefined) return { entries: [], dropped: empty, snapshot: null, lines }
  const parsed = parseSnapshotLine(last, scope, owner)
  if (parsed.snapshot === null) return { entries: [], dropped: parsed.dropped + empty, snapshot: null, lines }
  return { entries: parsed.snapshot.entries, dropped: parsed.dropped, snapshot: parsed.snapshot, lines }
}

/**
 * 追加一行快照，并把文件裁到最近 `SNAPSHOT_KEEP` 行。
 *
 * **内容与来由都没变就不追加**：`flush` 的签名里带着统计数字（回合数、脉冲数），
 * 统计一变就会走到这里；不比对的话，三层记忆会各自被追加一条一模一样的快照，
 * 20 行的历史很快被无意义的行冲光。这里比对的是"条目 + 理由"，
 * 所以内容真的变了、或者理由变了（比如收尾的 `final`），照样会留下新的一行。
 *
 * 目录还不存在、而且这份快照是空的（`entries` 为空的首次写入）：不建文件——
 * "这个工作区还没有手边记忆"不需要专门留一份证据。
 */
function writeSnapshot(file: string, snapshot: StoredSnapshot, previous: SnapshotRead): boolean {
  const before = previous.snapshot
  // 还没有这份文件、而这一份快照又是空的：不建文件（"还没有手边记忆"不需要留证据）
  if (before === null && snapshot.entries.length === 0) return true
  const sameContent = before !== null && JSON.stringify(before.entries) === JSON.stringify(snapshot.entries)
  if (before !== null && sameContent && before.reason === snapshot.reason) return true

  const lines = [...previous.lines, JSON.stringify(snapshot)]
  const kept = lines.length > SNAPSHOT_KEEP ? lines.slice(lines.length - SNAPSHOT_KEEP) : lines
  return writeZstdLines(file, kept)
}

// ---------------------------------------------------------------- 全局

export function loadGlobal(raw: string): { entries: StoredEntry[]; dropped: number } {
  const { entries, dropped } = readLastSnapshot(globalMemoryFile(raw), 'global')
  return { entries, dropped }
}

/** 全局记忆是全量语义：把当前这份完整写成一行的新快照（顺手把简介也重写，别让两份对不上）。 */
export function saveGlobal(raw: string, entries: StoredEntry[], now: number, opts: SnapshotWriteOptions): boolean {
  const file = globalMemoryFile(raw)
  const previous = readLastSnapshot(file, 'global')
  const ok = writeSnapshot(file, wrapSnapshot('global', entries, now, { reason: opts.reason, seq: opts.seq }), previous)
  writeTextAtomic(globalSummaryFile(raw), renderGlobalSummary(entries, now))
  return ok
}

// ---------------------------------------------------------------- 会话

export function loadSession(raw: string, sessionId: string): { entries: StoredEntry[]; dropped: number } {
  const { entries, dropped } = readLastSnapshot(sessionMemoryFile(raw, sessionId), 'session', sessionId)
  return { entries, dropped }
}

/** 第一段挑会话的结果：看了多少、缺简介多少、最后进了哪几个。 */
export interface SessionSelection {
  /** 选中、准备进去读条目的会话 id（按简介相关度降序）。 */
  entered: string[]
  /** 一共看了几个会话目录（不含当前会话）。 */
  lookedAt: number
  /** 其中简介缺失或为空的个数：这些跳过，不参与打分。 */
  missing: number
  /** 简介非空、但与 query 一个字面重合都没有的个数。 */
  irrelevant: number
}

/**
 * 跨会话检索的第一段：**只读简介，不碰日记。**
 *
 * 用户的原话是"先读这个会话记忆的简介，看是不是自己需要的，不是就查下一题，是的话，
 * 就进这个会话里去查"。所以这里只做挑选：把每个会话的 `summary.md` 当成一篇文档，
 * 用 core 的 `bm25Scores` 打分（不另写一套打分），取前 `limit` 个。
 *
 * 门槛是"至少共享一个检索词"（BM25 原始分 > 0）。简介全缺、全空、或全不相关时
 * 就返回空 `entered`——宁可如实说"没一个像"，也不硬凑会话。
 *
 * 当前会话必须排除：它的日记本来就在 `memory()` 里，再进一遍会重复。
 */
export function selectSessionsBySummary(
  raw: string,
  query: string,
  limit = 5,
  excludeSessionId = '',
): SessionSelection {
  const ids = listSessionIds(raw).filter((id) => id !== excludeSessionId)
  const lookedAt = ids.length
  const docs: { id: string; text: string }[] = []
  let missing = 0

  for (const id of ids) {
    const summary = (readText(sessionSummaryFile(raw, id)) ?? '').trim()
    if (summary === '') {
      missing += 1
      continue
    }
    docs.push({ id, text: summary })
  }

  const trimmed = query.trim()
  if (trimmed === '' || docs.length === 0 || limit <= 0) {
    return { entered: [], lookedAt, missing, irrelevant: docs.length }
  }

  const scores = bm25Scores(trimmed, docs.map((doc) => doc.text))
  const ranked = docs
    .map((doc, index) => ({ id: doc.id, score: scores[index] ?? 0 }))
    .filter((item) => item.score > 0)
    // 同分时保持 listSessionIds 的顺序（它已经排过序），结果才可复现。
    .sort((a, b) => b.score - a.score)

  return {
    entered: ranked.slice(0, limit).map((item) => item.id),
    lookedAt,
    missing,
    irrelevant: docs.length - ranked.length,
  }
}

/**
 * 会话记忆：写一整份当前内容（**可修订**）。
 *
 * 旧条目在这次快照里没出现就等于删了，改了就改了——这正是"后一次做完了"该有的样子。
 * 返回是否真的落了盘（内容没变时返回 true，表示"盘上已经是对的"）。
 */
export function saveSession(
  raw: string,
  sessionId: string,
  entries: StoredEntry[],
  now: number,
  opts: SnapshotWriteOptions,
): boolean {
  const file = sessionMemoryFile(raw, sessionId)
  const previous = readLastSnapshot(file, 'session', sessionId)
  const snapshot = wrapSnapshot('session', entries, now, { reason: opts.reason, seq: opts.seq, owner: sessionId })
  const ok = writeSnapshot(file, snapshot, previous)
  writeTextAtomic(sessionSummaryFile(raw, sessionId), renderSessionSummary(entries, now, sessionId))
  return ok
}

// ---------------------------------------------------------------- 短期

export function loadShort(raw: string, workspaceKey: string): { entries: StoredEntry[]; dropped: number } {
  // 短期层本身就是"按工作区一份"，所以条目 scope 一律 workspace
  const { entries, dropped } = readLastSnapshot(shortFile(raw, workspaceKey), 'workspace', workspaceKey === '' ? undefined : workspaceKey)
  return { entries, dropped }
}

/** 短期记忆是全量语义：写一整份当前内容。 */
export function saveShort(
  raw: string,
  workspaceKey: string,
  entries: StoredEntry[],
  now: number,
  opts: SnapshotWriteOptions,
): boolean {
  const file = shortFile(raw, workspaceKey)
  const owner = workspaceKey === '' ? undefined : workspaceKey
  const previous = readLastSnapshot(file, 'workspace', owner)
  return writeSnapshot(file, wrapSnapshot('workspace', entries, now, { reason: opts.reason, seq: opts.seq, owner }), previous)
}

/**
 * 把所有短期文件清空（各追加一份空快照），返回清了几份。
 *
 * 为什么按**文件**清而不是按工作区键清：文件名是工作区键的哈希（见 `safeKey`），反推不回来。
 * 这是 `/mind reset` 与 `reset-once` 的一部分——"记忆从空开始"不能只清全局层，
 * 不然下一个会话又从 `short/` 里把手边的事捡回来。
 */
export function clearShort(raw: string, now: number): number {
  let cleared = 0
  for (const file of listShortFiles(raw)) {
    const previous = readLastSnapshot(file, 'workspace')
    if (writeSnapshot(file, wrapSnapshot('workspace', [], now, { reason: 'manual' }), previous)) cleared += 1
  }
  return cleared
}

/**
 * 把所有会话日记清空（各追加一份空快照），返回清了几份。
 *
 * 与 `clearShort` 同一个道理：读取只认最后一行，所以"追加一份空的"就是清空，
 * 旧内容仍留在文件里可以翻回来对。会话日记是**可修订**的（每次写一整份快照），
 * 所以空快照落下之后，那一段旧日记就真的没了——这正是"清库"要的效果。
 * `saveSession` 会顺手把那份人读的 `summary.md` 重生成（不会留着旧简介）。
 *
 * 只清**已经有日记文件**的会话：没写过日记的会话不该因为它多出一份空文件。
 */
export function clearSessions(raw: string, now: number): number {
  let cleared = 0
  for (const sessionId of listSessionIds(raw)) {
    if (!fileExists(sessionMemoryFile(raw, sessionId))) continue
    if (saveSession(raw, sessionId, [], now, { reason: 'manual' })) cleared += 1
  }
  return cleared
}

/**
 * 把三层记忆里所有条目的 id 收一份（清库用）。
 *
 * 为什么从**磁盘**收、而不是从 `MindPersist` 收：档案里只有跨会话层与人设——
 * 手边（`short/<工作区>.jsonl.zst`）住在会话状态那边，会话日记住在各自的会话目录里。
 * 2026-11-13 就是这么漏的：`/mind reset-memory` 只划到了跨会话库那一条，手边那两条没进名单，
 * 于是下一次落盘又把它们写回来，面板上看着像"清了个寂寞"。
 */
export function collectMemoryIds(raw: string): string[] {
  const ids = new Set<string>()
  const take = (file: string): void => {
    try {
      const read = readZstdLines(file)
      const last = read.lines.at(-1)
      if (last === undefined) return
      const parsed = JSON.parse(last) as { entries?: unknown }
      if (!Array.isArray(parsed.entries)) return
      for (const entry of parsed.entries as Array<{ id?: unknown }>) {
        if (typeof entry?.id === 'string' && entry.id !== '') ids.add(entry.id)
      }
    } catch {
      /* 读不动就当没有——清库不该因为一个坏文件而整件事做不成 */
    }
  }
  take(globalMemoryFile(raw))
  for (const file of listShortFiles(raw)) take(file)
  for (const sessionId of listSessionIds(raw)) take(sessionMemoryFile(raw, sessionId))
  return [...ids]
}

// ---------------------------------------------------------------- 回收站（假删的落点）

/**
 * 回收站里的一条：原样留着它在时的全部字段，另加"什么时候、从哪一层、为什么"。
 *
 * 为什么要有回收站：清 / 划都是**假删**——条目从三层里消失，但正文必须留着，
 * 用户才能"我清错了，捞回来"。只靠快照文件的前几行不够：那些行会被 `SNAPSHOT_KEEP` 裁掉
 * （文件写满以后，一次清空正好把旧内容挤出窗口）。
 *
 * 它**不进会话状态**：回收站是"文件历史"，不是它此刻记得的事——不进注入、不参与检索，
 * 因此也不会让"可回放"依赖磁盘。恢复才是把条目送回某一层的动作。
 */
export interface TrashedEntry extends StoredEntry {
  trashedAt: number
  /** 从哪一层消失的（展示用；条目自己的 `scope` 才是权威）。 */
  trashedFrom: StoredScope
  /** 为什么被删（人话，`show trash` 直接印出来）。 */
  trashedReason: string
  /** 恢复过的时间；有它就不在"等恢复"之列，也不会被重复恢复。 */
  restoredAt?: number
}

/** 回收站最多留几条（超了丢最老的）。它是后悔药，不是永久档案。 */
export const TRASH_KEEP = 300

/** 读回收站：只看最后一行；读不动就当空，**绝不抛**（坏文件不该让命令崩）。 */
export function loadTrash(raw: string): TrashedEntry[] {
  const read = readZstdLines(trashFile(raw))
  if (read.error !== undefined) return []
  const last = read.lines.at(-1)
  if (last === undefined) return []
  try {
    const parsed = JSON.parse(last) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) return []
    const out: TrashedEntry[] = []
    for (const item of parsed.entries) {
      if (item === null || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const scope: StoredScope =
        o['scope'] === 'workspace' || o['scope'] === 'session' ? (o['scope'] as StoredScope) : 'global'
      const base = parseStoredEntry(item, scope, typeof o['sessionId'] === 'string' ? o['sessionId'] : undefined)
      if (base === null) continue
      const from: StoredScope =
        o['trashedFrom'] === 'workspace' || o['trashedFrom'] === 'session' || o['trashedFrom'] === 'global'
          ? (o['trashedFrom'] as StoredScope)
          : base.scope
      out.push({
        ...base,
        trashedAt: typeof o['trashedAt'] === 'number' ? o['trashedAt'] : 0,
        trashedFrom: from,
        trashedReason: typeof o['trashedReason'] === 'string' ? o['trashedReason'] : '',
        ...(typeof o['restoredAt'] === 'number' ? { restoredAt: o['restoredAt'] } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

/** 写一整份回收站（全量语义，与别的层一致：追加一行，读取只认最后一行）。 */
export function saveTrash(
  raw: string,
  entries: TrashedEntry[],
  now: number,
  opts: { reason: SnapshotReason },
): boolean {
  const kept =
    entries.length > TRASH_KEEP
      ? [...entries].sort((a, b) => b.trashedAt - a.trashedAt).slice(0, TRASH_KEEP)
      : entries
  const file = trashFile(raw)
  const previous = readZstdLines(file)
  const lines = previous.error === undefined ? [...previous.lines] : []
  const last = lines.at(-1)
  if (last !== undefined) {
    try {
      const prev = JSON.parse(last) as { entries?: unknown; reason?: unknown }
      if (JSON.stringify(prev.entries ?? []) === JSON.stringify(kept) && prev.reason === opts.reason) return true
    } catch {
      /* 最后一行坏了：当没有可比的那一行，直接写下新的 */
    }
  }
  lines.push(JSON.stringify({ version: STORE_VERSION, at: now, reason: opts.reason, entries: kept }))
  const capped = lines.length > SNAPSHOT_KEEP ? lines.slice(lines.length - SNAPSHOT_KEEP) : lines
  return writeZstdLines(file, capped)
}

/**
 * 把"从三层里消失的条目"记进回收站：**这是所有假删的唯一入口**。
 *
 * 为什么用"前后 diff"而不是在每个删除点分别调用：删除的路不止一条——
 * 命令 `/mind clear|forget`、模型自己的 `forget_memory` 工具（走会话日志折叠）、
 * 遗忘名单过滤（`withoutForgotten`）、短期池淘汰（`pruneShort`）。逐点调用必然漏一处，
 * 而"上一份里有、这一份没有了"是**唯一能覆盖全部**的判据。
 *
 * 按 id 去重：同一条已经在回收站里等恢复（`restoredAt` 为空）就不重复记。
 * 返回这一次新记进去几条。
 */
export function trashGone(
  raw: string,
  before: readonly WritableEntry[],
  after: readonly WritableEntry[],
  at: number,
  reason: string,
): number {
  const alive = new Set(after.map((entry) => entry.id))
  const gone = before.filter((entry) => !alive.has(entry.id))
  if (gone.length === 0) return 0
  const existing = loadTrash(raw)
  const known = new Set(existing.filter((entry) => entry.restoredAt === undefined).map((entry) => entry.id))
  const fresh: TrashedEntry[] = []
  for (const entry of gone) {
    if (known.has(entry.id)) continue
    const scope: StoredScope = entry.scope ?? 'global'
    fresh.push({
      ...toStored(entry, scope),
      trashedAt: at,
      trashedFrom: scope,
      trashedReason: reason,
    })
  }
  if (fresh.length === 0) return 0
  saveTrash(raw, [...existing, ...fresh], at, { reason: 'manual' })
  return fresh.length
}

/** 标记一批 id 已恢复（在回收站里留痕，但不再算"等恢复"，也不会被重复恢复）。 */
export function markTrashRestored(raw: string, ids: readonly string[], at: number): boolean {
  const wanted = new Set(ids)
  const entries = loadTrash(raw).map((entry) => (wanted.has(entry.id) ? { ...entry, restoredAt: at } : entry))
  return saveTrash(raw, entries, at, { reason: 'manual' })
}

/**
 * **真删**：把一批 id（或全部）从回收站里抹掉。这是唯一不可逆的地方，
 * 所以只有 `/mind purge` 会调它——别的路径一律只做假删。
 */
export function purgeTrash(raw: string, ids: readonly string[] | 'all', at: number): number {
  const entries = loadTrash(raw)
  const kept = ids === 'all' ? [] : entries.filter((entry) => !ids.includes(entry.id))
  saveTrash(raw, kept, at, { reason: 'manual' })
  return entries.length - kept.length
}

// ---------------------------------------------------------------- 人设快照

/**
 * 人设快照的落盘内容（`global/persona.jsonl.zst`）。
 *
 * 装的是"跨会话要带走、但又不在三层记忆里"的东西：人设（说话习惯/自我认知/内核史）、
 * 性情基线、统计，以及**遗忘名单**——名单必须跟着走，丢了它，被明确要求忘掉的东西
 * 下次就会自己冒出来。
 *
 * 参数故意用结构类型而不是 core 的 `MindPersist`：迁移路径手里拿的是"读进来的旧档案"，
 * 形状只是碰巧一样，没必要为了类型去构造一个假的 persist。
 */
export interface PersonaSnapshotSource {
  persona: unknown
  baseline: unknown
  stats: unknown
  memory: { forgotten: string[] }
}

/** 读人设快照：只看最后一行。文件不在、坏了都返回 undefined。 */
export function loadPersonaState(
  raw: string,
): { persona: unknown; baseline: unknown; stats: unknown; forgotten: string[] } | undefined {
  const read = readZstdLines(globalPersonaFile(raw))
  if (read.error !== undefined) return undefined
  const last = read.lines.at(-1)
  if (last === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const o = parsed as Record<string, unknown>
  const forgotten = Array.isArray(o['forgotten'])
    ? o['forgotten'].filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  return { persona: o['persona'] ?? null, baseline: o['baseline'] ?? null, stats: o['stats'] ?? null, forgotten }
}

/** 写一份人设快照。内容与来由都没变时不追加（同 `writeSnapshot` 的规矩）。 */
export function savePersonaState(
  raw: string,
  source: PersonaSnapshotSource,
  now: number,
  opts: SnapshotWriteOptions,
  extra?: { migratedAt?: number },
): boolean {
  const file = globalPersonaFile(raw)
  const content = {
    persona: source.persona,
    baseline: source.baseline,
    stats: source.stats,
    forgotten: source.memory.forgotten,
  }
  const before = readZstdLines(file)
  const lines = before.error === undefined ? [...before.lines] : []
  const last = lines.at(-1)
  if (last !== undefined) {
    try {
      const prev = JSON.parse(last) as Record<string, unknown>
      const sameContent =
        JSON.stringify({ persona: prev['persona'] ?? null, baseline: prev['baseline'] ?? null, stats: prev['stats'] ?? null, forgotten: prev['forgotten'] ?? [] }) ===
        JSON.stringify(content)
      if (sameContent && prev['reason'] === opts.reason) return true
    } catch {
      // 最后一行坏了：当没有可比的那一行，直接写下新的
    }
  }
  lines.push(
    JSON.stringify({
      version: STORE_VERSION,
      at: now,
      reason: opts.reason,
      ...(extra?.migratedAt === undefined ? {} : { migratedAt: extra.migratedAt }),
      ...content,
    }),
  )
  const kept = lines.length > SNAPSHOT_KEEP ? lines.slice(lines.length - SNAPSHOT_KEEP) : lines
  return writeZstdLines(file, kept)
}
