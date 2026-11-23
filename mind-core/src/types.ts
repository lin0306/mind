/**
 * dsh-mind-core 的类型定义。
 *
 * 三条纪律（整个内核都遵守，违反其中任何一条，状态就不再可回放）：
 * 1. 状态是**普通数据结构**：没有 class、没有 Date 实例、没有函数。它一定可 JSON 化。
 * 2. 时间一律从外面传进来（会话事件自带 `time`），内核**从不调用 Date.now()**。
 * 3. 演化是**纯函数**：旧状态进、新状态出，不许改入参。
 */

/** 三维情感向量。valence 效价 -1..1；arousal 唤醒 0..1；dominance 支配感 0..1。 */
export interface Vector3 {
  valence: number
  arousal: number
  dominance: number
}

/**
 * 机械信号。
 *
 * 内核**只吃信号，不读原文**——这是把"情感"做成可测试、可回放逻辑的前提。
 * 把自然语言转成信号的那一层在适配器里（见 render.ts 的评估函数与根包的 signals.ts）。
 */
export type SignalKind =
  // 工作侧
  | 'tool_error' // 工具报错
  | 'tool_retry' // 同一件事重试
  | 'tool_recovered' // 出错之后自己修复了
  | 'token_heavy' // 这一轮烧得特别多
  | 'goal_progress' // 目标推进
  // 人侧
  | 'user_thanks' // 用户道谢
  | 'user_praise' // 用户明确肯定
  | 'user_pushback' // 用户否定/驳回
  | 'user_repeat' // 用户重复说过的话
  | 'user_interrupt' // 用户打断
  | 'user_question' // 用户在追问
  // 处境侧
  | 'own_fault' // 错在自己
  | 'ambiguity' // 需求含糊
  | 'idle' // 原地打转
  | 'novelty' // 遇到新东西
  | 'long_gap' // 隔了很久才继续

/** 一次信号。`weight` 由评估层给（0..1）。 */
export interface Signal {
  kind: SignalKind
  weight: number
  /** 触发缘由，只给 `/mind why` 和调试看，不进提示词正文。 */
  because: string
  /** 毫秒时间戳，来自会话事件的 time。 */
  at: number
}

/** 具名情绪的一条痕迹。同一时刻**允许多种情绪并存**。 */
export interface EmotionTrace {
  /** 词表里的词，如「挫败」。 */
  word: string
  /** 当前强度 0..1。 */
  strength: number
  /** 最近一次被激活的时刻。 */
  at: number
  /** 本会话内被激活过几次。 */
  count: number
  /**
   * 最近一次被点起时，那条信号自带的触发缘由（`Signal.because` 原样带过来）。
   *
   * 面板悬浮说明要回答"为什么它这么高"，靠的就是这一句——不是事后重新猜一遍，
   * 而是当时那条信号写下的说明。老状态里没有这个字段：缺就如实说"没留下缘由"，
   * 绝不补一个编的。
   */
  lastBecause?: string
}

/** 情感层状态。 */
export interface AffectState {
  /** 性情基线：除非自更新挪动它，否则不变。 */
  baseline: Vector3
  /** 此刻的即时情感（会被信号推离基线，然后按半衰期回归）。 */
  current: Vector3
  /** 心境：比 current 慢得多的跟随量，跨越一整轮对话。 */
  mood: Vector3
  /** 当前并存的具名情绪。 */
  emotions: EmotionTrace[]
  /** 最近一次演化时刻，回归计算靠它。 */
  updatedAt: number
}

/**
 * 一段**它自己写的人设自述**：我现在是个什么样的人、怎么说活。
 *
 * 人设的变化以天/月计，所以这段只在它自己觉得"这就是我了"的时候才写一次，
 * 注入时优先用它（原文照用），没有才回退到按四轴拼的规则文案。
 */
export interface SelfPortrait {
  /** 自述正文（它自己的话，不是规则拼的）。 */
  text: string
  /** 写于何时（毫秒）。用来判断这份自述是不是已经过时了。 */
  at: number
}

/** 思想层状态。 */
export interface ThoughtState {
  /** 悬置的张力：有矛盾没解决时 >0，解决后衰减。0..1 */
  tension: number
  /** 最近一次在意的事。 */
  intent: string | null
  /** 最近一次的工作判断（「我该怎么做」）。 */
  judgment: string | null
  /** 最近一次的元认知自查（「我这样想对吗」）。 */
  metaCheck: string | null
  /** 最近一次的好奇点。 */
  curiosity: string | null
  /** 它自己的人设自述；没写过就是 null（此时人设段用规则兜底）。 */
  selfPortrait: SelfPortrait | null
  /** 自我写下的思想条数（本会话）。 */
  noteCount: number
  /** 写下思想、但还没被后续行动消解的次数。 */
  openLoops: number
  updatedAt: number
}

