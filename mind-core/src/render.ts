/**
 * 渲染层：把状态变成给模型看、给人看的中文。
 *
 * 三条硬要求：
 * 1. **没有素材时，这一段的正确形式是不存在**——返回空串，不要用废话把它填满。
 * 2. 每一段都有长度上限。提示词预算是共享的，一个模块涨上去就是把别的模块挤掉。
 * 3. 给模型的文字要写清"这是你的状态，不是让你表演"——否则模型会开始朗读情绪。
 */

import type { MindTunables } from './config.js'
import { describeEmotions } from './affect.js'
import { describeVector } from './dynamics.js'
import { wordOf } from './lexicon.js'
import { describeEntry, describeMemory, describeShort } from './memory.js'
import { describePersona, settledTraits } from './persona.js'
import { describeThought, hasSomething } from './thought.js'
import type { AffectState, MindPersist, MindState, MindStats, PulseRecord, SelfPortrait } from './types.js'

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
/**
 * 四轴 → 一段能直接执行的行为句。只提有偏向的轴（0.4–0.6 视为中间，不提，省长度）。
 *
 * 老写法是 `说话习惯：偏短、温度适中、直给` —— 半成品："偏短"是几个字？"温度适中"是夸还是不夸？
 * 模型拿到之后还得再翻译一次，这一步本来就是多余的。
 */
function describeVoiceAsText(voice: MindState['persona']['voice']): string {
  const parts: string[] = []
  if (voice.brevity >= 0.6) parts.push('一句话能说完就不说两句')
  else if (voice.brevity <= 0.4) parts.push('话可以铺开讲，一层一层来，不怕长')
  if (voice.directness >= 0.6) parts.push('结论先给，不绕')
  else if (voice.directness <= 0.4) parts.push('先铺垫再给结论，会绕一下')
  if (voice.warmth >= 0.6) parts.push('先把人的情绪接住，再说事')
  else if (voice.warmth <= 0.4) parts.push('就事论事，不铺情绪')
  if (voice.initiative >= 0.6) parts.push('该开口时自己开口，不等着被问')
  else if (voice.initiative <= 0.4) parts.push('不主动开话头，等被问')
  if (parts.length === 0) return '说话风格没有明显偏向'
  return parts.join('；')
}

/**
 * 价值观：中文性格词 + 强度 → 分档人话。
 *
 * 老写法是 `认真(0.8)`，标签加数值。这里按强度配程度词，且**低于 0.5 的一律不写**——
 * 把它写进注入等于给"我可以不认真"的许可。
 */
function describeValues(values: Record<string, number>): string {
  const parts: string[] = []
  for (const [key, raw] of Object.entries(values)) {
    if (!Number.isFinite(raw) || raw < 0.5) continue
    const level = raw >= 0.75 ? `——${key}到近乎固执` : raw >= 0.6 ? `——很${key}` : ''
    parts.push(`${key}${level}`)
  }
  return parts.join('；')
}

/** 自述多久算过时：七天。人设是天/月尺度的东西，一周前的自述可能已经不像它了。 */
const PORTRAIT_STALE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 人设段：给**系统提示词**。
 *
 * 这里放的是"我一直是个什么样的人"，不是"我此刻什么状态"——后者在实况段。
 * 变化以天/月计，所以放前面不伤前缀缓存。
 *
 * 文案优先用**它自己写的** `selfPortrait`（原文照用）；没写过才回退到按四轴拼的规则文案。
 * 理由：人设几天才变一次，让它自己写一次摊下来几乎不花钱，而且它知道自己这几天在干什么，
 * 比规则只看着四个数拼出来的准。
 */
