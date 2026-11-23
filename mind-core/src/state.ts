/**
 * 初始状态与状态规范化。
 *
 * 为什么需要 `normalize`：
 * 会话投影的 `stateSchema`（zod）会**剥掉未声明的键**，而且跨会话持久层是磁盘 JSON，
 * 可能来自更老的版本。任何一个字段缺失，都会表现为"插件看起来在跑，但某一块永远是空的"。
 * 所以：**读进来先 normalize，写完再落盘**。
 */

import { DEFAULT_TUNABLES, type MindTunables } from './config.js'
import type {
  AffectState,
  MemoryEntry,
  MemoryScope,
  MemoryState,
  MindPersist,
  MindState,
  MindStats,
  PersonaState,
  ProgressState,
  ThoughtState,
  Trait,
  VoiceState,
} from './types.js'

/** 初始情感：就在基线上，没有情绪。 */
export function emptyAffect(t: MindTunables, now: number): AffectState {
  return {
    baseline: { ...t.baseline },
    current: { ...t.baseline },
    mood: { ...t.baseline },
    emotions: [],
    updatedAt: now,
  }
}

/** 初始思想：干净。 */
export function emptyThought(now: number): ThoughtState {
  return {
    tension: 0,
    intent: null,
    judgment: null,
    metaCheck: null,
    curiosity: null,
    selfPortrait: null,
    noteCount: 0,
    openLoops: 0,
    updatedAt: now,
  }
}

/** 初始说话习惯：不短不长，不过分热情，不绕弯，不多也不少给。 */
export function emptyVoice(): VoiceState {
  return { brevity: 0.5, warmth: 0.5, directness: 0.5, initiative: 0.5 }
}

/** 初始人设：内核为空（等用户填 persona.md），没有任何自我认知。 */
export function emptyPersona(now: number): PersonaState {
  return {
    voice: emptyVoice(),
    traits: [],
    relation: { turns: 0, thanks: 0, pushbacks: 0, firstSeenAt: now, lastSeenAt: now },
    kernel: { name: '', values: {}, boundaries: [] },
    kernelHistory: [],
    driftCount: 0,
    updatedAt: now,
  }
}

/** 初始记忆：三层都空（短期 / 本会话日记 / 全局）。 */
export function emptyMemory(now: number): MemoryState {
  return {
    short: [],
    session: [],
    global: [],
    // "这一段已经进过日记的条目"是**一等字段**：它必须在状态里完整地出生、被规范化接住、
    // 被后续事件看见（理由见 types.ts 的 `digested`）。
    digested: [],
    pendingSignals: 0,
    forgotten: [],
    updatedAt: now,
  }
}

/** 初始折叠观察。 */
export function emptyProgress(turn: number): ProgressState {
  return {
    lastToolError: null,
    consecutiveErrors: 0,
    lastAssistantChars: 0,
    notesThisTurn: 0,
    toolCallsThisTurn: 0,
    turn,
    // 步计数**单位是步不是轮**，所以从 0 起（`turn/start` 也会把它归零）
    steps: 0,
    summaryDue: false,
    summaryReason: null,
  }
}

/** 会话状态根。 */
export function emptyState(t: MindTunables = DEFAULT_TUNABLES, now = 0): MindState {
  return {
    affect: emptyAffect(t, now),
    thought: emptyThought(now),
    persona: emptyPersona(now),
    memory: emptyMemory(now),
    // 空串 = 还没拿到会话头（适配层在 `init` 里按 cwd 填）。它不随时间变化。
    workspace: '',
    // 同上：会话 id 也由会话头填，拿不到就是空串（这时未分组会话的记忆不标出处）。
    session: '',
    progress: emptyProgress(0),
    pulses: [],
    folded: 0,
    updatedAt: now,
  }
}

/** 初始累计统计。 */
export function emptyStats(): MindStats {
  return {
    sessions: 0,
    turns: 0,
    pulses: 0,
    notes: 0,
    recalls: 0,
    kernelChanges: 0,
    proactive: 0,
    lastProactiveAt: 0,
  }
}

