/**
 * 中立事件：adapter 与 core 之间**唯一**的输入形状。
 *
 * core 只认 `{ type, seq, time, data }`（见 `fold.ts` 的 `SessionEventLike`）。
 * 这里把"常用事件怎么造"固定下来的理由有两个：
 *
 * 1. **第二个 adapter 不必先读 core 的源码**就能把事件翻译对；
 * 2. 事件 `data` 的形状是**实测出来的**（`tool/call` 的 `arguments` 是字符串而不是对象；
 *    `assistant/message` 的文本藏在 `stream[].texts` 里）——这些坑不该让每个 adapter 各踩一遍。
 *
 * 这些形状与 DSH 适配层实际产生的一致，所以别的 adapter 折出来的状态与真机同源。
 */

import type { SessionEventLike } from './fold.js'

/** core 认的中立事件（取个好记的别名给 adapter 用）。 */
export type MindEvent = SessionEventLike

/** 一轮结束的原因：正常收束传 `'completed'`，被用户打断传对象（core 认这两种）。 */
export type TurnEndReason = string | { kind?: string; reason?: unknown }

/** 一个事件流：自己维护 `seq`，保证单调递增（core 靠它判断先后）。 */
export interface MindEventStream {
  userMessage(text: string, time: number, sourceKind?: string): MindEvent
  assistantMessage(text: string, time: number, tokens?: number): MindEvent
  toolCall(name: string, args: Record<string, unknown> | string, time: number, callId?: string): MindEvent
  toolResult(
    name: string,
    time: number,
    opts?: { callId?: string; error?: string; isError?: boolean },
  ): MindEvent
  turnStart(turn: number, time: number): MindEvent
  turnEnd(turn: number, time: number, reason?: TurnEndReason): MindEvent
}

/**
 * 造一个事件流。
 *
 * `sourceKind` 很关键：core 用 `source.kind` 判断"这是不是用户亲口说的"。
 * 传 `'user'`（默认）才算真用户消息；插件自己造的消息（比如主动开口的唤醒消息）
 * 传自己的 kind，于是**不会被当成用户说过的话记进记忆**。
 */
export function createEventStream(startSeq = 1): MindEventStream {
  let seq = startSeq
  const next = (type: string, time: number, data: unknown): MindEvent => ({ type, seq: seq++, time, data })
  return {
    userMessage: (text, time, sourceKind = 'user') =>
      next('user/message', time, { source: { kind: sourceKind }, text }),
    assistantMessage: (text, time, tokens = 0) =>
      next('assistant/message', time, {
        stream: [{ kind: 'text-chunks', texts: [text] }],
        usage: { totalTokens: tokens },
      }),
    toolCall: (name, args, time, callId) =>
      next('tool/call', time, {
        callId: callId ?? `${name}-${seq}`,
        name,
        // 真机这里就是字符串（core 会自己 JSON.parse），别传对象
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      }),
    toolResult: (name, time, opts) =>
      next('tool/result', time, {
        callId: opts?.callId,
        name,
        ...(opts?.error === undefined ? {} : { error: { name: opts.error } }),
        ...(opts?.isError === undefined ? {} : { message: { isError: opts.isError } }),
      }),
    turnStart: (turn, time) => next('turn/start', time, { turn }),
    turnEnd: (turn, time, reason = 'completed') => next('turn/end', time, { turn, reason }),
  }
}