/** 一条自我认知。只有证据够了才会被提升为 trait。 */
export interface Trait {
  /** 归一化后的主题键，用于判定「同一件事」。 */
  key: string
  /** 给人看的说法。 */
  label: string
  /** 权重 0..1，决定它进入提示词的优先级。 */
  weight: number
  /** 被印证过几次。 */
  hits: number
  firstAt: number
  lastAt: number
  /** 第一次到最近一次之间跨了几天（判定「反复」而非「一次」）。 */
  spanDays: number
  /** 已经沉淀进内核的时刻。null = 还没沉淀。沉淀过的不会再重复沉淀。 */
  settledAt: number | null
}

/** 关系与习惯（对某个人、对这件事）。 */
export interface RelationState {
  /** 认识多久了（本会话之外的累计轮数）。 */
  turns: number
  thanks: number
  pushbacks: number
  /** 第一次见面时刻（跨会话保留）。 */
  firstSeenAt: number
  /** 最近一次见面时刻。 */
  lastSeenAt: number
}

/**
 * 说话习惯。三档漂移里最快的一档（只受最近几轮影响，出厂都是 0.5）。
 *
 * 四根轴各管一件**互不重叠**的事（v2.4.x 补的第 4 根 + 明确各自的操作定义）：
 *
 * | 轴 | 管的是 | 低（0.3） | 高（0.7） |
 * |---|---|---|---|
 * | `brevity` 简洁 | 说**多少** | 背景和权衡都讲一遍 | 能一句就一句 |
 * | `warmth` 温度 | 什么**口气** | 只给事实，不寒暄 | 先接住情绪再说事 |
 * | `directness` 直给 | 什么**顺序** | 先铺垫再给结论 | 结论第一、理由随后 |
 * | `initiative` 主动 | 给多大**范围** | 只答所问 | 会多给一层：提醒、追问、建议 |
 *
 * 长度 / 语气 / 顺序 / 范围——任意两根都不是同一件事，这也是为什么"简洁"和"直给"
 * 不重复：一个说多长，一个说先说什么。
 *
 * **每根轴都必须有双向的驱动源**（见 `persona.ts` 的 `noteInteraction`）：
 * 只有单向的话，那根轴会一路爬到硬上限就再也下不来。
 */
export interface VoiceState {
  /** 简洁度：越高话越短。 */
  brevity: number
  /** 温度：越高越顺人情。 */
  warmth: number
  /** 直给度：越高越少绕弯。 */
  directness: number
  /** 主动性：越高越会多给一层（提醒、追问、建议）。 */
  initiative: number
}

/** 人设内核。变化最慢的一档（年尺度），且**只有用户能直接改**。 */
export interface KernelState {
  /** 名字/自称，空串表示还没定。 */
  name: string
  /** 价值观排序：键 -> 权重。 */
  values: Record<string, number>
  /** 硬边界：安全底线、破坏性操作纪律。**任何演化路径都不得触碰**。 */
  boundaries: string[]
}

/** 一次内核变化的留痕（可追溯、可回滚）。 */
export interface KernelSnapshot {
  at: number
  /** 改前 -> 改后的 diff，人话描述。 */
  reason: string
  /** 支撑这次变化的证据（信号或其摘要）。 */
  evidence: string[]
  /** 改前的 values，回滚时用它。 */
  values: Record<string, number>
}

/** 人设层状态：同一时刻只有一份，但整体会演化（三层速度不同）。 */
export interface PersonaState {
  voice: VoiceState
  traits: Trait[]
  relation: RelationState
  kernel: KernelState
  /** 内核变化历史，只留最近若干条。 */
  kernelHistory: KernelSnapshot[]
  /** 自我认知被提升过的总次数，用于面板展示"我变了几次"。 */
  driftCount: number
  updatedAt: number
}

/**
 * 记忆的归属层（v2.0）。
 *
 * 为什么要有这个字段：v1.x 里"这条记忆归谁"是靠 `ws` 的四态（缺省 / 空串 / 有值 / null）
 * 反推出来的，推得越多越含糊——空串和缺省都表示全局，`null` 又和"未知工作区"缠在一起。
 * v2.0 把归属直接写成一个字段，`ws` 退回它本来的角色：**工作区键**。
 *
 * - `global` = 关于"人"和跨项目通用的东西，任何会话都看得见；
 * - `workspace` = 绑在某个工作区上（`ws` 必须有值），只在那个工作区里注入；
 * - `session` = 属于某一个会话（写的时候没绑工作区），默认只在本会话里看得见，
 *   也就是会话日记那一层。
 */
