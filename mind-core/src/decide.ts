/**
 * 决策通道：**情感与思想怎么影响"这一轮该怎么想"**。
 *
 * 这是整套东西里最像"达马西奥"的一块：情绪不是装饰，它参与决策本身。
 * 但内核在这里只产出**无量纲的倾向**，一个 agent 专有的参数名都不出现——
 * "温度调多少""推理强度用哪一档"是适配层的事（见根包 `src/decide.ts`）。
 * 这条界线是这套东西能移植到别的 agent 的前提。
 *
 * 三条设计约束：
 * 1. **只给倾向，不给结论**：`openness` / `urgency` 都是 -1..1 或 0..1 的裸数字；
 * 2. **有界**：`openness` 受 `decisionGain` 缩放并夹在 ±1，怎么算都出不去；
 * 3. **可解释**：`because` 说人话，日志与 `/mind` 都要能回答"为什么这一轮变了"。
 */

import { deviation, describeEmotions } from './affect.js'
import type { MindTunables } from './config.js'
import { clamp } from './dynamics.js'
import type { AffectState, ThoughtState } from './types.js'

/** 决策倾向：内核给适配层的全部输出。 */
export interface DecisionSignal {
  /**
   * 更放开（+1）还是更收紧（-1）。
   *
   * 正效价偏离基线 → 放开（敢想、敢多试一条路）；负效价 → 收紧（稳住、别乱发挥）。
   * 唤醒越高，这个倾向被放大得越明显——平静的时候，情绪不该左右决策。
   */
  openness: number
  /** 有多需要"多推一步"（0..1）：张力（没解决的矛盾）是最直接的来源。 */
  urgency: number
  /**
   * 该不该"多推一步"——由**内核**按 `decisionUrgencyFloor` 判定。
   *
   * 分工：内核决定"要不要"，适配层只决定"温度推多少"（那是 LLM 的参数，不该内核管）。
   */
  needMoreThought: boolean
  /** 为什么，人话（日志与面板用）。 */
  because: string
  /** 此刻像不像"情绪在起作用"（用于自检与日志：偏移太小就不该有任何动作）。 */
  active: boolean
}

/**
 * 算出这一轮的决策倾向。
 *
 * @param affect 情感状态（用 `current`——**此刻**，不是心境也不是基线：决策是当下做的）
 * @param thought 思想状态（张力）
 */
export function decisionSignal(affect: AffectState, thought: ThoughtState, t: MindTunables): DecisionSignal {
  const { valence, arousal } = affect.current
  const baselineValence = affect.baseline.valence

  // openness：离基线的正负 × 唤醒的放大 × 总增益
  const raw = (valence - baselineValence) * (0.5 + arousal) * t.decisionGain
  // 注意 `-0`：gain=0 时乘法得到的是 `-0`，而 `assert.strictEqual(-0, 0)` 是**失败**的。
  // 归一成 0，让"完全没有倾向"这件事在数值上也是干净的。
  const openness = raw === 0 ? 0 : clamp(raw, -1, 1)

  // urgency：张力为主，自查（已发现自己在凑合/在猜）再加一点
  const urgencyRaw = thought.tension * 1.4 + (thought.metaCheck !== null ? 0.15 : 0)
  const urgency = urgencyRaw === 0 ? 0 : clamp(urgencyRaw, 0, 1)

  const mood = describeEmotions(affect)
  // 张力够了，或者它自己已经记下"我在凑合/我在猜"——后者本身就是多推一步的理由
  const needMoreThought = urgency >= t.decisionUrgencyFloor || thought.metaCheck !== null
  const active = Math.abs(openness) >= 0.05 || needMoreThought

  const parts: string[] = []
  if (Math.abs(openness) >= 0.05) {
    parts.push(openness > 0 ? `状态偏正（${mood}）→ 这一轮放开一点` : `状态偏负（${mood}）→ 这一轮收着点`)
  }
  if (needMoreThought) {
    const reasons: string[] = []
    if (thought.tension > 0) reasons.push(`有没解决的矛盾（张力 ${thought.tension.toFixed(2)}）`)
    if (thought.metaCheck !== null) reasons.push('自查没过')
    parts.push(`${reasons.join('、')}→ 多推一步`)
  }
  if (parts.length === 0) parts.push(`离基线 ${deviation(affect).toFixed(2)}，不干预`)

  return { openness, urgency, needMoreThought, because: parts.join('；'), active }
}
