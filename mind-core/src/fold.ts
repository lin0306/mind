/**
 * 折叠：状态**唯一**的演化入口。
 *
 * 这个函数就是会话投影的 `apply(state, event)`。它必须满足三条：
 * 1. **同步**（投影注册表是同步的，不许为此引入异步）；
 * 2. **纯**（不读时钟、不读文件、不发网络——所有时间来自 `event.time`）；
 * 3. **对无关事件返回同一个引用**（注册表用 `Object.is` 做第一层闸门，引用不变即零下游工作）。
 *
 * 第 3 条是这里唯一的性能纪律：它会拿到 `request/header`、`step/start`、`assistant/stream` 这类
 * 高频事件，那些必须原样返回。
 *
 * v2.0 起 `step/end` 不再"无关"：它是**步计数**的唯一来源（触发点①，见 `onStepEnd`），
 * 所以它会真的改状态；别的高频事件照旧原样返回。
 */

import { appraise, type Observation, type TurnEndReasonKind } from './appraise.js'
import { driftBaseline, evolveAffect, tickAffect } from './affect.js'
import type { MindTunables } from './config.js'
import {
  FORGET_TOOL_NAME,
  IMPORTANCE_BY_KIND,
  RECALL_TOOL_NAME,
  allEntries,
  appendSession,
  forgetEntries,
  overlap,
  recall,
  reinforce,
  rememberAuto,
  sensitiveReason,
  solidify,
  worthRemembering,
  type RecallScope,
} from './memory.js'
import { noteInteraction, observeSelfStatement, settleKernel, driftVoice } from './persona.js'
import { applyNote, relieve, tickTension, type InnerNote } from './thought.js'
import type { MemoryEntry, MemoryScope, MindState, Signal, SurfaceOp } from './types.js'

/** 写内心记录的工具名（与适配层 `tools.ts` 的 `INNER_NOTE_TOOL` 必须是同一个字符串）。 */
const INNER_NOTE_TOOL = 'inner_note'

/** 事件的最小形状（不 import DSH 类型，保持 core 与 agent 无关）。 */
export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data?: unknown
  /**
   * 上下文表面操作（可选，v2.0 新增，DESIGN §22.3 触发点②）。
   *
   * 适配层把表面事件自带的 `surfaceOp` 原样透传：`'append'` 是平常的一次追加，
   * `{ op: 'replace', startSeq, endSeq }` 就是**上下文压缩**。
   * core 不去猜"是不是压缩了"，只认这个字段。
   */
  surfaceOp?: SurfaceOp
}

/** 折叠参数。 */
export interface FoldOptions {
  tunables: MindTunables
  /**
   * 内核**不写日志**（它是纯逻辑），但有些事必须让人看得见——比如"这一句像密钥，没让它进记忆"。
   * 所以这里只把话递出去，写去哪儿由适配层决定（不传就没人接，静默丢弃）。
   */
  note?: (message: string) => void
  /**
   * 「我是哪个会话」。内核不持有会话本身（状态必须是日志的纯函数，会话 id 也不是事件里能折叠出来的东西），
   * 所以由适配层在注册投影时闭包带进来。只用在一处：没选工作区的会话写下的记忆要标上出处，
   * 否则所有未分组会话的条目会混成一组，面板也无从显示"这是哪个会话说的"。
   */
  sessionId?: string
}

// ─────────────────────────────────────────────────────────
// 从 DSH 的消息/事件对象里取东西（宽容取值：形状不确定时不炸，只是取不到）
// ─────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 从任意消息形状里取纯文本。 */
export function extractText(data: unknown): string {
  if (typeof data === 'string') return data
  const o = asRecord(data)
  if (typeof o['text'] === 'string') return o['text']
  const content = o['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const b = asRecord(block)
      if (typeof b['text'] === 'string') parts.push(b['text'])
    }
    return parts.join('\n')
  }
  return ''
}

/** 这条 user/message 是不是"用户亲口说的"（合成消息不算）。 */
function isRealUserMessage(data: unknown): boolean {
  const source = asRecord(asRecord(data)['source'])
  const kind = source['kind']
  // 没有 source 字段就不做判断（宽容：老版本或别的形状一样收）。
  if (typeof kind !== 'string') return true
  return kind === 'user'
}

