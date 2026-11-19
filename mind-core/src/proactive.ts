/**
 * 主动开口的**判断**（不是说话本身）。
 *
 * 为什么内核只做判断、不说话：开口要改提示词、要起一轮新对话，那是 agent 专有的能力
 * （DSH 里是 `agent/turn-stopping` + `agent.followup()`）。内核给的是「此刻该不该开口」
 * 以及一句人话的原因——换一个 agent，这套判断一行都不用改。
 *
 * 门槛必须硬，因为这是最容易变成骚扰的功能：
 *
 * 1. **必须有没说完的事**：有没收的线（`openLoops`）或张力还高。没有就是没有，不要找话说；
 * 2. **必须真的在情绪上**：离静息状态太近就不开口——平静的时候说"我想到一件事"是假的，
 *    人只在心里搁着事的时候才会主动回头说一句；
 * 3. **必须够久没开口**：冷却没到一律不提（默认 45 分钟）。
 *
 * 还有一条不在这里，在适配层：**默认关**。要人明确允许，它才会主动说话。
 */

import { deviation } from './affect.js'
import type { MindTunables } from './config.js'
import { MIN } from './dynamics.js'
import { hasSomething } from './thought.js'
import type { MindState } from './types.js'

/** 该不该主动开口。 */
export interface ProactiveDecision {
  speak: boolean
  /** 为什么（写日志用）。说"不"也要写清楚为什么不说——不然关掉开关的人会怀疑它坏了。 */
  because: string
}

/**
 * 判断此刻该不该主动开口。
 *
 * @param now 当前时间戳（毫秒）
 * @param lastSpokeAt 上一次主动开口的时间戳，0 表示从来没开过口
 */
export function proactiveDecision(
  state: MindState,
  t: MindTunables,
  now: number,
  lastSpokeAt: number,
): ProactiveDecision {
  const tension = state.thought.tension
  const away = deviation(state.affect)
  const pending = state.thought.openLoops

  if (!hasSomething(state.thought) && tension < t.proactiveTensionFloor) {
    return { speak: false, because: '心里没搁着事（没有没收的线，张力也低）' }
  }
  if (tension < t.proactiveTensionFloor) {
    return {
      speak: false,
      because: `张力只有 ${tension.toFixed(2)}（门槛 ${t.proactiveTensionFloor}），不值得开口`,
    }
  }
  if (away < t.proactiveDeviationFloor) {
    return {
      speak: false,
      because: `离静息只有 ${away.toFixed(2)}（门槛 ${t.proactiveDeviationFloor}），太平静了`,
    }
  }

  const minutesSince = lastSpokeAt === 0 ? Number.POSITIVE_INFINITY : (now - lastSpokeAt) / MIN
  if (minutesSince < t.proactiveCooldownMin) {
    return {
      speak: false,
      because: `上次开口在 ${minutesSince.toFixed(1)} 分钟前（冷却 ${t.proactiveCooldownMin} 分钟）`,
    }
  }

  const when = lastSpokeAt === 0 ? '还没开过口' : `上次开口 ${(minutesSince / 60).toFixed(1)} 小时前`
  return {
    speak: true,
    because: `张力 ${tension.toFixed(2)}（≥${t.proactiveTensionFloor}）、离静息 ${away.toFixed(2)}（≥${t.proactiveDeviationFloor}）、${pending} 条没收的线、${when}`,
  }
}