/** 跨会话持久层的初始内容。 */
export function emptyPersist(now = 0, t: MindTunables = DEFAULT_TUNABLES): MindPersist {
  return {
    version: 1,
    persona: emptyPersona(now),
    baseline: { ...t.baseline },
    memory: emptyMemory(now),
    stats: emptyStats(),
    savedAt: now,
  }
}

// ─────────────────────────────────────────────────────────
// 规范化：把任何来源的数据收敛成合法的完整形状
// ─────────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function vec(v: unknown, fallback: { valence: number; arousal: number; dominance: number }) {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    valence: num(o['valence'], fallback.valence),
    arousal: num(o['arousal'], fallback.arousal),
    dominance: num(o['dominance'], fallback.dominance),
  }
}

function normalizeTrait(v: unknown): Trait | null {
  const o = (v ?? {}) as Record<string, unknown>
  const key = str(o['key'])
  if (!key) return null
  return {
    key,
    label: str(o['label'], key),
    weight: num(o['weight'], 0.5),
    hits: num(o['hits'], 1),
    firstAt: num(o['firstAt'], 0),
    lastAt: num(o['lastAt'], 0),
    spanDays: num(o['spanDays'], 0),
    settledAt: typeof o['settledAt'] === 'number' ? o['settledAt'] : null,
  }
}

/** 规范化人设。 */
export function normalizePersona(raw: unknown, now: number): PersonaState {
  const fallback = emptyPersona(now)
  const o = (raw ?? {}) as Record<string, unknown>
  const voice = (o['voice'] ?? {}) as Record<string, unknown>
  const relation = (o['relation'] ?? {}) as Record<string, unknown>
  const kernel = (o['kernel'] ?? {}) as Record<string, unknown>
  const values = (kernel['values'] ?? {}) as Record<string, unknown>
  const cleanValues: Record<string, number> = {}
  for (const [k, v] of Object.entries(values)) {
    const n = num(v, Number.NaN)
    if (Number.isFinite(n)) cleanValues[k] = n
  }
  return {
    voice: {
      brevity: num(voice['brevity'], fallback.voice.brevity),
      warmth: num(voice['warmth'], fallback.voice.warmth),
      directness: num(voice['directness'], fallback.voice.directness),
      // 老档案里没有这一根：缺就退回出厂 0.5，不替历史编一个值
      initiative: num(voice['initiative'], fallback.voice.initiative),
    },
    traits: arr<unknown>(o['traits']).map(normalizeTrait).filter((x): x is Trait => x !== null),
    relation: {
      turns: num(relation['turns'], 0),
      thanks: num(relation['thanks'], 0),
      pushbacks: num(relation['pushbacks'], 0),
      firstSeenAt: num(relation['firstSeenAt'], now),
      lastSeenAt: num(relation['lastSeenAt'], now),
    },
    kernel: {
      name: str(kernel['name']),
      values: cleanValues,
      boundaries: arr<unknown>(kernel['boundaries']).map((b) => str(b)).filter(Boolean),
    },
    kernelHistory: arr<unknown>(o['kernelHistory']).map((h) => {
      const s = (h ?? {}) as Record<string, unknown>
      return {
        at: num(s['at'], 0),
        reason: str(s['reason']),
        evidence: arr<unknown>(s['evidence']).map((e) => str(e)),
        values: (s['values'] ?? {}) as Record<string, number>,
      }
    }),
    driftCount: num(o['driftCount'], 0),
    updatedAt: num(o['updatedAt'], now),
  }
}

/** 规范化情感。 */
export function normalizeAffect(raw: unknown, t: MindTunables, now: number): AffectState {
  const o = (raw ?? {}) as Record<string, unknown>
  const base = vec(o['baseline'], t.baseline)
  return {
    baseline: base,
    current: vec(o['current'], base),
    mood: vec(o['mood'], base),
    emotions: arr<unknown>(o['emotions'])
      .map((e) => {
        const s = (e ?? {}) as Record<string, unknown>
        const word = str(s['word'])
        if (!word) return null
        return {
          word,
          strength: num(s['strength'], 0),
          at: num(s['at'], now),
          count: num(s['count'], 1),
        }
      })
      .filter((x): x is AffectState['emotions'][number] => x !== null),
    updatedAt: num(o['updatedAt'], now),
  }
}