/** 统计助手这条消息的体量。 */
function assistantMetrics(data: unknown): { chars: number; totalTokens?: number; outputTokens?: number } {
  const o = asRecord(data)
  let chars = 0
  const stream = o['stream']
  if (Array.isArray(stream)) {
    for (const rec of stream) {
      const r = asRecord(rec)
      if (r['kind'] !== undefined && r['kind'] !== 'text-chunks') continue
      const texts = r['texts']
      if (Array.isArray(texts)) {
        for (const piece of texts) if (typeof piece === 'string') chars += piece.length
      }
    }
  }
  if (chars === 0) chars = extractText(o['message']).length
  if (chars === 0) chars = extractText(data).length

  const usage = asRecord(o['usage'])
  const total = usage['totalTokens']
  // "这一轮新写了多少"：宿主各家字段名不一样，认几个常见的；取不到就留空
  //（`token_heavy` 宁可不判，也不要拿整包用量误判——见 appraise.ts 里的事故注释）。
  const output = [
    usage['completionTokens'],
    usage['outputTokens'],
    usage['output_tokens'],
    usage['completion_tokens'],
  ].find((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return {
    chars,
    ...(typeof total === 'number' ? { totalTokens: total } : {}),
    ...(output === undefined ? {} : { outputTokens: output }),
  }
}

/** 归一化 DSH 的回合收场方式（字符串与带 kind 的对象都认）。 */
export function turnEndReasonKind(reason: unknown): TurnEndReasonKind {
  if (typeof reason === 'string') {
    switch (reason) {
      case 'completed':
        return 'completed'
      case 'blocked':
        return 'blocked'
      case 'error':
        return 'error'
      case 'max-tokens':
        return 'max-tokens'
      case 'interrupted':
        return 'interrupted'
      default:
        return 'other'
    }
  }
  const o = asRecord(reason)
  const kind = o['kind']
  if (kind === 'aborted') {
    const cause = asRecord(o['reason'])
    return cause['kind'] === 'user' ? 'aborted-user' : 'aborted-other'
  }
  if (typeof kind === 'string') return turnEndReasonKind(kind)
  return 'other'
}

/**
 * 把工具参数解析成对象（v2.2）：**字符串与对象两种形状都吃**。
 *
 * 为什么必须两种都吃：早先四处取值都写成 `typeof x === 'string' ? x : ''`，于是
 * 参数一旦不是 JSON 字符串，写思想 / 写记忆 / 遗忘 / 取回**全部静默失效**——
 * 实测把对象喂进去，"思想"和"记忆"一起丢，连一条日志都没有。宿主此刻恰好传字符串，
 * 但"此刻是字符串"不是契约：工具参数天然可以是对象。
 */
function toRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'object') return asRecord(raw)
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '' || !text.includes('{')) return null
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

/** 解析 `inner_note` 的参数（字符串或对象都认；`tension` 是唯一的数字键）。 */
export function parseNote(raw: unknown): InnerNote | null {
  const o = toRecord(raw)
  if (o === null) return null
  const pick = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
  const tension = typeof o['tension'] === 'number' ? o['tension'] : undefined
  const note: InnerNote = {}
  const intent = pick('intent')
  const judgment = pick('workingJudgment')
  const metaCheck = pick('metaCheck')
  const curiosity = pick('curiosity')
  if (intent !== undefined) note.intent = intent
  if (judgment !== undefined) note.workingJudgment = judgment
  if (metaCheck !== undefined) note.metaCheck = metaCheck
  if (curiosity !== undefined) note.curiosity = curiosity
  if (tension !== undefined) note.tension = tension
  return Object.keys(note).length > 0 ? note : null
}

/** 四类记忆的合法取值（写进档案，所以这里要挡住乱值）。 */
const MEMORY_KINDS = ['fact', 'agreement', 'preference', 'lesson'] as const

/**
 * 解析 `inner_note` 里"顺手记一条"的那部分参数。
 *
 * 为什么跟 `parseNote` 分开解析同一段 JSON：思想层（`thought.ts`）不该知道记忆的存在，
 * 反过来也一样。两边各挑各的键，谁都不用往对方那里塞类型。
 */
export function parseRemember(raw: unknown): { kind: MemoryEntry['kind']; text: string } | null {
  const args = toRecord(raw)
  if (args === null) return null
  const text = typeof args['remember'] === 'string' ? args['remember'].replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  const kind = typeof args['rememberKind'] === 'string' ? args['rememberKind'] : ''
  return {
    kind: (MEMORY_KINDS as readonly string[]).includes(kind) ? (kind as MemoryEntry['kind']) : 'fact',
    text,
  }
}

/**
 * 一条记忆该落在哪儿：弱绑定按种类分级，未分组会话再标上"是哪个会话说的"。
 *
 * 两条写入路径（它自己写的、从用户原话里摘的）共用这一处判定——
 * 否则同一个"偏好"从哪条路进来会落到不同范围，跨会话读起来就乱了。
 */
