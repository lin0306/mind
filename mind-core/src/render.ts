/**
 * 渲染层：把状态变成给模型看、给人看的中文。
 *
 * 三条硬要求：
 * 1. **没有素材时，这一段的正确形式是不存在**——返回空串，不要用废话把它填满。
 * 2. 每一段都有长度上限。提示词预算是共享的，一个模块涨上去就是把别的模块挤掉。
 * 3. 给模型的文字要写清"这是你的状态，不是让你表演"——否则模型会开始朗读情绪。
 */

import type { MindTunables } from './config.js'
import { describeEmotions, dominantEmotion, deviation } from './affect.js'
import { describeVector } from './dynamics.js'
import { describeEntry, describeMemory, describeShort } from './memory.js'
import { describePersona, settledTraits } from './persona.js'
import { describeThought, hasSomething } from './thought.js'
import type { MindPersist, MindState, MindStats, PulseRecord } from './types.js'

/** 硬上限：任何一段都不许超过它。 */
export const SEGMENT_LIMITS = {
  /** 人设段（改动很少，放系统提示词）。 */
  persona: 700,
  /** 实况段（每步都在变，放请求末尾）。 */
  realtime: 900,
  /** 面板。 */
  panel: 6000,
} as const

/** 「该总结了」的理由：给人看的都是人话，不印内部枚举值（v2.3 加了 `signal` 一档）。 */
const SUMMARY_REASON_TEXT: Record<string, string> = {
  steps: '步数到点',
  compaction: '上下文刚被压缩过',
  final: '会话要收尾了',
  signal: '刚说的话里有值得记的',
}

/** 超长就截断，并在末尾标出来（宁可看得见截断，也不要悄悄丢内容）。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 24)}\n…（已截断，共 ${text.length} 字）`
}

/**
 * 人设段：给**系统提示词**（改动很少，前缀缓存几乎不受影响）。
 * 这一段的职责是回答"我是谁、我怎么说话"，不是"我现在什么心情"。
 */
export function renderPersonaSection(
  persona: MindState['persona'],
  memory: MindState['memory'],
  t: MindTunables,
): string {
  const lines: string[] = []
  lines.push('【我的人设】这一节是我的立场与习惯，不是任务描述；它随经历缓慢变化。')

  if (persona.kernel.name) lines.push(`自称：${persona.kernel.name}`)
  const kernelKeys = Object.keys(persona.kernel.values)
  if (kernelKeys.length > 0) {
    lines.push(`已经沉淀成性子的东西：${kernelKeys.map((k) => `${k}(${persona.kernel.values[k]})`).join('、')}`)
  }
  const traits = settledTraits(persona, t)
  if (traits.length > 0) {
    lines.push('我对自己的认识：')
    for (const trait of traits.slice(0, 5)) lines.push(`　· ${trait.label}`)
  }
  const voice = persona.voice
  lines.push(
    `说话习惯：${
      voice.brevity >= 0.6 ? '偏短' : voice.brevity <= 0.4 ? '偏长' : '长短中等'
    }、${voice.warmth >= 0.6 ? '顺人情' : voice.warmth <= 0.4 ? '就事论事' : '温度适中'}、${
      voice.directness >= 0.6 ? '直给' : voice.directness <= 0.4 ? '会绕一下' : '直给程度中等'
    }`,
  )
  const short = describeShort(memory, t.memoryShortMax)
  if (short.length > 0) {
    lines.push('手边记着的事（短期记忆，不用查）：')
    for (const line of short) lines.push(`　· ${line}`)
  }
  if (persona.kernel.boundaries.length > 0) {
    lines.push(`不越过的线：${persona.kernel.boundaries.join('；')}`)
  }
  // 使用说明（只在人设段说一次，实况段不再重复）
  lines.push('心情与工作状态在每轮末尾的「内部状态」块里给。')
  lines.push('那个块**不是回复内容**：不要复述它、不要引用它的标签、不要用第一人称描述自己的心情，也不要为了对齐它而演情绪。')
  lines.push('要表达就正常表达——真的受影响时，你的措辞和取舍本来就会变，不需要报状态。')

  return clip(lines.join('\n'), SEGMENT_LIMITS.persona)
}

/**
 * 实况段：给**请求末尾**。
 *
 * 为什么不能放系统提示词：这一段每一步都变。放进系统提示词会让它之后的所有内容
 * （工具 schema + 全部历史）每一步都失去前缀复用，实测命中量会恒定卡在 2.8k token 左右。
 * 放请求末尾，则每一步只有尾巴这一小段是新的。
 */
// 第二个参数保留在签名里（调用方按位置传），但这一段确实用不到时间——
// 用 `_` 前缀是按 TypeScript 约定标注"故意不用"，比删掉参数安全（不会让调用方错位）。
export function renderRealtimeSection(state: MindState, _now: number): string {
  const lines: string[] = []
  const affect = state.affect

  // ① 情绪：没有情绪就老实说平静（这比空着好，空着模型会自己编一个）
  const top = dominantEmotion(affect, 0.2)
  lines.push(
    `情绪：${describeEmotions(affect)}${top ? `　（最强的是「${top.word}」）` : ''}`,
  )

  // ② 心境与偏离：只在真的离开基线时给，避免每轮都在报"我很好"
  if (deviation(affect) > 0.12) {
    lines.push(`心境：${describeVector(affect.mood)}`)
  }

  // ③ 思想：只有真有内容时才出现
  if (hasSomething(state.thought)) {
    const t = state.thought
    if (t.judgment) lines.push(`我的判断：${t.judgment}`)
    if (t.tension > 0.1) lines.push(`悬着的：${t.tension.toFixed(2)}${t.intent ? `（${t.intent}）` : ''}`)
    if (t.metaCheck) lines.push(`自查：${t.metaCheck}`)
    if (t.curiosity) lines.push(`想多看：${t.curiosity}`)
  }

  // ④ 关系：只给会改变语气的两件事
  const rel = state.persona.relation
  if (rel.turns > 0 && (rel.pushbacks > 0 || rel.thanks > 0)) {
    lines.push(`相处：第 ${rel.turns} 轮；被肯定 ${rel.thanks} 次、被否掉 ${rel.pushbacks} 次`)
  }

  if (lines.length === 0) return ''
  const body = clip(lines.join('\n'), SEGMENT_LIMITS.realtime)
  // 显式括起来。真跑两次都发现：没有硬边界时，模型会把状态行当成一种"风格"
  // 接在自己回复的最后（"…等你说清方向再动手。\n【此刻】平静"）。
  return `【内部状态·给你自己看的，不要出现在回复里】\n${body}\n【内部状态结束】`
}

