/**
 * dsh-mind · Host 半边
 *
 * 把内核（`dsh-mind-core`，与 agent 无关的纯逻辑）接到 DSH 上。这一层只做四件事：
 *
 * 1. **接线**：把宿主服务取出来，把投影 / 提示词 / 工具 / 命令挂上去；
 * 2. **翻译**：把 DSH 的事件形状翻成内核认的 `SessionEventLike`（其实形状一致，主要是类型）；
 * 3. **跨会话**：会话起点接管人设与长期记忆，会话过程中把变化写回档案；
 * 4. **容错**：任何一步失败都只降级——**少一个情感插件，不能影响用户聊天**。
 *
 * 三条不可破的纪律：
 * - 所有事件回调与注入函数都包 try/catch，绝不向上抛；
 * - 状态只由会话日志派生（`applyEvent` 纯函数），这一层**不许**直接改状态；
 * - 不在 `agent/turn-stopping` 这类 serial 且会被 await 的地方做任何慢事。
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  KIND_LABEL,
  adoptKernel,
  describeEntry,
  finalize,
  findEntries,
  forgetEntries,
  normalizePersist,
  rollbackKernel,
  toPersist,
  type MemoryEntry,
  type MemoryState,
  type MindPersist,
  type MindState,
  type MindStats,
} from 'dsh-mind-core'
import { Config, describeConfig, flag, num, str, toTunables, type MindConfig } from './config.js'
import { mindCommand } from './commands.js'
import { registerPersonaSection, registerRealtimeContext } from './inject.js'
import { registerDecision } from './decide.js'
import { registerProactive } from './proactive.js'
import { configureLogger, logger } from './log.js'
import { loadArchive, personaFile, signature, stateDir } from './persist.js'
import { readPersonaKernel, writePersonaTemplate } from './persona-md.js'
import { hasZod, registerProjection, stateOfVia } from './projection.js'
import { registerSettingsBridge } from './settings-bridge.js'
import { FORGET_TOOL, INNER_NOTE_TOOL, forgetTool, innerNoteTool, recallTool } from './tools.js'
import type { CrossSessionResult } from './tools.js'
import {
  service,
  warn,
  type CommandsService,
  type HostEvent,
  type MindContext,
  type SessionProjectionsService,
  type SystemPromptService,
  type ToolsService,
} from './host.js'

/** Cordis 插件身份：模块上只有 name / inject / Config / apply 会被读。 */
export const name = 'dsh-mind'

/**
 * 硬依赖：缺任何一个就静默不激活。
 *
 * 这是刻意的——**少一个情感插件，不能影响用户聊天**。
 * 只声明"稳定服务"，后注册的服务（如 `remote.xxx`）一律用 `ctx.get()` 取，
 * 否则守卫会永久停在 pending（`@deepseek-ai/dsh-agent-loop` 的已知陷阱）。
 */
export const inject = ['systemPrompt', 'sessionProjections']

export { Config }
export type { MindConfig }

// ─────────────────────────────────────────────────────────
// 给测试与工具用的再导出
//
// 打包之后 `lib/` 里只剩这一个文件（内核与依赖都内联进来了），测试没法再按内部路径
// `import '../lib/tools.js'`。这些符号本来就是"写第二个 adapter 会用到的东西"，
// 所以放在公共出口是合理的——顺手也让 adapter 作者少翻源码。
// ─────────────────────────────────────────────────────────
export { CONFIG_FIELDS, CONFIG_GROUPS, configCatalog, describeConfig, flag, num, str, toTunables } from './config.js'
export {
  MIND_PACKAGE_NAME,
  MISSING_SETTINGS_REASON,
  SETTINGS_ROUTE_PREFIX,
  RouteFailure,
  createSettingsApi,
  entryIdCandidates,
  handleSettingsRequest,
  isSettingsConflict,
  makeSettingsFace,
  methodOfPath,
  ownEntryId,
  registerSettingsBridge,
  resolveSettingsNamespace,
  serviceVia,
} from './settings-bridge.js'
export { PROJECTION_KEY, STATE_KEYS, STATE_VERSION, registerProjection, stateOf } from './projection.js'
export { applyDecision, registerDecision } from './decide.js'
export { FORGET_TOOL, INNER_NOTE_TOOL, RECALL_TOOL, forgetTool, innerNoteTool, recallTool } from './tools.js'
export type { CrossSessionOptions, CrossSessionRecall, CrossSessionResult } from './tools.js'
export { parsePersonaText, readPersonaKernel, writePersonaTemplate } from './persona-md.js'
export { PROACTIVE_SOURCE_KIND, PROACTIVE_WAKE_TEXT, registerProactive, wakeMessage } from './proactive.js'
export { personaText, realtimeText, registerPersonaSection, registerRealtimeContext } from './inject.js'
export { extract, loadArchive, personaFile, signature, stateDir } from './persist.js'
export {
  archiveDir,
  archiveFile,
  ensureDirFor,
  fileExists,
  globalDir,
  globalMemoryFile,
  globalPersonaFile,
  globalSummaryFile,
  legacyMigrationFile,
  listSessionIds,
  listShortFiles,
  logFile,
  migrationFile,
  readJson,
  readText,
  readZstdLines,
  rootDir,
  safeKey,
  sessionDir,
  sessionMemoryFile,
  sessionSummaryFile,
  sessionsDir,
  shortDir,
  shortFile,
  trashDir,
  trashFile,
  writeJsonAtomic,
  writeTextAtomic,
  writeZstdLines,
  type ZstdLinesResult,
} from './layout.js'
// 上面那一段是**再导出**（测试要从包入口拿到它们），名字并不在本文件作用域里；
// 这里才是本文件自己要用的那几个。
import { listSessionIds, migrationFile, readText, sessionSummaryFile, sessionsDir } from './layout.js'
// 同样是"再导出 + 自己还要用"：`migrateV1` 要在启动时跑一次。
import { migrateToV3 } from './migrate.js'
// 运行期把三层记忆写成快照（`global/`、`short/`、`sessions/`）。
import {
  asWorkspaceEntry,
  clearSessions,
  clearShort,
  collectMemoryIds,
  loadGlobal,
  loadSession,
  loadShort,
  loadTrash,
  markTrashRestored,
  purgeTrash,
  trashGone,
  type TrashedEntry,
  saveGlobal,
  savePersonaState,
  saveSession,
  saveShort,
  selectSessionsBySummary,
  toStored,
} from './store.js'
import { type SnapshotReason, type StoredEntry } from './entries.js'
export { migrateToV3, migrateV1, type MigrationCounts, type MigrationResult } from './migrate.js'
// "回收站留多少条"这个常数：测试要拿它断言，别在测试里写死数字（写死了就会跟实现漂）
// （`SNAPSHOT_KEEP` 早就在上面那一组再导出里了，别再来一条。）
export { TRASH_KEEP } from './store.js'
export {
  asWorkspaceEntry,
  clearSessions,
  clearShort,
  collectMemoryIds,
  loadGlobal,
  loadPersonaState,
  loadSession,
  loadShort,
  loadTrash,
  markTrashRestored,
  purgeTrash,
  saveGlobal,
  savePersonaState,
  saveSession,
  saveShort,
  saveTrash,
  selectSessionsBySummary,
  toStored,
  trashGone,
  type PersonaSnapshotSource,
  type SessionSelection,
  type SnapshotWriteOptions,
  type WritableEntry,
} from './store.js'
export {
  SCOPES,
  SNAPSHOT_KEEP,
  SNAPSHOT_REASONS,
  STORE_VERSION,
  entryLine,
  parseSnapshotLine,
  parseStoredEntry,
  parseStoredFile,
  renderGlobalSummary,
  renderSessionSummary,
  wrapSnapshot,
  type SnapshotReason,
  type StoredEntry,
  type StoredFile,
  type StoredScope,
  type StoredSnapshot,
} from './entries.js'

/**
 * 两段式跨会话检索的适配层实现：先按简介选会话，再只进选中的那几个读最后一份快照。
 *
 * 抽成不依赖 Cordis 的纯函数（只要数据目录与当前会话 id），是为了能直接测；
 * 它不改任何状态，也不写盘。
 *
 * 分页**不在这里做**：要先 `recall` 打分才知道"共几条命中"，所以 `page`/`pageSize`
 * 只回显（`page` 用于排查，`pageSize` 留给工具切命中）。`total` 是搬来的候选条目数，
 * 不是命中数。
 */
export function crossSessionRecall(
  raw: string,
  currentSessionId: string,
  query: string,
  page: number,
  pageSize: number,
  sessionLimit = 5,
): CrossSessionResult {
  if (currentSessionId === '') {
    return { entries: [], lookedAt: 0, entered: [], page, total: 0, reason: 'no-session' }
  }
  const selection = selectSessionsBySummary(raw, query, sessionLimit, currentSessionId)
  const entries: MemoryEntry[] = []
  for (const id of selection.entered) {
    try {
      // 只看最后一行快照：会话记忆可修订，早先的快照是历史，不是"现在的内容"。
      for (const entry of loadSession(raw, id).entries) entries.push(entry)
    } catch {
      // 读不动就跳过这个会话：宁可少给几条，也不要毁掉整次检索。
    }
  }
  // 命中分页在工具里（打完分才切），这里不按 pageSize 切条目。
  void pageSize
  return { entries, lookedAt: selection.lookedAt, entered: selection.entered, page, total: entries.length }
}

/** 落盘去抖窗口（毫秒）。状态变化很频繁，写盘不能跟着走。 */
const SAVE_DEBOUNCE_MS = 1200

interface AgentLike {
  id?: string
  ctx?: MindContext
  session?: unknown
}