export function renderPersonaSection(
  persona: MindState['persona'],
  memory: MindState['memory'],
  t: MindTunables,
  portrait: SelfPortrait | null = null,
): string {
  const lines: string[] = []
  lines.push('【我是谁】这一节是我的立场与习惯，不是任务清单；它随经历缓慢变化。')

  if (persona.kernel.name) lines.push(`自称：${persona.kernel.name}`)

  // ① 我说话是什么样：自述原文优先，没有就按四轴拼
  if (portrait !== null && portrait.text.trim() !== '') {
    lines.push(portrait.text.trim())
    if (Date.now() - portrait.at > PORTRAIT_STALE_MS) {
      lines.push(
        '（这份自述是一周前写的。如果它已经不像我了——说话习惯变了、或者这些认识过时了——' +
          '用 inner_note 的 selfPortrait 重写一段。）',
      )
    }
  } else {
    const voiceText = describeVoiceAsText(persona.voice)
    lines.push(`我说话：${voiceText}。`)
  }

  // ② 我对自己有数的几点：只说结论，不报"见过几次"（那是面板的审计信息）
  const traits = settledTraits(persona, t)
  if (traits.length > 0) {
    lines.push('我对自己有数的几点：')
    for (const trait of traits.slice(0, 5)) lines.push(`　· ${trait.label}`)
  }

  // ③ 我认的理：分档翻译，不带数值
  const values = describeValues(persona.kernel.values)
  if (values !== '') lines.push(`我认的理：${values}`)

  // ④ 手边记着的事
  const short = describeShort(memory, t.memoryShortMax)
  if (short.length > 0) {
    lines.push('手边记着的事（短期记忆，不用查）：')
    for (const line of short) lines.push(`　· ${line}`)
  }

  // ⑤ 不越过的线：原文照抄（用户自己写的话）
  if (persona.kernel.boundaries.length > 0) {
    lines.push(`不越过的线：${persona.kernel.boundaries.join('；')}`)
  }

  // ⑥ 使用说明。
  // ⚠️ 老写法是"不要为了对齐它而演情绪"——那句会被读成"这个块可以忽略"，
  // 等于把状态与人设的作用一起否掉。改成把"不要复述"和"要影响措辞"分开说。
  lines.push('末尾那块是给我定语气的，不是给我汇报的：不要复述它、不要引用它的标签、不要用第一人称说"我现在很X"。')
  lines.push('但语气要照它走——真的受影响时，措辞和取舍本来就会变，不需要把状态点破。')

  return clip(lines.join('\n'), SEGMENT_LIMITS.persona)
}

/** 低于这个强度就不提：说出来反而是噪声。 */
const SIGNIFICANT = 0.1

/**
 * 把"在场情绪"写成一段——**全部参与，按权重分配分量**，不是取最强的一两个。
 *
 * 强度是**权重**：≥0.5 当主调、0.25–0.5 当伴随、0.1–0.25 当底色。
 * 底色不当主角，但它决定语气收不收（疲惫 0.16 就是"别铺太长"的依据），所以不能丢。
 *
 * 每条情绪的说明只用词表 `inner` 常量——那是写死的通用感受，不含具体事件，所以不会编。
 */
function describeFeelings(affect: AffectState): string {
  const live = affect.emotions
    .filter((e) => e.strength >= SIGNIFICANT)
    .sort((a, b) => b.strength - a.strength)
  // 空态**照样给一句话**：这一段永远存在。空着的坏处是模型会自己编一个状态出来，
  // 而不是"什么都没说"（这条是原设计的结论，别为了省几个 token 改掉）。
  if (live.length === 0) return '没什么情绪，心里是平的。'

  const head = live.filter((e) => e.strength >= 0.5)
  const mid = live.filter((e) => e.strength >= 0.25 && e.strength < 0.5)
  const low = live.filter((e) => e.strength < 0.25)

  const withoutPeriod = (text: string): string => text.replace(/。$/, '')
  const withInner = (e: AffectState['emotions'][number]): string => {
    const word = wordOf(e.word)
    return word ? `${e.word}——${withoutPeriod(word.inner)}` : e.word
  }
  const names = (list: AffectState['emotions']): string => list.map((e) => e.word).join('、')

  const parts: string[] = []
  if (head.length > 0) parts.push(`主要是${head.map(withInner).join('，还有')}`)
  if (mid.length > 0) parts.push(`还带着${names(mid)}`)
  if (low.length > 0) parts.push(`底下压着${names(low)}`)
  return `${parts.join('；')}。`
}

/**
 * 把情绪按 `toward` 三维**加权求和**，写成"合起来是什么基调"。
 *
 * 是加权求和，不是取最大值的那个——疲惫的 dominance 为负，它会把"底气"往下拽一点，
 * 这正是底色该起的作用。三项分别对应"敢不敢下判断 / 劲头够不够 / 心情松不松"。
 */
function describeTone(affect: AffectState): string {
  let dominance = 0
  let arousal = 0
  let valence = 0
  let total = 0
  for (const e of affect.emotions) {
    if (e.strength < SIGNIFICANT) continue
    const word = wordOf(e.word)
    if (word === undefined) continue
    dominance += e.strength * word.toward.dominance
    arousal += e.strength * word.toward.arousal
    valence += e.strength * word.toward.valence
    total += e.strength
  }
  if (total <= 0) return ''

  dominance /= total
  arousal /= total
  valence /= total
  const bits: string[] = [
    dominance < -0.15 ? '底气偏弱，别把话说满' : dominance > 0.25 ? '底气是够的，可以下判断' : '底气一般',
    arousal < -0.1 ? '劲头不足，短些慢些' : arousal > 0.3 ? '劲头偏足' : '劲头平常',
    valence < -0.15 ? '心情偏沉，少客套' : valence > 0.2 ? '心情是亮的，语气可以松' : '心情平和',
  ]
  return `合起来：${bits.join('；')}。`
}

/**
 * 情绪 → 落到句子上的动作。
 *
 * 这张表是**渲染层**的措辞（不进状态、不进面板），所以放这里而不是词表：
 * 词表管"这个情绪是什么"，这里管"它该怎么影响我这一轮怎么说话"。
 */
