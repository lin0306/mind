/**
 * 「该总结了」这枚闩锁的生命周期（触发点①②③ 与两条清除规则）。
 *
 * 为什么单独测：`summaryDue` 一挂上就会进每一轮的注入。**没写好清除，它会变成永久噪音**；
 * 而清除又必须发生在折叠里（投影那半边没有写入 API，适配层碰不到这个字段），
 * 所以这两条规则得钉死在 core 的测试里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_TUNABLES as T, applyEvent, normalizeState, withDefaults } from '../lib/index.js'

const HERE = 'E:/code/thought'
const fold = (state, event, tunables = T) => applyEvent(state, event, { tunables, sessionId: 's-1' })
const fresh = (tunables = T) => normalizeState({ workspace: HERE }, tunables, 0)
const stepEnd = (seq, time) => ({ type: 'step/end', seq, time, data: {} })
const turnEnd = (turn, seq, time) => ({ type: 'turn/end', seq, time, data: { turn, reason: 'completed' } })
const note = (args, seq, time) => ({
  type: 'tool/call',
  seq,
  time,
  data: { name: 'inner_note', callId: `c-${seq}`, arguments: JSON.stringify(args) },
})

test('按步到点：到了就置「该总结了」，并把步数归零重算', () => {
  const t = withDefaults({ memorySummarySteps: 3 })
  let state = fresh(t)

  for (let i = 1; i <= 2; i += 1) state = fold(state, stepEnd(i, 100 + i), t)
  assert.equal(state.progress.summaryDue, false, '还差一步，不该提醒')
  assert.equal(state.progress.steps, 2)

  state = fold(state, stepEnd(3, 200), t)
  assert.equal(state.progress.summaryDue, true)
  assert.equal(state.progress.summaryReason, 'steps')
  assert.equal(state.progress.steps, 0, '到点即归零：下一个阈值从这一步重新数')
})

test('上下文压缩：置「该总结了」并归零，但不覆盖已经亮着的来路', () => {
  const t = withDefaults({ memorySummarySteps: 99 })
  const event = (seq, time) => ({
    type: 'step/end',
    seq,
    time,
    data: {},
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
  })

  let state = fold(fresh(t), stepEnd(1, 100), t)
  assert.equal(state.progress.steps, 1)
  state = fold(state, event(2, 200), t)
  assert.equal(state.progress.summaryDue, true)
  assert.equal(state.progress.summaryReason, 'compaction')
  assert.equal(state.progress.steps, 0, '压缩把旧账抹了：步数归零（REQUIREMENTS §9 的裁决）')

  // 先因为"步到点"亮着，又来一次压缩：理由保持 'steps'，不改成 'compaction'
  const quick = withDefaults({ memorySummarySteps: 1 })
  let other = fold(fresh(quick), stepEnd(1, 100), quick)
  assert.equal(other.progress.summaryReason, 'steps')
  other = fold(other, { ...event(2, 200) }, quick)
  assert.equal(other.progress.summaryReason, 'steps', '先说出口的来路说了算')
})

test('闩锁的两条清除规则：它写了 remember 就算办完；这一轮没写，回合收束时收掉', () => {
  const t = withDefaults({ memorySummarySteps: 2 })
  const due = () => {
    let state = fresh(t)
    state = fold(state, stepEnd(1, 100), t)
    state = fold(state, stepEnd(2, 200), t)
    assert.equal(state.progress.summaryDue, true, '前置条件：这一拍确实到点了')
    return state
  }

  // ① 写了 remember → 当场清掉（它动笔了，提醒的使命就完成了）
  let wrote = fold(due(), note({ remember: '定下了：先跑探针再写断言', rememberKind: 'lesson' }, 3, 300), t)
  assert.equal(wrote.progress.summaryDue, false)
  assert.equal(wrote.progress.summaryReason, null)
  assert.equal(wrote.memory.short.length, 1, '它自己写的那条进了短期')
  assert.equal(wrote.memory.short[0].origin, 'self')

  // 只写了思想、没写记忆：不算办完，提醒还在
  let thoughtOnly = fold(
    due(),
    note({ workingJudgment: '这一段在改记忆三层，先把它写完' }, 3, 300),
    t,
  )
  assert.equal(thoughtOnly.progress.summaryDue, true, '没写记忆就不算办完')

  // ② 这一轮没写 → 回合收束时收掉（提醒只提醒一轮，下个阈值/下次压缩再提）
  let unwritten = fold(due(), turnEnd(1, 3, 300), t)
  assert.equal(unwritten.progress.summaryDue, false)
  assert.equal(unwritten.progress.summaryReason, null)
})