/** 会话标识：优先 `session.id`，实在没有就退到一个固定键（单会话场景够用）。 */
function sessionKey(session: unknown): string {
  const id = (session as { id?: unknown } | null)?.id
  return typeof id === 'string' && id !== '' ? id : 'default'
}

/**
 * 按遗忘名单过一遍。
 *
 * 名单是"划掉过什么"的权威记录，而且**必须两边都照它过滤**：
 * - 会话起点（`adoptPersist`）：不然刚被划掉的条目会在这段对话里复活；
 * - 写档案前（`rebuild`）：不然下一次落盘又把它写回去。
 *
 * 为什么不能只靠"删掉"：手工遗忘（`/mind forget`）是宿主侧动作，不经过会话日志，
 * 而会话状态只能由日志派生——名单是这两种遗忘（人替它忘 / 它自己忘）的交汇点。
 */
function withoutForgotten(memory: MemoryState): MemoryState {
  const ids = new Set(memory.forgotten)
  if (ids.size === 0) return memory
  const short = memory.short.filter((entry) => !ids.has(entry.id))
  const session = memory.session.filter((entry) => !ids.has(entry.id))
  const global = memory.global.filter((entry) => !ids.has(entry.id))
  if (
    short.length === memory.short.length &&
    session.length === memory.session.length &&
    global.length === memory.global.length
  ) {
    return memory
  }
  // 三层都过一遍。会话日记现在是**可修订**的（每次写一整份快照），所以这里删掉一条
  // 就是真的删掉了；名单是权威，任何一层都不能例外。
  return { ...memory, short, session, global }
}

/**
 * 只留全局层的记忆视图，给命令层用。
 *
 * `/mind remember|forget` 面对的是**跨会话库**：短期是手边那几条（由会话日志派生，
 * 手工改它没意义，下一轮折叠就长回来），会话日记是"这一段对话自己的流水账"，
 * 要删得让它自己走 `forget_memory`（那次调用会落进日志，折叠时才算数）。
 * 所以列表与检索都只看全局层；删依然按 id 删（id 来自全局层，只影响它自己）。
 */
function globalOnly(memory: MemoryState): MemoryState {
  return { ...memory, short: [], session: [] }
}

/**
 * 插件入口。
 *
 * @param ctx 插件作用域（root）。每-agent 的东西一律在 `agent/created` 里用 `agent.ctx` 注册。
 * @param config patch 里给的配置（可能是 `{}`、可能缺键，按默认补齐）
 */