function locationOf(
  kind: MemoryEntry['kind'],
  workspace: string,
  sessionId?: string,
): { ws: string | null; sessionId?: string; scope: MemoryScope } {
  // 偏好是关于"人"的（全局 `''`），其余绑定当前工作区；
  // 工作区未知（会话没选工作区）时落 `null`，**不能**落成全局——否则
  // 没选工作区时说的一句"这个项目用 pnpm"会跟着走进每一个项目。
  //
  // v2.0：归属层在这里**直接定下来**（`scope`），不再让下游靠 `ws` 的四态去反推。
  if (kind === 'preference') return { ws: '', scope: 'global' }
  if (workspace !== '') return { ws: workspace, scope: 'workspace' }
  // 没绑工作区 → 会话日记那一层（`ws: null` 仍是它的"在哪儿不知道"的意思）
  return sessionId !== undefined && sessionId !== ''
    ? { ws: null, sessionId, scope: 'session' }
    : { ws: null, scope: 'session' }
}

// ─────────────────────────────────────────────────────────
// 内部：把一批信号并进状态
// ─────────────────────────────────────────────────────────

/**
 * 没有信号时**原样返回**（不滴答、不更新时间戳）。
 * 时间的流逝会在下一个带信号的事件里一次性补上——因为 `evolveAffect` 是按时间戳回归的，
 * 不是"每调一次退一点"。
 */
function withSignals(state: MindState, signals: Signal[], now: number, t: MindTunables): MindState {
  if (signals.length === 0) return state
  const { affect, pulses } = evolveAffect(state.affect, signals, now, t)
  const thought = tickTension(state.thought, now, t)
  return {
    ...state,
    affect,
    thought,
    pulses: [...state.pulses, ...pulses].slice(-t.pulseKeep),
    folded: state.folded + 1,
    updatedAt: now,
  }
}

/** 只让时间过去（回合结束时用一次）。 */
function tickOnly(state: MindState, now: number, t: MindTunables): MindState {
  return {
    ...state,
    affect: tickAffect(state.affect, now, t),
    thought: tickTension(state.thought, now, t),
    folded: state.folded + 1,
    updatedAt: now,
  }
}

// ─────────────────────────────────────────────────────────
// 各事件的处理
// ─────────────────────────────────────────────────────────

function onUserMessage(state: MindState, event: SessionEventLike, t: MindTunables): MindState {
  if (!isRealUserMessage(event.data)) return state
  const text = extractText(event.data)
  if (!text.trim()) return state

  const signals = appraise(
    { kind: 'user-text', text, at: event.time, turn: state.progress.turn },
    state.progress,
    t.longUserChars,
  )

  const has = (kind: Signal['kind']) => signals.some((s) => s.kind === kind)
  const persona = noteInteraction(
    { ...state.persona, relation: { ...state.persona.relation, lastSeenAt: event.time } },
    {
      thanks: has('user_thanks') || has('user_praise'),
      pushback: has('user_pushback'),
      // 四根轴都要有双向的驱动源：这三项是 v2.4.x 补的（原来只有"被谢/被驳回"两条单向的）
      interrupt: has('user_interrupt'),
      question: has('user_question'),
      repeat: has('user_repeat'),
    },
    event.time,
    t,
  )

  const next: MindState = {
    ...state,
    persona,
    progress: { ...state.progress, notesThisTurn: 0, toolCallsThisTurn: 0 },
  }
  return withSignals(next, signals, event.time, t)
}

function onToolCall(state: MindState, event: SessionEventLike, opts: FoldOptions): MindState {
  const t = opts.tunables
  const o = asRecord(event.data)
  const name = typeof o['name'] === 'string' ? o['name'] : ''
  const progress = { ...state.progress, toolCallsThisTurn: state.progress.toolCallsThisTurn + 1 }

  if (name !== INNER_NOTE_TOOL) return { ...state, progress, folded: state.folded + 1, updatedAt: event.time }

  // 字符串与对象都认（v2.2）；"不是合法 JSON"这件事由 `applyEvent` 统一说一次，这里不出声
  const note = parseNote(o['arguments'])
  if (!note) return { ...state, progress, folded: state.folded + 1, updatedAt: event.time }

  const thought = applyNote(state.thought, note, event.time, t)
  // 自我认知来自**自己反复说过的判断**，而不是来自一次自我宣示。
  const statement = note.workingJudgment ?? note.intent ?? note.metaCheck ?? ''
  let persona = statement ? observeSelfStatement(state.persona, statement, event.time, t) : state.persona
  persona = settleKernel(persona, event.time, t)

  return {
    ...state,
    thought,
    persona,
    progress: { ...progress, notesThisTurn: progress.notesThisTurn + 1 },
    folded: state.folded + 1,
    updatedAt: event.time,
  }
}

