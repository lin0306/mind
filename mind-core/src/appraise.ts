/**
 * 评估层：把「发生了什么」变成「这对我意味着什么」。
 *
 * 这一层是情感与思想的接缝（appraisal）。它**不调用模型**，只做机械识别——
 * 这是刻意的：情感必须是**每轮都付得起**的东西，多一次模型调用就等于多一倍的延迟和成本，
 * 而且不可回放（同一个日志折两次会得到不同的情感）。
 *
 * 换成模型来做也可以，但那是**可选增强**（配置项），默认走这里。
 */

import type { ProgressState, Signal, SignalKind } from './types.js'

/** 适配器能看见的所有事情。内核只认这个联合类型，不认 DSH 的事件对象。 */
export type Observation =
  | { kind: 'user-text'; text: string; at: number; turn: number }
  | { kind: 'tool-call'; name: string; argsText: string; at: number; turn: number }
  | {
      kind: 'tool-result'
      name: string
      failed: boolean
      errorName?: string
      at: number
      turn: number
    }
  | {
      kind: 'assistant-text'
      chars: number
      /** 整包用量（prompt + 输出）：**约等于上下文有多长**，不能拿来判断"这一轮烧得多不多"。 */
      totalTokens?: number
      /** 这一轮新写了多少（输出 token）。判"烧得多"只认它。 */
      outputTokens?: number
      reasoningChars?: number
      at: number
      turn: number
    }
  | {
      kind: 'turn-end'
      reason: TurnEndReasonKind
      at: number
      turn: number
      steps: number
      hadError: boolean
    }

/** 回合结束的几种收场方式（由根包从 DSH 的 TurnEndReason 归一化而来）。 */
export type TurnEndReasonKind =
  | 'completed'
  | 'aborted-user'
  | 'aborted-other'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'
  | 'other'

// ─────────────────────────────────────────────────────────
// 文本识别规则（中文）
// 规则表是**数据**：想加词、想改权重，不用动逻辑。
// ─────────────────────────────────────────────────────────

interface TextRule {
  kind: SignalKind
  weight: number
  re: RegExp
  because: string
}

const TEXT_RULES: readonly TextRule[] = [
  {
    kind: 'user_thanks',
    weight: 0.7,
    re: /谢谢|感谢|多谢|辛苦了|受教|帮大忙/,
    because: '用户道谢',
  },
  {
    kind: 'user_praise',
    weight: 0.8,
    re: /不错|很好|挺好|厉害|正是|就是这样|对了|漂亮|牛|可以啊|这个好/,
    because: '用户明确肯定',
  },
  {
    kind: 'own_fault',
    weight: 0.7,
    re: /你没|你理解错|你搞错|你看错|你忘了|谁让你|你怎么不/,
    because: '用户指认是我的问题',
  },
  {
    kind: 'user_pushback',
    weight: 0.7,
    re: /不对|错了|不是这样|不是这个|不行|重来|有问题|别这样|胡说|扯/,
    because: '用户否定了我的判断',
  },
  {
    kind: 'user_repeat',
    weight: 0.6,
    re: /我说过|刚才不是|已经说过|又说|说了几遍|再强调/,
    because: '同一件事被再次提起',
  },
  {
    kind: 'ambiguity',
    weight: 0.5,
    re: /随便|都行|看着办|你定|大概|差不多|之类的|你懂的/,
    because: '要求本身含糊',
  },
  {
    kind: 'user_question',
    weight: 0.35,
    re: /为什么|怎么|能不能|可不可以|是否|是不是|吗[？?]?$|[？?]$/,
    because: '用户在追问',
  },
]

/**
 * 评估一条用户消息。
 * 命中多条就都发出去——人会同时"被否定"又"被告知错在自己"，不必压成一条。
 */
// `_turn` 保留在签名里（调用方按位置传第几轮），这一层判信号确实用不到轮次
export function appraiseUserText(text: string, at: number, _turn: number, longUserChars: number): Signal[] {
  const signals: Signal[] = []
  const trimmed = text.trim()
  if (!trimmed) return signals

  for (const rule of TEXT_RULES) {
    if (rule.re.test(trimmed)) {
      signals.push({ kind: rule.kind, weight: rule.weight, because: rule.because, at })
    }
  }

  if (trimmed.length > longUserChars) {
    signals.push({
      kind: 'token_heavy',
      weight: 0.4,
      // 缘由写"发生了什么"，不写"多少"：面板要回答的是"为什么"，不是"记录到了几"
      because: '用户一口气说了很长一段',
      at,
    })
  }
  if (trimmed.length > 0 && !signals.some((s) => s.kind === 'user_question') && trimmed.length < 12) {
    // 很短又不是提问：通常是"嗯""继续"这类推进指令，给一点微弱的推进感。
    signals.push({ kind: 'goal_progress', weight: 0.15, because: '用户简短推进', at })
  }
  return signals
}