export type MemoryScope = 'global' | 'workspace' | 'session'

/** 记忆条目。短期记忆注入上下文；会话/全局记忆要模型主动查。 */
export interface MemoryEntry {
  id: string
  /** 分类：事实 / 约定 / 偏好 / 教训。 */
  kind: 'fact' | 'agreement' | 'preference' | 'lesson'
  text: string
  /** 重要度 0..1，决定注入排序与固化。 */
  importance: number
  /** 被取回过几次（取回会加固）。 */
  hits: number
  createdAt: number
  lastAt: number
  /** 来源缘由，用于"为什么记着这条"。 */
  because: string
  /**
   * 归属层（v2.0 新增）。
   *
   * 老档案里没有这个字段：规范化时按所在列表 + `ws` 的语义补出来，
   * **不替历史编归属**——`ws` 缺省的老条目按全局算。
   */
  scope: MemoryScope
  /**
   * 这条会话记忆写在第几个事件上（v2.0 新增，只有会话层会填）。
   *
   * 会话记忆是"日记"：一条一条往下追加，每条都得能追回当时的那段日志。
   * 不留 seq 的话，过一阵子就只剩一句没有上下文的话，没人知道它从哪来。
   */
  seq?: number
  /**
   * 工作区键（弱绑定，可选）。
   *
   * - 缺省 = 全局：关于"人"的偏好（"用中文回答"）换哪个项目都成立；
   * - 有值 = 只在那个工作区里注入，召回时降权并标「跨工作区」；
   * - `null` = 写的时候不知道自己在哪个工作区（那个会话没绑工作区）。
   *   它既不等于"关于人"（缺省），也不属于任何一个具体项目——只在
   *   同样不知道工作区的会话里才看得见，进了某个项目就不带过去。
   *
   * 为什么不用空串表示这一档：空串已经是"显式全局"了，两者混在一起，
   * 一个没人绑工作区的会话里说的"这个项目用 pnpm"就会被当成"关于人"的话，
   * 跟着它走进每一个项目。
   *
   * 为什么是弱绑定：硬切两半一定丢东西——"先调研再动手"跟哪个项目都有关，
   * 但"这个项目用 pnpm"只属于这里。分级比一刀切更接近人记事情的样子。
   */
  ws?: string | null
  /**
   * 写下这条时所在的会话（**只给 `ws: null` 那一档记**）。
   *
   * 为什么只给这一档：绑了工作区的条目"在哪儿"由 `ws` 就说清了，再存一份会话是重复信息。
   * 而没选工作区的会话在档案里原本无处可寻——它们写下的东西会挤成一堆谁也不认识的条目，
   * 面板上只能合并成一句"未分组会话"。记下 id 才能按会话归组、挂上那个会话自己的标题。
   *
   * 为什么不从会话列表反查：条目可能来自早就删掉的会话，反查不到就丢了归属；
   * 而会话 id 本身就是这份状态所在日志的身份，存它不违背"可重放"。
   */
  sessionId?: string
  /**
   * 这条是谁写的。
   *
   * - `self` = **它自己写下的**（调 `inner_note` 时顺手记的那一句，用它的话说）；
   * - `digest` = **收尾时按规则拼的**（会话要结束了、它自己没来得及写，只能拿手边材料拼一段）；
   * - `heard` = **听来的原话**：v2.2 及以前"从用户话里自动摘句"那条路留下的老条目。
   *   **v2.3 起这条路不再写入**（用户要求「所有的记忆，都让 ai 自己整理生成，不要直接引用
   *   用户的原话」），这个档位现在只用于把老档案如实读出来。
   *
   * 为什么必须分档：用户点名提过"当前想法不该全是我的原话，应该是它自己总结的"。早先摘句是
   * 当"保险"用的（怕它那一轮偷懒没记），结果保险变成了主路——库里堆的是被截断的半句话，还要
   * 跟它自己写的抢位置（短期池只有十几格，摘来的分反而更高）。现在只留它自己写的、以及收尾按
   * 规则拼的那一段；**用户的原话一个字都不入库**。
   *
   * 为什么 `digest` 要单独一档（v2.2）：规则兜底拼出来的那段话**不是它说的**。
   * 早先它被标成 `self`，于是面板与日记都把机器拼的句子当成它的口吻——用户一眼就能看出
   * 不是它写的（"这一段在做什么：[seq 10] …"），信任就是从这里开始掉的。来源必须如实。
   *
   * 老档案里没有这个字段，一律按"听来的"算（那时候还没让它自己写）。
   */
  origin?: 'self' | 'heard' | 'digest'
}