const ADVICE_BY_WORD: Record<string, string> = {
  挫败: '卡住就直说卡住，别硬撑着说没问题',
  烦躁: '少寒暄，但别把不耐烦撒在措辞上',
  焦虑: '把握不足就说不确定，别用肯定句把事情说死',
  疲惫: '别铺陈，一次说完',
  困惑: '先问清再动手，别猜着往下写',
  内疚: '该认的直说，不解释过多',
  委屈: '不必反复解释自己',
  无聊: '别拖着，直接推进',
  认可: '可以放开一点',
  满足: '语气可以松',
  好奇: '可以多给一点"为什么"',
  感激: '把具体收到了什么说出来',
  自豪: '可以下判断，不用每条都加保险',
  期待: '可以顺口提一句下一步',
}

/** "这一轮就这么说"：由基调 + 四轴 + 在场情绪合出来。 */
function describeAdvice(state: MindState): string {
  const advice: string[] = []
  const voice = state.persona.voice

  // 四轴：只提有偏向的，中间态不提（省 token）
  if (voice.brevity >= 0.6) advice.push('句子短一点，能一句说完就不说两句')
  else if (voice.brevity <= 0.4) advice.push('话可以铺开讲，一层一层来')
  if (voice.directness >= 0.6) advice.push('结论先给')
  else if (voice.directness <= 0.4) advice.push('先铺垫再给结论')
  if (voice.warmth >= 0.6) advice.push('先把人的情绪接住再说事')
  else if (voice.warmth <= 0.4) advice.push('就事论事，不用铺垫客套')

  // 在场情绪：按权重从高到低取，权重越大越该照着做（最多取三条，免得堆成清单）
  const live = state.affect.emotions
    .filter((e) => e.strength >= 0.25)
    .sort((a, b) => b.strength - a.strength)
  let taken = 0
  for (const e of live) {
    const hint = ADVICE_BY_WORD[e.word]
    if (hint === undefined) continue
    advice.push(hint)
    taken += 1
    if (taken >= 3) break
  }

  if (advice.length === 0) return ''
  return `这一轮就这么说：${advice.join('；')}。`
}

/**
 * 实况段：给**请求末尾**。
 *
 * 为什么不能放系统提示词：这一段每一步都变。放进系统提示词会让它之后的所有内容
 * （工具 schema + 全部历史）每一步都失去前缀复用，实测命中量会恒定卡在 2.8k token 左右。
 * 放请求末尾，则每一步只有尾巴这一小段是新的。
 *
 * **这里一个数字都不出现**：数值是给面板看的仪表读数，模型需要的是"该怎么说"。
 * 有断言盯着这一条（测试里查裸数值）。
 */
// 第二个参数保留在签名里（调用方按位置传），但这一段确实用不到时间——
// 用 `_` 前缀是按 TypeScript 约定标注"故意不用"，比删掉参数安全（不会让调用方错位）。
export function renderRealtimeSection(state: MindState, _now: number): string {
  const lines: string[] = []

  // ① 在场情绪（全部参与，按权重分档）
  const feelings = describeFeelings(state.affect)
  if (feelings !== '') lines.push(feelings)

  // ② 合起来的基调（toward 三维加权）
  const tone = describeTone(state.affect)
  if (tone !== '') lines.push(tone)

  // ③ 思想：它自己写的原文，原样引用，不加解释
  const thought = state.thought
  if (hasSomething(thought)) {
    if (thought.judgment) lines.push(`我的判断：${thought.judgment}`)
    if (thought.intent && thought.tension > 0.1) lines.push(`还没落地：${thought.intent}`)
    if (thought.metaCheck) lines.push(`自查：${thought.metaCheck}`)
    if (thought.curiosity) lines.push(`想多看：${thought.curiosity}`)
  }

  // ④ 相处：只翻成"要不要收着说"，不报次数
  const rel = state.persona.relation
  if (rel.turns > 0) {
    if (rel.pushbacks > 0 && rel.pushbacks / Math.max(rel.turns, 1) > 0.15) {
      lines.push('这一段被否掉的次数不少，话收着说。')
    } else if (rel.thanks > 0) {
      lines.push('这一段有几次被肯定，可以放松些。')
    }
  }

  // ⑤ 这一轮就这么说
  const advice = describeAdvice(state)
  if (advice !== '') lines.push(advice)

  if (lines.length === 0) return ''
  const body = clip(lines.join('\n'), SEGMENT_LIMITS.realtime)
  // 显式括起来。真跑两次都发现：没有硬边界时，模型会把状态行当成一种"风格"
  // 接在自己回复的最后（"…等你说清方向再动手。\n【此刻】平静"）。
  return `【此刻】\n${body}\n【此刻结束】`
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