export async function apply(ctx: MindContext, config?: MindConfig): Promise<void> {
  const now0 = Date.now()

  const enabled = flag(config, 'enabled')
  const tunables = toTunables(config)
  // **根目录**（不是某个文件）。v2 这里给的是 `stateFile(...)`，也就是 `state.json` 的**文件路径**，
  // 而 `layout.ts` 的那套函数又把它当目录拼了一层，于是落地文件全落到 `<根>/state.json/global/…`——
  // `state.json` 本身是个文件，ENOTDIR，原子写静默返回 false。结果：v2 的"落地那份"在运行期
  // **一份都没更新过**，只有 `state.json` 与 md 镜像是活的——"前后不一致"就是这么来的。
  // v3 一律只传根目录，一个都不例外。
  const root = str(config, 'stateDir')
  const kernelPath = personaFile(str(config, 'personaPath'))
  /** 旧聚合档案（v2/v1 的 `state.json`）：只在迁移那一次读它，之后它会被改名进 `archive/`。 */
  const legacyArchive = path.join(stateDir(root), 'state.json')
  // 「下次启动清空」标记。
  //
  // 为什么清档案要留一个标记而不是当场删文件：正在跑的会话**会把状态写回档案**
  // （记忆是从日志折叠出来的，`flush` 一有机会就落盘），所以中途删文件、清档案，
  // 都会被它当场写回来。只有在**进程刚起来、还没有任何会话状态**的那一刻清，才作数。
  const resetMarker = path.join(stateDir(root), 'reset-once')
  // 调试日志同时落一份文件：headless 下 `ctx.logger` 通常没人接，
  // 光靠宿主日志就没法验证"注入到底有没有发生"。这份文件是**可验证性**的一部分。
  const debugOn = flag(config, 'debugLog')
  configureLogger(ctx, {
    verbose: debugOn,
    // **文件日志始终开**（`info`/`warn` 一定落盘），只有 `debug` 那档由 `debugLog` 控制。
    // 这条是踩出来的：原来 `file` 跟着 `debugLog` 走，而它默认 false，
    // 于是"日志看起来消失了"（`log/mind.log` 停在好几天前）——排查问题时最需要的那份证据没了。
    // 日志单独放 `log/` 子目录：和 state.json、persona.md 平铺在一起时它太不显眼。
    file: path.join(stateDir(root), 'log', 'mind.log'),
  })

  // ── 旧档案 → v3 布局（一次性、幂等）───────────────────────────
  //
  // 顺序很要紧：**先迁移，再读存档，最后才理 reset-once 标记**。
  // v2 的顺序是"先读、再清、最后迁移"，放到 v3 会出事：reset-once 刚把快照清空，
  // 紧接着迁移又把 `state.json` 里的旧记忆搬回来——那次"清空"当场失效。
  //
  // 迁移这一步**只读旧档案、只写新文件**，读完把旧文件改名进 `archive/`（不是删掉）。
  // 跑过一次就留下 `migrated-to-v3` 标记，之后不再进来。
  let loadNote = ''
  try {
    if (!existsSync(migrationFile(root))) {
      const migrated = migrateToV3({ stateDir: root, archiveFile: legacyArchive, now: now0 })
      loadNote = migrated.note
    }
  } catch (error) {
    // 迁移失败只降级：旧档案还在，新布局先当空的用，下次启动再试。
    warn(ctx, '[dsh-mind] 旧档案→v3 迁移失败（旧档案未动，下次启动再试）', error)
  }

  // ── 跨会话存档（v3：`global/persona.jsonl.zst` + `global/memory.jsonl.zst`）──
  const loaded = loadArchive(root, now0)
  let persist: MindPersist = loaded.persist
  loadNote = loadNote === '' ? loaded.note : `${loadNote}｜${loaded.note}`

  // reset-once 标记：按"没有存档"起步，并**立刻把空的快照写下去**。
  // 这一刻是**唯一**能清干净的时刻：还没有任何会话状态，也就没有东西会写回来。
  if (existsSync(resetMarker)) {
    const before =
      persist.memory.global.length + persist.memory.short.length + persist.memory.session.length
    try {
      unlinkSync(resetMarker)
    } catch (error) {
      // 删不掉不是坏事：下次启动还会再清一次。
      warn(ctx, '[dsh-mind] 清不掉 reset-once 标记（下次启动会再清一次）', error)
    }
    persist = normalizePersist(undefined, now0)
    // 清空 = 往各层**追加一份空快照**（读取只认最后一行，所以这就是"从空开始"），
    // 旧记忆仍留在文件里可以翻回来对。短期按**文件**清：文件名是工作区键的哈希，反推不回来。
    const ok =
      saveGlobal(root, [], now0, { reason: 'manual' }) &&
      savePersonaState(
        root,
        {
          persona: persist.persona,
          baseline: persist.baseline,
          stats: persist.stats,
          memory: { forgotten: [] },
        },
        now0,
        { reason: 'manual' },
      )
    const shorts = clearShort(root, now0)
    loadNote = ok
      ? `按 reset-once 标记清空存档（原有 ${before} 条记忆、${shorts} 份短期；人设自我认知与长期记忆从空开始）`
      : 'reset-once 标记在，但空快照写不进去（原文件保留未动）'
  }

  let stats: MindStats = { ...persist.stats, sessions: persist.stats.sessions + 1 }

  // ── 人设内核文件（用户可编辑；首次运行给一份模板）────────────────
  const createdTemplate = writePersonaTemplate(kernelPath)
  const kernelFile = readPersonaKernel(kernelPath)
  if (kernelFile !== null && kernelFile.nonEmpty) {
    persist = { ...persist, persona: adoptKernel(persist.persona, kernelFile.patch, now0) }
  }

  logger.info(
    `[dsh-mind] 启动｜${loadNote}｜人设内核${kernelFile !== null && kernelFile.nonEmpty ? '已载入' : '为空（只用性情）'}${
      createdTemplate ? '｜已生成人设模板' : ''
    }｜${describeConfig(config, ctx.logger)}`,
  )

  const projections = service<SessionProjectionsService>(ctx, 'sessionProjections')
  if (projections === undefined) {
    warn(ctx, '[dsh-mind] 拿不到 sessionProjections，插件不激活（聊天不受影响）')
    return
  }

  /**
   * 本工作区的短期层从哪来：读 `short/<工作区键>.jsonl.zst` 的**最后一行快照**。
   *
   * v2 这里还留着"落地文件空就回落到聚合档案"的兜底；v3 没有聚合档案了——
   * 这个文件就是短期记忆唯一的家。读不动就当作空的：宁可这一会话手边空着，
   * 也不能拿一份读不懂的东西去糊它（更不许挡住聊天）。
   */
  const adoptShort = (workspace: string): MemoryEntry[] => {
    try {
      return loadShort(root, workspace).entries
    } catch (error) {
      warn(ctx, '[dsh-mind] 读短期记忆失败，本会话手边先空着', error)
      return []
    }
  }

  /**
   * 新会话的起点：**接管**跨会话的人设与记忆（全局层 + 本工作区短期层）；
   * 会话日记、情感与思想一律从零开始——它们永远是"这一段对话内"的东西。
   */
  /**
   * **宿主侧遗忘名单**（权威）：`/mind forget` 与 `/mind reset-memory` 划掉的 id 都在这里。
   *
   * 为什么要单独留一份：会话状态是**从会话日志折叠出来的**，它不知道宿主侧做过什么；
   * 而每次落盘都会写一份人设快照，`forgotten` 就在里面。只改档案的话，正在跑的会话
   * 下一次落盘就把它覆盖回自己那份（2026-11-12 实测：手工清库 + 名单，几秒后全被写回旧值）。
   * 所以这份名单在 `rebuild`（写档案前）与 `adoptPersist`（接管时）都要并进去。
   */
  const hostForgotten = new Set<string>(persist.memory.forgotten)

  const adoptPersist = (state: MindState, now: number): MindState => {
    try {
      // 静息状态就是"我的性情基线"：新会话从**漂移后**的基线开始，而不是从出厂设定开始。
      // （出厂基线仍在配置里，它是漂移的锚点，永远保留。）
      const baseline = persist.baseline
      // 自检留痕：档案里带着漂移过的基线才算闭环（`/mind log` 能看见）
      const drifted = Math.max(
        Math.abs(baseline.valence - tunables.baseline.valence),
        Math.abs(baseline.arousal - tunables.baseline.arousal),
        Math.abs(baseline.dominance - tunables.baseline.dominance),
      )
      logger.debug(
        `[affect] 接管性情基线 效价=${baseline.valence.toFixed(2)} 唤醒=${baseline.arousal.toFixed(2)} ` +
          `支配=${baseline.dominance.toFixed(2)}｜离出厂基线 ${drifted.toFixed(3)}` +
          (drifted > 0.001 ? '（已漂移）' : '（未漂移）'),
      )
      // 这一段对话一开始手边就有的那批（按工作区从磁盘载入）：它们**不是"这一段长出来的
      // 材料"**。不标成已消化，收尾兜底就会拿别的会话的旧账替这一段代笔——旧日记里
      // "还没解决什么：[seq 433] 你这个包结构…"就是这么写出来的（v2.2，见 types.ts）。
      const seeded = adoptShort(state.workspace)
      const digested = [...new Set([...(state.memory.digested ?? []), ...seeded.map((e) => e.id)])].slice(-200)
      return {
        ...state,
        affect: {
          ...state.affect,
          baseline: { ...baseline },
          current: { ...baseline },
          mood: { ...baseline },
          updatedAt: now,
        },
        persona: persist.persona,
        // **接管全局层 + 本工作区的短期层**，两条理由不同：
        // - 全局层是"关于人、跨项目成立"的，当然带过来；
        // - 短期层是"这个项目手边的事"，跨会话有效（注入时还会按工作区再过滤一次），
        //   不带的话，同一个项目里新开的会话手边记忆是空的，前一段对话说的事接不上。
        // **会话日记（session）不带**：那是某一段对话自己的流水账，串味是错的。
        // 名单要合并过去——手工遗忘只改了档案，会话这边不跟着过滤的话，
        // 刚划掉的那条会在这一段对话里复活。宿主侧那份（`hostForgotten`）也要算上：
        // 档案上的名单可能刚被别的会话的落盘覆盖过，而它是权威。
        memory: withoutForgotten({
          ...state.memory,
          global: persist.memory.global,
          short: seeded,
          digested,
          forgotten: [...new Set([...state.memory.forgotten, ...persist.memory.forgotten, ...hostForgotten])].slice(-500),
        }),
        updatedAt: now,
      }
    } catch (error) {
      warn(ctx, '[dsh-mind] 接管档案失败，本会话从零开始', error)
      return state
    }
  }

  // 注册投影：DSH 0.2.x 的 `register` 是可调用的 thenable，await 它拿到句柄；
  // 句柄的 `stateOf(session)` 是推荐的状态读取入口（注册表级读取从 0.2.1-rc.2 起已弃用）。
  const registration = await registerProjection(projections, {
    tunables: () => tunables,
    adoptPersist,
    // 内核不写日志，只把"发生了什么"递出来；落点就是 mind.log
    note: (message) => logger.info(message),
    // 活状态也照名单过滤（每个事件之后）：宿主侧划掉的条目要在**本会话里也立刻消失**。
    // 并成一份名单再交给内核的 `withoutForgotten`——名单只有这一处真相。
    pruneForgotten: (memory) => {
      const extra = [...hostForgotten].filter((id) => !memory.forgotten.includes(id))
      const merged = extra.length === 0 ? memory : { ...memory, forgotten: [...memory.forgotten, ...extra] }
      return withoutForgotten(merged)
    },
    // 反向：刚被 `/mind restore` 捞回来的条目，在下一个事件补回活状态
    //（活状态没有写入 API，只能这么补；没捞过东西时**原样返回**，不动引用纪律）。
    revive: (memory) => {
      if (revived.length === 0) return memory
      let short = memory.short
      let session = memory.session
      let global = memory.global
      for (const entry of revived) {
        const pool = entry.scope === 'session' ? session : entry.scope === 'workspace' ? short : global
        if (pool.some((e) => e.id === entry.id)) continue
        if (entry.scope === 'session') session = [...session, entry]
        else if (entry.scope === 'workspace') short = [...short, entry]
        else global = [...global, entry]
      }
      if (short === memory.short && session === memory.session && global === memory.global) return memory
      return { ...memory, short, session, global }
    },
    // 会话 id 不从这里传：它由投影的 `init` 从会话头读（`SessionHeader.id`），
    // 放进状态里跟 `workspace` 一路。这条路由过两次弯路（作用域里没有 agent、
    // 进程内多条会话会互相覆盖），别再把它做成"注册方给的盒子"。
  })

  const stateOfSession = (session: unknown): MindState | undefined =>
    stateOfVia(registration, projections, session)

  // ── 提示词注入 ────────────────────────────────────────────────
  const systemPrompt = service<SystemPromptService>(ctx, 'systemPrompt')
  if (systemPrompt !== undefined && enabled) {
    if (flag(config, 'injectRealtime')) {
      registerRealtimeContext(systemPrompt, { tunables: () => tunables, stateOfSession })
    }

    // 每个 agent 的注册都集中在这一处。
    //
    // 为什么必须在这里：`agent/created` 是 scope-filtered 的，payload 里只有
    // `agent.id`，**会话对象只能从这个 payload 上拿**；而人设段、决策通道、主动开口
    // 全都要"按会话取状态"，所以它们只能在这里注册（不能挂在外层的 root ctx 上）。
    ctx.on?.('agent/created', ((...args: unknown[]) => {
      const payload = args[0] as { agent?: AgentLike } | undefined
      const agent = payload?.agent
      if (agent === undefined) return
      const session = agent.session
      const agentCtx = agent.ctx ?? ctx

      // 人设段：`section` 的 text() 是同步无参的，拿不到会话，只能靠闭包抓住这个 agent。
      if (flag(config, 'injectPersona')) {
        if (session === undefined) {
          // 拿不到会话就不注册 section：实况段会把人设兜进请求末尾（降级，但不缺席）
          logger.debug('[dsh-mind] agent 没有 session，人设段退回请求末尾')
        } else {
          try {
            const scoped = service<SystemPromptService>(agentCtx, 'systemPrompt') ?? systemPrompt
            registerPersonaSection(scoped, session, agent, { tunables: () => tunables, stateOfSession })
          } catch (error) {
            warn(ctx, '[dsh-mind] 注册人设段失败（退回请求末尾兜底）', error)
          }
        }
      }

      if (session === undefined) return

      // 决策通道：情绪参与「这一轮该怎么想」（只改 temperature / reasoningEffort）
      try {
        registerDecision(agentCtx, session, {
          tunables: () => tunables,
          stateOfSession,
          enabled: () => flag(config, 'enabled'),
          temperatureTilt: () => num(config, 'decisionTempTilt'),
        })
      } catch (error) {
        warn(ctx, '[dsh-mind] 注册决策通道失败（这一轮用原参数）', error)
      }

      // 主动开口：默认关。关着就不注册，连判断都不算
      if (flag(config, 'proactive')) {
        try {
          registerProactive(agentCtx, agent, session, {
            tunables: () => tunables,
            stateOfSession,
            lastSpokeAt: () => stats.lastProactiveAt,
            recordSpoken: (at) => {
              stats = { ...stats, proactive: stats.proactive + 1, lastProactiveAt: at }
              // 立刻落盘：冷却按"距上次多久"算，重启一次就忘的话它会马上又说一句
              try {
                // 主动开口要**立刻**落盘（冷却按"距上次多久"算，重启一次它就忘了自己刚说过话）。
                // 它不是总结周期的一部分，所以理由记 `manual`。
                flush('主动开口', 'manual')
              } catch (error) {
                warn(ctx, '[dsh-mind] 记录主动开口之后落盘失败', error)
              }
            },
          })
        } catch (error) {
          warn(ctx, '[dsh-mind] 注册主动开口失败（这一条功能就没了）', error)
        }
      }
    }) as (...args: unknown[]) => unknown)
  } else if (systemPrompt === undefined) {
    warn(ctx, '[dsh-mind] 拿不到 systemPrompt，提示词注入全部跳过')
  }

  // ── 工具 ─────────────────────────────────────────────────────
  if (enabled) {
    ctx.inject?.(['tools'], (scope) => {
      const tools = service<ToolsService>(scope, 'tools')
      /**
       * 注册一个工具。
       *
       * ⚠️ 两层保护都是**真机教出来的**：
       * ①必须挂到作用域上（`scope.effect`）——对照能跑通的第三方插件（feiyu-memory
       *   的 `ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register(...)))`），
       *   直接调 `register` 不包 effect 时，工具不会出现在模型面前；
       * ②失败必须留下**看得见**的痕迹——这里以前只 `warn(ctx, …)` 走宿主日志，
       *   而 headless 下那条日志被 CLI 输出吞掉，结果"工具没注册上"这件事完全静默。
       */
      const registerTool = (spec: unknown, label: string): void => {
        if (tools === undefined) return
        // ⚠️ 绝不能把方法取出来再用：`const f = tools.register; f(spec)` 会丢掉 `this`，
        // 真机报 `Cannot read properties of undefined (reading 'layers')`（注册表内部要靠 this）。
        const run = (): unknown => (tools.register as unknown as (s: unknown) => unknown).call(tools, spec)
        try {
          if (typeof scope.effect === 'function') scope.effect(run)
          else run()
          logger.debug(`[tool] 已注册 ${label}`)
        } catch (error) {
          logger.warn(`[tool] 注册 ${label} 失败：${error instanceof Error ? error.message : String(error)}`)
          warn(ctx, `[dsh-mind] 注册工具 ${label} 失败`, error)
        }
      }
      if (tools === undefined) {
        warn(ctx, '[dsh-mind] 拿不到 tools，inner_note 不注册')
        return
      }
      /**
       * 别的会话的日记。只有 `scope="all"` 时才需要，所以默认不读。
       *
       * 为什么在适配层：core 不碰磁盘。**要不要看别的会话、看得到什么**是"这个宿主上
       * 记忆存在哪"的问题，内核只负责给结论排序。读不动就少给几条，绝不让它毁掉整次检索。
       */
      try {
        registerTool(innerNoteTool(), 'inner_note')
        // 长期记忆要**主动查**（短期记忆已经注进上下文了）。读的是跨会话档案：
        // 那是同一份"笔记本"，所有会话共用——语义上就该这样，也不必绑某个会话。
        registerTool(
          recallTool({
            memory: () => persist.memory,
            tunables: () => tunables,
            // 跨工作区判定要知道"这次调用在哪个工作区"：从宿主给的 agent 会话上取
            // （工具是根作用域注册的，只能靠 execute 的上下文回到会话）。
            // 取不到会话就返回空串（未知），这时不降权——不知道自己在哪时宁可当全局。
            workspace: (context) => {
              try {
                const session = context?.agent?.session
                return session === undefined ? '' : stateOfSession(session)?.workspace ?? ''
              } catch {
                return ''
              }
            },
            // 跨会话：第一段看简介挑会话，第二段只进选中的会话。分页由工具切命中。
            // 拿不到"当前是哪个会话"就如实返回 no-session——宁可明说查不了，不要查错人。
            crossSession: (query, page, pageSize, options) => {
              try {
                const session = options?.context?.agent?.session
                const current = session === undefined ? '' : stateOfSession(session)?.session ?? ''
                return crossSessionRecall(root, current, query, page, pageSize, options?.sessionLimit)
              } catch (error) {
                warn(ctx, '[dsh-mind] 跨会话检索失败（这次只查本会话与跨会话库）', error)
                return { entries: [], lookedAt: 0, entered: [], page, total: 0 }
              }
            },
          }),
          'recall_memory',
        )
        // 遗忘：**只在用户明确要求忘掉时**才该调（描述里写死了这条纪律）。
        // 工具负责回答"能不能删"，真正的删除在折叠那一步完成——所以它一样可重放。
        registerTool(forgetTool({ memory: () => persist.memory, tunables: () => tunables }), 'forget_memory')
        logger.info(`[dsh-mind] 已注册工具 ${INNER_NOTE_TOOL} / recall_memory / ${FORGET_TOOL}`)
      } catch (error) {
        warn(ctx, `[dsh-mind] 注册 ${INNER_NOTE_TOOL} 失败`, error)
      }
    })
  }

  // ── 命令 ─────────────────────────────────────────────────────
  const flushSessions = new Map<string, { session: unknown; state: MindState }>()
  const pulseCursor = new Map<string, number>()
  let savedSignature = signature(persist)

  /**
   * 上一次真正落盘时档案里的记忆（**回收站的 diff 基线**）。
   *
   * 为什么基线放在这儿：删除的路不止一条——命令 `/mind clear|forget`、模型自己的
   * `forget_memory` 工具（走会话日志折叠）、遗忘名单过滤、短期池淘汰。挨个调用点去记
   * 必然漏一处，而"上一次落盘时有、这一次落盘时没有了"是**唯一能覆盖全部**的判据，
   * 所以捕获只放在 `writeArchive` 这一个门口。
   */
  let committed = persist.memory

  /**
   * 被 `/mind restore` 捞回来的条目（内容缓存）：投影每走一步都会把它们补回活状态。
   *
   * 为什么必须这样：会话状态由日志派生、**没有写入 API**，所以"捞回来一条"没法直接改活状态。
   * 做法是"文件里写回 + 这里记一笔"，由 `revive` 依赖在下一个事件补上——与 `adoptPersist`
   * 同性质（磁盘影响状态，但同输入同输出，可回放这条纪律不受损）。
   *
   * 声明放在这一层：命令闭包要往里写（`restore`），投影依赖要读它（`revive`）。
   */
  const revived: MindState['memory']['short'] = []

  const rebuild = (state: MindState, now: number): MindPersist => {
    const next = toPersist(state, stats, now)
    // 宿主侧的名单并进来（见 `hostForgotten`）：不然刚划掉的 id 会被这一次落盘覆盖掉。
    const hostOnly = [...hostForgotten].filter((id) => !next.memory.forgotten.includes(id))
    const merged =
      hostOnly.length === 0 ? next.memory : { ...next.memory, forgotten: [...next.memory.forgotten, ...hostOnly] }
    // 写档案前再过一遍名单：这是"划掉的东西不会自己长回来"的最后一道保证
    const memory = withoutForgotten(merged)
    return memory === next.memory ? next : { ...next, memory }
  }

  /**
   * 把三层记忆 + 人设快照写成 v3 的快照文件：`global/memory.jsonl.zst`、
   * `global/persona.jsonl.zst`、`short/<工作区键>.jsonl.zst`、`sessions/<会话 id>/memory.jsonl.zst`。
   *
   * `state` 缺省时只写"跨会话要带走的"（全局层 + 人设快照）：命令层手里只有存档、没有会话状态，
   * 短期的家是会话状态，会话日记的家是那段对话，命令不该替它们编。
   *
   * 每条写入都是一整份**新快照**：会话日记不再"只追加"——旧条目这次没出现就等于删了，
   * 改了就改了。`reason` 说明这一次为什么写（到点总结 / 压缩后 / 收尾 / 人工 / 迁移）。
   */
  const writeLayers = (next: MindPersist, state: MindState | undefined, reason: SnapshotReason, seq?: number): boolean => {
    const now = Date.now()
    const opts = { reason, ...(seq === undefined ? {} : { seq }) }
    // 全局层分两种：关于人/跨项目的，和在某个工作区里成立的（后者明写出处）。
    const global: StoredEntry[] = next.memory.global.map((entry) => {
      if (entry.scope === 'workspace' && typeof entry.ws === 'string' && entry.ws !== '') {
        return asWorkspaceEntry(entry, entry.ws)
      }
      // 老档案里没有 ws 的条目：如实标 legacy，不替它编归属。
      return toStored(entry, 'global', entry.ws === undefined ? { legacy: true } : {})
    })
    let ok = saveGlobal(root, global, now, opts)
    ok = savePersonaState(
      root,
      { persona: next.persona, baseline: next.baseline, stats: next.stats, memory: { forgotten: next.memory.forgotten } },
      now,
      opts,
    ) && ok
    if (state === undefined) return ok
    // 名单是权威，**三层都过**：`next.memory` 已经在 `rebuild` 里滤过一道，可短期与会话这两桶
    // 是从**活状态**取的，而活状态由会话日志派生、不知道宿主侧划过什么（`/mind forget`、
    // `/mind reset-memory`）。不在这儿再滤一遍，手工清掉的条目下一次落盘就回来了。
    const forgotten = [...new Set([...state.memory.forgotten, ...hostForgotten])]
    const live = withoutForgotten({ ...state.memory, forgotten })
    // 短期：按工作区各一份，每次一整份（全量语义）。
    const byWorkspace = new Map<string, StoredEntry[]>()
    for (const entry of live.short) {
      const key = typeof entry.ws === 'string' ? entry.ws : ''
      const bucket = byWorkspace.get(key)
      const stored = toStored(entry, 'workspace')
      if (bucket === undefined) byWorkspace.set(key, [stored])
      else bucket.push(stored)
    }
    // 手边清空了也得写：短期是全量语义，"这一份没了"必须让盘上那一份也没了。
    // v2 只写"有桶的那些工作区"，于是某个项目的短期被清空后，旧文件会一直留在盘上。
    if (!byWorkspace.has(state.workspace)) byWorkspace.set(state.workspace, [])
    for (const [key, entries] of byWorkspace) ok = saveShort(root, key, entries, now, opts) && ok
    // 会话日记：写一整份当前内容（可修订）。写完整份，就不会出现"旧条目还留在盘上"的矛盾。
    if (state.session !== '') {
      ok = saveSession(root, state.session, live.session.map((entry) => toStored(entry, 'session')), now, opts) && ok
    }
    return ok
  }

  /**
   * 写存档：人设快照 + 三层记忆各追加一份新快照。
   *
   * 所有写入点都走这里。v3 没有"副本"了——这些文件**就是**记忆本身，
   * 所以任何一份没写进去都要如实地报出来，不能像 v2 那样"聚合档案写成了就算成功"。
   */
  const writeArchive = (
    next: MindPersist,
    state?: MindState,
    reason: SnapshotReason = 'manual',
    seq?: number,
  ): boolean => {
    try {
      // 假删的唯一入口：跟上一份落盘的档案比，"消失的条目"记进回收站（正文留着，随时能捞回来）。
      // 覆盖命令 / 工具 / 遗忘过滤 / 池子淘汰四条路；真删只有 `/mind purge` 一处。
      const layers = (memory: MindState['memory']) => [...memory.short, ...memory.session, ...memory.global]
      const why = reason === 'manual' ? '人工操作（命令或清库）' : `会话落盘（${reason}）`
      trashGone(root, layers(committed), layers(next.memory), Date.now(), why)
      const ok = writeLayers(next, state, reason, seq)
      if (ok) committed = next.memory
      if (!ok) warn(ctx, '[dsh-mind] 有记忆快照没写进去（看看 stateDir 是不是可写）')
      return ok
    } catch (error) {
      warn(ctx, '[dsh-mind] 记忆快照写入失败（这次不落盘）', error)
      return false
    }
  }

  /**
   * 记住"这条会话刚动过"，并把它挪到 Map 的末尾。
   *
   * `Map.set` 对一个**已有**的键不会改变顺序，而 `flush` 取的是最后一个——
   * 多会话同时跑时，那就会拿着这条会话的由头去写另一条会话的状态。先删后放，最后那个一定是刚动过的。
   */
  const remember = (key: string, entry: { session: unknown; state: MindState }): void => {
    flushSessions.delete(key)
    flushSessions.set(key, entry)
  }

  /** 把"最后动过的那条会话"落盘。`reason` 会写进快照，说明这一次为什么写。 */
  const flush = (why: string, reason: SnapshotReason): void => {
    const latest = [...flushSessions.values()].at(-1)
    if (latest === undefined) return
    const next = rebuild(latest.state, Date.now())
    const nextSignature = signature(next)
    if (nextSignature === savedSignature) return
    savedSignature = nextSignature
    persist = next
    const key = [...flushSessions.keys()].at(-1)
    const seq = key === undefined ? undefined : lastSeq.get(key)
    if (writeArchive(next, latest.state, reason, seq)) logger.debug(`[dsh-mind] 存档已写回（${why}）`)
  }

  let timer: NodeJS.Timeout | null = null
  const scheduleSave = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      try {
        flush('去抖到点', 'steps')
      } catch (error) {
        warn(ctx, '[dsh-mind] 写回档案失败（这次不落盘）', error)
      }
    }, SAVE_DEBOUNCE_MS)
  }

  if (enabled) {
    ctx.inject?.(['commands'], (scope) => {
      const commands = service<CommandsService>(scope, 'commands')
      /** 同上：命令注册也要挂在作用域上，失败要留痕。 */
      const registerCommand = (spec: unknown): void => {
        if (commands === undefined) return
        // 契约翻译（真机教出来的）：
        // 宿主 `CommandDefinition.handler` 必须返回 CommandResult **对象**（`{kind:'success', text}`），
        // 而命令层为了可读性直接返回字符串。翻译是适配层的活，不该污染命令层。
        // 不翻译时真机报 `Cannot read properties of undefined (reading 'layers')`，注册即失败。
        const source = spec as Record<string, unknown>
        const inner = source['handler'] as (invocation: unknown) => unknown
        const adapted: Record<string, unknown> = {
          ...source,
          handler: (invocation: unknown) => {
            const result = inner(invocation)
            return typeof result === 'string' ? { kind: 'success', text: result } : result
          },
        }
        // 同上：不能丢 this
        const run = (): unknown =>
          (commands.register as unknown as (s: unknown) => unknown).call(commands, adapted)
        try {
          run()
          logger.debug('[command] 已注册 /mind')
        } catch (error) {
          logger.warn(`[command] 注册 /mind 失败：${error instanceof Error ? error.message : String(error)}`)
          warn(ctx, '[dsh-mind] 注册 /mind 失败', error)
        }
      }
      if (commands === undefined) {
        warn(ctx, '[dsh-mind] 拿不到 commands，/mind 不注册')
        return
      }
      /**
       * `/mind sessions`：有哪些会话记忆、各写了些什么（只读）。
       *
       * 为什么要有它：跨会话读取是"它主动去读"，那就得先让人（和它）看得出**有哪些会话**。
       * 只读 `summary.md`（那是给人看的简介）；简介还没生成就只报条数，不替它编。
       */
      const sessionsText = (): string => {
        let ids: string[] = []
        try {
          ids = listSessionIds(root)
        } catch (error) {
          return `读不到会话目录：${String(error)}`
        }
        if (ids.length === 0) {
          return [
            '# 还没有会话记忆',
            '',
            '会话记忆是在回合收束 / 到点总结 / 上下文压缩之后写的（一个会话一份，每次写一整份、可以修订），',
            '所以刚换上新布局的这段时间这里是空的。',
            `位置：${sessionsDir(root)}`,
          ].join('\n')
        }
        const lines: string[] = [`# 会话记忆 ${ids.length} 份`, '']
        for (const id of ids) {
          // 只看最后一行快照（`loadSession` 就是这么读的）：早先那些快照是历史，不算"现在有几条"
          const count = loadSession(root, id).entries.length
          const summary = readText(sessionSummaryFile(root, id))
          lines.push(`· ${id}　${count} 条`)
          if (summary === undefined || summary.trim() === '') {
            lines.push('　　简介还没生成。')
          } else {
            for (const line of summary.trim().split('\n')) lines.push(`　　${line}`)
          }
          lines.push('')
        }
        lines.push(`存放位置：${sessionsDir(root)}`)
        lines.push('　它默认只读**本会话 + 全局**；要看上面某一份，得让它显式指定（`recall_memory` 的 scope 参数）。')
        return lines.join('\n')
      }

      /**
       * 把一批 id 记进**宿主侧名单**并返回到记忆上（清/划的公共收尾）。
       *
       * 名单是权威：写档案前（`rebuild`）与每次状态更新（投影的 `pruneForgotten`）都要并它，
       * 所以"清了就真的清"靠的是这一步，不是靠删文件。
       */
      const markForgotten = (ids: readonly string[], memory: MindState['memory']): MindState['memory'] => {
        for (const id of ids) hostForgotten.add(id)
        return { ...memory, forgotten: [...hostForgotten].slice(-500) }
      }

      /**
       * `clear <层>`：只清那一层，另外两层一个字不动。
       *
       * 与 `reset-memory`（＝ `clear all`）的分工：这个是"把这一层擦掉"，那个是"三层一起擦"。
       * 两个都**不动人设与统计**（那不是记忆条目，连人设一起归零是 `/mind reset-archive`）。
       *
       * 手边是**按项目**一份的：`clear short` 清"当前项目那一份 + 『关于人』那一档"（也就是面板上
       * 当前想法显示的那些），别的项目的手边不动。
       */
      const clearLayer = (layer: string, live: MindState | undefined): string => {
        const now = Date.now()
        const memory = persist.memory
        if (layer === '' || layer === 'forgotten') {
          const counts = {
            short: (live?.memory.short ?? memory.short).length,
            session: (live?.memory.session ?? memory.session).length,
            global: memory.global.length,
          }
          return [
            '用法：/mind clear <short|session|global|all>',
            '',
            `现在：手边 ${counts.short} 条｜本会话日记 ${counts.session} 条｜跨会话库 ${counts.global} 条`,
            '',
            '　· clear short　　只清**当前这个项目**的手边（含「关于人」那一档；别的项目的手边不动）',
            '　· clear session　只清本会话日记（别的会话的日记命令碰不到，它们由各自的会话日志派生）',
            '　· clear global　　只清跨会话库（手边与日记不动）',
            '　· clear all　　　　三层一起清（＝ reset-memory；人设与统计不动）',
            '',
            '清是不可逆的：这些 id 会进遗忘名单，之后不会被重新接管回来。要真清，把层名写上。',
          ].join('\n')
        }

        const ids: string[] = []
        if (layer === 'short') {
          const ws = live?.workspace ?? ''
          for (const entry of live?.memory.short ?? memory.short) {
            const key = typeof entry.ws === 'string' ? entry.ws : ''
            if (key === ws || key === '') ids.push(entry.id)
          }
          for (const entry of loadShort(root, ws).entries) ids.push(entry.id)
          for (const entry of loadShort(root, '').entries) ids.push(entry.id)
          saveShort(root, ws, [], now, { reason: 'manual' })
          saveShort(root, '', [], now, { reason: 'manual' })
        } else if (layer === 'session') {
          const sessionId = live?.session ?? ''
          if (sessionId === '') return '这个会话还没有 id，日记无从清起。'
          for (const entry of live?.memory.session ?? memory.session) ids.push(entry.id)
          for (const entry of loadSession(root, sessionId).entries) ids.push(entry.id)
          saveSession(root, sessionId, [], now, { reason: 'manual' })
        } else if (layer === 'global') {
          for (const entry of memory.global) ids.push(entry.id)
          for (const entry of loadGlobal(root).entries) ids.push(entry.id)
        } else {
          return '用法：/mind clear <short|session|global|all>'
        }

        const unique = [...new Set(ids)]
        // 档案那一份也要真的少了这批条目：回收站的捕获是"跟上一份落盘比，谁不见了"，
        // 命令自己不动这一份的话，清手边 / 清日记就一条都记不进回收站（2026-11-16 实测）。
        const gone = new Set(unique)
        const kept = (list: MindState['memory']['short']) => list.filter((entry) => !gone.has(entry.id))
        const nextMemory =
          layer === 'short'
            ? { ...memory, short: kept(memory.short) }
            : layer === 'session'
              ? { ...memory, session: kept(memory.session) }
              : { ...memory, global: [] }
        persist = { ...persist, memory: markForgotten(unique, nextMemory), savedAt: now }
        savedSignature = signature(persist)
        const ok = writeArchive(persist)
        const what =
          layer === 'short'
            ? '当前项目的手边 + 「关于人」那一档'
            : layer === 'session'
              ? '本会话日记'
              : '跨会话库'
        return [
          `已清掉 ${what}：${unique.length} 条。`,
          ok ? '名单与档案已经写下去（人设与统计没动）。' : '档案写入失败（原文件保留未动），但这一层已经写过空快照。',
          '',
          layer === 'session'
            ? '别的会话的日记命令碰不到（它们由各自的会话日志派生）——要清得停机删文件。'
            : '正在跑的会话里它可能还看得见（状态由日志派生，命令改不了它）——**下一个事件起就干净**（名单每一步都会过滤）。',
        ].join('\n')
      }

      /** `forget <层> <序号|片段>`：只在该层里找（序号来自 `show <层>`，各层各自从 1 开始）。 */
      const forgetInLayer = (layer: string, target: string, live: MindState | undefined): string => {
        const now = Date.now()
        const liveMemory = live?.memory
        const entries: MindState['memory']['short'] =
          layer === 'global'
            ? persist.memory.global
            : layer === 'short'
              ? (liveMemory?.short ?? persist.memory.short)
              : (liveMemory?.session ?? persist.memory.session)
        const label = layer === 'global' ? '跨会话库' : layer === 'short' ? '手边' : '本会话日记'
        if (entries.length === 0) return `${label}里现在是空的，没什么可划。`
        if (target === '') return `用法：/mind forget ${layer} <序号|片段>（序号看 \`/mind show ${layer}\`）`

        let chosen: MindState['memory']['short'][number] | undefined
        const asIndex = Number.parseInt(target, 10)
        if (String(asIndex) === target && asIndex >= 1 && asIndex <= entries.length) {
          chosen = entries[asIndex - 1]
        } else {
          const pool: MindState['memory'] = {
            ...(liveMemory ?? persist.memory),
            short: layer === 'short' ? entries : [],
            session: layer === 'session' ? entries : [],
            global: layer === 'global' ? entries : [],
          }
          const hits = findEntries(pool, target, 5).filter((hit) => hit.score >= 0.3)
          const first = hits[0]
          const second = hits[1]
          if (first === undefined) return `在${label}里没找到和「${target}」对得上的条目——什么都没删。`
          if (second !== undefined && second.score >= first.score - 0.02) {
            return [
              `「${target}」在${label}里对上了 ${hits.length} 条，我不替你猜：`,
              '',
              ...hits.map((hit, index) => describeEntry(hit.entry, index + 1, now)),
              '',
              `用序号（\`/mind forget ${layer} <序号>\`），或者给一段更长的原文。`,
            ].join('\n')
          }
          chosen = first.entry
        }
        if (chosen === undefined) return '没定位到要划掉的条目，什么都没删。'

        hostForgotten.add(chosen.id)
        const after = forgetEntries(
          { ...persist.memory, forgotten: [...new Set([...persist.memory.forgotten, ...hostForgotten])].slice(-500) },
          [chosen.id],
          now,
        )
        persist = { ...persist, memory: after, savedAt: now }
        savedSignature = signature(persist)
        const ok = writeArchive(persist)
        return [
          ok ? `已划掉（${label}）：[${KIND_LABEL[chosen.kind]}] ${chosen.text}` : '存档写入失败（原文件保留未动）。',
          '',
          '正在跑的会话里它可能还看得见（状态由日志派生）——**下一个事件起就干净**（名单每一步都会过滤）。',
        ].join('\n')
      }

      // ── 回收站：假删的挽回路径（恢复 / 撤销遗忘 / 真删）─────────────────────

      /** 回收站里的一条 → 内核能用的记忆条目（补回活状态时用）。 */
      const asMemoryEntry = (
        entry: TrashedEntry,
        scope: MindState['memory']['short'][number]['scope'],
      ): MindState['memory']['short'][number] => ({
        id: entry.id,
        kind: entry.kind,
        text: entry.text,
        importance: entry.importance,
        hits: entry.hits,
        createdAt: entry.createdAt,
        lastAt: entry.lastAt,
        because: entry.because,
        origin: entry.origin,
        scope,
        ...(entry.ws === undefined ? {} : { ws: entry.ws }),
        ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
        ...(entry.seq === undefined ? {} : { seq: entry.seq }),
      })

      /** 回收站里"等恢复"的那些（最近的在前）；已恢复的不再列。 */
      const pendingTrash = (): TrashedEntry[] =>
        loadTrash(root)
          .filter((entry) => entry.restoredAt === undefined)
          .sort((a, b) => b.trashedAt - a.trashedAt)

      const layerLabel = (scope: string): string =>
        scope === 'workspace' ? '手边' : scope === 'session' ? '本会话日记' : '跨会话库'

      /** `show trash`：把回收站摊开给人看（序号与 `restore` / `purge` 对齐）。 */
      const trashList = (): string => {
        const entries = pendingTrash()
        if (entries.length === 0) {
          return [
            '# 回收站是空的',
            '',
            '清 / 划都是**假删**：条目会先落到这里，正文留着，随时能捞回来。',
            '什么会进这儿：清空、划掉、遗忘名单过滤、手边池子淘汰——只要从三层里消失，都留一份。',
          ].join('\n')
        }
        return [
          `# 回收站（${entries.length} 条；正文还在，随时能捞回来）`,
          '',
          ...entries.map((entry, index) =>
            [
              `${index + 1}. [${KIND_LABEL[entry.kind]}] ${entry.text}`,
              `　原层：${layerLabel(entry.trashedFrom)}｜进回收站：${new Date(entry.trashedAt).toLocaleString('zh-CN')}｜为什么：${entry.trashedReason}`,
            ].join('\n'),
          ),
          '',
          '恢复：`/mind restore <序号>`（默认回原来的层，也可以 `/mind restore <序号> global` 换层）；全部恢复：`/mind restore all`。',
          '**真删**（不可逆）：`/mind purge <序号>`，或 `/mind purge trash` 清空回收站。',
        ].join('\n')
      }

      /**
       * `restore`：把回收站里的条目送回某一层。三件事必须一起做，少一件都是"恢复了但没用"：
       *   ① **撤销遗忘**——不摘名单，捞回来也会在下一个事件被过滤掉；
       *   ② **写回那一层的文件**——跨会话库写进档案（立刻生效），手边 / 日记写回各自文件；
       *   ③ **记进 `revived`**——活状态由日志派生、命令改不了它，下一个事件由 `revive` 补上。
       */
      const restoreTarget = (target: string, layerArg?: string): string => {
        const entries = pendingTrash()
        if (target === '' || target === 'trash' || target === '回收站') return trashList()
        const wantsAll = target === 'all' || target === '全部'
        const index = Number.parseInt(target, 10)
        const picked = wantsAll
          ? entries
          : String(index) === target && index >= 1 && index <= entries.length
            ? [entries[index - 1] as TrashedEntry]
            : entries.filter((entry) => entry.id === target || entry.id.startsWith(target))
        if (picked.length === 0) {
          return entries.length === 0
            ? '回收站是空的，没有可恢复的。'
            : `没对上要恢复的条目（「${target}」）——序号看 \`/mind show trash\`。什么都没做。`
        }
        const to =
          layerArg === 'short' || layerArg === 'workspace'
            ? 'workspace'
            : layerArg === 'session'
              ? 'session'
              : layerArg === 'global'
                ? 'global'
                : undefined

        const now = Date.now()
        const moved: string[] = []
        const notes: string[] = []
        for (const entry of picked) {
          const layer = to ?? entry.trashedFrom ?? entry.scope
          if (layer === 'session' && (entry.sessionId ?? '') === '') {
            notes.push(`「${entry.text.slice(0, 12)}…」没记住是哪个会话，恢复不了日记层——加 ` + '`global`' + ' 可以放进跨会话库。')
            continue
          }
          hostForgotten.delete(entry.id)
          if (layer === 'global') {
            if (!persist.memory.global.some((e) => e.id === entry.id)) {
              persist = {
                ...persist,
                memory: { ...persist.memory, global: [...persist.memory.global, asMemoryEntry(entry, 'global')] },
                savedAt: now,
              }
            }
          } else if (layer === 'workspace') {
            const ws = entry.ws ?? ''
            const stored = loadShort(root, ws).entries
            if (!stored.some((e) => e.id === entry.id)) {
              saveShort(
                root,
                ws,
                [...stored, { ...entry, scope: 'workspace', ...(ws === '' ? {} : { ws }) }],
                now,
                { reason: 'manual' },
              )
            }
          } else {
            const sessionId = entry.sessionId ?? ''
            const stored = loadSession(root, sessionId).entries
            if (!stored.some((e) => e.id === entry.id)) {
              saveSession(root, sessionId, [...stored, { ...entry, scope: 'session', sessionId }], now, { reason: 'manual' })
            }
          }
          revived.push(asMemoryEntry(entry, layer))
          markTrashRestored(root, [entry.id], now)
          moved.push(`[${KIND_LABEL[entry.kind]}] ${entry.text.slice(0, 20)}…→ ${layerLabel(layer)}`)
        }

        persist = {
          ...persist,
          memory: { ...persist.memory, forgotten: [...hostForgotten].slice(-500) },
          savedAt: now,
        }
        savedSignature = signature(persist)
        const ok = writeArchive(persist)
        return [
          moved.length === 0 ? '一条都没恢复成功。' : `恢复了 ${moved.length} 条：`,
          ...moved.map((line) => `　· ${line}`),
          ok ? '名单也撤了（不再被遗忘挡着），档案已经写下去。' : '档案写入失败（原文件保留未动）。',
          '',
          '它会在**下一个事件**起出现在面板与注入里（状态由日志派生，这一步只能这么补）。',
          '日记层的恢复只在**这个会话**里可靠（重启后日记由会话日志重建）；要长期留住，恢复时加 `global`。',
          ...(notes.length === 0 ? [] : ['', ...notes]),
        ].join('\n')
      }

      /** `unforget`：把 id 从遗忘名单里摘掉（划错了能撤回）。 */
      const unforgetTarget = (target: string): string => {
        const ids = [...new Set([...hostForgotten, ...persist.memory.forgotten])]
        if (ids.length === 0) return '遗忘名单是空的，没得撤。'
        const index = Number.parseInt(target, 10)
        const id =
          String(index) === target && index >= 1 && index <= ids.length
            ? ids[index - 1]
            : ids.find((candidate) => candidate === target || candidate.startsWith(target))
        if (id === undefined) return `没对上「${target}」（序号看 \`/mind show forgotten\`）。什么都没做。`
        const now = Date.now()
        hostForgotten.delete(id)
        persist = {
          ...persist,
          memory: { ...persist.memory, forgotten: [...hostForgotten].slice(-500) },
          savedAt: now,
        }
        savedSignature = signature(persist)
        const ok = writeArchive(persist)
        const alive = [...persist.memory.short, ...persist.memory.session, ...persist.memory.global].some(
          (entry) => entry.id === id,
        )
        return [
          `已从遗忘名单里撤掉：${id}`,
          ok ? '名单已经写下去。' : '档案写入失败（原文件保留未动）。',
          alive
            ? '它本来就在三层里（只是被名单挡着），现在回来了——下一个事件起出现在面板与注入里。'
            : '它已经不在三层里了。正文在回收站：`/mind show trash` 之后 `/mind restore <序号>`。',
        ].join('\n')
      }

      /** `purge`：**真删**（唯一不可逆的地方，所以只由它来做）。 */
      const purgeTarget = (target: string): string => {
        const now = Date.now()
        if (target === '') {
          return '用法：`/mind purge <序号>`（序号看 `/mind show trash`），或 `/mind purge trash`（清空回收站）。'
        }
        if (target === 'trash' || target === 'all' || target === '回收站' || target === '全部') {
          const count = purgeTrash(root, 'all', now)
          return `回收站清空了：真删 ${count} 条，**不可逆**。以后想要后悔药就别用这条。`
        }
        const entries = pendingTrash()
        const index = Number.parseInt(target, 10)
        const picked =
          String(index) === target && index >= 1 && index <= entries.length
            ? entries[index - 1]
            : entries.find((entry) => entry.id === target || entry.id.startsWith(target))
        if (picked === undefined) return `没对上「${target}」——什么都没删（序号看 \`/mind show trash\`）。`
        const count = purgeTrash(root, [picked.id], now)
        return count === 0
          ? '它已经不在回收站里了。'
          : `已真删：[${KIND_LABEL[picked.kind]}] ${picked.text}（**不可逆**）`
      }

      try {
        registerCommand(
          mindCommand({
            tunables: () => tunables,
            stateOfSession,
            persist: () => persist,
            stats: () => stats,
            trashList: () => trashList(),
            restore: (target, layerArg) => restoreTarget(target, layerArg),
            unforget: (target) => unforgetTarget(target),
            purge: (target) => purgeTarget(target),
            forgotten: () => [...new Set([...hostForgotten, ...persist.memory.forgotten])],
            clear: (layer, live) => clearLayer(layer, live),
            remember: (query) => {
              const now = Date.now()
              const global = persist.memory.global
              if (global.length === 0) {
                return [
                  '# 跨会话库还是空的',
                  '',
                  '记忆是自动写的、够重要才固化：要么被反复取用（≥2 次），要么重要度高（≥0.75）。',
                  '所以刚装上的头几天它是空的——短期记忆（手边那几条）在 `/mind` 里能看到，',
                  '本会话的日记在 `sessions/<会话 id>/memory.jsonl.zst` 里（命令不动它）。',
                ].join('\n')
              }
              const hits = findEntries(globalOnly(persist.memory), query, 20)
              const head =
                query === ''
                  ? `# 跨会话库 ${global.length} 条（按重要度倒序）`
                  : `# 记得「${query}」的有 ${hits.length} 条`
              if (hits.length === 0) {
                return [
                  head,
                  '',
                  '没找到。它只收"值得长期留着"的东西（明确的约定 / 偏好 / 教训），查不到不代表忘了。',
                  '不带词看一眼里面都有什么：`/mind remember`。',
                ].join('\n')
              }
              const lines = hits.map((hit, index) => describeEntry(hit.entry, index + 1, now))
              const tail =
                persist.memory.forgotten.length > 0
                  ? `已遗忘（不会再被查出来）：${persist.memory.forgotten.length} 条`
                  : ''
              return [head, '', ...lines, '', '划掉哪条：`/mind forget <序号>`。', tail]
                .filter((line) => line !== '')
                .join('\n')
            },
            forget: (target, layer, live) => {
              // 带层的用法（v2.4.x）：`forget short 3` / `forget global 片段` —— 只在该层里找
              if (layer === 'short' || layer === 'session' || layer === 'global') {
                return forgetInLayer(layer, target, live)
              }
              const now = Date.now()
              if (target === '') {
                return [
                  '用法：/mind forget [short|session|global] <序号|片段>',
                  '',
                  '序号看 `/mind show <层>` 的输出（各层各自从 1 开始）；不带层时按"跨会话库"算（老习惯）。',
                  '关键词要够像原文——对上多条时它不会替你猜，会把候选列出来。',
                ].join('\n')
              }
              const listed = findEntries(globalOnly(persist.memory), '', 20)
              const asIndex = Number.parseInt(target, 10)
              let picked: { id: string; kind: keyof typeof KIND_LABEL; text: string } | null = null

              if (String(asIndex) === target && asIndex >= 1 && asIndex <= listed.length) {
                const hit = listed[asIndex - 1]
                if (hit !== undefined) picked = { id: hit.entry.id, kind: hit.entry.kind, text: hit.entry.text }
              } else {
                const hits = findEntries(globalOnly(persist.memory), target, 5).filter((hit) => hit.score >= 0.3)
                const first = hits[0]
                const second = hits[1]
                if (first === undefined) {
                  return `没找到和「${target}」对得上的条目——什么都没删（遗忘了就找不回来，宁可不动）。`
                }
                if (second !== undefined && second.score >= first.score - 0.02) {
                  return [
                    `「${target}」对上了 ${hits.length} 条，我不替你猜：`,
                    '',
                    ...hits.map((hit, index) => describeEntry(hit.entry, index + 1, now)),
                    '',
                    '用序号，或者给一段更长的原文。',
                  ].join('\n')
                }
                picked = { id: first.entry.id, kind: first.entry.kind, text: first.entry.text }
              }

              if (picked === null) return '没定位到要划掉的条目，什么都没删。'
              const before = persist.memory
              const after = forgetEntries(before, [picked.id], now)
              if (after === before) return '这一条已经不在长期库里了。'
              // 记进**宿主侧名单**：档案上的 `forgotten` 会被正在跑的会话下一次落盘覆盖，
              // 名单才是权威（`rebuild` 写档案前、`adoptPersist` 接管时都并它）。
              // 少了这一步，重启之后被划掉的条目会自己长回来。
              hostForgotten.add(picked.id)
              persist = {
                ...persist,
                memory: { ...after, forgotten: [...new Set([...after.forgotten, ...hostForgotten])].slice(-500) },
                savedAt: now,
              }
              savedSignature = signature(persist)
              const ok = writeArchive(persist)
              return [
                ok ? `已划掉：[${KIND_LABEL[picked.kind]}] ${picked.text}` : '存档写入失败（原文件保留未动），什么都没变。',
                '',
                '生效范围：',
                '　· 跨会话的长期库：立即生效，已经写进存档；',
                '　· 本会话内：它可能还在短期记忆里（短期由会话日志派生，命令改不了）。',
                '　　要它立刻消失，让模型调 `forget_memory` 工具——那次调用会落进日志，折叠时就删了。',
              ].join('\n')
            },
            sessions: sessionsText,
            personaFile: () => kernelPath,
            diagnose: () => {
              const lines = [
                `总开关：${enabled ? '开' : '关'}`,
                `注入：人设段 ${flag(config, 'injectPersona') ? '开' : '关'}｜实况段 ${flag(config, 'injectRealtime') ? '开' : '关'}`,
                `状态 schema：${hasZod ? 'zod（宿主自带）' : 'zod 不可用，已降级为浅校验'}`,
                `存储目录：${root}（跨会话库 global/memory.jsonl.zst｜人设与统计 global/persona.jsonl.zst）`,
                `人设内核：${kernelPath}`,
                `跨会话：会话 ${stats.sessions} 次｜回合 ${stats.turns}｜脉冲 ${stats.pulses}｜思想 ${stats.notes}｜取回 ${stats.recalls}｜遗忘 ${persist.memory.forgotten.length}`,
                describeConfig(config, ctx.logger),
              ]
              return lines.join('\n')
            },
            logTail: (limit) => logger.tail(limit),
            resetArchive: () => {
              const fresh = normalizePersist(undefined, Date.now())
              const before =
                persist.memory.global.length + persist.memory.short.length + persist.memory.session.length
              persist = fresh
              savedSignature = signature(fresh)
              // 清空 = 全局层与人设层各追加一份空快照（读取只认最后一行），短期的每份文件也清掉
              const ok = writeArchive(fresh, undefined, 'manual')
              const cleared = clearShort(root, Date.now())
              // 再留一个「下次启动清空」标记：正在跑的会话会把状态写回存档，
              // 所以真正清干净要等下一次启动（那一刻还没有会话状态，没人能写回来）。
              let marked = false
              try {
                mkdirSync(path.dirname(resetMarker), { recursive: true })
                writeFileSync(resetMarker, `${new Date().toISOString()}\n`, 'utf8')
                marked = true
              } catch (error) {
                warn(ctx, '[dsh-mind] 留不下 reset-once 标记', error)
              }
              if (!ok) return `存档清空失败（写入出错），原文件保留未动：${root}`
              return [
                `存档已清空（原有 ${before} 条记忆、${cleared} 份短期）：人设自我认知 + 长期记忆从空开始。`,
                `目录：${root}`,
                '',
                '**要彻底干净，请重启一次 DSH。** 正在跑的会话，状态是从它自己的日志折叠出来的，',
                '一有机会就会把记忆写回存档（这是当初为了可重放刻意定的规矩），所以光清存档会被它写回来。',
                marked
                  ? '标记已留下：下次启动时以空存档开始，并把这个标记吃掉。'
                  : '（标记没留下：重启后可能又被写回来，再敲一次这个命令即可。）',
                '',
                '另外：**旧会话自己的记忆，删文件删不掉**——它由那份会话日志派生。要测新数据，开一个新会话。',
              ].join('\n')
            },
            /**
             * 清记忆：手边 + 本会话日记 + 跨会话库三层全清，**人设与统计原样保留**。
             *
             * 与 `resetArchive` 的分工：那个是"从零开始的自己"（自我认知、相处统计一起归零），
             * 这个是"把记得的事忘掉，我还是我"。用户 2026-11-12 要的是后者。
             *
             * 三层都划进名单之后就**不会再回来**：写档案前（`rebuild`）与写短期/日记时
             * （`writeLayers` 里那道 `withoutForgotten`）都按名单过滤，所以正在跑的会话
             * 也写不回旧的记忆——这一条以前是做不到的（手工清盘会被会话的落盘覆盖）。
             */
            resetMemory: () => {
              const now = Date.now()
              const before = persist.memory
              // id 要从**磁盘**上收（三层都收）：档案里只有跨会话层，手边住在会话状态那边、
              // 会话日记住在各会话目录里。只从 `persist.memory` 收，会把最脏的两层漏出名单——
              // 2026-11-13 真机就是这么漏的（手边那两条没被划掉，随后又被写回盘上）。
              const ids = [
                ...new Set([
                  ...collectMemoryIds(root),
                  ...before.short.map((entry) => entry.id),
                  ...before.session.map((entry) => entry.id),
                  ...before.global.map((entry) => entry.id),
                ]),
              ]
              for (const id of ids) hostForgotten.add(id)
              persist = {
                ...persist,
                memory: {
                  ...before,
                  short: [],
                  session: [],
                  global: [],
                  forgotten: [...hostForgotten].slice(-500),
                },
                savedAt: now,
              }
              savedSignature = signature(persist)
              const ok = writeArchive(persist)
              const shorts = clearShort(root, now)
              const diaries = clearSessions(root, now)
              if (!ok) return `清记忆失败（写入出错），原文件保留未动：${root}`
              return [
                `记忆已清空：原有 ${ids.length} 条（手边 ${before.short.length}｜本会话日记 ${before.session.length}｜跨会话库 ${before.global.length}）。`,
                `**人设、性情基线、相处统计原样保留**（要连它们一起归零，用 \`/mind reset-archive\`）。`,
                `手边清了 ${shorts} 份文件，会话日记清了 ${diaries} 份；那批 id 进了遗忘名单（共 ${persist.memory.forgotten.length} 条），不会被重新接管回来。`,
                '',
                '刚被划掉的条目在**正在跑的会话**里可能还看得见（它的状态由日志派生，命令改不了它），',
                '但盘上已经是空的、名单也挡着：重启一次 DSH 就彻底干净了（不需要等重启才能不再写回去）。',
              ].join('\n')
            },
            /**
             * 内核回滚（v1.2 的另一半：能变，也要能退回去）。
             *
             * 为什么是**档案级**操作：当前会话的状态由日志派生，投影没有写入 API，
             * 所以改不了正在跑的会话。命令如实说明"下一个会话生效"，不装作用。
             */
            rollbackKernel: (index) => {
              const history = persist.persona.kernelHistory
              if (history.length === 0) {
                return [
                  '内核还没有变过，没有快照可回滚。',
                  '',
                  '这是正常的：内核走的是年尺度闸门（证据 ≥8 次、跨 ≥60 天）。',
                  '刚认识的这段时间里，动的应该是说话习惯（最快）和自我认知（次快）。',
                ].join('\n')
              }
              if (!Number.isInteger(index) || index < 1 || index > history.length) {
                return `快照序号要在 1..${history.length} 之间（/mind history 看序号）。`
              }
              const restored = rollbackKernel(persist.persona, index, Date.now())
              persist = { ...persist, persona: restored, savedAt: Date.now() }
              savedSignature = signature(persist)
              const ok = writeArchive(persist)
              return [
                ok ? `已回滚：内核恢复为第 ${index} 份快照之前的那一版。` : '回滚写入失败（原文件保留未动）。',
                '',
                '**生效范围：下一个会话。** 当前会话的状态由会话日志派生，投影没有写入 API，改不了正在跑的这一段。',
                `你写的 persona.md 不受影响：${kernelPath}`,
              ].join('\n')
            },
          }),
        )
        logger.info('[dsh-mind] 已注册命令 /mind')
      } catch (error) {
        warn(ctx, '[dsh-mind] 注册 /mind 失败', error)
      }
    })
  }

  // 每条会话日志走到哪个事件了。会话收尾时给日记条目写 `seq` 要用它——
  // 日记要能回答"这件事是在第几个事件上记下来的"，而这个数字只有事件里带着。
  const lastSeq = new Map<string, number>()

  // ── 会话事件 → 统计与写回 ─────────────────────────────────────
  ctx.on?.('session/event', ((...args: unknown[]) => {
    try {
      const session = args[0]
      const event = args[1] as HostEvent | undefined
      const state = stateOfSession(session)
      if (state === undefined) return
      const key = sessionKey(session)
      const seq = (event as { seq?: unknown } | undefined)?.seq
      if (typeof seq === 'number') lastSeq.set(key, seq)
      const data = event?.data as { name?: unknown } | undefined

      if (event?.type === 'turn/end') {
        stats = { ...stats, turns: stats.turns + 1 }
      } else if (event?.type === 'tool/call') {
        if (data?.name === INNER_NOTE_TOOL) stats = { ...stats, notes: stats.notes + 1 }
      }

      // 脉冲计数用**时间游标**，不能用数组长度：脉冲数组有上限，会被截断。
      const cursor = pulseCursor.get(key) ?? 0
      const fresh = state.pulses.filter((pulse) => pulse.at > cursor)
      if (fresh.length > 0) {
        const last = fresh[fresh.length - 1]
        if (last !== undefined) {
          pulseCursor.set(key, last.at)
          stats = { ...stats, pulses: stats.pulses + fresh.length }
        }
      }

      if (state.persona.kernelHistory.length > stats.kernelChanges) {
        stats = { ...stats, kernelChanges: state.persona.kernelHistory.length }
      }

      remember(key, { session, state })
      // 上下文刚被压缩过：宿主把 `surfaceOp.op === 'replace'` 挂在事件上（mind-core 的
      // `withSurfaceOp` 就是照它置 `summaryReason = 'compaction'` 的）。这是"到点总结"的
      // 第二个触发点，也是快照该记下 `reason: 'compaction'` 的时刻——中间那一段的账要在这里结掉，
      // 不能等去抖窗口：压缩把上下文换掉之后，那些账就再也追不回来了。
      const surfaceOp = (event as { surfaceOp?: { op?: unknown } } | undefined)?.surfaceOp
      if (surfaceOp !== undefined && surfaceOp.op === 'replace') {
        flush('上下文压缩', 'compaction')
        return
      }
      scheduleSave()
    } catch (error) {
      warn(ctx, '[dsh-mind] 处理会话事件失败（这一条跳过）', error)
    }
  }) as (...args: unknown[]) => unknown)

  // agent 销毁 = 这段会话要收尾了：先把"到点了"这件事走完（**规则兜底拼一段日记，不调模型**），
  // 再立刻落盘，不等去抖窗口。
  ctx.on?.('agent/disposed', ((...args: unknown[]) => {
    try {
      const payload = args[0] as { agent?: { session?: unknown } } | undefined
      const session = payload?.agent?.session
      const key = session === undefined ? '' : sessionKey(session)
      const state = session === undefined ? undefined : stateOfSession(session)
      if (key !== '' && state !== undefined) {
        // `finalize` 是纯函数：它给的是"如果就此收尾，这一段日记会长成什么样"，
        // 用来写落地文件。投影状态仍然只由日志派生，这里不（也无法）改它。
        const closed = finalize(state, Date.now(), {
          tunables,
          ...(state.session === '' ? {} : { sessionId: state.session }),
        }, lastSeq.get(key))
        remember(key, { session, state: closed })
      }
      // 会话收尾：这是这一段对话最后一份快照，理由记 `final`
      flush('agent 销毁', 'final')
    } catch (error) {
      warn(ctx, '[dsh-mind] agent 销毁时写回失败', error)
    }
  }) as (...args: unknown[]) => unknown)

  // 设置页半边：把配置接到宿主的 `settings` 服务上，再开一条受围栏的路由给客户端读写。
  // 三个服务（settings / webServer / connection）全是动态可选注入——没有它们，
  // 聊天照旧，只是设置页里没有可编辑的入口（页面会如实说明原因）。
  registerSettingsBridge(ctx)

  logger.info('[dsh-mind] 接线完成')
}