function onToolResult(state: MindState, event: SessionEventLike, t: MindTunables): MindState {
  const o = asRecord(event.data)
  const name = typeof o['name'] === 'string' ? o['name'] : ''
  const error = asRecord(o['error'])
  const message = asRecord(o['message'])
  const failed = Object.keys(error).length > 0 || message['isError'] === true
  const errorName = typeof error['name'] === 'string' ? error['name'] : undefined

  const obs: Extract<Observation, { kind: 'tool-result' }> = {
    kind: 'tool-result',
    name,
    failed,
    ...(errorName !== undefined ? { errorName } : {}),
    at: event.time,
    turn: state.progress.turn,
  }
  const signals = appraise(obs, state.progress, t.longUserChars)

  const progress = failed
    ? {
        ...state.progress,
        consecutiveErrors: state.progress.consecutiveErrors + 1,
        lastToolError: { name, turn: state.progress.turn, at: event.time },
      }
    : {
        ...state.progress,
        consecutiveErrors: 0,
        lastToolError: null,
      }

  const thought =
    !failed && state.progress.consecutiveErrors > 0
      ? relieve(state.thought, t.tensionRelief, event.time)
      : state.thought

  return withSignals({ ...state, progress, thought }, signals, event.time, t)
}

function onAssistantMessage(state: MindState, event: SessionEventLike, t: MindTunables): MindState {
  const metrics = assistantMetrics(event.data)
  const signals = appraise(
    {
      kind: 'assistant-text',
      chars: metrics.chars,
      ...(metrics.totalTokens !== undefined ? { totalTokens: metrics.totalTokens } : {}),
      ...(metrics.outputTokens !== undefined ? { outputTokens: metrics.outputTokens } : {}),
      at: event.time,
      turn: state.progress.turn,
    },
    state.progress,
    t.longUserChars,
  )

  // 自我观察：一直写得很长 / 很短，会慢慢挪动"简洁度"，一天动一点点。
  let persona = state.persona
  if (metrics.chars > 1200) persona = driftVoice(persona, { brevity: -1 }, event.time, t)
  else if (metrics.chars > 0 && metrics.chars < 200) persona = driftVoice(persona, { brevity: 1 }, event.time, t)

  return withSignals(
    { ...state, persona, progress: { ...state.progress, lastAssistantChars: metrics.chars } },
    signals,
    event.time,
    t,
  )
}

/**
 * 触发点①：按**步**计数（v2.0）。
 *
 * 计数单位是步，不是轮：一次对话会走很多步，每一步都有一个 `step/end`。
 * 按轮算的话，一轮里干多少活都只算一次，"到点总结"就永远等不到
 * （REQUIREMENTS §9 的原话裁决）。
 *
 * 到点就把计数**归零**：不归零的话，之后每一步都会再置一次信号，等于每步都总结。
 * `turn/end` 不动它（这一轮走了几步就是几步），`turn/start` 才归零重数。
 */
function onStepEnd(state: MindState, event: SessionEventLike, t: MindTunables): MindState {
  const steps = state.progress.steps + 1
  // 阈值可能是被人改小的坏值（0 / 负数），那样会变成"每步都总结"——按 1 兜住
  const need = Math.max(1, t.memorySummarySteps)
  const due = steps >= need
  return {
    ...state,
    progress: {
      ...state.progress,
      steps: due ? 0 : steps,
      // 已经置上的信号不许被后来的来路顶掉：先置的那个才是原因
      summaryDue: state.progress.summaryDue || due,
      summaryReason: state.progress.summaryDue ? state.progress.summaryReason : due ? 'steps' : null,
    },
    folded: state.folded + 1,
    updatedAt: event.time,
  }
}

function onTurnStart(state: MindState, event: SessionEventLike): MindState {
  const o = asRecord(event.data)
  const turn = typeof o['turn'] === 'number' ? o['turn'] : state.progress.turn
  if (
    state.progress.turn === turn &&
    state.progress.notesThisTurn === 0 &&
    state.progress.toolCallsThisTurn === 0 &&
    // 步计数也要一起看：`turn/start` 是"新一轮对话重新数"的那个点（v2.0）
    state.progress.steps === 0
  ) {
    return state
  }
  return {
    ...state,
    progress: { ...state.progress, turn, notesThisTurn: 0, toolCallsThisTurn: 0, steps: 0 },
    folded: state.folded + 1,
    updatedAt: event.time,
  }
}

