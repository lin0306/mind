/**
 * 主动开口的判断（dsh-mind-core 的 `proactiveDecision`）。
 *
 * 这个功能最容易变成骚扰，所以这份测试的重点不是"它会不会开口"，而是**它会不会不该开口时开口**：
 * 心里没事、情绪上没动静、刚说过话——三种情况都必须是"不"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_TUNABLES, applyEvent, deviation, emptyState, proactiveDecision } from '../lib/index.js'

const T = { ...DEFAULT_TUNABLES }
const MIN = 60_000
const fold = (state, event) => applyEvent(state, event, { tunables: T })

/** 一条带张力的 inner_note：心里搁着事。 */
const note = (tension, time) => ({
  type: 'tool/call',
  seq: 1,
  time,
  data: { callId: 'c-note', name: 'inner_note', arguments: JSON.stringify({ intent: '需求还没确认', tension }) },
})

/** 一次工具失败：真的被推了一下情绪。 */
const failure = (time) => ({ type: 'tool/result', seq: 1, time, data: { callId: 'c-fail', message: { isError: true } } })

test('起始状态必须是"完好"的：向量有值、离基线为 0（NaN 会让所有阈值闸门静默放行）', () => {
  const state = emptyState(T, 0)
  assert.equal(Number.isFinite(state.affect.current.valence), true, '起始向量的分量必须是数字')
  assert.equal(deviation(state.affect), 0, '起始状态离基线应该正好是 0')
})

test('心里没搁着事就不开口（不是"找不到话说"，是本来就不该说话）', () => {
  const decision = proactiveDecision(emptyState(T, 0), T, 10_000_000, 0)
  assert.equal(decision.speak, false)
  assert.match(decision.because, /心里没搁着事/)
})

test('只有张力、情绪上没动静，也不开口（平静时说"我想到一件事"是假的）', () => {
  const state = fold(emptyState(T, 0), note(0.9, 0))
  const decision = proactiveDecision(state, T, 10_000_000, 0)
  assert.equal(decision.speak, false)
  assert.match(decision.because, /太平静/)
})

test('心里搁着事 + 情绪真的在 + 没开过口 → 开口', () => {
  let state = emptyState(T, 0)
  state = fold(state, note(0.9, 0))
  state = fold(state, failure(1_000))
  state = fold(state, failure(2_000))
  const decision = proactiveDecision(state, T, 10_000_000, 0)
  assert.equal(decision.speak, true, `该开口时没开口：${decision.because}`)
  assert.match(decision.because, /还没开过口/)
})

test('冷却没到一律不开口（默认 45 分钟）', () => {
  let state = emptyState(T, 0)
  state = fold(state, note(0.9, 0))
  state = fold(state, failure(1_000))
  state = fold(state, failure(2_000))
  const now = 10_000_000

  const tooSoon = proactiveDecision(state, T, now, now - 10 * MIN)
  assert.equal(tooSoon.speak, false)
  assert.match(tooSoon.because, /冷却/)

  const justEnough = proactiveDecision(state, T, now, now - (T.proactiveCooldownMin + 1) * MIN)
  assert.equal(justEnough.speak, true, `冷却已过却没开口：${justEnough.because}`)
})

test('张力被消解之后，它自己就安静了（不需要谁去关开关）', () => {
  let state = emptyState(T, 0)
  state = fold(state, note(0.9, 0))
  state = fold(state, failure(1_000))
  state = fold(state, failure(2_000))
  assert.equal(proactiveDecision(state, T, 10_000_000, 0).speak, true)

  // 连续几个回合正常收束：张力被一次次消解下去
  for (let turn = 1; turn <= 8; turn += 1) {
    state = fold(state, { type: 'turn/end', seq: turn, time: 10_000 + turn * 1_000, data: { turn, reason: { kind: 'completed' } } })
  }
  const decision = proactiveDecision(state, T, 10_000_000, 0)
  assert.equal(decision.speak, false, `张力都消解了还在开口：${decision.because}`)
  assert.ok(state.thought.tension < T.proactiveTensionFloor, `张力应该被消解到门槛之下，实际 ${state.thought.tension}`)
})