/** 记忆层状态。三层各有一份存放处，别再靠 `ws` 猜。 */
export interface MemoryState {
  /**
   * 短期记忆：会被注入上下文的少量条目。**全量层**——整份重新算、整个覆盖，
   * 不留增量的痕迹（`rewriteShort` 就是干这个的）。
   */
  short: MemoryEntry[]
  /**
   * 会话记忆（v2.0 新增）：**本会话的日记**，增量追加、永不改写旧条目。
   *
   * 到点才写一条（三个总结点见 fold.ts），写进去就不动它——所以它只增不减，
   * 除非被显式遗忘。归属层是 `scope: 'session'`。
   */
  session: MemoryEntry[]
  /**
   * 全局记忆库（v1.x 的 `long` 改名而来）：**全量层**——整理成一份，
   * 整个覆盖；**不注入**，只能靠 recall 工具捞。归属层是 `global` / `workspace`。
   */
  global: MemoryEntry[]
  /**
   * 本会话**已经进过日记**的条目 id（v2.2 新增）。
   *
   * 为什么需要它：收尾兜底要拼日记时，材料必须**只取这一段对话里长出来的**。
   * 早先取的是"手边这一池"（`short` 全量），而短期池是**按工作区**从磁盘载入的——
   * 于是别的会话留下的陈年条目会替这一段代笔："还没解决什么：[seq 433] 你这个包结构…"
   * 那是几个月前的事，跟这一段毫无关系，却写进了它的日记。
   *
   * 用 id 名单而不是 seq 游标：seq 是**会话内**编号，跨会话会互相串（新会话的游标可能
   * 小于旧会话条目的 seq），而 id 是"同一段文本 + 同一时刻"的稳定指纹，跨会话不会撞。
   * 适配层在按工作区载入短期池时，把载入的那批 id 直接标成已消化（它们不是这一段的材料）。
   *
   * 不进档案（跟 `pending` 同理：它是"这一次会话进行到哪了"，不是记忆本身）。
   */
  digested?: string[]
  /** 自上次固化以来累计的信号条数（记忆固化闸门用）。 */
  pendingSignals: number
  /**
   * 遗忘名单：这些 id 不许再出现（手工遗忘与"用工具忘掉"都会记在这里）。
   *
   * 为什么需要一份名单，而不是删掉就算了：手工遗忘（`/mind forget`）是**宿主侧**动作，
   * 不经过会话日志，因此它改不了会话状态（状态只能由日志派生）。名单的作用是
   * 「接管档案时过滤一次、写档案时再过滤一次」——否则下一次落盘就会把刚划掉的那条又写回去。
   */
  forgotten: string[]
  updatedAt: number
}

/** 一次情感脉冲的留痕，给 `/mind why` 用。 */
export interface PulseRecord {
  at: number
  /** 触发的情绪词。 */
  word: string
  /** 来自哪个信号。 */
  kind: SignalKind
  because: string
  /** 带来的强度。 */
  strength: number
}

/**
 * 折叠过程中的近期观察。
 * 「重试 / 自己修好了 / 原地打转」这类信号必须看前后文才能判定，它们暂存在这里。
 */
export interface ProgressState {
  /** 上一个失败的工具。同名再次失败即判为重试。 */
  lastToolError: { name: string; turn: number; at: number } | null
  /** 连续失败次数。 */
  consecutiveErrors: number
  /** 上一轮助手回复的字数（用来自我观察风格，一个很慢的漂移源）。 */
  lastAssistantChars: number
  /** 本回合已经写了几条思想。 */
  notesThisTurn: number
  /** 本回合调了几次工具（判定「原地打转」用）。 */
  toolCallsThisTurn: number
  /** 本回合编号，用来判定「本回合」。 */
  turn: number
  /**
   * 距上一次总结走了多少**步**（v2.0 新增）。
   *
   * **计数单位是步，不是轮**：一次对话会执行很多步（每一步都会有 `step/end`），
   * 按轮数算的话，一轮里干多少活都只算一次，到点总结就永远等不到。
   * 累加规则：`step/end` 加一；`turn/start`（新一轮对话）**归零重数**；
   * `turn/end` 不动它；上下文被压缩（`surfaceOp` 是 replace）也归零；
   * 真写出一次总结之后同样归零。
   */
  steps: number
  /**
   * 「该总结了」的信号（v2.0 新增）。
   *
   * 四个来路都会置上它：按步到点、上下文压缩之后、会话结束、**用户刚说的话里有值得记的**（v2.3）。
   * **置上只是信号**：由总结动作消费（写完一条会话记忆就清掉），
   * 会话结束那次则直接走规则兜底、当轮就写完。
   */
  summaryDue: boolean
  /** 为什么该总结（`null` = 不该）。给注入文案和调试看。 */
  summaryReason: SummaryReason | null
}

