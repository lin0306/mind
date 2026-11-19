/**
 * 内核的可调参数。
 *
 * 约定：**内核里不许出现魔法数字**。所有会被人想调的量都在这里，并且有默认值；
 * 根包的 `Config`（schemastery）只是把这套值接到 DSH 的配置文件上。
 *
 * 单位一律写进名字（`Min` / `Hours` / `Days`），避免"90 到底是分钟还是秒"这种事故。
 */

import type { Vector3 } from './types.js'

/** 内核参数全集。 */
export interface MindTunables {
  // ── 情感 ─────────────────────────────────────────────
  /** 性情基线：静息时的效价 / 唤醒 / 支配。默认「温和中性」。 */
  baseline: Vector3
  /** 即时情感回归基线的半衰期（分钟）。 */
  halfLifeMin: number
  /** 心境的半衰期（小时）——比即时情感慢一个量级，所以它才叫"心境"。 */
  moodHalfLifeHours: number
  /** 信号强度换算成情感位移的比例。 */
  gain: number
  /**
   * **一次事件**允许施加的总强度上限（主要情绪 + 全部次要情绪合并）。
   *
   * 为什么必须有这道闸：一个 `tool_error` 会同时点起挫败、烦躁、内疚三种情绪，
   * 如果各自独立叠加，一次命令失败就等于被三件事同时打击——那不是"情绪丰富"，
   * 那是把一件小事写成创伤。有这个上限，"很挫败"需要**真的连续发生**才成立。
   */
  eventMaxStrength: number
  /** 保留最近多少条脉冲痕迹（解释用，防止无限增长）。 */
  pulseKeep: number
  /** 低于这个强度的情绪痕迹就被丢掉。 */
  emotionFloor: number
  /**
   * 性情基线漂移的半衰期（**天**）。
   *
   * 自更新闭环里最慢的一环：情绪几十分钟回基线，心境十几小时跟随情绪，
   * 而基线跟的是心境、量级是**月**。默认 30 天意味着相处一天只能挪 2%，
   * 一次对话永远看不出来，一个月的相处看得出来——这就是"三年前和三年后性格不同"
   * 在情感层的对应物。
   */
  baselineHalfLifeDays: number
  /**
   * 基线离**出厂基线**最多能漂多远（三维各自的分量上限）。
   *
   * 这是防人格崩坏的那道闸：漂移必须有界，否则一路漂下去它就不是它了。
   */
  baselineDriftLimit: number

  // ── 决策（情感参与"这一轮该怎么想"） ────────────────
  /**
   * 情绪能左右决策的强度。0 = 情绪完全不参与参数决定（决策通道关掉）。
   *
   * 这是"躯体标记"在提示词之外的另一个落点：情绪不改变你看到什么，
   * 只改变**你多放开一点还是多收紧一点**。
   */
  decisionGain: number
  /** 张力高到这个程度，才值得"多推一步"（推理强度上调）。 */
  decisionUrgencyFloor: number

  // ── 主动开口 ─────────────────────────────────────────
  /** 张力高到这个程度，才值得主动开口。 */
  proactiveTensionFloor: number
  /** 离静息状态至少这么远才值得主动开口（太平静时不要找话说）。 */
  proactiveDeviationFloor: number
  /** 两次主动开口之间至少隔多少分钟。 */
  proactiveCooldownMin: number

  // ── 思想 ─────────────────────────────────────────────
  /** 张力（未解矛盾）的半衰期（分钟）。没人管它，它自己也会淡。 */
  tensionHalfLifeMin: number
  /** 一次成功行动能消解多少张力。 */
  tensionRelief: number
  /** 单条思想文本的字符上限（超过截断，防止把提示词撑爆）。 */
  noteMaxChars: number

  // ── 人设（三档速度） ─────────────────────────────────
  /** 说话习惯的漂移上限（周尺度）。 */
  voiceDrift: number
  /** 自我认知的漂移上限（周–月尺度）。 */
  traitDrift: number
  /** 内核的漂移上限（年尺度）——单次改动的幅度天花板。 */
  kernelDrift: number
  /** 提升为自我认知所需的最少印证次数。 */
  traitMinHits: number
  /** 提升为自我认知所需的最少跨越天数（"反复"而不是"一次"）。 */
  traitMinSpanDays: number
  /** 改动内核所需的最少证据条数。 */
  kernelMinEvidence: number
  /** 改动内核所需的证据跨越天数。 */
  kernelMinSpanDays: number
  /** 内核变化历史保留条数。 */
  kernelHistoryKeep: number