function onTurnEnd(state: MindState, event: SessionEventLike, t: MindTunables): MindState {
  const o = asRecord(event.data)
  const turn = typeof o['turn'] === 'number' ? o['turn'] : state.progress.turn
  const reason = turnEndReasonKind(o['reason'])

  const signals = appraise(
    {
      kind: 'turn-end',
      reason,
      at: event.time,
      turn,
      steps: state.progress.notesThisTurn + state.progress.toolCallsThisTurn,
      hadError: state.progress.consecutiveErrors > 0,
    },
    state.progress,
    t.longUserChars,
  )

  // 原地打转：一整回合几乎没调工具也没写思想 —— 那这一轮对"我"没有新输入。
  if (state.progress.toolCallsThisTurn === 0 && state.progress.notesThisTurn === 0) {
    signals.push({ kind: 'idle', weight: 0.25, because: '这一回合没有新东西', at: event.time })
  }

  let thought = state.thought
  if (reason === 'completed') thought = relieve(thought, t.tensionRelief * 0.5, event.time)

  let persona = noteInteraction(state.persona, { turn: true }, event.time, t)
  persona = settleKernel(persona, event.time, t)

  // v1.2 自更新闭环最慢的一环：性情基线跟着心境漂（半衰期按天算）。
  // 出厂基线取配置里的 `t.baseline`，所以漂移永远有界；只在回合收束时动一次。
  const affect = driftBaseline(state.affect, event.time, t, t.baseline)

  // 「该总结了」只提醒一轮：这一回合没写，就收掉；下个阈值到点或下次压缩再提。
  // 不收的话，一次到点会永远挂在每一轮的注入里——那就成了背景噪音，不是提醒。
  const progress = { ...state.progress, notesThisTurn: 0, toolCallsThisTurn: 0, turn }
  if (progress.summaryDue || progress.summaryReason !== null) {
    progress.summaryDue = false
    progress.summaryReason = null
  }

  const next: MindState = {
    ...state,
    affect,
    thought,
    persona,
    progress,
  }
  return withSignals(next, signals, event.time, t)
}

/**
 * 会话投影的 `apply`。
 *
 * 记忆闸门（v1.1）**包在主流程外面**：主流程一行都不用改，
 * 而且"无关事件原样返回同一引用"这条纪律由两层各自守住（见 `withMemory`）。
 */
export function applyEvent(state: MindState, event: SessionEventLike, opts: FoldOptions): MindState {
  // 参数不是合法 JSON 时说一声（v2.2）：下面"思想"和"记忆"两条腿都会各自解析它，
  // 但**诊断只说一次**——同一件事在日志里出现两遍比不说还糟。
  // 静默的失败是最贵的失败：上一轮排查一整晚，卡住的就是这里"没有声音"。
  if (event.type === 'tool/call') {
    const data = asRecord(event.data)
    const name = typeof data['name'] === 'string' ? data['name'] : ''
    const raw = data['arguments']
    if (
      (name === INNER_NOTE_TOOL || name === RECALL_TOOL_NAME || name === FORGET_TOOL_NAME) &&
      typeof raw === 'string' &&
      raw.trim() !== '' &&
      toRecord(raw) === null
    ) {
      opts.note?.(`[记忆] ${name} 的参数不是合法 JSON，这一次没生效`)
    }
  }
  // 触发点②（压缩）与事件类型无关：它看的是事件对象上的 `surfaceOp`，
  // 所以夹在主流程与记忆闸门之间，两类事件都能带上它。
  const folded = withSurfaceOp(evolve(state, event, opts), event)
  return withMemory(folded, event, opts)
}

/**
 * 触发点②：上下文压缩之后要总结一次（DESIGN §22.3）。
 *
 * 压缩把中间那一段对话整体换掉了，而"步"是照着上下文里的动作数的：旧账没法再追，
 * 所以计数**归零重算**（REQUIREMENTS §9 的原话裁决），同时置「该总结了」。
 *
 * `'append'` 与没带 `surfaceOp` 的事件都**原样返回**——这是高频路径。
 */
function withSurfaceOp(state: MindState, event: SessionEventLike): MindState {
  const op = event.surfaceOp
  if (op === undefined || op === 'append') return state
  if (op.op !== 'replace') return state
  return {
    ...state,
    progress: {
      ...state.progress,
      steps: 0,
      summaryDue: true,
      summaryReason: state.progress.summaryDue ? state.progress.summaryReason : 'compaction',
    },
    folded: state.folded + 1,
    updatedAt: event.time,
  }
}

/** 主流程：情感 / 思想 / 人设 / 进度。 */
function evolve(state: MindState, event: SessionEventLike, opts: FoldOptions): MindState {
  const t = opts.tunables
  switch (event.type) {
    case 'user/message':
      return onUserMessage(state, event, t)
    case 'tool/call':
      return onToolCall(state, event, opts)
    case 'tool/result':
      return onToolResult(state, event, t)
    case 'assistant/message':
      return onAssistantMessage(state, event, t)
    case 'step/end':
      // v2.0：走完一步就记一笔。这是高频事件里唯一会真的改状态的那个（见 onStepEnd）。
      return onStepEnd(state, event, t)
    case 'turn/start':
      return onTurnStart(state, event)
    case 'turn/end':
      return onTurnEnd(state, event, t)
    default:
      // ★ 高频事件必须原样返回（引用不变 = 零下游工作）。
      return state
  }
}

// ─────────────────────────────────────────────────────────
// 记忆闸门（v1.1）
// ─────────────────────────────────────────────────────────

