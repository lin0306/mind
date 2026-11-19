/**
 * 情感层的强度上限。
 *
 * 这组断言来自一次真机观察：连续三次工具失败就把效价打到 **-1.000（下限）**。
 * 根因不是"情绪太灵敏"，而是一个 tool_error 同时点起挫败+烦躁+内疚、各自独立叠加，
 * 等于一次失败被三件事同时打击。修法是给**一次事件**的总强度封顶。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TUNABLES, evolveAffect, emptyAffect } from '../lib/index.js'

const T = DEFAULT_TUNABLES
const MINUTE = 60_000

/** 造一个信号（形状与 appraise.ts 产出的一致）。 */
function signal(kind, at, weight = 0.25) {
  return { kind, at, weight, because: '测试' }
}

/** 从静息状态开始，按时间顺序施加一批信号。 */
function after(signals) {
  const start = emptyAffect(T, 0)
  const now = signals.length > 0 ? signals[signals.length - 1].at : 0
  return evolveAffect(start, signals, now, T)
}

test('一次事件的总强度封顶：一个 tool_error 不会等于三倍打击', () => {
  const outcome = after([signal('tool_error', 0)])
  const moved = Math.abs(outcome.affect.current.valence - T.baseline.valence)
  assert.ok(
    moved <= T.eventMaxStrength + 1e-9,
    `一次事件的位移必须 ≤ eventMaxStrength=${T.eventMaxStrength}，实际 ${moved}`,
  )
})

test('多种情绪仍然并存，但主要情绪明显重于次要情绪', () => {
  const outcome = after([signal('tool_error', 0)])
  const words = outcome.affect.emotions.map((trace) => trace.word)
  assert.ok(words.length >= 2, `应该并存多种情绪，实际只有 ${words.join('、')}`)
  const strengths = outcome.affect.emotions.map((trace) => trace.strength)
  const primary = Math.max(...strengths)
  const secondary = Math.min(...strengths)
  assert.ok(primary > secondary, '主要情绪要重于次要情绪（形状不能被封顶破坏）')
})

test('连续三次失败会累积，但不该打到底（-1.0 是"崩了"，不是"挫败"）', () => {
  const outcome = after([
    signal('tool_error', 0),
    signal('tool_error', MINUTE),
    signal('tool_error', 2 * MINUTE),
  ])
  const valence = outcome.affect.current.valence
  assert.ok(valence < T.baseline.valence - 0.2, `三次失败应该明显下沉，实际 ${valence}`)
  assert.ok(valence > -0.95, `三次失败不该打到底，实际 ${valence}`)
})

test('正向事件同样受上限约束（封顶不是只压负面）', () => {
  const outcome = after([signal('goal_progress', 0)])
  const moved = outcome.affect.current.valence - T.baseline.valence
  assert.ok(moved <= T.eventMaxStrength + 1e-9, `正向位移也要封顶，实际 ${moved}`)
})
