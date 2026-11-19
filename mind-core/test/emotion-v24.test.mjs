/**
 * 情绪饱和的根治（v2.4）。
 *
 * 病：**同一种情绪反复出现会顶到 1.00**。两处都是线性累加——
 *   ① 三维分量：`v + toward × k`，几次就顶到边界，之后再推没有任何区别；
 *   ② 具名情绪：`strength + strength`，而且只加不退（历史强度要等"读"的时候才按 `trace.at`
 *      衰减一次），于是隔了两小时的两句气话会像挨在一起一样叠起来。
 *
 * 药（用户定的口径：「单次推动改成 强度 × (1 − 当前值)」）：
 *   ① `push` 按方向还剩多少余地打折扣（双向的效价对称推广：朝正 `1−v`、朝负 `1+v`，封顶 1）；
 *   ② 具名情绪先衰减到此刻、再按 `(1 − 当前值)` 加——**渐近逼近 1，永不贴死**，
 *      而且"间隔"真的降强度。
 *
 * 这一份盯的就是这两条，别再退回线性。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HOUR, MIN, DEFAULT_TUNABLES as T, emptyState, evolveAffect } from '../lib/index.js'

const fresh = (now = 0) => emptyState(T, now)
/** 一次工具失败 → 主要情绪是挫败（强度给满，方便看饱和）。 */
const blow = (at) => ({ kind: 'tool_error', weight: 1, because: '又失败了', at })
const frustration = (affect) => affect.emotions.find((e) => e.word === '挫败')

test('同一种情绪反复出现：渐近逼近 1、永不等于 1，而且边际收益递减', () => {
  let affect = fresh().affect
  const strengths = []
  for (let k = 0; k < 20; k += 1) {
    affect = evolveAffect(affect, [blow(0)], 0, T).affect
    const trace = frustration(affect)
    assert.ok(trace, '第 ' + (k + 1) + ' 次之后情绪还在（不该被清理掉）')
    strengths.push(trace.strength)
  }

  for (const [i, s] of strengths.entries()) {
    assert.ok(s > 0 && s < 1, `第 ${i + 1} 次强度必须落在 (0,1)：实际 ${s}`)
  }
  for (let i = 1; i < strengths.length; i += 1) {
    assert.ok(strengths[i] > strengths[i - 1], `强度要一直涨：第 ${i + 1} 次 ${strengths[i]} 应 > ${strengths[i - 1]}`)
  }
  // 饱和根治的证据：**每一次的增量都比上一次小**（线性累加的增量是恒定的）
  const deltas = strengths.map((s, i) => (i === 0 ? s : s - strengths[i - 1]))
  for (let i = 1; i < deltas.length; i += 1) {
    assert.ok(
      deltas[i] < deltas[i - 1],
      `第 ${i + 1} 次的增量应当更小（边际收益递减）：${deltas[i]} 应 < ${deltas[i - 1]}`,
    )
  }
  // 二十次之后已经很接近顶，但**没有贴死**——再推一次还能涨
  assert.ok(strengths.at(-1) > 0.9, `推了 20 次应当很接近上界，实际 ${strengths.at(-1)}`)
  const after = evolveAffect(affect, [blow(0)], 0, T).affect
  assert.ok(frustration(after).strength > strengths.at(-1), '贴死后就再也推不动了——那正是以前的样子')
})

test('同一种情绪：隔得久的两次，累计强度必须比紧挨着的两次低（先退到此刻再加）', () => {
  const close = evolveAffect(fresh().affect, [blow(0), blow(60_000)], 60_000, T).affect
  const far = evolveAffect(fresh().affect, [blow(0), blow(6 * HOUR)], 6 * HOUR, T).affect

  const a = frustration(close).strength
  const b = frustration(far).strength
  assert.ok(a > b, `紧挨着（${a}）应当高于隔六小时（${b}）——老写法对间隔完全无感，那是病`)
})

test('三维分量同理：连续猛推只渐近逼近边界，不会贴死在 ±1 / 1.00 上', () => {
  const many = evolveAffect(fresh().affect, Array.from({ length: 40 }, () => blow(0)), 0, T).affect
  const v = many.current.valence
  const arousal = many.current.arousal
  assert.ok(v < 0 && v > -1, `效价应当逼近下界但不到下界：实际 ${v}`)
  assert.ok(arousal < 1 && arousal > 0.9, `唤醒应当逼近上界但不到上界：实际 ${arousal}`)
  // 三维分量也有"边际收益递减"：连续五次的效价位移逐个变小（线性累加时每次一样大）
  let acc = fresh().affect
  const moves = []
  for (let k = 0; k < 5; k += 1) {
    const before = acc.current.valence
    acc = evolveAffect(acc, [blow(0)], 0, T).affect
    moves.push(before - acc.current.valence)
  }
  for (const [i, move] of moves.entries()) {
    assert.ok(move > 0, `每一次都该往下推：第 ${i + 1} 次位移 ${move}`)
  }
  for (let i = 1; i < moves.length; i += 1) {
    assert.ok(moves[i] < moves[i - 1], `第 ${i + 1} 次的效价位移应当更小：${moves[i]} 应 < ${moves[i - 1]}`)
  }
  assert.ok(T.halfLifeMin > 0 && MIN > 0, '单位约定：内核里的时间一律是毫秒')
})