/** 工具参数（**字符串或对象都认**）宽容解析成对象；解析不了就当空。 */
function toolArgs(raw: unknown): Record<string, unknown> {
  return toRecord(raw) ?? {}
}

/** 从 `recall_memory` 的参数里取查询词。 */
function recallQuery(argsText: unknown): string {
  const query = toolArgs(argsText)['query']
  return typeof query === 'string' ? query.trim() : ''
}

/** 从 `recall_memory` 的参数里取检索范围（认不出就当默认的 `this`）。 */
function recallScopeFromArgs(argsText: unknown): RecallScope {
  const scope = toolArgs(argsText)['scope']
  return scope === 'global' || scope === 'all' ? scope : 'this'
}

/**
 * 从 `forget_memory` 的参数里认出"要忘掉哪一条"。
 *
 * 只认两种指认方式：**条目 id**（精确）或**一段文本**（挑最像的那一条）。
 * 故意不做"关键词命中一堆就全删"——遗忘不可逆，宁可一条都删不掉，也不要删错。
 */
function forgetTargets(memory: MindState['memory'], argsText: unknown): string[] {
  // 三层一起找（v2.0）：短期、会话日记、全局库都能被显式忘掉
  const all = allEntries(memory)
  const args = toolArgs(argsText)

  const id = typeof args['id'] === 'string' ? args['id'].trim() : ''
  if (id !== '') {
    const hit = all.find((entry) => entry.id === id)
    if (hit !== undefined) return [hit.id]
  }

  const text = typeof args['text'] === 'string' ? args['text'].trim() : ''
  if (text === '') return []
  let best: { id: string; score: number } | null = null
  for (const entry of all) {
    const score = overlap(text, entry.text)
    // 必须真的像（0.3）才敢删
    if (score >= 0.3 && (best === null || score > best.score)) best = { id: entry.id, score }
  }
  return best === null ? [] : [best.id]
}

/**
 * 记忆的几件事全在这里：
 *
 * 1. **写入**：用户说了值得记的话 → 进短期记忆（还要过四道闸门，见 memory.ts）；
 * 2. **固化**：一轮结束 → 短期里"被反复取用 / 重要度高"的沉淀进**全局**库；
 * 3. **加固**：调了 `recall_memory` → 用查询重算命中并加固（被想起来的事更不容易掉）；
 * 4. **遗忘**：调了 `forget_memory` → 那次调用本身就在日志里，折叠时把它删掉（可重放、可审计）。
 *
 * 会话日记那一层**不在这条路上写**：它到点才写、一次一条（三个触发点见 `onStepEnd`、
 * `withSurfaceOp`、`finalize`），走 `appendSession`——只增不改。
 *
 * 第 3 条为什么用查询重算、而不是读工具结果：`tool/result` 事件里没有返回内容，
 * 而**查询词在 `tool/call` 的 arguments 里**。状态只能由日志派生，日志里有什么就用什么——
 * 好处是"同一份日志折两次得到同一份记忆"这条仍然成立。
 *
 * 整段包在 try 里：记忆坏了顶多是想不起来，绝不能让折叠这条链断掉。
 */