/** 规范化思想。 */
export function normalizeThought(raw: unknown, now: number): ThoughtState {
  const o = (raw ?? {}) as Record<string, unknown>
  const maybe = (k: string): string | null => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : null)
  // 老档案没有 `selfPortrait`（2026-11-23 才加的）→ 补成 null，走规则兜底
  const rawPortrait = o['selfPortrait']
  const portraitRecord = (rawPortrait ?? null) as Record<string, unknown> | null
  const portraitText = portraitRecord !== null && typeof portraitRecord === 'object' && typeof portraitRecord['text'] === 'string'
    ? (portraitRecord['text'] as string)
    : ''
  const selfPortrait =
    portraitText !== ''
      ? { text: portraitText, at: num(portraitRecord?.['at'], now) }
      : null
  return {
    tension: num(o['tension'], 0),
    intent: maybe('intent'),
    judgment: maybe('judgment'),
    metaCheck: maybe('metaCheck'),
    curiosity: maybe('curiosity'),
    selfPortrait,
    noteCount: num(o['noteCount'], 0),
    openLoops: num(o['openLoops'], 0),
    updatedAt: num(o['updatedAt'], now),
  }
}

/**
 * 老档案里没有 `scope` 这个字段：按"它住在哪个名单里 + `ws` 当年是什么意思"补出来。
 *
 * v1.x 是靠 `ws` 的四态**猜**归属的；v2.0 把归属写成字段，所以这里要把老条目补上。
 * 补出来的只是"它本来就该算哪一层"，不是给它编一段故事。
 */
function inheritScope(
  explicit: unknown,
  list: 'short' | 'session' | 'global' | 'legacy',
  ws: string | null | undefined,
  sessionId: string | undefined,
): MemoryScope {
  // 新档案自己写了归属：照它说的算
  if (explicit === 'global' || explicit === 'workspace' || explicit === 'session') return explicit
  // 住在日记名单里的，当然是会话记忆
  if (list === 'session') return 'session'
  // 老口径里 `ws: null` + 具体会话 = "某个没绑工作区的会话说的"——正是日记那一档（DESIGN §22.8）
  if (ws === null && sessionId !== undefined) return 'session'
  // 绑了具体工作区的老条目：归属是**工作区**（住处仍是全局库，只是带着 `where` 这个标记）
  if (typeof ws === 'string' && ws !== '') return 'workspace'
  // 其余（`ws: ''` 的偏好、以及 `ws` 缺省的老档案）都算全局。
  // 缺省的那些**不替历史编归属**：它们只是"当年没有这个概念"，不是"关于某个会话"。
  return 'global'
}