  // ── 记忆 ─────────────────────────────────────────────
  /** 短期记忆（会被注入）最多留几条。 */
  memoryShortMax: number
  /** 全局记忆库上限。 */
  memoryLongMax: number
  /** recall 一次最多返回几条。 */
  recallLimit: number
  /** 记忆条目的字符上限（**从用户话里摘的原句**用这一档，默认 160）。 */
  memoryMaxChars: number
  /**
   * **它自己写下的**那一条的字符上限（默认 400）。
   *
   * 为什么跟 `memoryMaxChars` 分开：听来的原句是"摘一句"，越紧越好；而它自己写下的是
   * **它已经想过一遍的结论**——那句话里往往同时有结论和理由，按 160 切会在半句上截断
   * （旧档案里就留下一堆"…但是"、"…而"这样的残句，看起来像 bug，因为它确实就是）。
   */
  memorySelfMaxChars: number
  /** 收尾兜底拼的那一段的字符上限（默认 600：一段话要装下几件事）。 */
  digestMaxChars: number
  /**
   * 每走多少**步**总结一次记忆（DESIGN §22.3 触发点①，默认 20）。
   *
   * 注意单位是**步**不是轮：一次对话会执行很多步，按轮数算就永远等不到总结。
   * `step/end` 累加，`turn/start`（新一轮对话）与上下文压缩都会把计数归零重数。
   * 这个值必须能在设置页改（见 REQUIREMENTS §9）。
   */
  memorySummarySteps: number
  /**
   * 短期记忆里"常驻"几条（按分数取前几条），其余名额**跨轮轮换**。
   *
   * 为什么要轮换：不轮换的话每轮注入的都是同几条，库里其余的永远不露面，
   * 模型也就永远不知道它们存在（这也是"跨会话效果不好"的原因之一）。
   * 常驻的几条是"每轮都得知道的事"（约定、偏好），轮换的是事实与教训——一轮一轮翻，总能翻到。
   */
  memoryShortPinned: number
  /** BM25 词频饱和参数：越大，同一个词重复出现带来的加分越早到顶。 */
  bm25K1: number
  /** BM25 长度归一化强度：0 = 不按长度归一，1 = 完全按长度归一。 */
  bm25B: number
  /**
   * 把**无上界**的 BM25 分压进 0..1 的那个"半分点"：原始分等于它时映射成 0.5。
   *
   * 为什么不"除以查询里所有词的 IDF 之和"：那样一来，提问时多写一个库里没有的词
   * 就会把分压低——惩罚的是提问的人，不是衡量相关。饱和映射只看命中的部分。
   */
  bm25Half: number

  // ── 处境 ─────────────────────────────────────────────
  /** 连续多少个回合没什么新东西算"原地打转"。 */
  idleAfterTurns: number
  /** 单轮 token 超过这个量算"这一轮很重"。 */
  heavyTokens: number
  /** 用户消息超过这个字符数算"一次给了很多"。 */
  longUserChars: number
}

/** 默认参数：温和中性、慢、克制。 */
export const DEFAULT_TUNABLES: MindTunables = {
  baseline: { valence: 0.05, arousal: 0.25, dominance: 0.5 },
  halfLifeMin: 90,
  moodHalfLifeHours: 12,
  gain: 1,
  eventMaxStrength: 0.25,
  pulseKeep: 12,
  emotionFloor: 0.02,
  baselineHalfLifeDays: 30,
  baselineDriftLimit: 0.25,

  decisionGain: 0.6,
  decisionUrgencyFloor: 0.45,

  proactiveTensionFloor: 0.35,
  proactiveDeviationFloor: 0.15,
  proactiveCooldownMin: 45,

  tensionHalfLifeMin: 240,
  tensionRelief: 0.3,
  /**
   * 一条自我陈述最多留多少字。
   *
   * 原来是 40——太短了，模型写「判断：……」经常在句子中间被切掉，
   * 面板上就是一句带省略号的话（用户点名问过"这写的是啥，怎么还省略了"）。
   * 现在放到 120：够把一句判断说完，又不至于把提示词撑爆
   * （实况段还有 `SEGMENT_LIMITS.realtime` 那道 900 字的闸兜着）。
   */
  noteMaxChars: 120,

  voiceDrift: 0.2,
  traitDrift: 0.1,
  kernelDrift: 0.02,
  traitMinHits: 3,
  traitMinSpanDays: 2,
  kernelMinEvidence: 8,
  kernelMinSpanDays: 60,
  kernelHistoryKeep: 20,

  // 与设置页那份保持一致（那边是 6 / 400）。两处不同的默认值 = 用户永远调不到他看到的那个数。
  // 短期 6 条：这些是每轮都要注入的，多于六条就是拿上下文换"记性"，不划算。
  memoryShortMax: 6,
  memoryLongMax: 400,
  recallLimit: 5,
  memoryMaxChars: 160,
  memorySelfMaxChars: 400,
  digestMaxChars: 600,
  memorySummarySteps: 20,
  memoryShortPinned: 2,
  bm25K1: 1.2,
  bm25B: 0.75,
  bm25Half: 1.5,

  idleAfterTurns: 4,
  // ⚠️ 这两个默认值**必须与设置页那份**（`dsh-mind/src/config.ts` 的 `CONFIG_FIELDS`）一致：
  // 两处写着不同的数，就等于"设置页显示 8000、实际跑 40000"，用户调了也不生效（真发生过）。
  // `heavyTokens` 判的是"这一轮**新写了**多少 token"，8000 已经是很长的一段。
  heavyTokens: 8_000,
  longUserChars: 800,
}

/** 半份配置 + 默认值 = 全量配置（外部只传想改的那几个）。 */
export function withDefaults(partial?: Partial<MindTunables>): MindTunables {
  if (!partial) return DEFAULT_TUNABLES
  return {
    ...DEFAULT_TUNABLES,
    ...partial,
    baseline: { ...DEFAULT_TUNABLES.baseline, ...(partial.baseline ?? {}) },
  }
}