/**
 * 「该总结了」的四个来路（DESIGN §22.3）。
 *
 * - `steps` = 按步到点（每 `memorySummarySteps` 步）；
 * - `compaction` = 上下文刚被压缩过（`surfaceOp` 是 replace），前面那一段的账要结掉；
 * - `final` = 会话要结束了，这是最后一次机会，只能规则兜底；
 * - `signal` = **用户刚说的话里出现了值得记的东西**（v2.3）。这条路上以前是"把原话摘下来先
 *   攒着"，现在只点信号，让它用自己的话写一条（见 `memory.ts` 的 `worthRemembering`）。
 */
export type SummaryReason = 'steps' | 'compaction' | 'final' | 'signal'

/**
 * 上下文表面操作（v2.0 新增，DESIGN §22.3 触发点②）。
 *
 * `'append'` = 平常的一次追加，什么都不用做；
 * `{ op: 'replace', startSeq, endSeq }` = `[startSeq, endSeq]` 这段事件被整体换掉，
 * 也就是**上下文压缩**——它就是"该总结了"的第二个来路。
 */
export type SurfaceOp = 'append' | { op: 'replace'; startSeq: number; endSeq: number }

/** 会话内状态的根。它整体由会话日志折叠而来，可重放。 */
export interface MindState {
  affect: AffectState
  thought: ThoughtState
  persona: PersonaState
  memory: MemoryState
  /**
   * 本会话的工作区键：`init` 时由会话头的 cwd 算出，之后不再变。
   *
   * 空串 = 未知（拿不到 cwd）：那就只认全局条目，别的项目的东西一条都不注入。
   * 会话头是会话身份的一部分，所以由它派生的这个字段仍然可回放。
   */
  workspace: string
  /**
   * 本会话的 id：`init` 时由会话头填进来，之后不再变。
   *
   * 为什么状态里要留一份：没选工作区的会话写下的记忆要标出处（面板才知道"这是哪个会话说的"）。
   * 会话 id 是会话身份的一部分（`SessionHeader.id`），跟 `workspace` 一样由头派生，**仍然可回放**。
   * 空串 = 拿不到（老日志 / 测试里没有头），那就只好不标。
   */
  session: string
  progress: ProgressState
  /** 最近若干次脉冲，供解释用（会被截断，不无限增长）。 */
  pulses: PulseRecord[]
  /** 折叠过的事件条数，用于自检。 */
  folded: number
  updatedAt: number
}

/** 跨会话持久的部分：**会话投影之外**要留住的东西。 */
export interface MindPersist {
  version: number
  /** 人设整体（含 traits / kernel / 快照），跨会话保留同一份。 */
  persona: PersonaState
  /**
   * 演化后的**性情基线**（跟着心境慢慢漂出来的）。
   *
   * 它属于"我是谁"：长期在挫败里磨的 agent，静息状态本就该比出厂时低一点。
   * 不带走它，"性情会变"就只在单次会话内成立，每次新会话又回到出厂设定——那是假的。
   *
   * 注意：**出厂基线不在档案里**，它永远等于配置里的 `baseline`（锚点必须由外部定，
   * 否则漂移就没有参照物，也就没法"有界"）。
   */
  baseline: Vector3
  /**
   * 记忆三层（v2.0）。
   *
   * 注意：**会话记忆是"某一次会话的日记"，不属于跨会话档案**。core 的档案形状
   * 仍然带着它（好让适配层按会话写进 `sessions/<id>/memory.json`），但接管档案
   * （`adopt`）只带回全局层，绝不让上一次会话的日记串进新会话。
   */
  memory: MemoryState
  /** 累计统计，面板用。 */
  stats: MindStats
  savedAt: number
}

/** 累计统计。 */
export interface MindStats {
  sessions: number
  turns: number
  pulses: number
  notes: number
  recalls: number
  kernelChanges: number
  /** 主动开口过多少次。 */
  proactive: number
  /**
   * 上一次主动开口的时间戳（0 = 从没开过口）。
   *
   * 它跟统计放在一起只是因为**都得落盘**：冷却时间是按"距上次多久"算的，
   * 存在内存里的话，重启一次它就会忘记自己刚说过话，于是又开始聒噪。
   */
  lastProactiveAt: number
}
