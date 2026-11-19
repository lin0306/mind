/**
 * 说话习惯四轴（v2.4.x）。
 *
 * 这一组测的是"**每根轴都有双向的驱动源**"：原来只有两条单向的
 * （被谢 → 温度 +1、被驳回 → 直给 +1），于是那两根只会一路爬到硬上限、
 * 再也下不来（真机证据：`directness` 卡在 0.50+0.20）。单向 = 一根只会涨的仪表。
 *
 * 这组测试在"驱动到底有没有"这件事上已经骗过我一次（我只 grep 了 fold.ts，
 * 没看见 persona.ts 里的驱动，差点去重复加一份），所以这里每根轴都直接断言数值。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { DEFAULT_TUNABLES, emptyPersona, noteInteraction, driftVoice } = await import('../lib/index.js')

/** 走一步 noteInteraction，返回**新的 persona**（不是 voice——第一版这里就写错了）。 */
const run = (persona, ev, at) => noteInteraction(persona, ev, at, DEFAULT_TUNABLES)

/**
 * 近似比较：这些值是 0.01 一步步加出来的，`0.51 - 0.01` 在 double 里是
 * `0.5000000000000001`——断言"回到 0.5"必须给容差，否则测的是浮点表示而不是逻辑。
 */
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}（实际 ${actual}，期望 ${expected}）`)

test('温度：被谢会暖，被驳回/被打断会冷（双向）', () => {
  const base = emptyPersona(1_000)
  const warmer = run(base, { thanks: true }, 2_000)
  near(warmer.voice.warmth, 0.51, '被谢 → 温度 +0.01')

  const colder = run(warmer, { pushback: true }, 3_000)
  near(colder.voice.warmth, 0.5, '被驳回 → 温度回落（单向的话它会永远停在 0.51）')

  const colder2 = run(base, { interrupt: true }, 4_000)
  near(colder2.voice.warmth, 0.49, '被打断 → 温度也降')
})

test('直给：被驳回更直接，同一件事被重复说则要铺垫（双向）', () => {
  const base = emptyPersona(1_000)
  const up = run(base, { pushback: true }, 2_000)
  near(up.voice.directness, 0.51, '被驳回 → 少绕弯')

  const down = run(up, { repeat: true }, 3_000)
  near(down.voice.directness, 0.5, '被重复说 → 上一遍没讲清，回头看铺垫')
})

test('主动（新增的第四轴）：被追问多给一层，被打断就收着', () => {
  const base = emptyPersona(1_000)
  near(base.voice.initiative, 0.5, '出厂 0.5：不多也不少给')

  const more = run(base, { question: true }, 2_000)
  near(more.voice.initiative, 0.51, '被追问 → 多给一层')

  const less = run(more, { interrupt: true }, 3_000)
  near(less.voice.initiative, 0.5, '被打断 → 收着点')
})

test('一次输入同时推两根轴：驳回会同时"更冷、更直接"', () => {
  const base = emptyPersona(1_000)
  const after = run(base, { pushback: true }, 2_000)
  near(after.voice.warmth, 0.49)
  near(after.voice.directness, 0.51)
})

test('漂移有硬上限：不会越过 0.5±drift', () => {
  let persona = emptyPersona(1_000)
  for (let i = 0; i < 200; i += 1) persona = run(persona, { question: true }, 2_000 + i)
  const cap = 0.5 + DEFAULT_TUNABLES.voiceDrift
  assert.ok(persona.voice.initiative <= cap + 1e-9, `主动不该超过 ${cap}（实际 ${persona.voice.initiative}）`)
})

test('driftVoice 认识四根轴，且 delta 全为 0 时原样返回（不动引用）', () => {
  const base = emptyPersona(1_000)
  const same = driftVoice(base, {}, 2_000, DEFAULT_TUNABLES)
  assert.equal(same, base, '没有变化时必须返回同一个对象（引用纪律）')

  const moved = driftVoice(base, { initiative: -1 }, 2_000, DEFAULT_TUNABLES)
  near(moved.voice.initiative, 0.49)
  near(moved.voice.brevity, 0.5, '别的轴不受影响')
})
