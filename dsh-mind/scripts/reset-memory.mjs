#!/usr/bin/env node
/**
 * 清空存量记忆数据（v2.3 交接用）。
 *
 * 为什么需要它：v2.3 之前那两条写入路（"从用户原话自动摘句"与收尾规则兜底）产出的条目里混着
 * 当时的半句话，用户明确要求清空重来：「现在的记忆数据我都不知道是历史的bug的数据，还是什么个
 * 情况，所有的记忆，都让 ai 自己整理生成」。
 *
 * 它做四件事（**不动人设 / 性情基线 / 统计**，那三样不是记忆条目）：
 *   1. 把现有所有记忆条目的 id 记进**遗忘名单**——这是"划掉的东西不会自己长回来"的唯一保证：
 *      宿主内存里还留着旧状态，它下一次落盘会把「手边」写回去；有了名单，重启后接管档案时
 *      三层都会被过滤掉，而写档案前也会再过一遍名单（见 `dsh-mind/src/index.ts` 的 `withoutForgotten`）。
 *   2. 跨会话库追加一份**空快照**（`global/memory.jsonl.zst`，人读的 `summary.md` 一并重生成）。
 *   3. 手边按**文件**清（`short/*.jsonl.zst`，各追加空快照——文件名是工作区键的哈希，反推不回来）。
 *   4. 各会话日记（`sessions/<会话 id>/memory.jsonl.zst`）连同它们的 `summary.md` 直接删掉：
 *      读不到就是空，比留一份空快照干净（宿主不会替不活跃的会话重写它）。
 *
 * 用法：
 *   node dsh-mind/scripts/reset-memory.mjs [数据目录]
 *
 * 数据目录缺省 `$DSH_HOME/dsh-mind`，再缺省 `~/.dsh/dsh-mind`。
 *
 * ⚠️ **必须在宿主停止时跑**：宿主内存里的状态才是权威，它下一次落盘（事件驱动的去抖写回）
 * 会把自己的记忆快照**连遗忘名单一起覆盖掉**——2026-11-12 实测：运行中跑这个脚本，几秒后
 * `global/memory.jsonl.zst`、`short/*`、`persona` 的名单全被写回旧内容。
 * 宿主开着的时候想清记忆，走**插件自己的路**（v2.4 起有了正经入口）：
 *   · `/mind reset-memory`   **首选**：清记忆三层、留人设与统计，名单会挡住"写回来"；
 *   · `forget_memory` 工具   一条一条划（走日志折叠，会真的改活状态）；
 *   · `/mind reset-archive`  下次启动清，代价是人设自我认知与统计一起归零。
 * 这个脚本仍然有用：**停着宿主时清得最干净**（旧快照行、人读的简介都能一并处理）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const {
  clearSessions,
  clearShort,
  globalMemoryFile,
  loadPersonaState,
  readZstdLines,
  saveGlobal,
  savePersonaState,
} = await import(new URL('../lib/index.js', import.meta.url).href)

const DIR = path.resolve(
  process.argv[2] ??
    path.join(process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : path.join(homedir(), '.dsh'), 'dsh-mind'),
)

if (!existsSync(DIR)) {
  console.error(`数据目录不存在：${DIR}`)
  process.exit(1)
}

/** 一个快照文件的最后一行里的 entries（读不动就当空，绝不抛）。 */
function entriesOf(file) {
  if (!existsSync(file)) return []
  try {
    const read = readZstdLines(file)
    const last = read.lines?.at(-1)
    if (last === undefined) return []
    const parsed = JSON.parse(last)
    return Array.isArray(parsed?.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

const shortDir = path.join(DIR, 'short')
const sessionsDir = path.join(DIR, 'sessions')
const shortFiles = existsSync(shortDir)
  ? readdirSync(shortDir)
      .filter((name) => name.endsWith('.jsonl.zst'))
      .map((name) => path.join(shortDir, name))
  : []
const sessionIds = existsSync(sessionsDir) ? readdirSync(sessionsDir) : []
const sessionFiles = sessionIds
  .map((id) => path.join(sessionsDir, id, 'memory.jsonl.zst'))
  .filter((file) => existsSync(file))

const layers = [globalMemoryFile(DIR), ...shortFiles, ...sessionFiles]
const ids = new Set()
for (const file of layers) {
  for (const entry of entriesOf(file)) {
    if (typeof entry?.id === 'string' && entry.id !== '') ids.add(entry.id)
  }
}

const now = Date.now()
const before = loadPersonaState(DIR)
if (before === undefined) {
  console.error(`读不到人设快照（${path.join(DIR, 'global', 'persona.jsonl.zst')}）——先让宿主启动一次再来。`)
  process.exit(1)
}
const forgotten = [...new Set([...(before.forgotten ?? []), ...ids])].slice(-500)
const personaOk = savePersonaState(
  DIR,
  { persona: before.persona, baseline: before.baseline, stats: before.stats, memory: { forgotten } },
  now,
  { reason: 'manual' },
)
// **假删**：动手之前，先把这一批条目搬进回收站（正文留着，随时能捞回来）。
const everything = []
for (const file of layers) for (const entry of entriesOf(file)) everything.push(entry)
let trashed = 0
try {
  trashed = trashGone(DIR, everything, [], now, '停机清库（reset-memory.mjs）')
} catch (error) {
  console.error(`搬进回收站失败（继续清，但正文可能没留）：${error?.message ?? error}`)
}

const globalOk = saveGlobal(DIR, [], now, { reason: 'manual' })
const shorts = clearShort(DIR, now)
// 会话日记：**不删文件**（删了就真没了），改成各写一份空快照 + 重生成简介。
const diaries = clearSessions(DIR, now)

console.log(`数据目录：${DIR}`)
console.log(`清掉的记忆条目：${ids.size} 条（id 已并入遗忘名单，共 ${forgotten.length} 条）`)
console.log(`跨会话库：写成空快照 ${globalOk ? '✓' : '✗'}｜人设快照（只改了名单）：${personaOk ? '✓' : '✗'}`)
console.log(`手边：清了 ${shorts} 份文件｜会话日记：清了 ${diaries} 份（写空快照，**一个文件都没删**）`)
console.log(`回收站：搬进去 ${trashed} 条 —— 想捞回来就 \`/mind show trash\` + \`/mind restore <序号>\``)
console.log(`人设 / 性情基线 / 统计：**原样保留**（它们不是记忆条目；要一起归零就说一声）`)
console.log('')
console.log('这次是**假删**：条目进了回收站、快照文件也没动（只追加了空快照）。')
console.log('要真删只有两条路：`/mind purge`，或者手动删掉 trash/ 目录。')
console.log('')
console.log('⚠️ 宿主内存里还留着旧状态，它下一次落盘会把「手边」那份写回来——**重启宿主**后，')
console.log('   遗忘名单会把它们挡在门外（三层都过滤），盘面从此从空开始长。')