function withMemory(state: MindState, event: SessionEventLike, opts: FoldOptions): MindState {
  const t = opts.tunables
  try {
    if (event.type === 'user/message') {
      if (!isRealUserMessage(event.data)) return state
      // v2.3：用户话里出现"值得记"的东西时，**原话一个字都不入库**。这里只把「该总结了」
      // 点亮，让下一轮注入点名要它用自己的话写一条——写什么、怎么写是它的判断，抄不抄不是
      // 选项（用户原话："所有的记忆，都让 ai 自己整理生成，不要直接引用用户的原话"）。
      // 到点仍然没写，收尾那次兜底也只会用**它自己写过的**材料。
      const kinds = worthRemembering(extractText(event.data))
      if (kinds.length === 0) return state
      return {
        ...state,
        progress: {
          ...state.progress,
          // 已有的信号不被顶掉：先到点的那个理由更要紧（步数/压缩是"必总结"的账）
          ...(state.progress.summaryDue ? {} : { summaryDue: true, summaryReason: 'signal' as const }),
        },
        updatedAt: event.time,
      }
    }

    if (event.type === 'tool/call') {
      const data = asRecord(event.data)
      const name = data['name']
      // 它自己写下的那一条：用它的话进短期记忆。v2.3 起这是**唯一**会产生新条目的正常路径
      // （另一条是收尾按规则拼的 `digest` 兜底），用户的原话不再入库。
      if (name === INNER_NOTE_TOOL) {
        const remember = parseRemember(data['arguments'])
        if (remember === null) return state
        const sensitive = sensitiveReason(remember.text)
        // 它动笔了，就说明"到点了"这件事办完了 → 收掉提醒。
        // （`summaryDue` 是闩锁：只有 `consumeSummary` 和这里会清。投影那半边没有写入 API，
        //  适配层碰不到这个字段，所以清除必须发生在折叠里，才仍然"只由日志派生"。）
        const settled =
          state.progress.summaryDue || state.progress.summaryReason !== null
            ? { ...state.progress, summaryDue: false, summaryReason: null }
            : state.progress
        if (sensitive !== null) {
          opts.note?.(`[记忆] 它想记的一条没入库：像${sensitive}`)
          return { ...state, progress: settled, updatedAt: event.time }
        }
        const loc = locationOf(remember.kind, state.workspace, opts.sessionId)
        const memory = rememberAuto(
          state.memory,
          {
            kind: remember.kind,
            text: remember.text,
            importance: IMPORTANCE_BY_KIND[remember.kind],
            because: '它自己记下的',
            at: event.time,
            ...loc,
            origin: 'self',
            // 记下它是写在哪一步上的：会话结束时兜底拼日记要能追回这一步
            seq: event.seq,
          },
          t,
        )
        if (memory === state.memory) {
          // 同一引用 = 这一条没能进池（跟手边/日记里已有的几乎一样，被判成"说过一遍"）。
          // 如实说一句：否则"它明明记了、库里却没有"这种事又要靠人猜——上一轮就是栽在这。
          opts.note?.(`[记忆] 它想记的一条没能进池（与已有条目几乎重复）：${remember.text.slice(0, 30)}…`)
        }
        return { ...state, memory, progress: settled, updatedAt: event.time }
      }
      // 遗忘：模型明确说"忘掉它"，那一次调用就在日志里 → 折叠时删掉
      if (name === FORGET_TOOL_NAME) {
        const targets = forgetTargets(state.memory, data['arguments'])
        if (targets.length === 0) return state
        const after = forgetEntries(state.memory, targets, event.time)
        return after === state.memory ? state : { ...state, memory: after, updatedAt: event.time }
      }
      if (name !== RECALL_TOOL_NAME) return state
      const query = recallQuery(data['arguments'])
      if (query === '') return state
      // 与工具那一侧用**同一个工作区、同一个范围**重算命中：否则"模型看到的"和"被加固的"
      // 会是两套（跨工作区的条目降权后可能过不了阈值，那它就不该被这次取回加固）。
      // 注意 `scope: 'all'` 里"别的会话的日记"只有适配层手上有，折叠这条路上看不到——
      // 那几条不会被加固，但模型看到的结果是全的。
      const hits = recall(
        state.memory,
        query,
        event.time,
        t,
        state.workspace,
        recallScopeFromArgs(data['arguments']),
      )
      if (hits.length === 0) return state
      const memory = reinforce(state.memory, hits.map((hit) => hit.entry.id), event.time)
      return { ...state, memory, updatedAt: event.time }
    }

    if (event.type === 'turn/end') {
      // 回合收束只做一件事：把"被反复取用 / 重要度高"的短期条目**固化**进全局库。
      // （v2.3 起这里不再"结算听来的原句"——用户的原话根本不入库，见 `user/message` 分支。）
      const solidified = solidify(state.memory, event.time, t)
      return solidified === state.memory ? state : { ...state, memory: solidified, updatedAt: event.time }
    }
  } catch {
    // 想不起来是可以接受的失败；把折叠搞挂不是
  }
  return state
}

/** 让时间过去（适配器在会话开始/结束时调一次，保证"隔了一天回来情绪已归位"）。 */
export function tick(state: MindState, now: number, opts: FoldOptions): MindState {
  return tickOnly(state, now, opts.tunables)
}

// ─────────────────────────────────────────────────────────
// 触发点③：会话结束（只能规则兜底）
// ─────────────────────────────────────────────────────────

/**
 * 规则兜底的三问（DESIGN §22.4）：只用已有材料，按时间拼「这一段在做什么 /
 * 定下了什么 / 还没解决什么」。
 */
const DIGEST_BUCKETS: ReadonlyArray<{
  kind: MemoryEntry['kind']
  label: string
  from: ReadonlyArray<MemoryEntry['kind']>
}> = [
  { kind: 'fact', label: '这一段在做什么', from: ['fact'] },
  { kind: 'agreement', label: '定下了什么', from: ['agreement', 'preference'] },
  { kind: 'lesson', label: '还没解决什么', from: ['lesson'] },
]

/**
 * 把已有材料拼成会话日记（最多三条，一问一条）。
 *
 * 每条材料都带着它来自哪个事件（`seq`）——但 `seq` 是**机器坐标，不进正文**（v2.2）：
 * 早先拼出来的是"这一段在做什么：[seq 19771] …"，读起来像调试输出，不像日记。
 * 出处仍然保留在条目字段上（`appendSession` 的 `seq` 参数），要回日志随时能回。
 * 一条材料都没有就返回空数组——**什么都不写**，比编一句空话好（DESIGN §22.4）。
 */
