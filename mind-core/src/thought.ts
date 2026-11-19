/**
 * 思想层。
 *
 * 这里的取舍是整个项目最关键的一条：**思想不由第二个模型模拟**。
 *
 * 理由是三条硬的：
 * 1. 钱与延迟——每轮再跑一次模型，成本翻倍，而"像人"的收益并不随调用次数线性增长；
 * 2. 不可回放——同一份会话日志折两次会得到两套思想，这个项目的立身之本（状态可重放）就没了；
 * 3. 不可审计——你没法回答"它当时到底在想什么"，因为它每次都在重新想。
 *
 * 所以做法是：模型在**真的产生了值得留下的判断**时，调用 `inner_note` 工具写一条。
 * 那条工具调用本身就落在会话日志里，于是思想变成**日志的一部分**，可回放、可审计、可解释。
 * 没有值得写的就不写——大多数回合是空的，这正是"人不是每句话都在深想"。
 */

import type { MindTunables } from './config.js'
import { MIN, regress } from './dynamics.js'
import type { ThoughtState } from './types.js'

/** `inner_note` 工具的参数。字段全部可选：写得出哪条就写哪条。 */
export interface InnerNote {
  /** 我此刻在意的是什么。 */
  intent?: string
  /** 我打算怎么做（工作判断）。 */
  workingJudgment?: string
  /** 悬着的张力 0..1：有没解决的矛盾就 >0。 */
  tension?: number
  /** 我这样想对不对（元认知自查）。 */
  metaCheck?: string
  /** 我想多看一眼的地方。 */
  curiosity?: string
}

/** 截断一条自我陈述，防止把提示词撑爆。 */
function clip(text: string | undefined, max: number): string | null {
  if (typeof text !== 'string') return null
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** 写一条思想。 */
export function applyNote(
  thought: ThoughtState,
  note: InnerNote,
  at: number,
  t: MindTunables,
): ThoughtState {
  const tension = typeof note.tension === 'number' && Number.isFinite(note.tension)
    ? Math.min(Math.max(note.tension, 0), 1)
    : thought.tension

  return {
    tension,
    intent: clip(note.intent, 60) ?? thought.intent,
    judgment: clip(note.workingJudgment, t.noteMaxChars) ?? thought.judgment,
    metaCheck: clip(note.metaCheck, t.noteMaxChars) ?? thought.metaCheck,
    curiosity: clip(note.curiosity, t.noteMaxChars) ?? thought.curiosity,
    noteCount: thought.noteCount + 1,
    openLoops: tension > 0.05 ? thought.openLoops + 1 : thought.openLoops,
    updatedAt: at,
  }
}

/** 一次有效的行动会消解一部分张力。 */
export function relieve(
  thought: ThoughtState,
  amount: number,
  at: number,
): ThoughtState {
  if (thought.tension <= 0) return thought
  const tension = Math.max(thought.tension - amount, 0)
  return {
    ...thought,
    tension,
    openLoops: tension <= 0.05 ? 0 : thought.openLoops,
    updatedAt: at,
  }
}

/** 没人管的张力自己会淡（默认半衰期 4 小时）。 */
export function tickTension(thought: ThoughtState, now: number, t: MindTunables): ThoughtState {
  const dt = now - thought.updatedAt
  if (dt <= 0) return thought
  const next = regress(thought.tension, 0, dt, t.tensionHalfLifeMin * MIN)
  if (Math.abs(next - thought.tension) < 1e-4) return thought
  return { ...thought, tension: next, updatedAt: now }
}

/** 新回合开始：清掉回合内的计数（思想本身留着）。 */
export function beginTurn(thought: ThoughtState): ThoughtState {
  return thought
}

/** 这条思想值不值得进提示词。 */
export function hasSomething(thought: ThoughtState): boolean {
  return Boolean(thought.judgment || thought.intent || thought.tension > 0.1 || thought.curiosity)
}

/** 给面板/命令看的几行中文。 */
export function describeThought(thought: ThoughtState): string[] {
  const lines: string[] = []
  if (thought.intent) lines.push(`在意：${thought.intent}`)
  if (thought.judgment) lines.push(`判断：${thought.judgment}`)
  if (thought.tension > 0.05) lines.push(`悬着：${thought.tension.toFixed(2)}（没解决的矛盾）`)
  if (thought.metaCheck) lines.push(`自查：${thought.metaCheck}`)
  if (thought.curiosity) lines.push(`好奇：${thought.curiosity}`)
  if (lines.length === 0) lines.push('（没有留下思想——大多数回合本来就没有）')
  return lines
}
