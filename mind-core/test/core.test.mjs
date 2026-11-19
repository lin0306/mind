/**
 * 内核测试。
 *
 * 一律 `node --test`，**零依赖**——这个包不该为了跑测试而拖进任何东西。
 * 测的是"机制"而不是"数值好看"：半衰期对不对、无关事件是否原样返回、
 * 证据不够时会不会乱提升、时间顺序会不会算错。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_TUNABLES,
  DAY,
  MIN,
  applyEvent,
  applyNote,
  appraiseUserText,
  describeEmotions,
  emptyState,
  evolveAffect,
  isDuplicate,
  makeEntry,
  normalizeState,
  recall,
  regress,
  renderRealtimeSection,
  rememberShort,
  settledTraits,
  settleKernel,
  withDefaults,
} from '../lib/index.js'

const T = DEFAULT_TUNABLES
/** 造一个干净的会话状态。 */
const fresh = (now = 0) => emptyState(T, now)

/** 折叠一个事件。 */
const fold = (state, event) => applyEvent(state, event, { tunables: T })

// ── 动力学 ──────────────────────────────────────────────

test('半衰期：一个半衰期后恰好剩一半（时间一律毫秒）', () => {
  const hl = 90 * MIN
  assert.equal(regress(1, 0, 0, hl), 1)
  assert.equal(regress(1, 0, hl, hl), 0.5)
  assert.equal(regress(1, 0, 2 * hl, hl), 0.25)
  // 一半的时间 -> 剩下 sqrt(0.5)
  assert.ok(Math.abs(regress(1, 0, hl / 2, hl) - Math.SQRT1_2) < 1e-9)
})

test('单位不能错：90 分钟后脉冲只剩一半，而不是瞬间归位', () => {
  const state = fresh(0)
  const base = state.affect.baseline.valence
  const sig = { kind: 'user_thanks', weight: 1, because: '谢谢', at: 0 }

  const v0 = evolveAffect(state.affect, [sig], 0, T).affect.current.valence
  const later = evolveAffect(state.affect, [sig], T.halfLifeMin * MIN, T).affect.current.valence

  assert.ok(v0 - base > 0.1, `道谢应该抬高效价，实际 ${v0}`)
  assert.ok(
    Math.abs(later - base - (v0 - base) / 2) < 1e-9,
    `一个半衰期后应剩一半：起始 ${v0}，一小时半后 ${later}（若为基线值说明单位传错了）`,
  )
})

test('每个信号各自按自己的时刻衰减（时间顺序必须参与计算）', () => {
  const state = fresh(0)
  const half = T.halfLifeMin * 60_000
  // 权重取小一点，免得撞上 ±1 的夹取，把要测的东西掩盖掉
  const sig = (at) => ({ kind: 'goal_progress', weight: 0.25, because: '推进', at })
  const base = state.affect.baseline.valence
  const widen = (r) => evolveAffect(state.affect, r, half, T).affect.current.valence - base

  // A：一下在 t=0，一下在 t=half      B：两下都在 t=0
  const a = widen([sig(0), sig(half)])
  const b = widen([sig(0), sig(0)])

  // v2.4：单次推动仍然**精确**按自己的时刻衰减——同一颗信号放在 t=half 不衰减、
  // 放在 t=0 要衰减半个周期，**恰好 2:1**。饱和阻尼只看"起点还剩多少余地"，
  // 两次的起点一样（都从 `state.affect` 出发），所以这里不受它影响：这是"时间顺序参与计算"的精确守卫。
  const oneEarly = widen([sig(0)])
  const oneLate = widen([sig(half)])
  assert.ok(Math.abs(oneLate - 2 * oneEarly) < 1e-9, `期望 2:1，实际 ${oneLate / oneEarly}`)

  assert.ok(b > 0, '推进应该把效价抬起来')
  // A：一下在 t=0、一下在 t=half；B：两下都在 t=0。
  // 分散开的（A）比挤在一起的（B）高——后来那一下赶上"余地更大"的时候。
  // 但**不再是精确的 1.5 倍**：v2.4 起边际收益递减（饱和阻尼），挤在一起时第二下打的折扣更重，
  // 所以 a/b 会偏离 1.5（旧实现是恒等于 1.5——那不是特性，是线性累加）。
  assert.ok(a > b, `同强度下分散开的应当更高：A=${a} 应 > B=${b}`)
  assert.ok(Math.abs(a - 1.5 * b) > 1e-6, 'v2.4 起不再是线性叠加（这正是情绪饱和根治的证据）')

  // 同一时刻猛推：**渐近逼近**上界，而不是撞在 1.0 上被夹住（老实现是后者）
  const many = evolveAffect(state.affect, Array.from({ length: 40 }, () => sig(0)), 0, T).affect.current.valence
  assert.ok(many < 1 && many > 0.9, `应当渐近逼近 1 而不是贴死在 1.0，实际 ${many}`)

  // 一个信号能点亮多种情绪（主要 + 次要），而不是只挑起一种
  const outcome = evolveAffect(state.affect, [{ kind: 'tool_error', weight: 0.5, because: 'x', at: 0 }], 0, T)
  const words = outcome.pulses.map((p) => p.word)
  assert.ok(words.length >= 2, `一个信号应牵动多种情绪，实际 ${words.join('/')}`)
  assert.ok(words.includes('挫败'), `主要情绪应是挫败，实际 ${words.join('/')}`)
})

