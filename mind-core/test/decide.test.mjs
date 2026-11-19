/**
 * 决策通道的内核一半：`decisionSignal`。
 *
 * 这些断言测的是**方向与边界**（收紧还是放开、要不要多推一步、会不会出界），
 * 不是"数值好不好看"——数值好不好看只能在真机上看着模型表现调。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TUNABLES, decisionSignal, emptyAffect, emptyThought } from '../lib/index.js'

const T = DEFAULT_TUNABLES

/** 造一个"此刻"的情感状态（直接写字面量，不依赖 push 的签名）。 */
function affectWith(valence, arousal, dominance = 0.5) {
  return { ...emptyAffect(T, 0), current: { valence, arousal, dominance } }
}

/** 造一个思想状态。 */
function thoughtWith(tension, metaCheck = null) {
  return { ...emptyThought(0), tension, metaCheck }
}

test('平静时不给任何倾向：openness≈0，也不要求多推一步', () => {
  const signal = decisionSignal(emptyAffect(T, 0), emptyThought(0), T)
  assert.equal(signal.openness, 0)
  assert.equal(signal.needMoreThought, false)
  assert.equal(signal.active, false, '什么都不想做时 active 必须是 false（调用方据此完全不碰参数）')
  assert.match(signal.because, /不干预/)
})

test('负效价 + 高唤醒 → 收紧（这一轮收着点）', () => {
  const signal = decisionSignal(affectWith(-0.5, 0.8), emptyThought(0), T)
  assert.ok(signal.openness < 0, `要收紧，实际 openness=${signal.openness}`)
  assert.match(signal.because, /收着点/)
})

test('正效价 + 高唤醒 → 放开（敢多试一条路）', () => {
  const signal = decisionSignal(affectWith(0.6, 0.8), emptyThought(0), T)
  assert.ok(signal.openness > 0, `要放开，实际 openness=${signal.openness}`)
  assert.match(signal.because, /放开/)
})

test('唤醒越高，同样的偏移放大得越明显（平静时情绪不该左右决策）', () => {
  const calm = decisionSignal(affectWith(0.6, 0.05), emptyThought(0), T)
  const wired = decisionSignal(affectWith(0.6, 0.95), emptyThought(0), T)
  assert.ok(wired.openness > calm.openness)
})

test('有没解决的矛盾 → needMoreThought；张力淡了就不要求了', () => {
  assert.equal(decisionSignal(emptyAffect(T, 0), thoughtWith(0.8), T).needMoreThought, true)
  assert.equal(decisionSignal(emptyAffect(T, 0), thoughtWith(0.05), T).needMoreThought, false)
})

test('自查没过也算"多推一步"的理由，且写进原因里', () => {
  const signal = decisionSignal(emptyAffect(T, 0), thoughtWith(0.1, '我在凑合'), T)
  assert.equal(signal.needMoreThought, true)
  assert.match(signal.because, /自查没过/)
})

test('怎么算都出不去 ±1（有界是硬要求）', () => {
  for (const valence of [-1, 1]) {
    const signal = decisionSignal(affectWith(valence, 1), thoughtWith(1), T)
    assert.ok(signal.openness >= -1 && signal.openness <= 1, `openness 出界：${signal.openness}`)
    assert.ok(signal.urgency >= 0 && signal.urgency <= 1, `urgency 出界：${signal.urgency}`)
  }
})

test('decisionGain=0 → 情绪完全不参与决策（开关的意义）', () => {
  const off = { ...T, decisionGain: 0 }
  const signal = decisionSignal(affectWith(-0.9, 0.95), emptyThought(0), off)
  assert.equal(signal.openness, 0)
  assert.equal(signal.active, false)
})