/** 规范化记忆（三层：短期 / 本会话日记 / 全局）。 */
export function normalizeMemory(raw: unknown, now: number): MemoryState {
  const o = (raw ?? {}) as Record<string, unknown>
  // 返回类型要显式写出来：不写的话 TS 会把 `origin` 推成字面量 `'self'` 一种，
  // 后面那个 `x is MemoryEntry` 的收窄就会报 TS2677（"heard" 不在推断出来的类型里）。
  const entry = (v: unknown, list: 'short' | 'session' | 'global' | 'legacy'): MemoryEntry | null => {
    const s = (v ?? {}) as Record<string, unknown>
    const text = str(s['text'])
    if (!text) return null
    const kind = str(s['kind'], 'fact')
    // 老条目没有 `ws` 字段：**保持缺省**，别补空串——缺省是"当年没有这个字段"（未标注），
    // 与"显式全局（关于人）"不是一回事。三种状态的差别见下面那行展开。
    const ws = typeof s['ws'] === 'string' || s['ws'] === null ? (s['ws'] as string | null) : undefined
    // 会话 id 只跟 `ws: null` 一起出现（有工作区的条目"在哪儿"已经说清楚了）。
    const sessionId =
      ws === null && typeof s['sessionId'] === 'string' && s['sessionId'] !== '' ? s['sessionId'] : undefined
    return {
      id: str(s['id'], `m${Math.round(num(s['createdAt'], now))}`),
      kind: (['fact', 'agreement', 'preference', 'lesson'] as const).includes(kind as 'fact')
        ? (kind as 'fact' | 'agreement' | 'preference' | 'lesson')
        : ('fact' as const),
      text,
      importance: num(s['importance'], 0.5),
      hits: num(s['hits'], 0),
      createdAt: num(s['createdAt'], now),
      lastAt: num(s['lastAt'], now),
      because: str(s['because']),
      // v2.0 新字段，**必须在这里接住**，否则规范化一轮就静默丢了（老条目按老口径补出来）
      scope: inheritScope(s['scope'], list, ws, sessionId),
      // 三种"在哪儿"逐字保留：`null` 未分组会话、`''` 显式全局（关于人）、缺省 老档案。
      // 以前把 `''` 折成缺省，于是偏好被当成年老数据，面板的"关于你"那组永远出不来。
      ...(ws !== undefined ? { ws } : {}),
      // 不在这里接住的话，规范化一轮就把它丢了——第一次折叠之后面板就再也查不到
      // "这条是哪个没选工作区的会话说的"，而且是静默的。
      ...(sessionId !== undefined ? { sessionId } : {}),
      // 谁写的：`self` = 它自己写的（缺省 = 从用户原话里摘的），`digest` = 收尾时按规则拼的。
      // 这里不接住的话，规范化一轮就丢了——面板会把"它自己总结的"重新显示成"听来的原话"，
      // 或者把机器拼的一段冒充成它的口吻，两种都是用户点名不许发生的事。
      ...(s['origin'] === 'self' || s['origin'] === 'heard' || s['origin'] === 'digest'
        ? { origin: s['origin'] as NonNullable<MemoryEntry['origin']> }
        : {}),
      // 会话记忆写在第几个事件上（可回到日志）。同样，不接住就等于没有。
      ...(typeof s['seq'] === 'number' && Number.isFinite(s['seq']) ? { seq: s['seq'] } : {}),
    }
  }
  const short = arr<unknown>(o['short'])
    .map((v) => entry(v, 'short'))
    .filter((x): x is MemoryEntry => x !== null)
  // `long` 是 v1.x 的名字。两处同时存在时以 `global` 为准（否则同一批条目会被读两遍）
  const legacy = arr<unknown>(o['global']).length > 0 ? [] : arr<unknown>(o['long'])
  const rest = [
    ...arr<unknown>(o['session']).map((v) => entry(v, 'session')),
    ...legacy.map((v) => entry(v, 'legacy')),
    ...arr<unknown>(o['global']).map((v) => entry(v, 'global')),
  ].filter((x): x is MemoryEntry => x !== null)
  // 重建完按归属**分家**：会话层的进日记，其余进全局库。
  // 老档案里"没绑工作区 + 有 sessionId"的条目，就是在这里搬到日记那一档的（DESIGN §22.8）。
  return {
    short,
    session: rest.filter((e) => e.scope === 'session'),
    global: rest.filter((e) => e.scope !== 'session'),
    // 一律物化成数组（而不是留着 undefined）：规范化出来的形状必须是**完整**的，
    // 否则"某个字段悄悄不见了"这种事还会再来一次。
    // 已消化的 id 名单（只给收尾取材用）：留最近 200 个就够——短期池本身只装得下十几条
    digested: arr<unknown>(o['digested'])
      .filter((x): x is string => typeof x === 'string')
      .slice(-200),
    pendingSignals: num(o['pendingSignals'], 0),
    forgotten: arr<unknown>(o['forgotten'])
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 500),
    updatedAt: num(o['updatedAt'], now),
  }
}

