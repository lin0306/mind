/**
 * v3.0 的存储布局。
 *
 * ## 为什么又换一次（v2 → v3）
 *
 * v2 已经做到"一个文件一个所有者"，但留下两个真问题：
 *
 * 1. **会话记忆只追加**：同一段会话会写很多次，"上一次没做完、这一次做完了"就没法改——
 *    旧条目还躺在文件里，新条目又接在后面，读起来自相矛盾。v3 改成**每次写入追加一整份快照**：
 *    一个 `.jsonl.zst` 的每一行就是那一层**当时的全部条目**，**最后一行就是当前内容**。
 *    要改要删，在新快照里改——旧快照仍然留在文件里可以追溯，但读取只认最后一行。
 * 2. **没压缩**：`.json` 明文躺着，体积大、读得慢。v3 一律 `.jsonl.zst`
 *    （`node:zlib` 的 zstd，Node 24 自带），一个文件一帧，体积受控。
 *
 * ## 四条纪律
 *
 * 1. **一个文件一个所有者**：谁写谁负责，不许两个模块写同一个文件。
 * 2. **原子写**：一律 `.tmp` + `rename`，中途崩了不许留下半截文件。
 * 3. **路径可复现**：会话目录与工作区文件名都从会话头（`header.id` / `header.cwd`）推出来，
 *    所以"哪份记忆在哪个文件"是可重放的，不依赖运行时的临时状态。
 * 4. **快照只追加、读取只看最后一行**：历史留在文件里，但**不许**被当成当前内容读。
 *
 * ## 目录长这样
 *
 * ```
 * ~/.dsh/dsh-mind/
 * ├── persona.md                        用户手写的内核（不参与演化，不动）
 * ├── global/
 * │   ├── memory.jsonl.zst              跨会话库（含 scope:'workspace' 的条目）   快照
 * │   ├── persona.jsonl.zst               人设快照 + 性情基线 + 统计 + 遗忘名单      快照
 * │   └── summary.md                    全局记忆简介（人读）
 * ├── sessions/<会话 id>/
 * │   ├── memory.jsonl.zst              本会话日记                              快照
 * │   └── summary.md                    会话记忆简介（人读）
 * ├── short/<工作区键>.jsonl.zst         短期记忆（手边记着的事）                快照
 * ├── archive/                          退休的旧文件（只进不出，便于追溯）
 * ├── migrated-to-v3                    一次性迁移标记
 * └── log/mind.log
 * ```
 *
 * 两份 v2 的东西在这里退休：
 * - `state.json`（聚合档案）：迁移那一次把它**改名**进 `archive/state.v1.json`，此后不读也不写；
 * - `mirror/memory.md`（只读镜像）：它只是把记忆抄一遍，人读的那一份只留两个 `summary.md`。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { stateDir } from './persist.js'

/** 根目录（`$DSH_HOME/dsh-mind/`）。
 *
 * 末尾的分隔符要去掉：`path.normalize` 在 Windows 上会把它留着，而"根"只该有一种写法——
 * 否则 `startsWith(root + sep)` 这类判断会被双分隔符绊住，日志里也会出现两种根路径。
 * 盘符根（`E:\`）是唯一例外，去掉就成了 `E:`，那是另一个意思。
 */
export function rootDir(raw: string): string {
  const dir = stateDir(raw)
  const stripped = dir.replace(/[\\/]+$/, '')
  return stripped === '' || /^[A-Za-z]:$/.test(stripped) ? dir : stripped
}

/** `global/`：跨会话要带走的东西。 */
export function globalDir(raw: string): string {
  return path.join(rootDir(raw), 'global')
}

/** 全局记忆（规矩 / 关于人 / 带出处的工作区条目）。每次写入追加一份快照。 */
export function globalMemoryFile(raw: string): string {
  return path.join(globalDir(raw), 'memory.jsonl.zst')
}

/** 人设的跨会话部分：人设快照 / 性情基线 / 统计 / 遗忘名单。每次写入追加一份快照。 */
export function globalPersonaFile(raw: string): string {
  return path.join(globalDir(raw), 'persona.jsonl.zst')
}