/** 工具结果 -> 信号（重试与自我修复必须看前后文）。 */
export function appraiseToolResult(
  obs: Extract<Observation, { kind: 'tool-result' }>,
  prev: ProgressState,
): Signal[] {
  const signals: Signal[] = []
  const sameAsBefore = prev.lastToolError?.name === obs.name

  if (obs.failed) {
    const extra = Math.min(prev.consecutiveErrors * 0.12, 0.3)
    signals.push({
      kind: 'tool_error',
      weight: Math.min(0.5 + extra, 0.85),
      because: `${obs.name} 失败${obs.errorName ? `（${obs.errorName}）` : ''}`,
      at: obs.at,
    })
    if (sameAsBefore) {
      signals.push({
        kind: 'tool_retry',
        weight: 0.6,
        because: `${obs.name} 又一次失败`,
        at: obs.at,
      })
    }
  } else if (sameAsBefore) {
    // 之前错、现在过：这是"自己修好了"，人这里通常是有爽感的。
    signals.push({
      kind: 'tool_recovered',
      weight: 0.6,
      because: `${obs.name} 自己修好了`,
      at: obs.at,
    })
  }
  return signals
}

/** 助手自己的回复 -> 信号（只看量，不看内容）。 */
export function appraiseAssistantText(
  obs: Extract<Observation, { kind: 'assistant-text' }>,
  heavyTokens: number,
): Signal[] {
  const signals: Signal[] = []
  // 判据必须是"**这一轮新写了多少**"，不是"整包用量"。
  //
  // 真机事故（2026-11-18）：`totalTokens` 约等于上下文长度，一个聊了 460 轮的会话
  // 每轮都报 42 万 token → 每轮 +0.45 疲惫 → 强度顶到 0.92、计数 33 次，
  // 面板上永远显示"为什么这么高：这一轮烧了 421026 token"。那不是它累了，是**上下文长了**。
  //
  // 宿主没给增量数据时**宁可不判**：每轮误报一次，比偶尔漏报糟得多。
  if (typeof obs.outputTokens === 'number' && obs.outputTokens > heavyTokens) {
    signals.push({
      kind: 'token_heavy',
      weight: 0.45,
      // 同上：不写 token 数。数字只用来做判据，不进"因为什么"这句话——
      // 用户要的是"它写了特别长的一段"，不是"421026"。
      because: '这一轮它写了特别长的一段',
      at: obs.at,
    })
  }
  return signals
}

/** 回合收场 -> 信号。 */
export function appraiseTurnEnd(obs: Extract<Observation, { kind: 'turn-end' }>): Signal[] {
  const signals: Signal[] = []
  switch (obs.reason) {
    case 'completed':
      if (obs.steps > 0) {
        signals.push({ kind: 'goal_progress', weight: 0.25, because: '这一回合走完了', at: obs.at })
      }
      break
    case 'aborted-user':
      signals.push({ kind: 'user_interrupt', weight: 0.7, because: '用户打断了', at: obs.at })
      break
    case 'blocked':
      signals.push({ kind: 'ambiguity', weight: 0.6, because: '被拦住了，走不下去', at: obs.at })
      break
    case 'error':
      signals.push({ kind: 'tool_error', weight: 0.7, because: '这一轮出错了', at: obs.at })
      break
    case 'max-tokens':
      signals.push({ kind: 'token_heavy', weight: 0.7, because: '撞到 token 上限', at: obs.at })
      break
    default:
      break
  }
  return signals
}

/** 统一入口。 */
export function appraise(obs: Observation, prev: ProgressState, longUserChars = 800): Signal[] {
  switch (obs.kind) {
    case 'user-text':
      return appraiseUserText(obs.text, obs.at, obs.turn, longUserChars)
    case 'tool-result':
      return appraiseToolResult(obs, prev)
    case 'assistant-text':
      return appraiseAssistantText(obs, 40_000)
    case 'turn-end':
      return appraiseTurnEnd(obs)
    default:
      return []
  }
}