function composeDigest(
  material: readonly MemoryEntry[],
): Array<{ kind: MemoryEntry['kind']; text: string; importance: number }> {
  const sorted = [...material].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.createdAt - b.createdAt)
  const out: Array<{ kind: MemoryEntry['kind']; text: string; importance: number }> = []
  for (const bucket of DIGEST_BUCKETS) {
    const items = sorted.filter((e) => bucket.from.includes(e.kind))
    if (items.length === 0) continue
    out.push({
      kind: bucket.kind,
      text: `${bucket.label}：${items.map((e) => e.text).join('；')}`,
      importance: Math.max(...items.map((e) => e.importance)),
    })
  }
  return out
}

/**
 * 触发点③：会话结束（适配层在 `agent/disposed` / `session/flush` 时调一次）。
 *
 * 此刻**没有后续模型回合**了，所以这条路只允许规则兜底：拿手边已有的材料拼一段会话日记，
 * 不调模型（core 本来也不调）；一条材料都没有就什么都不写，只把这件事说一声。
 *
 * 写进去的是会话层，走 `appendSession`——只 push、不改旧条目，重复调用也不会写重。
 *
 * 它同时也是触发点①②③的**规则兜底**入口：到点了（或压缩之后、或用户话里出现了值得记的
 * 东西）适配层喊模型用 `inner_note.remember` 补一次总结，模型没写，适配层就调这里补一段。
 * 所以来路要保留：`summaryReason` 已经有值（'steps' / 'compaction' / 'signal'）时不覆盖成
 * 'final'。
 *
 * @param seq 会话收束那个事件的 seq（可选）：没有就用最后一条材料的 seq 当出处。
 */
export function finalize(state: MindState, now: number, opts: FoldOptions, seq?: number): MindState {
  const t = opts.tunables
  let memory = state.memory

  // 材料 = **这一段自己长出来的**条目（`digested` 名单之外的那些，见 types.ts）。
  // 不能拿"手边这一池"当材料：短期池是按工作区从磁盘载入的，里面装着别的会话留下的陈年
  // 条目；拿它代笔就会写出"还没解决什么：[seq 433] 你这个包结构…"——那是几个月前的事，
  // 跟这一段毫无关系，却成了它的日记。适配层在载入短期池时把载入的那批标成已消化。
  const digested = new Set(memory.digested ?? [])
  const material = memory.short.filter((entry) => entry.scope !== 'session' && !digested.has(entry.id))
  if (material.length === 0) {
    // 如实说一声：适配层据此在本会话的 summary.md 里写"这一段没有值得留下的"
    opts.note?.('[记忆] 这一段没有值得留下的，会话日记没有新增')
  } else {
    const lastSeq = seq ?? material.reduce((max, e) => Math.max(max, e.seq ?? 0), 0)
    const where =
      opts.sessionId !== undefined && opts.sessionId !== ''
        ? { ws: null as string | null, sessionId: opts.sessionId, scope: 'session' as const }
        : { ws: null as string | null, scope: 'session' as const }
    for (const item of composeDigest(material)) {
      // 来源如实标 `digest`（v2.2）：这段是**规则拼的**，不是它说的。
      // 早先标成 `self`，面板与日记都把机器拼的句子当成它的口吻——信任就是从这里开始掉的。
      memory = appendSession(
        memory,
        { ...item, at: now, ...where, origin: 'digest', because: '收尾时按规则拼的', seq: lastSeq },
        t,
      )
    }
    // 记下"这些已经进过日记"：下一次兜底（到点总结没写成、压缩之后、或会话结束）不再拼一遍
    memory = {
      ...memory,
      digested: [...(memory.digested ?? []), ...material.map((entry) => entry.id)].slice(-200),
    }
  }

  const next: MindState = {
    ...state,
    memory,
    progress: { ...state.progress, summaryDue: true, summaryReason: state.progress.summaryReason ?? 'final' },
  }
  return tickOnly(next, now, t)
}

/**
 * 「该总结了」被消费掉了（适配层写完那一段点名注入、或自己算完一次总结之后调一次）。
 *
 * 为什么要有这一步：信号置上之后没人清，它就会一直亮着，每轮都催着总结。
 * 清这个动作只能由适配层发起（只有它知道总结到底做没做），core 只负责把它记下来。
 */
export function consumeSummary(state: MindState, now: number): MindState {
  if (!state.progress.summaryDue && state.progress.summaryReason === null) return state
  return {
    ...state,
    progress: { ...state.progress, summaryDue: false, summaryReason: null },
    updatedAt: now,
  }
}