/** 全局记忆简介（人看，同时是注入里的"长期库有多少条"索引的出处）。 */
export function globalSummaryFile(raw: string): string {
  return path.join(globalDir(raw), 'summary.md')
}

/** `trash/`：回收站。假删（清 / 划）的落点；宿主停着时整目录搬走就能彻底清掉。 */
export function trashDir(raw: string): string {
  return path.join(rootDir(raw), 'trash')
}

/**
 * 回收站：一个文件装所有被删掉的条目。
 *
 * 为什么不靠"快照文件的前几行"：那些行会被 `SNAPSHOT_KEEP` 裁掉——文件满 20 行时，
 * 一次清空正好把被清的内容挤出窗口（2026-11-15 实测：两个文件都已满 20 行）。
 * 所以被删的条目**另存一份**，与裁剪策略无关。
 */
export function trashFile(raw: string): string {
  return path.join(trashDir(raw), 'memory.jsonl.zst')
}

/** `sessions/`：每个会话一个目录。 */
export function sessionsDir(raw: string): string {
  return path.join(rootDir(raw), 'sessions')
}

/**
 * 一个会话的目录。
 *
 * 会话 id 形如 `session-4a9596a3-…`，本来就是文件系统安全的，但**不假设**：
 * 归一化一次，免得某个宿主版本给出带斜杠的 id 把文件写到目录外面去。
 */
export function sessionDir(raw: string, sessionId: string): string {
  return path.join(sessionsDir(raw), safeSegment(sessionId))
}

/** 会话记忆：一份日记，每次写入追加一份完整快照（可修订）。 */
export function sessionMemoryFile(raw: string, sessionId: string): string {
  return path.join(sessionDir(raw, sessionId), 'memory.jsonl.zst')
}

/** 会话记忆简介。 */
export function sessionSummaryFile(raw: string, sessionId: string): string {
  return path.join(sessionDir(raw, sessionId), 'summary.md')
}

/** 列出已经有目录的会话 id（按名字排序，稳定）。 */
export function listSessionIds(raw: string): string[] {
  try {
    return readdirSync(sessionsDir(raw), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** `short/`：短期记忆，按工作区一份。 */
export function shortDir(raw: string): string {
  return path.join(rootDir(raw), 'short')
}

/** 短期记忆（一个工作区一份，每次写入追加一份完整快照）。 */
export function shortFile(raw: string, workspaceKey: string): string {
  return path.join(shortDir(raw), `${safeKey(workspaceKey)}.jsonl.zst`)
}

/**
 * 列出已经存在的短期文件（绝对路径，按文件名排序）。
 *
 * 清空短期记忆时按**文件**清：文件名是工作区键的哈希，反推不回工作区键，
 * 而"这个工作区在这儿"未必有人知道（换个工作区开新会话就不知道了）。
 */
export function listShortFiles(raw: string): string[] {
  const dir = shortDir(raw)
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl.zst'))
      .map((name) => path.join(dir, name))
      .sort()
  } catch {
    return []
  }
}

/** `archive/`：退休的旧文件。只进不出，出问题还能翻回来对。 */
export function archiveDir(raw: string): string {
  return path.join(rootDir(raw), 'archive')
}

/** 日志文件（单独一个文件夹，别堆在根目录）。 */
export function logFile(raw: string): string {
  return path.join(rootDir(raw), 'log', 'mind.log')
}

/**
 * 一次性迁移的标记（沿用 `reset-once` 那套做法：跑完写下，之后不再重复处理）。
 *
 * v2 的标记叫 `migrated-to-v2`，迁移时会被搬进 `archive/`；从 v3 起只认这一个。
 */
export function migrationFile(raw: string): string {
  return path.join(rootDir(raw), 'migrated-to-v3')
}

/** 上一代的迁移标记（只在 v2→v3 里搬它进 `archive/` 时用得到）。 */
export function legacyMigrationFile(raw: string): string {
  return path.join(rootDir(raw), 'migrated-to-v2')
}

/**
 * 工作区键 → 一个**文件名安全**的短名。
 *
 * 工作区键长这样：`E:/code/thought`。直接当文件名有两个问题：`:` 在部分文件系统上是非法字符；
 * 而且两个不同工作区去掉非法字符后可能撞名（`E:/a/b` 与 `E:/a\b`）。
 * 所以：可读的 slug（方便人一眼看出是哪个工作区）+ 键的短哈希（保证不撞）。
 * 拿不到工作区（空键）时叫 `_global`——那是"还没选工作区"，不是"全局记忆"，
 * 但它在短期层里就是"哪儿都算自己人"的那一份。
 */
export function safeKey(workspaceKey: string): string {
  const key = workspaceKey.trim()
  if (key === '') return '_global'
  const slug = key
    .replace(/^[A-Za-z]:/, (match) => match[0] ?? '') // 盘符只留字母：C:/x → C--x
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-40)
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8)
  return `${slug === '' ? 'ws' : slug}-${hash}`
}