// ── 折叠纪律 ────────────────────────────────────────────

test('无关事件原样返回同一个引用（高频事件不该触发下游工作）', () => {
  const state = fresh(1000)
  // `step/end` 从 v2.0 起**不在这张名单里**：它是步计数的唯一来源（见下一条），
  // 每走一步都要改状态。别的高频事件照旧原样返回，缓存纪律不变。
  for (const type of ['request/header', 'request/context', 'step/start', 'assistant/stream']) {
    assert.equal(fold(state, { type, seq: 1, time: 2000, data: {} }), state, `${type} 不该改变状态`)
  }
})

test('step/end 就是步计数的唯一来源（v2.0 新语义，计数单位是步不是轮）', () => {
  const state = fresh(1000)
  const next = fold(state, { type: 'step/end', seq: 1, time: 2000, data: {} })
  assert.notEqual(next, state, '既然要数步，就不能再原样返回同一个引用')
  assert.equal(next.progress.steps, 1, '每走一步加一')
  assert.equal(state.progress.steps, 0, '纯函数：原状态不动')
})

test('用户道谢 -> 感激/认可，且语气温度往上挪一点点', () => {
  const state = fresh(0)
  const next = fold(state, { type: 'user/message', seq: 1, time: 1000, data: { text: '谢谢，这个不错' } })
  const words = next.affect.emotions.map((e) => e.word)
  assert.ok(words.includes('感激'), `期望有感激，实际 ${words.join('/')}`)
  assert.ok(next.persona.relation.thanks === 1)
  assert.ok(next.persona.voice.warmth > 0.5)
})

test('工具连续失败 -> 烦躁/挫败，且重试能被识别出来', () => {
  let state = fresh(0)
  state = fold(state, { type: 'tool/result', seq: 1, time: 1000, data: { name: 'read', error: { name: 'ENOENT' } } })
  assert.equal(state.progress.consecutiveErrors, 1)
  const firstPulses = state.pulses.map((p) => p.kind)
  assert.ok(firstPulses.includes('tool_error'))
  assert.ok(!firstPulses.includes('tool_retry'), '第一次失败不算重试')

  state = fold(state, { type: 'tool/result', seq: 2, time: 2000, data: { name: 'read', error: { name: 'ENOENT' } } })
  assert.equal(state.progress.consecutiveErrors, 2)
  assert.ok(state.pulses.map((p) => p.kind).includes('tool_retry'), '同名再次失败应识别为重试')

  // 第三次成功 -> 自己修好了
  state = fold(state, { type: 'tool/result', seq: 3, time: 3000, data: { name: 'read', message: {} } })
  assert.equal(state.progress.consecutiveErrors, 0)
  // 注意：脉冲是按"每个信号 × 它牵动的每个情绪"记的，所以同一个信号可能有多条脉冲
  assert.ok(state.pulses.some((p) => p.kind === 'tool_recovered'), '修好之后应当能识别出来')
})

