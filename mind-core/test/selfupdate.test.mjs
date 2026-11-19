/**
 * v1.2 自更新闭环的机制测试。
 *
 * 闭环 = 经历 → 情绪 → 心境 → **性情基线**（最慢，按天）→ 下一次会话的静息状态。
 *
 * 人设那一环（说话习惯 / 自我认知 / 内核）在 `persona.ts`，`core.test.mjs` 已覆盖；
 * 这里只钉情感那一环——因为它**最容易被写快**，而写快了就成了"一句话改性格"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_TUNABLES } from '../lib/config.js'
import { driftAmount, driftBaseline } from '../lib/affect.js'
import { DAY } from '../lib/dynamics.js'
import { emptyAffect, emptyState, emptyStats, normalizePersist, toPersist } from '../lib/state.js'

const T = DEFAULT_TUNABLES
const SEED = T.baseline

/** 一个"心境被抬得很高"的情感状态（updatedAt = 0，方便用 now 直接当时间差）。 */
const elevated = () => ({
  ...emptyAffect(T, 0),
  mood: { valence: 0.9, arousal: 0.9, dominance: 0.9 },
})

test('性情基线会朝心境漂，但一天只挪一点点', () => {
  const after = driftBaseline(elevated(), DAY, T, SEED)
  const moved = after.baseline.valence - SEED.valence
  assert.ok(moved > 0, '确实朝心境方向动了')
  assert.ok(moved < 0.05, `一天只能挪一点点（实际 ${moved.toFixed(4)}）`)
})

test('按天计的半衰期：30 天挪到一半左右', () => {
  // 刻意用**小到不会碰到上限**的心境（0.05 → 0.25，差 0.2 < 上限 0.25）：
  // 心境一极端，"有界"那道闸就会先把结果截住，半衰期本身就看不出来了。
  const mild = {
    ...emptyAffect(T, 0),
    mood: { valence: 0.25, arousal: T.baseline.arousal, dominance: T.baseline.dominance },
  }
  const after = driftBaseline(mild, 30 * DAY, T, SEED)
  const moved = after.baseline.valence - SEED.valence
  const total = 0.25 - SEED.valence
  const ratio = moved / total
  assert.ok(ratio > 0.4 && ratio < 0.6, `30 天约挪一半（实际 ${ratio.toFixed(2)}）`)
})

test('漂移有界：心境再极端、时间再久，也不会越过出厂基线 ± 上限', () => {
  const after = driftBaseline(elevated(), 365 * 200 * DAY, T, SEED)
  assert.ok(
    after.baseline.valence <= SEED.valence + T.baselineDriftLimit + 1e-9,
    '越过上限就是人格崩坏，不是成长',
  )
  assert.ok(after.baseline.valence > SEED.valence + T.baselineDriftLimit * 0.9, '时间足够久应该贴近上限')
  assert.ok(driftAmount(after, SEED) <= T.baselineDriftLimit + 1e-9)
  // arousal / dominance 是 0..1 的物理量，别漂出这个区间
  assert.ok(after.baseline.arousal >= 0 && after.baseline.arousal <= 1)
  assert.ok(after.baseline.dominance >= 0 && after.baseline.dominance <= 1)
})

test('没有时间流逝就不产生新对象（无关事件的原样返回纪律不能被这一层打破）', () => {
  const before = elevated()
  assert.equal(driftBaseline(before, 0, T, SEED), before)
})

test('性情基线跨会话带走：toPersist / normalizePersist 往返不丢，老档案回落到出厂基线', () => {
  const state = emptyState(T, 0)
  const drifted = driftBaseline(
    { ...state.affect, mood: { valence: 0.9, arousal: 0.6, dominance: 0.6 } },
    90 * DAY,
    T,
    SEED,
  )
  assert.ok(drifted.baseline.valence > SEED.valence, '前提：这次确实漂了')

  const persist = toPersist({ ...state, affect: drifted }, emptyStats(), 1)
  assert.deepEqual(persist.baseline, drifted.baseline)

  const back = normalizePersist(JSON.parse(JSON.stringify(persist)), 1, T)
  assert.deepEqual(back.baseline, drifted.baseline, '过一趟 JSON 也要原样回来')

  // 老档案（v1.1 写的、没有 baseline 键）→ 回到出厂基线，而不是 NaN
  assert.deepEqual(normalizePersist({ version: 1 }, 1, T).baseline, SEED)
})
