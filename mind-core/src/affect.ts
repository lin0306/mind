/**
 * 情感层：信号的推进、具名情绪的并存、以及向基线的回归。
 *
 * 一次演化的完整过程（顺序不能乱）：
 *   1. 先把此刻的状态按时间回归到"第一个信号发生的时刻"；
 *   2. 按时间顺序逐个施加脉冲，每两个脉冲之间再回归一次（**时间必须参与**）；
 *   3. 最后回归到 `now`；
 *   4. 心境缓慢跟随即时情感；
 *   5. 情绪痕迹按半衰期衰减，低于地板就丢掉。
 *
 * 第 2、3 步的顺序是这个模块唯一容易写错的地方：先推后回归，和先回归后推，结果不一样。
 */

import { buildSignalIndex, wordOf, wordsForSignal, type EmotionWord } from './lexicon.js'
import type { MindTunables } from './config.js'
import { DAY, HOUR, MIN, clamp, decayed, follow, followRate, push, regressVector } from './dynamics.js'
import type { AffectState, EmotionTrace, PulseRecord, Signal, Vector3 } from './types.js'

const SIGNAL_INDEX = buildSignalIndex()

/** 次要情绪合计只拿主要情绪的六成：一件事会牵动多种情绪，但不该把整个情绪场带跑。 */
const SECONDARY_GAIN = 0.6

/** 一个信号点亮哪个词：取该信号的主要词条。 */
export function wordForSignal(signal: Signal): EmotionWord | undefined {
  const words = SIGNAL_INDEX.get(signal.kind)
  if (!words || words.length === 0) return undefined
  return wordOf(words[0] as string)
}

/** 演化结果：新状态 + 这次产生的新脉冲（解释用）。 */
export interface AffectOutcome {
  affect: AffectState
  pulses: PulseRecord[]
}

/**
 * 施加一批信号。
 * @param now 这批信号处理完之后的时刻（通常是最后一条事件的 time）
 */
export function evolveAffect(
  affect: AffectState,
  signals: readonly Signal[],
  now: number,
  t: MindTunables,
): AffectOutcome {
  const pulses: PulseRecord[] = []
  const traces = new Map<string, EmotionTrace>()
  for (const trace of affect.emotions) traces.set(trace.word, { ...trace })

  // 1. 先回归到第一个信号的时刻
  const ordered = [...signals].sort((a, b) => a.at - b.at)
  const firstAt = ordered.length > 0 ? (ordered[0] as Signal).at : now
  let current = regressVector(affect.current, affect.baseline, firstAt - affect.updatedAt, t.halfLifeMin * MIN)
  let clock = Math.max(firstAt, affect.updatedAt)

  // 2. 逐个脉冲
  for (const signal of ordered) {
    current = regressVector(current, affect.baseline, signal.at - clock, t.halfLifeMin * MIN)
    clock = signal.at

    const matched = wordsForSignal(SIGNAL_INDEX, signal.kind)
    if (matched.length === 0) continue

    // 一个信号可以同时点亮"主要情绪 + 若干次要情绪"：这才有多情绪并存的样子。
    //
    // 但**一次事件的总强度必须有天花板**（`eventMaxStrength`）：次要情绪是**分摊**
    // 同一份预算，不是各自再叠一份。否则一个 tool_error 同时点起挫败+烦躁+内疚，
    // 一次失败就等于被三件事同时打击——真机上表现为"三次工具失败就把效价打到下限"。
    const secondaries = Math.max(1, matched.length - 1)
    const budget = signal.weight * t.gain
    const raw = matched.map((_, i) => (i === 0 ? budget : (budget * SECONDARY_GAIN) / secondaries))
    const rawTotal = raw.reduce((sum, value) => sum + value, 0)
    // 形状不变（主要情绪仍然最重），只是总量封顶
    const scale = rawTotal > t.eventMaxStrength && rawTotal > 0 ? t.eventMaxStrength / rawTotal : 1

    for (const [i, word] of matched.entries()) {
      const strength = clamp((raw[i] as number) * scale, 0, 1)
      if (strength <= 0) continue
      current = push(current, word.toward, strength)

      const existing = traces.get(word.word)
      if (existing) {
        // v2.4 **先退到此刻、再按"还剩多少余地"加**：
        //   ① 老写法把历史强度原封不动累加（衰减只在读的时候按 `trace.at` 算一次），
        //      于是隔了两小时的两句气话会像挨在一起一样叠起来；
        //   ② 累加是线性的，几次就把强度顶到 1.00（"同一种情绪反复出现会饱和"）。
        // 现在：`before` 是衰减到此刻的当前值，增量是 `(1 − before) × strength`——渐近逼近 1，
        // 而且**同一次事件最多 +eventMaxStrength** 的天花板照旧。
        const before = decayed(existing.strength, existing.at, signal.at, t.halfLifeMin * MIN)
        existing.strength = clamp(before + (1 - before) * strength, 0, 1)
        existing.at = signal.at
        existing.count += 1
        // 把"当时是什么情况"带下来：面板回答"为什么它这么高"只能靠这句原话
        if (signal.because !== '') existing.lastBecause = signal.because
      } else {
        traces.set(word.word, {
          word: word.word,
          strength,
          at: signal.at,
          count: 1,
          ...(signal.because === '' ? {} : { lastBecause: signal.because }),
        })
      }
      pulses.push({
        at: signal.at,
        word: word.word,
        kind: signal.kind,
        because: signal.because,
        strength,
      })
    }
  }

  // 3. 回归到 now
  current = regressVector(current, affect.baseline, now - clock, t.halfLifeMin * MIN)

  // 4. 心境跟随（慢得多，所以它记的是"这一整段什么样"，不是"刚才那一下"）
  const mood = follow(affect.mood, current, followRate(now - affect.updatedAt, t.moodHalfLifeHours * HOUR))

  // 5. 情绪痕迹衰减 + 清理
  const emotions: EmotionTrace[] = []
  for (const trace of traces.values()) {
    const strength = decayed(trace.strength, trace.at, now, t.halfLifeMin * MIN)
    if (strength >= t.emotionFloor) emotions.push({ ...trace, strength })
  }
  emotions.sort((a, b) => b.strength - a.strength)

  return {
    affect: { baseline: affect.baseline, current, mood, emotions, updatedAt: now },
    pulses,
  }
}