test('用户打断 -> 委屈；长消息 -> 疲惫', () => {
  let state = fresh(0)
  state = fold(state, { type: 'turn/end', seq: 1, time: 1000, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.ok(state.affect.emotions.some((e) => e.word === '委屈'))

  const long = fold(fresh(0), { type: 'user/message', seq: 2, time: 2000, data: { text: '啊'.repeat(1200) } })
  assert.ok(long.pulses.some((p) => p.kind === 'token_heavy'))
})

// ── 思想 ────────────────────────────────────────────────

test('inner_note 写回：判断留下、张力记上，且截断超长文本', () => {
  const note = {
    intent: '把注入量压下去',
    workingJudgment: '不'.repeat(200),
    tension: 0.6,
    metaCheck: '其实我还没验证缓存是真的没坏',
  }
  const thought = applyNote(fresh(0).thought, note, 1000, T)
  assert.equal(thought.tension, 0.6)
  assert.equal(thought.noteCount, 1)
  assert.ok(thought.judgment.length <= T.noteMaxChars + 1, '判断必须被截断')
  assert.equal(thought.metaCheck, note.metaCheck, '没超长的不该动')
  assert.equal(thought.openLoops, 1)
})

test('工具调用能被折成思想，且参数是 JSON 字符串也能解析', () => {
  const args = JSON.stringify({ intent: '查缓存', tension: 0.4 })
  const state = fold(fresh(0), { type: 'tool/call', seq: 1, time: 500, data: { name: 'inner_note', arguments: args, turn: 1, step: 1, callId: 'c1' } })
  assert.equal(state.thought.intent, '查缓存')
  assert.equal(state.thought.tension, 0.4)
  assert.equal(state.progress.notesThisTurn, 1)
})

// ── 人设三档速度 ────────────────────────────────────────

test('自我认知要证据：说一次不算，跨天说三次才算', () => {
  const text = '先确认再动手，别一次改多处'
  let state = fresh(0)
  /** 在某一刻说一次同样的自我判断。 */
  const say = (at) => {
    state = fold(state, {
      type: 'tool/call',
      seq: Math.round(at),
      time: at,
      data: { name: 'inner_note', arguments: JSON.stringify({ workingJudgment: text }), turn: 1, step: 1, callId: `c${at}` },
    })
    return state.persona
  }

  const once = say(1000)
  assert.equal(once.traits.length, 1)
  assert.equal(once.traits[0].hits, 1)
  assert.equal(settledTraits(once, T).length, 0, '一次不该立住')

  // 同一天里再说两次：hits 够了但跨度不够
  say(2000)
  const sameDay = say(3000)
  assert.equal(sameDay.traits[0].hits, 3)
  assert.equal(settledTraits(sameDay, T).length, 0, '同一天说三次也不算"反复"')

  // 隔两天再说 -> 跨度够了，正式立住
  const later = say(3000 + 2 * DAY)
  assert.equal(settledTraits(later, T).length, 1, '跨天三次应该立住')
})

test('说话习惯漂移有硬上限（±0.2）', () => {
  let state = fresh(0)
  for (let i = 0; i < 200; i += 1) {
    state = fold(state, { type: 'user/message', seq: i, time: 1000 + i, data: { text: '谢谢' } })
  }
  assert.ok(state.persona.voice.warmth <= 0.7 + 1e-9, `温度冲破了上限：${state.persona.voice.warmth}`)
  assert.ok(state.persona.voice.warmth >= 0.3)
})

test('内核是年尺度：证据与跨度都够了才沉淀，且每次只挪一点点、留快照', () => {
  const label = '先确认再动手'
  let persona = fresh(0).persona
  const first = 0
  for (let i = 0; i < T.kernelMinEvidence; i += 1) {
    // 前 7 次都在短期内 -> 不该沉淀
    persona = { ...persona, traits: [] }
  }

  // 手动造一条"跨 61 天、被印证 8 次"的自我认知
  persona = {
    ...fresh(0).persona,
    traits: [
      {
        key: '先确认再动手',
        label,
        weight: 0.5,
        hits: 8,
        firstAt: first,
        lastAt: first + 61 * DAY,
        spanDays: 61,
        settledAt: null,
      },
    ],
  }
  const after = settleKernel(persona, first + 61 * DAY, T)
  assert.equal(Object.keys(after.kernel.values).length, 1)
  assert.equal(after.kernelHistory.length, 1, '内核变化必须留快照')
  assert.ok(Math.abs(after.kernel.values['先确认再动手']) <= T.kernelDrift + 1e-9, '单次改动不得超过天花板')
  assert.equal(after.traits[0].settledAt !== null, true)

  // 再来一次：已沉淀过的不重复沉淀
  const again = settleKernel(after, first + 70 * DAY, T)
  assert.equal(again.kernelHistory.length, 1)
})

// ── 记忆 ────────────────────────────────────────────────

test('重复的记忆只加固，不新增', () => {
  let memory = fresh(0).memory
  memory = rememberShort(memory, { kind: 'agreement', text: '以后别再用 pnpm install 改 profile', at: 1 }, T)
  memory = rememberShort(memory, { kind: 'agreement', text: '以后不要再用 pnpm install 改 profile', at: 2 }, T)
  assert.equal(memory.short.length, 1, '几乎一样的两句应判为同一条')
  assert.ok(memory.short[0].hits >= 1)
})

test('全局记忆查不到就老实返回空，不硬凑', () => {
  // 长期库在 v2.0 改名成"全局层"（`long` → `global`），语义没变：不注入、只能主动查
  const memory = { ...fresh(0).memory, global: [makeEntry({ kind: 'fact', text: '用户的工作区在 E 盘', at: 1, maxChars: 160 })] }
  assert.equal(recall(memory, '量子色动力学是什么', 10, T).length, 0)
  const hit = recall(memory, '用户工作区在哪', 10, T)
  assert.ok(hit.length >= 1)
})

test('isDuplicate 认得同一件事的两种写法', () => {
  const memory = { ...fresh(0).memory, global: [makeEntry({ kind: 'fact', text: '这个项目用 pnpm workspace 双包', at: 1, maxChars: 160 })] }
  assert.equal(isDuplicate(memory, '这个项目是 pnpm workspace 双包结构'), true)
  assert.equal(isDuplicate(memory, '明天上海会下雨'), false)
})

// ── 渲染与规范化 ────────────────────────────────────────

test('实况段永远存在且很短（空态也只报平静，绝不复述情绪）', () => {
  const text = renderRealtimeSection(fresh(0), 0)
  assert.ok(text.startsWith('【内部状态'), '要用明确的边界标记开头')
  assert.ok(text.endsWith('【内部状态结束】'), '边界要闭合——真跑里模型会把没闭合的状态行接在自己回复末尾')
  assert.ok(text.length < 220, `空态实况段应很短，实际 ${text.length}`)
  assert.ok(text.includes('平静') || text.includes('情绪'))
})

test('没有任何情绪时显示平静', () => {
  assert.equal(describeEmotions(fresh(0).affect, 0), '平静')
})

test('规范化：残缺/陌生的输入不会炸，且字段齐全', () => {
  const messy = { affect: { current: { valence: 'x' } }, persona: { traits: [{ key: '' }, { key: 'k', hits: '3' }] }, folded: 'nan' }
  const s = normalizeState(messy, T, 123)
  assert.equal(s.affect.current.valence, T.baseline.valence)
  assert.equal(s.persona.traits.length, 1, '没有 key 的条目应被丢掉')
  assert.equal(s.persona.traits[0].hits, 1, '非数字回落到默认值')
  assert.equal(s.progress.toolCallsThisTurn, 0)
  assert.equal(s.memory.global.length, 0)
  assert.equal(s.memory.session.length, 0, '三层都要在：规范化之后形状必须齐全')
})

test('状态是纯数据：可以 JSON 往返，不会有 class / Date 漏进去', () => {
  let state = fresh(0)
  state = fold(state, { type: 'user/message', seq: 1, time: 10, data: { text: '谢谢' } })
  state = fold(state, { type: 'turn/end', seq: 2, time: 20, data: { turn: 1, reason: 'completed' } })
  const round = JSON.parse(JSON.stringify(state))
  assert.deepEqual(round, state, '状态必须能被 JSON 无损往返（可回放的前提）')
})

test('配置项：只传想改的，其余取默认', () => {
  const t = withDefaults({ halfLifeMin: 60 })
  assert.equal(t.halfLifeMin, 60)
  assert.equal(t.moodHalfLifeHours, T.moodHalfLifeHours)
  assert.deepEqual(t.baseline, T.baseline)
})

test('文本规则表：几种说法都能命中', () => {
  const hit = (text) => appraiseUserText(text, 1, 1, 800).map((s) => s.kind)
  assert.ok(hit('谢谢').includes('user_thanks'))
  assert.ok(hit('这个不对').includes('user_pushback'))
  assert.ok(hit('你没看懂').includes('own_fault'))
  assert.ok(hit('随便').includes('ambiguity'))
  assert.ok(hit('我说过三遍了').includes('user_repeat'))
  assert.deepEqual(hit('嗯'), ['goal_progress'], '很短的推进语只给一点点推进感')
})
