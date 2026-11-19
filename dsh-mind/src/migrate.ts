/**
 * v1 / v2 → v3.0 的一次性迁移。
 *
 * ## 为什么要有这个文件
 *
 * 老档案不能丢，也不能靠"下一次写入顺便修正"——那就等于让每个写入点都记着历史包袱。
 * 所以：**读进来、判一次、写成 v3 的快照文件，留一枚标记，之后不再管**。
 *
 * ## v2 的真实情况（读代码读出来的，别信文档）
 *
 * v2 的权威是根目录的 `state.json`（`savePersist` 每次 flush 都写它），
 * 而 `global/memory.json`、`short/*.json`、`sessions/<id>/memory.json` 是 `writeLandingFiles` 的落地副本。
 * 但 v2 运行期把 `stateFile(...)`（**文件**路径）当目录传给了 layout 的那些函数，
 * 于是落地副本被写到 `<stateDir>/state.json/global/…`——`state.json` 是个文件，那是 ENOTDIR，
 * 写入静默失败。**落地那条路在 v2 运行时其实是死的**，盘上那份停在迁移当时的样子。
 *
 * 所以转换**以聚合档案 `state.json` 为准**（它是活的），落地文件用来补它没有的东西
 * （各会话的日记文件、以及聚合档案读不出来时的兜底）。本机实测：`state.json` 20:32、
 * 落地文件 18:44，条数一样（全局 1 / 短期 6 / 会话 0）——用落地文件会白白退回两个小时前。
 *
 * ## 规矩
 *
 * - **不编造归属**：当年没记 ws 的老条目标 `legacy: true` 放进全局，并如实说明"当年没记归属"；
 *   `ws: ''` 是 v1 的显式全局；具体路径 → 工作区记忆并标出出处；`ws: null` 且有会话 id →
 *   那个会话的日记；其余进全局。
 * - **幂等**：跑完写 `migrated-to-v3` 标记；有标记就直接返回，不重复搬。
 * - **旧文件不删，改名进 `archive/`**：它们是源头，留着便于对账
 *   （`state.json` → `archive/state.v1.json`，v2 的落地文件按原相对路径放进 `archive/` 下）。
 */
import { readdirSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import {
  archiveDir,
  archiveFile,
  fileExists,
  legacyMigrationFile,
  migrationFile,
  readJson,
  rootDir,
  sessionSummaryFile,
  writeTextAtomic,
} from './layout.js'
import {
  parseStoredEntry,
  parseStoredFile,
  renderSessionSummary,
  type StoredEntry,
  type StoredScope,
} from './entries.js'
import { saveGlobal, savePersonaState, saveSession, saveShort } from './store.js'

/** 老档案里我们真正要读的部分（其余字段忽略，不做校验——读不懂的条目会被丢掉并报数）。 */
interface LegacyArchive {
  format?: number
  mind?: LegacyMind
}

interface LegacyMind {
  persona?: unknown
  baseline?: unknown
  stats?: unknown
  memory?: {
    short?: unknown[]
    /** v1 的长期库。 */
    long?: unknown[]
    /** v2 把 `long` 改名叫 `global`，也读。 */
    global?: unknown[]
    /** v2 的本会话日记。 */
    session?: unknown[]
    forgotten?: unknown[]
    updatedAt?: number
  }
}

export interface MigrationCounts {
  /** 落进 `global/memory.jsonl.zst` 的条数。 */
  global: number
  /** 其中属于某个工作区（带 `where`）的条数。 */
  workspace: number
  /** 落进各会话 `memory.jsonl.zst` 的条数。 */
  session: number
  /** 落进 `short/` 的条数。 */
  short: number
  /** 建了记忆的会话 id。 */
  sessions: string[]
  /** 读不懂、被丢掉的条数（要报出来，不能悄悄少）。 */
  dropped: number
  /** 这次成功写下的快照文件数（不含简介 `.md` 与标记）。 */
  files: number
}

export interface MigrationResult {
  migrated: boolean
  note: string
  counts: MigrationCounts
  /** 这批老数据是从哪一代搬来的。 */
  from: 'v1' | 'v2' | 'none'
}

const EMPTY: MigrationCounts = { global: 0, workspace: 0, session: 0, short: 0, sessions: [], dropped: 0, files: 0 }

/** v2 落地文件的路径（v3 的 layout 已经不再产出它们，所以在这里就地算出来）。 */
function legacyPaths(dir: string): {
  globalMemory: string
  globalPersona: string
  short: string
  sessions: string
  mirror: string
  v1Mirror: string
} {
  const root = rootDir(dir)
  return {
    globalMemory: path.join(root, 'global', 'memory.json'),
    globalPersona: path.join(root, 'global', 'persona.json'),
    short: path.join(root, 'short'),
    sessions: path.join(root, 'sessions'),
    mirror: path.join(root, 'mirror', 'memory.md'),
    v1Mirror: path.join(root, 'memory.md'),
  }
}

/** 列出某个目录下的 `.json` 文件名（目录不在就空数组）。 */
function jsonNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

/** v2 的档案（`state.json`）是不是已经带上了 v2 的字段名。 */
function isV2Archive(mind: LegacyMind | undefined): boolean {
  return mind !== undefined && (Array.isArray(mind.memory?.global) || Array.isArray(mind.memory?.session))
}

/**
 * 把老档案拆到 v3 布局（一行一份快照），并把退休的旧文件搬进 `archive/`。
 *
 * `stateDir` 是配置里的 `stateDir`（**目录**，与 `layout.ts` 的一套函数一致），
 * `archiveFile` 是旧 `state.json` 的路径。
 *
 * 名字写清楚是有代价换来的：这个参数原来叫 `raw`，调用方顺手把**档案的 JSON 文本**传了进来，
 * 于是标记与文件全落在一个乱路径、写入静默失败，看起来「迁移成功」其实什么都没落地。
 */
export function migrateToV3(args: { stateDir: string; archiveFile: string; now: number }): MigrationResult {
  const { stateDir, archiveFile: oldArchive, now } = args
  const marker = migrationFile(stateDir)
  const legacy = legacyPaths(stateDir)

  if (fileExists(marker)) {
    return { migrated: false, note: '迁移标记已在（migrated-to-v3），跳过', counts: EMPTY, from: 'none' }
  }

  const shortNames = jsonNames(legacy.short)
  const sessionNames = readdirSyncCatch(legacy.sessions)
  const v2Files =
    (fileExists(legacy.globalMemory) ? 1 : 0) + (fileExists(legacy.globalPersona) ? 1 : 0) + shortNames.length + sessionNames.length

  const archive = readJson<LegacyArchive>(oldArchive)
  const mind: LegacyMind | undefined =
    archive === undefined || archive === null ? undefined : (archive.mind ?? (archive as unknown as LegacyMind))

  if (mind === undefined && v2Files === 0) {
    return { migrated: false, note: '没有可读的旧档案，按空档案起步', counts: EMPTY, from: 'none' }
  }

  const from: 'v1' | 'v2' = v2Files > 0 || isV2Archive(mind) ? 'v2' : 'v1'
  const memory = mind?.memory ?? {}
  const counts: MigrationCounts = { ...EMPTY, sessions: [] }

  let failed = 0
  const ok = (wrote: boolean): void => {
    if (wrote) counts.files += 1
    else failed += 1
  }

  // ---------------------------------------------------------------- 全局层
  const globalEntries: StoredEntry[] = []
  const perSession = new Map<string, Map<string, StoredEntry>>()
  const addSession = (sessionId: string, entry: StoredEntry): void => {
    const bucket = perSession.get(sessionId) ?? new Map<string, StoredEntry>()
    // 同一个 id 先到先得：落地文件里那一份更接近"那个会话自己写下的样子"
    if (!bucket.has(entry.id)) bucket.set(entry.id, entry)
    perSession.set(sessionId, bucket)
  }

  if (mind !== undefined) {
    // 旧档案是 v1 形状（`long`），但这份文件也可能已经是 v2 形状（`global`）——
    // 两种都读：一份「升级到一半」的档案不能在这一步丢掉全局层（本机就真发生过）。
    const longItems = [
      ...(Array.isArray(memory.long) ? memory.long : []),
      ...(Array.isArray(memory.global) ? memory.global : []),
    ]
    for (const item of longItems) {
      const o = (item ?? {}) as Record<string, unknown>
      const ws = o['ws']
      const sessionId = typeof o['sessionId'] === 'string' && o['sessionId'] !== '' ? o['sessionId'] : undefined

      if (ws === null && sessionId !== undefined) {
        // 未分组会话写下的：只有它自己看得见，所以落在它自己的会话记忆里
        const entry = parseStoredEntry(item, 'session', sessionId)
        if (entry === null) {
          counts.dropped += 1
          continue
        }
        addSession(sessionId, entry)
        continue
      }

      const entry = parseStoredEntry(item, 'global')
      if (entry === null) {
        counts.dropped += 1
        continue
      }
      if (typeof ws === 'string' && ws !== '') {
        // 某个工作区里说过的话：留在全局文件里，但明写出处
        entry.scope = 'workspace' as StoredScope
        entry.ws = ws
        entry.where = ws
      } else if (ws === undefined || ws === null) {
        // 老档案：当年没有 ws 这个概念，或未分组且不知道是哪个会话。如实标注，不替历史编
        entry.legacy = true
      }
      globalEntries.push(entry)
    }

    // v2 聚合档案里的本会话日记（v1 没有这一层）。不知道属于哪个会话的那条不能编，
    // 只能丢掉并报数——放错会话比丢掉更糟。
    for (const item of Array.isArray(memory.session) ? memory.session : []) {
      const o = (item ?? {}) as Record<string, unknown>
      const sessionId = typeof o['sessionId'] === 'string' && o['sessionId'] !== '' ? o['sessionId'] : undefined
      const entry = sessionId === undefined ? null : parseStoredEntry(item, 'session', sessionId)
      if (entry === null || sessionId === undefined) {
        counts.dropped += 1
        continue
      }
      addSession(sessionId, entry)
    }
  } else {
    // 聚合档案读不出来：退回 v2 的落地文件（那时它们是唯一的副本）
    const parsed = parseStoredFile(readJson<unknown>(legacy.globalMemory), 'global')
    globalEntries.push(...parsed.entries)
    counts.dropped += parsed.dropped
  }

  // v2 的会话日记文件：不管聚合档案在不在都读——它按会话分文件，聚合档案只装着最后那一段。
  for (const name of sessionNames) {
    const sessionId = name
    const parsed = parseStoredFile(readJson<unknown>(path.join(legacy.sessions, name, 'memory.json')), 'session', sessionId)
    counts.dropped += parsed.dropped
    for (const entry of parsed.entries) addSession(sessionId, entry)
  }

  counts.global = globalEntries.length
  counts.workspace = globalEntries.filter((entry) => entry.scope === 'workspace').length

  // ---------------------------------------------------------------- 短期层
  const shorts = new Map<string, StoredEntry[]>()
  if (mind !== undefined) {
    for (const item of Array.isArray(memory.short) ? memory.short : []) {
      const o = (item ?? {}) as Record<string, unknown>
      const ws = typeof o['ws'] === 'string' ? o['ws'] : ''
      // 短期层本身就是"按工作区一份"，所以条目 scope 一律 workspace：
      // 空工作区那一份（`_global` 桶）只是"还没选工作区"，不是跨项目的规矩。
      const entry = parseStoredEntry(item, 'workspace', ws === '' ? undefined : ws)
      if (entry === null) {
        counts.dropped += 1
        continue
      }
      if (ws !== '') entry.ws = ws
      const list = shorts.get(ws) ?? []
      list.push(entry)
      shorts.set(ws, list)
    }
  } else {
    for (const name of shortNames) {
      const raw = readJson<Record<string, unknown>>(path.join(legacy.short, name))
      const owner = raw !== null && typeof raw === 'object' && typeof raw['owner'] === 'string' ? raw['owner'] : ''
      const parsed = parseStoredFile(raw, 'workspace', owner === '' ? undefined : owner)
      counts.dropped += parsed.dropped
      if (parsed.entries.length === 0) continue
      const list = shorts.get(owner) ?? []
      list.push(...parsed.entries)
      shorts.set(owner, list)
    }
  }
  for (const list of shorts.values()) counts.short += list.length

  // 人设 / 基线 / 统计 / 遗忘名单：聚合档案优先，其次是 v2 的落地副本
  const landedPersona = readJson<Record<string, unknown>>(legacy.globalPersona)
  const personaSource =
    mind !== undefined
      ? { persona: mind.persona ?? null, baseline: mind.baseline ?? null, stats: mind.stats ?? null, forgotten: memory.forgotten }
      : landedPersona !== undefined && landedPersona !== null
        ? {
            persona: landedPersona['persona'] ?? null,
            baseline: landedPersona['baseline'] ?? null,
            stats: landedPersona['stats'] ?? null,
            forgotten: landedPersona['forgotten'],
          }
        : { persona: null, baseline: null, stats: null, forgotten: undefined }

  // 遗忘名单必须跟着走：丢了它，被明确要求忘掉的东西下次就会自己冒出来。
  // 名字表在 v1 的档案里只见过字符串；但老档案是别人手也能改的东西，见过 `{ id }` 这种写法，
  // 所以两种都认——把 id 抠出来就行，认不出形状的那条丢掉（总比整份遗忘名单丢了强）。
  const forgotten = (Array.isArray(personaSource.forgotten) ? personaSource.forgotten : [])
    .map((item: unknown): string => {
      if (typeof item === 'string') return item.trim()
      if (typeof item === 'object' && item !== null) {
        const id = (item as { id?: unknown }).id
        if (typeof id === 'string') return id.trim()
      }
      return ''
    })
    .filter((id) => id !== '')

  // ---------------------------------------------------------------- 落盘
  // 写失败以前是静默的（`writeTextAtomic` 只返回 boolean，没人看），
  // 结果就是「迁移报告成功、一个文件都没落地」。这里把失败数记下来，写进 note 与标记文件。
  ok(saveGlobal(stateDir, globalEntries, now, { reason: 'migrate' }))
  ok(
    savePersonaState(
      stateDir,
      { persona: personaSource.persona, baseline: personaSource.baseline, stats: personaSource.stats, memory: { forgotten } },
      now,
      { reason: 'migrate' },
      { migratedAt: now },
    ),
  )
  for (const [sessionId, bucket] of perSession) {
    const entries = [...bucket.values()]
    counts.session += entries.length
    ok(saveSession(stateDir, sessionId, entries, now, { reason: 'migrate' }))
    if (!writeTextAtomic(sessionSummaryFile(stateDir, sessionId), renderSessionSummary(entries, now, sessionId))) failed += 1
    counts.sessions.push(sessionId)
  }
  counts.sessions.sort()

  for (const [ws, entries] of shorts) {
    ok(saveShort(stateDir, ws, entries, now, { reason: 'migrate' }))
  }

  // ---------------------------------------------------------------- 退休的旧文件
  // 只改名不删除：它们是源头，出问题还能翻回来对。目标已存在时不覆盖（`archiveFile` 的规矩）。
  const box = archiveDir(stateDir)
  const retire = (source: string, target: string): void => {
    if (!archiveFile(source, target)) failed += 1
  }
  retire(oldArchive, path.join(box, 'state.v1.json'))
  retire(legacy.globalMemory, path.join(box, 'global', 'memory.json'))
  retire(legacy.globalPersona, path.join(box, 'global', 'persona.json'))
  for (const name of shortNames) retire(path.join(legacy.short, name), path.join(box, 'short', name))
  for (const name of sessionNames) {
    retire(path.join(legacy.sessions, name, 'memory.json'), path.join(box, 'sessions', name, 'memory.json'))
  }
  retire(legacyMigrationFile(stateDir), path.join(box, 'migrated-to-v2'))
  // 两份"给人看的镜像"也退休：v3 只留 `global/summary.md` 与会话目录里的 `summary.md`
  retire(legacy.mirror, path.join(box, 'mirror', 'memory.md'))
  retire(legacy.v1Mirror, path.join(box, 'memory.v1.md'))

  // 镜像目录搬空之后只剩个空壳，顺手收掉：v3 的布局里压根没有 `mirror/` 这一层，
  // 留一个空目录会让人以为镜像还在。里面要是有用户自己放的东西就留着——不影响迁移结果。
  try {
    rmdirSync(path.dirname(legacy.mirror))
  } catch {
    // 目录不存在 / 非空 / 权限不够：都不算迁移失败
  }

  const note =
    `按 v3 布局写成快照：全局 ${counts.global} 条（其中带出处的 ${counts.workspace} 条）、` +
    `会话日记 ${counts.session} 条（${counts.sessions.length} 个会话）、短期 ${counts.short} 条` +
    (counts.dropped > 0 ? `，另有 ${counts.dropped} 条读不懂被丢掉` : '') +
    (failed > 0 ? `，有 ${failed} 处没写进去（看看 stateDir 是不是可写）` : '') +
    `。旧档案已改名进 archive/，没有删。`

  if (!writeTextAtomic(marker, `${new Date(now).toISOString()}\n来源：${from}\n${note}\n`)) failed += 1
  return { migrated: true, note, counts, from }
}

/** 列出会话目录名（目录不在就空数组；不要让它把迁移整个炸掉）。 */
function readdirSyncCatch(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 旧名字，保留给调用方与测试。
 *
 * 它现在搬的是 **v1/v2 → v3**（`migrateToV3`），不再是"→ v2"。
 */
export const migrateV1 = migrateToV3
