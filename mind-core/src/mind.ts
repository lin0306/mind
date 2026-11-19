/**
 * 适配器门面：把 core 的一堆纯函数收成"一个对象 + 几个动作"。
 *
 * 它存在的唯一理由是**让第二个 adapter 不必先读 core 的源码**。
 * 门面本身不含机制——机制都在它调用的那些纯函数里；它只把这条线串起来：
 *
 * ```
 * observe(事件)  →  折叠          （唯一的演化入口，纯函数）
 * tick(now)      →  推进时间      （回归、褪色、过期）
 * assemble(now)  →  { stable, dynamic }   两段文本，adapter 决定注到哪
 * recall(q)      →  长期记忆命中  （给"我想想"那个工具）
 * panel(now)     →  中文面板文本  （给命令/UI）
 * persist(now)   →  跨会话档案    （原子落盘由 adapter 做，core 不碰 IO）
 * ```
 *
 * **注意 `assemble()` 只有两段**：设计稿里还有第三段 `urgent`（前置注入），
 * 实现时发现没有必要——易变的东西（此刻的情绪、思想、手边记着的事）放请求末尾就够，
 * 而"前置注入"那条路要么绕开系统提示词、要么多一次消息改写，两样都比它换来的收益贵。
 * 所以契约按实现的来，不留一个永远为空的字段。
 */

import { DEFAULT_TUNABLES, withDefaults, type MindTunables } from './config.js'
import type { MindEvent } from './events.js'
import {
  applyEvent,
  consumeSummary as consumeSummaryFold,
  finalize as finalizeFold,
  tick as tickFold,
  type FoldOptions,
} from './fold.js'
import { recall as recallMemory, type RecallHit, type RecallScope } from './memory.js'
import { adoptKernel } from './persona.js'
import { renderPanel, renderPersonaSection, renderRealtimeSection, renderWhy } from './render.js'
import { emptyState, emptyStats, normalizePersist, toPersist } from './state.js'
import type { MemoryEntry, MemoryState, MindPersist, MindState, MindStats } from './types.js'

/** 人设内核的输入形状（用户在 `persona.md` 里能写的东西）。 */
export interface KernelInput {
  name?: string
  values?: Record<string, number>
  boundaries?: string[]
}

/**
 * 两段文本。
 *
 * - `stable`：人设（内核 / 自我认知 / 说话习惯 / 硬边界）。改动很少，**放系统提示词**。
 * - `dynamic`：此刻（情绪 / 思想 / 相处）。每步都在变，**放请求末尾**。
 *
 * 谁放哪儿由 adapter 决定——但**别把 dynamic 放进系统提示词**：
 * 那会让它之后的全部内容每轮都失去前缀复用（有竞品实测掉到个位数命中率）。
 */
export interface MindSegments {
  stable: string
  dynamic: string
}

/** 门面对象。 */
export interface AdapterMind {
  observe(event: MindEvent): void
  tick(now: number): void
  /** 会话结束时的收束：置「该总结了」并按规则兜底补一段会话日记（不调模型）。 */
  finalize(now?: number, seq?: number): void
  /** 「该总结了」已经处理完了（适配层写完那一段点名注入之后调一次）。 */
  consumeSummary(now?: number): void
  setKernel(kernel: KernelInput, at?: number): void
  adopt(persist: MindPersist, now?: number): void
  assemble(now?: number): MindSegments
  recall(
    query: string,
    now?: number,
    limit?: number,
    opts?: { ws?: string; scope?: RecallScope; others?: readonly MemoryEntry[] },
  ): RecallHit[]
  panel(persist?: MindPersist, now?: number): string
  why(): string
  state(): MindState
  persist(now?: number): MindPersist
  tunables(): MindTunables
}