/** 只做时间流逝的演化（没有新信号时，每轮也要让情绪退下去）。 */
export function tickAffect(affect: AffectState, now: number, t: MindTunables): AffectState {
  return evolveAffect(affect, [], now, t).affect
}

/** 当前最强的那个词（面板与提示词里的"现在是什么情绪"）。 */
export function dominantEmotion(affect: AffectState, floor = 0.25): EmotionTrace | null {
  const top = affect.emotions[0]
  if (!top) return null
  return top.strength >= floor ? top : null
}

/** 情绪转人话：`挫败(0.62)、烦躁(0.31)`。 */
export function describeEmotions(affect: AffectState, floor = 0.15): string {
  const list = affect.emotions.filter((e) => e.strength >= floor)
  if (list.length === 0) return '平静'
  return list.map((e) => `${e.word}(${e.strength.toFixed(2)})`).join('、')
}

/** 相对基线的偏移量，用来判断"情绪起来了吗"。 */
export function deviation(affect: AffectState): number {
  const d = affect.current
  const b = affect.baseline
  return Math.sqrt(
    (d.valence - b.valence) ** 2 + (d.arousal - b.arousal) ** 2 + (d.dominance - b.dominance) ** 2,
  )
}

/** 把向量按分量夹在 `seed ± limit` 里（arousal / dominance 还额外夹在 0..1）。 */
function clampNear(v: Vector3, seed: Vector3, limit: number): Vector3 {
  return {
    valence: clamp(v.valence, seed.valence - limit, seed.valence + limit),
    arousal: clamp(v.arousal, Math.max(0, seed.arousal - limit), Math.min(1, seed.arousal + limit)),
    dominance: clamp(v.dominance, Math.max(0, seed.dominance - limit), Math.min(1, seed.dominance + limit)),
  }
}

/**
 * 性情基线漂移——**自更新闭环里最慢的一环，也是"情感会变"的唯一入口**。
 *
 * 三个尺度是叠在一起的，别混：
 *
 * | 层 | 跟随谁 | 半衰期 | 它回答的问题 |
 * |---|---|---|---|
 * | 情绪 `current` | 回落到 `baseline` | 90 分钟 | 刚才那一下 |
 * | 心境 `mood` | 跟随 `current` | 12 小时 | 这一段过得怎么样 |
 * | **性情基线 `baseline`** | **跟随 `mood`** | **30 天** | **我这些年是什么样的人** |
 *
 * 两条限制缺一不可：
 * 1. **慢**——一次交互永远看不出来（一天只挪 2% 左右）；
 * 2. **有界**——离**出厂基线 `seed`**（即配置里的 `baseline`）不超过 `baselineDriftLimit`。
 *    没有这条，一路反向漂下去就是人格崩坏，那不叫成长。
 *
 * 只在**回合收束**时调用一次（不是每个信号都调）：它反映的是长期处境的平均值，
 * 不该被某一句话带跑，也不该让高频事件背上这份计算。
 */
export function driftBaseline(affect: AffectState, now: number, t: MindTunables, seed: Vector3): AffectState {
  const rate = followRate(now - affect.updatedAt, t.baselineHalfLifeDays * DAY)
  if (rate <= 0) return affect
  const moved = follow(affect.baseline, affect.mood, rate)
  const baseline = clampNear(moved, seed, t.baselineDriftLimit)
  if (baseline.valence === affect.baseline.valence
    && baseline.arousal === affect.baseline.arousal
    && baseline.dominance === affect.baseline.dominance) {
    // 已经贴在上限上、且这一小步没有真的动——返回同一引用，省掉下游的无谓工作
    return affect
  }
  return { ...affect, baseline }
}

/** 基线离出厂基线漂了多远（面板/命令用，"我变了多少"就用它量）。 */
export function driftAmount(affect: AffectState, seed: Vector3): number {
  return Math.max(
    Math.abs(affect.baseline.valence - seed.valence),
    Math.abs(affect.baseline.arousal - seed.arousal),
    Math.abs(affect.baseline.dominance - seed.dominance),
  )
}