/** 规范化折叠观察。 */
export function normalizeProgress(raw: unknown, turn = 0): ProgressState {
  const o = (raw ?? {}) as Record<string, unknown>
  const err = o['lastToolError'] as Record<string, unknown> | null | undefined
  return {
    lastToolError:
      err && typeof err === 'object'
        ? { name: str(err['name']), turn: num(err['turn'], 0), at: num(err['at'], 0) }
        : null,
    consecutiveErrors: num(o['consecutiveErrors'], 0),
    lastAssistantChars: num(o['lastAssistantChars'], 0),
    notesThisTurn: num(o['notesThisTurn'], 0),
    toolCallsThisTurn: num(o['toolCallsThisTurn'], 0),
    turn: num(o['turn'], turn),
    // 步计数与「该总结了」：老档案里没有这几个字段，回落成"刚归零、不欠总结"。
    // **计数单位是步不是轮**——它和 `turn` 不是一回事（一次对话要走很多步）。
    steps: num(o['steps'], 0),
    summaryDue: o['summaryDue'] === true,
    summaryReason:
      o['summaryReason'] === 'steps' ||
      o['summaryReason'] === 'compaction' ||
      o['summaryReason'] === 'final' ||
      o['summaryReason'] === 'signal'
        ? o['summaryReason']
        : null,
  }
}

/**
 * 规范化整个会话状态。
 * 投影 hydrate / 冷读 / 版本升级都走这里，保证拿到的永远是一个完整合法的对象。
 */
export function normalizeState(raw: unknown, t: MindTunables = DEFAULT_TUNABLES, now = 0): MindState {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    affect: normalizeAffect(o['affect'], t, now),
    thought: normalizeThought(o['thought'], now),
    persona: normalizePersona(o['persona'], now),
    memory: normalizeMemory(o['memory'], now),
    // 老状态没有 workspace：回落成空串（未知工作区 = 只认全局条目），不炸
    workspace: str(o['workspace']),
    // 老状态也没有会话 id：回落成空串（这时未分组会话的记忆不标出处，是坦白不是编造）
    session: str(o['session']),
    progress: normalizeProgress(o['progress']),
    pulses: arr<unknown>(o['pulses'])
      .map((p) => {
        const s = (p ?? {}) as Record<string, unknown>
        const word = str(s['word'])
        if (!word) return null
        return {
          at: num(s['at'], 0),
          word,
          kind: str(s['kind'], 'idle') as MindState['pulses'][number]['kind'],
          because: str(s['because']),
          strength: num(s['strength'], 0),
        }
      })
      .filter((x): x is MindState['pulses'][number] => x !== null),
    folded: num(o['folded'], 0),
    updatedAt: num(o['updatedAt'], now),
  }
}

/** 规范化跨会话持久层。 */
export function normalizePersist(
  raw: unknown,
  now = 0,
  t: MindTunables = DEFAULT_TUNABLES,
): MindPersist {
  const o = (raw ?? {}) as Record<string, unknown>
  const stats = (o['stats'] ?? {}) as Record<string, unknown>
  return {
    version: num(o['version'], 1),
    persona: normalizePersona(o['persona'], now),
    baseline: vec(o['baseline'], t.baseline),
    memory: normalizeMemory(o['memory'], now),
    stats: {
      sessions: num(stats['sessions'], 0),
      turns: num(stats['turns'], 0),
      pulses: num(stats['pulses'], 0),
      notes: num(stats['notes'], 0),
      recalls: num(stats['recalls'], 0),
      kernelChanges: num(stats['kernelChanges'], 0),
      proactive: num(stats['proactive'], 0),
      lastProactiveAt: num(stats['lastProactiveAt'], 0),
    },
    savedAt: num(o['savedAt'], now),
  }
}

/** 只保留需要跨会话带走的部分。 */
export function toPersist(state: MindState, stats: MindStats, now: number): MindPersist {
  return {
    version: 1,
    persona: state.persona,
    baseline: state.affect.baseline,
    // `digested` 是**这一次会话进行到哪了**，不是记忆本身，所以落盘前清掉（下个会话没有
    // "这一段"）：档案是"这些记忆现在长什么样"的快照。注意这**不是**"可以随便丢"的理由——
    // 运行时它必须完整活着（规范化要接住），丢的只是档案里那一份。
    // 三层（短期 / 本会话日记 / 全局）都原样带走；
    // 下一个会话要不要读其中某一层，由 `adopt` 决定（它只带回全局层，日记不跨会话串味）。
    memory: { ...state.memory, digested: [] },
    stats,
    savedAt: now,
  }
}

/** 调试用：这份配置是否是默认值（面板上标「默认」）。 */
export function isDefaultTunables(t: MindTunables): boolean {
  return JSON.stringify(t) === JSON.stringify(DEFAULT_TUNABLES)
}