/** 面板/`/mind` 的主输出。 */
export function renderPanel(
  state: MindState,
  // 签名里的这一位保留（调用方按位置传），当前面板不展示持久化信息
  _persist: MindPersist,
  stats: MindStats,
  now: number,
  t: MindTunables,
): string {
  const lines: string[] = []
  lines.push('# dsh-mind 状态')
  lines.push('')
  lines.push('## 情感')
  lines.push(`此刻：${describeEmotions(state.affect)}`)
  lines.push(`心境：${describeVector(state.affect.mood)}`)
  lines.push(`基线（性情）：${describeVector(state.affect.baseline)}`)
  if (state.pulses.length > 0) {
    lines.push('最近几次为什么：')
    for (const p of state.pulses.slice(-5).reverse()) {
      lines.push(`　· ${p.word}（${p.strength.toFixed(2)}）← ${p.because}`)
    }
  }
  lines.push('')
  lines.push('## 思想')
  for (const line of describeThought(state.thought)) lines.push(line)
  lines.push('')
  lines.push('## 人设')
  for (const line of describePersona(state.persona, t)) lines.push(line)
  lines.push('')
  lines.push('## 记忆')
  for (const line of describeMemory(state.memory)) lines.push(line)
  // 步计数与「该总结了」（v2.0）。**单位是步不是轮**，所以这个数和上面的回合数不是一回事：
  // 一次对话要走很多步，压缩之后从 0 重数，新一轮对话也重新数。
  lines.push(
    `步计数：${state.progress.steps}/${t.memorySummarySteps}${
      state.progress.summaryDue
        ? `　·　该总结了（${SUMMARY_REASON_TEXT[state.progress.summaryReason ?? ''] ?? '未知'}）`
        : ''
    }`,
  )
  // 会话日记：只增不改，所以这里看的是"这一段到底留下了什么"
  if (state.memory.session.length > 0) {
    lines.push('本会话日记（增量追加，旧条目不改写）：')
    state.memory.session.slice(-5).forEach((entry, i) => {
      lines.push(`　· ${describeEntry(entry, i + 1, now)}`)
    })
  }
  if (state.memory.short.length > 0) {
    lines.push('短期记忆清单：')
    for (const line of describeShort(state.memory, 8)) lines.push(`　· ${line}`)
  }
  lines.push('')
  lines.push('## 累计')
  lines.push(
    `会话 ${stats.sessions} 次 · 回合 ${stats.turns} · 情感脉冲 ${stats.pulses} · 思想 ${stats.notes} · 取回记忆 ${stats.recalls} · 内核变化 ${stats.kernelChanges} · 主动开口 ${stats.proactive}`,
  )
  lines.push(`折叠事件 ${state.folded} 条（状态完全由会话日志推导，可重放）`)
  return clip(lines.join('\n'), SEGMENT_LIMITS.panel)
}

/** `/mind why`：最近几次情绪到底从哪来。 */
export function renderWhy(state: MindState, limit = 8): string {
  if (state.pulses.length === 0) return '还没有过情绪脉冲。'
  const lines = ['最近的脉冲（越靠下越早）：']
  for (const pulse of state.pulses.slice(-limit)) {
    lines.push(`　· ${pulse.word}（${pulse.strength.toFixed(2)}）← ${pulse.kind}：${pulse.because}`)
  }
  return lines.join('\n')
}

/** 把最新一条思想单独渲染（写完 `inner_note` 后给自己看一眼）。 */
export function renderLatestPulse(pulses: readonly PulseRecord[]): string {
  const last = pulses[pulses.length - 1]
  if (!last) return ''
  return `${last.word} ← ${last.because}`
}

/** 给模型看的"什么时候该写 inner_note"（放进工具描述，不占提示词预算）。 */
export const INNER_NOTE_GUIDE = [
  '什么时候用：你产生了值得留下的判断（例如换了做法、发现了矛盾、有件事没想通）时才写。',
  '什么时候别用：日常应答不要写；不要在每一轮都写；不要用这工具跟用户说话。',
  '大多数回合本来就没有值得写的东西，那就不写。',
  '要让它记住一件事（做法、约定、你的偏好、踩过的坑），用 remember 参数顺手记一条，写你自己的话。',
].join('\n')

/** 对外统一出口：一段是给系统提示词的，一段是给请求末尾的。 */
export function renderAll(
  state: MindState,
  t: MindTunables,
): { personaSection: string; realtimeSection: string } {
  return {
    personaSection: renderPersonaSection(state.persona, state.memory, t),
    realtimeSection: renderRealtimeSection(state, state.updatedAt),
  }
}