/** 路径里的一段：去掉分隔符与上跳，别让 id 把文件写到目录外。 */
function safeSegment(segment: string): string {
  const cleaned = segment
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // `..` 只有在"整段就是 `..`"时才会真的上跳，但路径里留着一串点号既难读、
    // 又让人以为有越界，索性压成一个点：`../../etc/passwd` → `.-etc-passwd`。
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'unknown' : cleaned
}

/** 目录不存在就建（递归）。 */
export function ensureDirFor(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
}

/** 原子写 JSON：`.tmp` + `rename`。失败返回 false（调用方决定要不要出声）。 */
export function writeJsonAtomic(file: string, value: unknown): boolean {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 原子写文本。失败返回 false。 */
export function writeTextAtomic(file: string, text: string): boolean {
  try {
    ensureDirFor(file)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 原子写一个 `.jsonl.zst`：把若干**行**压成一帧 zstd，再 `.tmp` + `rename`。
 *
 * 一次写整份（而不是往文件尾巴上追加一帧）：行数有上限（见 `SNAPSHOT_KEEP`），
 * 整份重写才能保证文件始终是**一帧**，体积与解压开销都可预期。
 * 失败返回 false。
 */
export function writeZstdLines(file: string, lines: readonly string[]): boolean {
  try {
    ensureDirFor(file)
    const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`
    const tmp = `${file}.tmp`
    writeFileSync(tmp, zstdCompressSync(Buffer.from(text, 'utf8')))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** `readZstdLines` 的结果：读不动时给一个**说得清**的原因，绝不抛。 */
export interface ZstdLinesResult {
  /** 文件里的行（去掉空行）。读不动时是空数组。 */
  lines: string[]
  /** `missing` = 文件不在（首次运行，正常）；`unreadable` = 在但解压不了（要当"丢了一份数据"报出来）。 */
  error?: 'missing' | 'unreadable'
}

/**
 * 读一个 `.jsonl.zst` 的所有行。
 *
 * **不许抛**：文件不在、不是 zstd、解压出来不是文本——一律回落成空 + 一个原因。
 * 一行 JSON 好不好解析是上层的事（`parseSnapshotLine` 会丢掉坏行并报数）。
 */
export function readZstdLines(file: string): ZstdLinesResult {
  let data: Buffer
  try {
    data = readFileSync(file)
  } catch {
    return { lines: [], error: 'missing' }
  }
  try {
    const text = zstdDecompressSync(data).toString('utf8')
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    return { lines }
  } catch {
    return { lines: [], error: 'unreadable' }
  }
}

/** 读 JSON。文件不存在、坏了都返回 undefined——**不许因为一份文件坏掉挡住聊天**。 */
export function readJson<T>(file: string): T | undefined {
  const text = readText(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** 读文本。读不到返回 undefined。 */
export function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 把一个文件搬进 `archive/`（改名，不复制，更不删）。
 *
 * 目标已经存在时**不覆盖**：`archive/` 是"当时那份长什么样"的证据，
 * 后来的同名文件没有资格盖掉它。返回 true 表示"搬过了（或者本来就没有）"。
 */
export function archiveFile(source: string, target: string): boolean {
  if (!existsSync(source)) return true
  try {
    if (existsSync(target)) return true
    ensureDirFor(target)
    renameSync(source, target)
    return true
  } catch {
    return false
  }
}

/** 文件在不在（迁移与标记判定用）。 */
export function fileExists(file: string): boolean {
  return existsSync(file)
}