/** 人设段里的"空记忆"：短期记忆是易变的，不该进系统提示词（见 MindSegments 的说明）。 */
const NO_MEMORY: MemoryState = {
  short: [],
  session: [],
  global: [],
  pendingSignals: 0,
  forgotten: [],
  updatedAt: 0,
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 脉冲计数的游标（**不能靠 `state.pulses.length`**：那个数组会被截断）。 */
export type StatsCursor = number

/**
 * 事件 → 累计统计。**纯函数**：同一串事件一定得到同一份统计。
 *
 * 为什么统计要放在 core 而不是各 adapter 各写一遍：统计是"这个 agent 活了多少"的事实，
 * 两套实现必然对不上（而且脉冲那条要看折叠后的 state、还要维护时间游标，最容易写错）。
 * adapter 只需要在折叠之后调一次，把游标带回去。
 *
 * `proactive` 不在里面——"开口"是 adapter 的动作（它才知道自己有没有真叫醒 agent），
 * 由 adapter 自己加。
 */
export function countEvent(
  stats: MindStats,
  state: MindState,
  event: MindEvent,
  cursor: StatsCursor,
): { stats: MindStats; cursor: StatsCursor } {
  let next = stats
  if (event.type === 'turn/end') next = { ...next, turns: next.turns + 1 }
  if (event.type === 'tool/call') {
    const name = asRecord(event.data)['name']
    if (name === 'inner_note') next = { ...next, notes: next.notes + 1 }
    if (name === 'recall_memory') next = { ...next, recalls: next.recalls + 1 }
  }
  const fresh = state.pulses.filter((pulse) => pulse.at > cursor)
  if (fresh.length > 0) {
    const last = fresh[fresh.length - 1]
    next = { ...next, pulses: next.pulses + fresh.length }
    return { stats: next, cursor: last === undefined ? cursor : last.at }
  }
  return { stats: next, cursor }
}

/** 造一个门面。传 `persist` 就是"接着上一次的自己继续"。 */
export function createMind(
  options: { tunables?: Partial<MindTunables>; persist?: MindPersist; now?: number } = {},
): AdapterMind {
  const t = options.tunables === undefined ? DEFAULT_TUNABLES : withDefaults(options.tunables)
  const opts: FoldOptions = { tunables: t }
  const now0 = options.now ?? Date.now()

  let state = emptyState(t, now0)
  let stats = emptyStats()
  let cursor: StatsCursor = 0

  /**
   * 接管跨会话档案：人设、**全局记忆**、性情基线。会话内的情绪与思想**从零开始**。
   *
   * v2.0 起只带全局层：会话日记是"某一次会话的日记"，把它带进新会话就串味了
   * （用户点名不许发生的事）；真要看上一次，得走 `recall` 的 `scope:'all'` 主动去查。
   */
  const adopt = (persist: MindPersist, now = Date.now()): void => {
    state = {
      ...state,
      persona: persist.persona,
      memory: { ...state.memory, global: persist.memory.global },
      // 基线是唯一跨会话保留的情感量：接管它，等于"我还是那个脾气，但此刻重新开始"
      affect: { ...state.affect, baseline: persist.baseline, current: persist.baseline, mood: persist.baseline },
      updatedAt: now,
    }
    stats = { ...persist.stats, sessions: persist.stats.sessions + 1 }
  }

  if (options.persist !== undefined) adopt(options.persist, now0)

  return {
    observe(event: MindEvent): void {
      state = applyEvent(state, event, opts)
      const counted = countEvent(stats, state, event, cursor)
      stats = counted.stats
      cursor = counted.cursor
    },
    tick(now: number): void {
      state = tickFold(state, now, opts)
    },
    finalize(now = Date.now(), seq?: number): void {
      state = finalizeFold(state, now, opts, seq)
    },
    consumeSummary(now = Date.now()): void {
      state = consumeSummaryFold(state, now)
    },
    setKernel(kernel: KernelInput, at = Date.now()): void {
      state = { ...state, persona: adoptKernel(state.persona, kernel, at) }
    },
    adopt,
    assemble(now = Date.now()): MindSegments {
      return {
        stable: renderPersonaSection(state.persona, NO_MEMORY, t),
        dynamic: renderRealtimeSection(state, now),
      }
    },
    // `ws` 缺省用当前工作区：知道自己在哪儿的时候，别的工作区的条目降权并标出来源
    // （不知道在哪儿时 `state.workspace` 是空串，等于不降权——宁可当全局，也不误伤）。
    recall(
      query: string,
      now = Date.now(),
      limit?: number,
      opts: { ws?: string; scope?: RecallScope; others?: readonly MemoryEntry[] } = {},
    ): RecallHit[] {
      const hits = recallMemory(
        state.memory,
        query,
        now,
        t,
        opts.ws ?? state.workspace,
        opts.scope ?? 'this',
        opts.others ?? [],
      )
      return limit === undefined ? hits : hits.slice(0, limit)
    },
    panel(persist?: MindPersist, now = Date.now()): string {
      return renderPanel(state, persist ?? toPersist(state, stats, now), stats, now, t)
    },
    why(): string {
      return renderWhy(state)
    },
    state(): MindState {
      return state
    },
    persist(now = Date.now()): MindPersist {
      return toPersist(state, stats, now)
    },
    tunables(): MindTunables {
      return t
    },
  }
}

/** 把"别人给的档案"（可能是老版本、可能残缺）洗成当前形状。adapter 读文件后用它。 */
export function readPersist(raw: unknown, now = Date.now(), t: MindTunables = DEFAULT_TUNABLES): MindPersist {
  return normalizePersist(raw, now, t)
}
