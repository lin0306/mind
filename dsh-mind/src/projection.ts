/**
 * 会话投影：状态的**唯一**正统载体。
 *
 * 三条纪律（违反任何一条，状态就不再可回放）：
 * 1. `apply` 同步、纯：时间一律取 `event.time`，**从不调用 `Date.now()`**；
 * 2. 对无关事件**返回同一个状态引用**（注册表用 `Object.is` 做第一层闸门，
 *    引用不变即零下游工作。它会拿到 `assistant/stream` 这类高频事件，那些必须原样返回）；
 * 3. 没有写入 API —— 想改状态只能改"会话日志里的事件"，再由 `apply` 折出来。
 *    所以 `inner_note` 这类动作不需要新事件类型：它天然落在 `tool/call` 事件里。
 */

import {
  KIND_LABEL,
  applyEvent,
  describeEmotions,
  describeMemory,
  describePersona,
  describeShort,
  describeThought,
  dominantEmotion,
  emptyState,
  memoryCounts,
  normalizeState,
  allWords,
  wordOf,
  type MemoryEntry,
  type MemoryState,
  type MindState,
  type MindTunables,
  type SessionEventLike,
} from 'dsh-mind-core'
import {
  resolveModule,
  type Disposable,
  type ProjectionDefinition,
  type ProjectionHandle,
  type SessionProjectionsService,
} from './host.js'
import { logger } from './log.js'

/** 投影键。改折叠语义时必须同时 +1 `STATE_VERSION`。 */
export const PROJECTION_KEY = 'mind'
/**
 * 状态版本：宿主冷读会丢弃版本不匹配的持久行。
 *
 * v2：多了 `workspace`（工作区键）。老投影缓存里没有这个键，不升版本会被 zod
 * 的 `object()` 剥掉，于是"工作区永远为空"——而插件表面一切正常。
 *
 * v3：多了 `session`（会话 id）。同样的坑：不升版本，缓存里那份状态没有这个键，
 * 未分组会话写下的记忆就永远标不出出处。
 */
export const STATE_VERSION = 3

/** 会话状态里**必须**存在的顶层键（zod 降级 shim 与自检都用它）。 */
export const STATE_KEYS = ['affect', 'thought', 'persona', 'memory', 'workspace', 'session', 'progress', 'pulses', 'folded', 'updatedAt'] as const

/** zod 是否可用（诊断输出要如实报告）。 */
export const hasZod = (() => {
  const loaded = resolveModule('zod', 'zod')
  if (loaded === null || typeof loaded !== 'object') return false
  const z = loaded as Record<string, unknown>
  return typeof z['object'] === 'function'
})()

/**
 * 状态 schema。
 *
 * 用 zod 是**有代价**的：zod 的 `object()` 默认**剥掉未声明的键**，
 * 漏一个字段 = 每轮 hydrate 之后那份数据凭空消失，而插件表面还在正常工作。
 * 所以顶层八个数全声明，**内部一律 `z.any()`**——内部完整性由 core 的
 * `normalizeState` 负责（它本来就容忍缺字段与老版本数据）。
 * 另外有一条测试专盯这件事：`emptyState()` 过一遍 `parse` 再深比较。
 */
export function buildStateSchema(): unknown {
  const loaded = resolveModule('zod', 'zod')
  const z = (loaded as Record<string, (...args: any[]) => any> | null)?.['object'] ? (loaded as Record<string, any>) : null
  if (z === null) return fallbackSchema()

  try {
    const anyNode = z['any']?.()
    const numberNode = z['number']?.()
    if (anyNode === undefined || numberNode === undefined) return fallbackSchema()
    return z['object']?.({
      affect: anyNode,
      thought: anyNode,
      persona: anyNode,
      memory: anyNode,
      // 工作区键是字符串（空串 = 未知），用 string 节点而不是 any：
      // 它是要参与"本工作区 / 全局"判定的值，形状必须可预期
      workspace: z['string']?.() ?? anyNode,
      // 会话 id 同样是字符串（空串 = 拿不到头）。它只用来标"这条记忆是哪个会话写的"
      session: z['string']?.() ?? anyNode,
      progress: anyNode,
      pulses: z['array']?.(anyNode) ?? anyNode,
      folded: numberNode,
      updatedAt: numberNode,
    })
  } catch {
    return fallbackSchema()
  }
}

/** zod 缺失时的浅校验：只确认顶层键都在。 */
function fallbackSchema(): unknown {
  return {
    parse(value: unknown): unknown {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('dsh-mind: 状态不是对象')
      }
      for (const key of STATE_KEYS) {
        if (!(key in (value as Record<string, unknown>))) {
          throw new TypeError(`dsh-mind: 状态缺键 ${key}`)
        }
      }
      return value
    },
    _dshMind: 'fallback',
  }
}

/**
 * 视图 schema。
 *
 * 契约要求 `wire` **同时**给 `viewSchema` 与 `view`（`ProjectionDefinition` 里它们是一个整体）：
 * 宿主把值交给客户端之前会先过 `viewSchema`。早先这里只写了 `view`，
 * 于是"客户端可见"这件事根本不成形——面板拿不到任何数据，而插件表面上一切正常。
 *
 * 视图是**中枢自己造的**形状（不是用户数据），所以校验从宽：zod 在就用 zod，
 * 不在就只查"有没有 sections 数组"。
 */
export function buildViewSchema(): unknown {
  const loaded = resolveModule('zod', 'zod')
  const z = (loaded as Record<string, (...args: any[]) => any> | null)?.['object']
    ? (loaded as Record<string, any>)
    : null
  if (z !== null) {
    try {
      const anyNode = z['any']?.()
      const arrayNode = z['array']?.(anyNode)
      // ⚠️ zod 的 `object()` 会**剥掉没声明的键**：这里少写一个键，
      // 客户端拿到的视图里那个字段就永远不存在（而且是静默的）。
      // 所以 MindView 每加一个字段，这份 schema 必须同步加一行。
      const built = z['object']?.({
        summary: z['string']?.(),
        emotion: anyNode,
        sections: arrayNode,
        text: z['string']?.(),
        emotions: arrayNode,
        emotionWords: arrayNode,
        tension: z['number']?.(),
        thoughtAt: z['number']?.(),
        selfPortrait: anyNode,
        folded: z['number']?.(),
        mood: anyNode,
        voice: anyNode,
        voiceTraits: arrayNode,
        shortMemory: arrayNode,
        shortGroups: arrayNode,
        sessionMemory: arrayNode,
        longGroups: arrayNode,
        memoryKinds: arrayNode,
      })
      if (built !== undefined && built !== null) return built
    } catch {
      /* 落到浅校验 */
    }
  }
  return {
    parse(value: unknown): unknown {
      if (value === null || typeof value !== 'object' || !Array.isArray((value as MindView).sections)) {
        throw new TypeError('dsh-mind: 视图缺 sections')
      }
      return value
    },
    _dshMind: 'view-fallback',
  }
}

/**
 * 客户端视图（v1.5 面板用）。
 *
 * 设计取舍：面板要什么，这里就带什么，而且**文本已经在中枢格式化好**
 * （`sections[].lines`）。客户端因此是个"画出来"的哑组件——中文措辞只有一处真相，
 * 不会出现"面板上一套说法、命令里另一套说法"这种慢慢跑偏的事。
 */
export interface MindView {
  /** 一句话现状（侧栏 tooltip 与面板首行用）。 */
  summary: string
  /** 此刻的主情绪词（没有就是 null）。 */
  emotion: string | null
  /** 一屏四区：每区一个标题 + 若干行。 */
  sections: { title: string; lines: string[] }[]
  /** ── 以下是早期视图形状，保留给已有断言与将来的图表用 ── */
  text: string
  /**
   * 当前的情绪与强度（各自独立，加起来不等于 1——面板据此画玫瑰图，不是画占比）。
   *
   * 每项还带三样东西，专供鼠标悬浮时那句说明：
   * `inner`＝词表里"这个情绪是什么意思"的原话（不是我编的解释）；
   * `because`＝最近一次点起它时那条信号写下的触发缘由；
   * `count` / `lastAt`＝这一段里被点起过几次、最近哪一次。
   */
  emotions: { word: string; strength: number; inner: string; because: string; count: number; lastAt: number }[]
  /**
   * 词表的**全序**（14 个词名，固定顺序）。
   *
   * 面板拿它给每个词分一个**固定的扇区槽位**：同一个情绪永远在同一根柱的位置，
   * 两次刷新才能对比（按"当前有几个情绪"重排的话，每次形状都变，等于不能比）。
   * 客户端不许自己硬编码这份顺序——那是一份会和内核词表漂移的第二真相。
   */
  emotionWords: string[]
  tension: number
  /**
   * 它**最近一次**写下内心记录的时间（0 = 这个会话里从没写过）。
   *
   * 为什么要给时间：`state.thought` 里的判断/自查/好奇是"最近一次"而不是"这一轮"——
   * 它可能好几天没调 `inner_note` 了，面板若写"它这一轮的内心记录"就是在骗人
   * （用户盯着一条两天前的记录问过）。有了这个时间戳，面板才能如实说"最近一次"。
   */
  thoughtAt: number
  /**
   * 它自己写的人设自述（`inner_note` 的 `selfPortrait` 参数）。
   *
   * 面板要显示"它怎么看自己"以及这份自述写于何时（过时了要标出来）；
   * 没写过就是 null——此时注入侧走规则兜底，面板如实说"还没写过"。
   */
  selfPortrait: { text: string; at: number } | null
  /** 本会话折叠过多少事件。 */
  folded: number
  /**
   * ── 面板要**画**（饼、条、分组），所以除了上面的文字，再给一份结构化数据 ──
   *
   * 为什么两套都给：文字那一套是给 `/mind` 命令和注入用的（措辞唯一真相在 core），
   * 结构化这一套只给面板画图。两套都从同一个 state 出来，不会打架。
   */
  mood: { valence: number; arousal: number; dominance: number }
  /** 说话习惯四轴（0–1，出厂 0.5）+ 允许漂移的半径。 */
  voice: {
    brevity: number
    warmth: number
    directness: number
    initiative: number
    drift: number
  }
  /**
   * 候选中的自我认知（还没沉淀进内核的那些）。
   *
   * 只给 `label` 和两个计数：面板要让人看见"它正往哪个方向认识自己"，
   * 而不是一行"5 条"了事。
   */
  voiceTraits: { label: string; hits: number; spanDays: number }[]
  /** 本会话的手边记忆（短期），平铺一份；面板改为按项目折叠后用它。 */
  shortMemory: MemoryView[]
  /**
   * 手边记忆**按工作区分组**（标题就是项目路径，见 `groupByWorkspace`）。
   *
   * 为什么不复用 `shortMemory` 让客户端自己分：路径与措辞只在服务端有一处真相，
   * 也省得客户端再实现一遍"没标注"那一档。
   */
  shortGroups: MemoryGroupView[]
  /**
   * **本会话的日记**（只增不改），按时间正序给最近若干条。
   *
   * 与短期、跨会话库分开给：三者的更新语义完全不同（全量覆盖 / 只追加 / 全量整理），
   * 面板上混在一起就没法解释"为什么这条不能改、那条会消失"。
   */
  sessionMemory: MemoryView[]
  /** 跨会话库**按工作区分组**（本项目 / 全局 / 其他项目），每组只带前若干条。 */
  longGroups: MemoryGroupView[]
  /** 跨会话库按类型的分布（画饼）。 */
  memoryKinds: { kind: string; label: string; count: number }[]
}

/** 一条记忆在视图里的样子（面板只负责画，不再自己措辞）。 */
export interface MemoryView {
  kind: string
  label: string
  text: string
  hits: number
  at: number
  because: string
  /**
   * 谁写的：`self` = 它自己写下的（`inner_note` 的 remember 参数），
   * `digest` = 收尾时按规则拼的（它自己没来得及写），`heard` = 从用户原话里摘的兜底。
   *
   * 为什么面板必须看见这个：用户问过"当前想法怎么都是我发的内容，不应该都是它自己总结的吗"——
   * 三种来源得在界面上一眼分得开，不能长得一样。缺省（老档案）按 `heard` 算，老实交代。
   */
  origin: 'self' | 'heard' | 'digest'
  /**
   * 这条记忆属于谁：本项目 / 未标注 / 全局（关于你） / 其他项目。
   * 面板靠它把"当前想法"分成两组——全局那组要做到项目无关，本项目的这组只在本项目里出现。
   *
   * `unknown` 是"这条记下来的时候，插件还不会记工作区"：老档案里只有 `ws: undefined`。
   * 它现在是全项目可见的（那就等于全局），但**不能就写成全局**——用户一眼就看出来
   * "这明明是我在这个项目里说的，怎么算全局的"。没标注就说没标注。
   *
   * `ungrouped` 是"写下的时候，那个会话没选工作区"（`ws: null`）。它跟 `unknown` 分开：
   * unknown 是插件没本事记，ungrouped 是当时确实不在任何项目里。可见范围也不同——
   * ungrouped 只在同样没选工作区的会话里看得见，进了具体项目就不显示。
   */
  scope: 'here' | 'unknown' | 'ungrouped' | 'global' | 'other'
}

/** 长期记忆的一组（一个工作区一组）。 */
export interface MemoryGroupView {
  scope: 'here' | 'unknown' | 'ungrouped' | 'global' | 'other'
  key: string
  label: string
  count: number
  entries: MemoryView[]
  /**
   * 未分组会话的组：这条记忆是哪个会话写下的。
   *
   * 只在这一档有值。为什么要有：没选工作区的会话，光有"未分组"这个标签，
   * 用户还是分不清哪几条是刚才那个会话里说的——得能拿 id 去查会话标题。
   * 条目来自已经删掉的会话时这里就是 undefined，面板不能编一个标题出来。
   */
  sessionId?: string
}

/** 视图缓存：**同一个状态引用必须复用同一个视图引用**。 */
const viewCache = new WeakMap<object, MindView>()

/**
 * 已经规范化过的状态。
 *
 * 为什么不能每次 `apply` 都调 `normalizeState`：那会**每次都产生新对象**，
 * 于是注册表的 `Object.is` 第一层闸门永远失效——它会拿到 `assistant/stream`
 * 这类高频事件，那些本该零成本原样返回，变成每一步都全量重建 + 通知下游。
 *
 * 所以用"见过就跳过"：每个状态引用只规范化一次，之后是 O(1) 查表，且不分配。
 */
const normalizedStates = new WeakSet<object>()

/**
 * 从会话头的 `cwd` 算工作区键。
 *
 * 只做三件事：去空白、反斜杠转正斜杠、去掉结尾斜杠。**故意不解析真实路径**——
 * 工作区键只需要"同一个目录稳定地得到同一个键"，不需要它是个合法路径；
 * 去做符号链接 / 大小写归一，反而会把同一台机器上的两种写法学成两个工作区，
 * 于是记忆凭空分家。空 / 拿不到 → 空串（未知），这时只认全局记忆。
 */
export function workspaceKey(cwd: string | undefined): string {
  if (typeof cwd !== 'string') return ''
  let key = cwd.trim().replace(/\\/g, '/')
  while (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1)
  return key
}

/** 需要时规范化一次；已见过就原样返回（**保持引用**）。 */
function ensureNormalized(state: unknown, t: MindTunables): MindState {
  if (state !== null && typeof state === 'object' && normalizedStates.has(state)) {
    return state as MindState
  }
  const next = normalizeState(state, t)
  if (next !== null && typeof next === 'object') normalizedStates.add(next)
  return next
}

/** 把一条记忆压成视图模型（面板只画，不再自己措辞）。 */
function toMemoryView(entry: MemoryEntry, here: string): MemoryView {
  return {
    kind: entry.kind,
    label: KIND_LABEL[entry.kind as keyof typeof KIND_LABEL] ?? entry.kind,
    text: entry.text,
    hits: entry.hits,
    at: entry.lastAt > 0 ? entry.lastAt : entry.createdAt,
    because: entry.because ?? '',
    origin: entry.origin === 'self' || entry.origin === 'digest' ? entry.origin : 'heard',
    // 三档来源不同，不能混：`undefined` 是当年还没有工作区这个字段（老档案），
    // `null` 是当时确实不在任何项目里，`''` 才是显式的"跨项目"。
    scope:
      entry.ws === undefined
        ? 'unknown'
        : entry.ws === null
          ? 'ungrouped'
          : scopeOfWorkspace(entry.ws, here),
  }
}

/**
 * 没有 `ws` 的记忆（老档案）在分组表里用的哨兵键。
 *
 * 为什么要哨兵：`ws: ''`（显式全局）和 `ws: undefined`（当年不会记）**必须分开**，
 * 否则两种东西会被塞进同一组，用户看到的仍然是"我项目里说的话跑到全局去了"。
 * 用 `\u0000` 开头是为了它不可能和任何真实路径撞上。
 */
const UNLABELED = '\u0000unlabeled'

/**
 * 未分组会话（`ws: null`）在分组表里的哨兵键，用于**不知道是哪个会话**写下的老条目。
 *
 * 和 `UNLABELED` 分两组：老档案是**当年还没这个字段**，未分组是**当时确实不在项目里**。
 * 两者的可见范围也不同——老档案哪儿都看得见，未分组的进了具体项目就不显示。
 * 知道会话 id 的那些不用这个键，见 `SESSION_PREFIX`。
 */
const UNGROUPED = '\u0000ungrouped'

/**
 * 某个未分组会话写下的记忆，在分组表里用的键前缀。
 *
 * 未分组会话**每个会话各成一组**：同一句"这个项目用 pnpm"从一个没选工作区的会话里说出来，
 * 跟另一个会话里说过的不是一回事；混成一组，面板就没法标出"这是哪个会话说的"。
 * `\u0000` 开头保证它撞不上真实路径。
 */
const SESSION_PREFIX = '\u0000session:'

/** 这一组属于谁：本项目 / 全局 / 其他项目。 */
function scopeOfWorkspace(key: string, here: string): 'here' | 'global' | 'other' {
  if (key === '') return 'global'
  if (here !== '' && key === here) return 'here'
  return 'other'
}

/** 组标题：措辞只在这里出现一次，客户端拿到就直接画。 */
function groupLabel(scope: MemoryGroupView['scope'], key: string, sessionId?: string): string {
  // 两档都叫"未标注"，但来源不同，别让它们挤成一个标题：
  // 老档案是当年还没有工作区这个字段；未分组会话是当时确实不在任何项目里。
  if (scope === 'unknown') {
    return key === UNLABELED ? '未标注（早于工作区绑定）' : '未标注'
  }
  // 未分组的组头由客户端去查会话标题（标题只有宿主会话列表里有），
  // 这里只给"没有标题时用"的兜底：知道是哪个会话 vs 连会话都不知道（老记录）。
  if (scope === 'ungrouped') return sessionId === undefined ? '未分组会话（旧记录）' : '未分组会话'
  if (scope === 'global') return '全局（关于你，跨项目）'
  if (scope === 'here') return key
  return `其他项目 · ${key}`
}

/** 排序：本项目 → 未标注 → 全局 → 其他项目（同档按条数多的在前，再按路径稳定排序）。 */
function compareGroups(a: MemoryGroupView, b: MemoryGroupView): number {
  const rank: Record<MemoryGroupView['scope'], number> = { here: 0, unknown: 1, ungrouped: 2, global: 3, other: 4 }
  if (rank[a.scope] !== rank[b.scope]) return rank[a.scope] - rank[b.scope]
  if (a.count !== b.count) return b.count - a.count
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** 每组最多带几条明细：面板是"看一眼"，不是浏览全库。 */
const GROUP_DETAIL_LIMIT = 12

/**
 * 按工作区把一批记忆分组（长期库与手边那批共用这一段）。
 *
 * 为什么手边也要分组：短记忆跟着档案跨会话活下来，别的项目里说过的话也可能躺在这里。
 * 以前只写「这个项目的 6 条」，用户没法知道是哪个项目——分组标题直接把路径写出来。
 */
function groupByWorkspace(entries: MemoryEntry[], here: string, limit: number): MemoryGroupView[] {
  const groups = new Map<string, MemoryView[]>()
  for (const entry of entries) {
    // 四段落脚点各成一组：具体项目、某个未分组会话（写了 sessionId）、
    // 不知道哪个会话的未分组老条目、老档案（当年还没有工作区字段）。
    const key =
      typeof entry.ws === 'string'
        ? entry.ws
        : entry.ws === null
          ? typeof entry.sessionId === 'string' && entry.sessionId !== ''
            ? SESSION_PREFIX + entry.sessionId
            : UNGROUPED
          : UNLABELED
    const list = groups.get(key)
    const view = toMemoryView(entry, here)
    if (list === undefined) groups.set(key, [view])
    else list.push(view)
  }
  return [...groups.entries()]
    .map(([key, views]) => {
      const bySession = key.startsWith(SESSION_PREFIX)
      const sessionId = bySession ? key.slice(SESSION_PREFIX.length) : undefined
      const scope: MemoryGroupView['scope'] =
        key === UNLABELED
          ? 'unknown'
          : bySession || key === UNGROUPED
            ? 'ungrouped'
            : scopeOfWorkspace(key, here)
      return {
        scope,
        // 哨兵键不外泄：路径组的 key 就是路径，会话组放会话 id（排序也要靠它稳定），
        // 老档案组清空（它没有路径可写）。
        key: key === UNLABELED ? '' : bySession ? (sessionId ?? '') : key,
        label: groupLabel(scope, key, sessionId),
        count: views.length,
        entries: views.slice(0, limit),
        ...(sessionId === undefined ? {} : { sessionId }),
      }
    })
    .sort(compareGroups)
}

function makeView(state: MindState, t: MindTunables): MindView {
  const emotions = state.affect.emotions.map((trace) => {
    const meta = wordOf(trace.word)
    return {
      word: trace.word,
      strength: Number(trace.strength.toFixed(3)),
      // 悬浮说明的材料：词表里"它是什么意思"的原话 + 最近那条信号写下的缘由。
      // 查不到词条、或老状态没留下缘由时给空串——面板据此如实说"没留下"，不编。
      inner: meta === undefined ? '' : meta.inner,
      because: trace.lastBecause ?? '',
      count: trace.count,
      lastAt: trace.at,
    }
  })
  const dominant = dominantEmotion(state.affect)
  // 手边记忆只给"本工作区 + 全局"；长期库仍然照实报总数，另加一行库存分布
  // 面板跟注入用**同一套轮换参数**：面板上看到的必须是模型真的看到的那几条，不能两套
  const short = describeShort(state.memory, t.memoryShortMax, state.workspace, {
    offset: state.progress.turn,
    pinned: t.memoryShortPinned,
  })
  const long = describeMemory(state.memory)
  const counts = memoryCounts(state.memory, state.workspace)

  const thoughtLines = describeThought(state.thought)

  const memoryLines = [
    ...(short.length > 0
      ? short.map((line) => `手边 · ${line}`)
      : ['手边没记着什么（跨会话库要靠它自己 recall_memory 去查）']),
  ]
  if (state.memory.session.length > 0) memoryLines.push(`本会话日记 ${state.memory.session.length} 条（只增不改）`)
  if (counts.here + counts.global + counts.other > 0) {
    memoryLines.push(
      `跨会话库 · 本工作区 ${counts.here} 条｜全局 ${counts.global} 条` +
        (counts.other > 0 ? `｜其他工作区 ${counts.other} 条` : ''),
    )
  }
  memoryLines.push(...long)

  const sections = [
    { title: '此刻', lines: [describeEmotions(state.affect)] },
    { title: '思想', lines: thoughtLines.length > 0 ? thoughtLines : ['此刻没有写下什么（它只在真有事时才调 inner_note）'] },
    { title: '人设', lines: describePersona(state.persona, t) },
    { title: '记忆', lines: memoryLines },
  ]

  // ── 结构化那一套：面板要画饼 / 画条 / 按项目分组，另外给一份 ──
  const shortMemory = state.memory.short.slice(0, t.memoryShortMax).map((entry) => toMemoryView(entry, state.workspace))

  // 跨会话库**按工作区分组**：本项目 / 未标注 / 全局 / 其他项目。
  // 四组都列出来，因为这是"弱绑定"的全部意义——记忆跟着工作区走，但你能看见别处有什么。
  const longGroups = groupByWorkspace(state.memory.global, state.workspace, GROUP_DETAIL_LIMIT)
  // 手边那批同样按项目分组，标题直接写路径（"当前想法"卡片的折叠面板就用它）。
  const shortGroups = groupByWorkspace(state.memory.short, state.workspace, t.memoryShortMax)
  // 本会话日记：只增不改，按时间正序给最近若干条（面板只画，不再分组）。
  const sessionMemory = state.memory.session
    .slice(-GROUP_DETAIL_LIMIT)
    .map((entry) => toMemoryView(entry, state.workspace))

  const kindCounts = new Map<string, number>()
  for (const entry of state.memory.global) kindCounts.set(entry.kind, (kindCounts.get(entry.kind) ?? 0) + 1)
  const memoryKinds = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, label: KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind, count }))
    .sort((a, b) => b.count - a.count)

  return {
    summary: `${describeEmotions(state.affect)}｜张力 ${state.thought.tension.toFixed(2)}`,
    emotion: dominant === null ? null : dominant.word,
    sections: sections.filter((section) => section.lines.length > 0),
    text: state.affect.emotions.length > 0 ? '有情绪在' : '平静',
    emotions,
    emotionWords: allWords(),
    tension: Number(state.thought.tension.toFixed(3)),
    thoughtAt: state.thought.updatedAt,
    selfPortrait: state.thought.selfPortrait,
    folded: state.folded,
    mood: {
      valence: Number(state.affect.mood.valence.toFixed(3)),
      arousal: Number(state.affect.mood.arousal.toFixed(3)),
      dominance: Number(state.affect.mood.dominance.toFixed(3)),
    },
    voice: {
      brevity: Number(state.persona.voice.brevity.toFixed(3)),
      warmth: Number(state.persona.voice.warmth.toFixed(3)),
      directness: Number(state.persona.voice.directness.toFixed(3)),
      initiative: Number(state.persona.voice.initiative.toFixed(3)),
      drift: t.voiceDrift,
    },
    voiceTraits: state.persona.traits
      .filter((trait) => trait.settledAt === null)
      .map((trait) => ({
        label: trait.label,
        hits: trait.hits,
        spanDays: Math.round(trait.spanDays),
      })),
    shortMemory,
    shortGroups,
    sessionMemory,
    longGroups,
    memoryKinds,
  }
}

/**
 * 注册投影。
 *
 * `init` 就是新会话的起点：从跨会话档案里**接管**人设与长期记忆，
 * 但情感/思想/进度从零开始（它们永远是"这一段对话内"的）。
 */
export async function registerProjection(
  projections: SessionProjectionsService,
  deps: {
    tunables: () => MindTunables
    adoptPersist: (state: MindState, now: number) => MindState
    /** 内核递出来的话（它自己不写日志）——没人接就静默丢弃。 */
    note?: (message: string) => void
    /**
     * 按遗忘名单处理一份记忆（宿主侧权威：`/mind forget`、`/mind reset-memory` 划掉的）。
     *
     * 适配层给的这个函数已经把"活状态自己的名单 + 宿主侧名单"并好了，投影不自己实现它：
     * **名单只能有一处真相**，分成两处迟早有一层漏掉（v2.4 的血泪）。
     * 必须保持引用纪律：没删任何东西时要返回**同一个对象**，否则每个事件都会换引用、
     * 把注册表的 `Object.is` 第一层闸门打掉。
     */
    pruneForgotten?: (memory: MemoryState) => MemoryState
    /**
     * 反向：把 **`/mind restore` 捞回来的条目**补回活状态。
     *
     * 会话状态由日志派生、没有写入 API，所以"恢复"没法直接改它——适配层在文件里写回、
     * 同时把内容交给这个函数，下一个事件起它就在面板与注入里了。
     * 同样要守引用纪律：没补任何东西时返回**同一个对象**。
     */
    revive?: (memory: MemoryState) => MemoryState
  },
): Promise<ProjectionHandle | Disposable | undefined> {
  const definition: ProjectionDefinition = {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: buildStateSchema(),
    init: (header) => {
      const now = Date.now()
      const base = emptyState(deps.tunables(), now)
      // 工作区身份的唯一可靠来源是会话头（`SessionHeader.cwd`，平台已确认的声明）。
      // 会话头是会话身份的一部分，所以由它派生的这个键仍然可回放。
      // 老调用方/测试可能不带参数 → `workspaceKey(undefined)` = 空串（未知）。
      // 会话 id 也只有这里拿得到（`SessionHeader.id` 是会话身份的一部分，可回放）。
      // 投影的 `apply` 拿不到会话对象，所以把它放进状态里，跟 `workspace` 一个路子。
      const withWorkspace: MindState = {
        ...base,
        workspace: workspaceKey(header?.cwd),
        session: header?.id === undefined ? '' : String(header.id),
      }
      const adopted = deps.adoptPersist(withWorkspace, now)
      // `init` 的产物**按构造就是规范化的**（emptyState + 规范化过的档案），
      // 所以直接标记成"已见过"。否则第一个事件会白白规范化一次、
      // 产生新引用，把 `Object.is` 闸门在第一枪就打掉。
      if (adopted !== null && typeof adopted === 'object') normalizedStates.add(adopted)
      return adopted
    },
    // 事件形状本来就是同一份（宿主事件就是会话事件），这里只是把"可选字段"的差异吞掉：
    // 内核只读 type/seq/time/data 四个键，多一个少一个不影响。
    apply: (state, event) => {
      const t = deps.tunables()
      const current = ensureNormalized(state, t)
      const applied = applyEvent(current, event as unknown as SessionEventLike, {
        tunables: t,
        note: deps.note,
        // 会话 id 从状态里读：它是 `init` 从会话头填的，`apply` 看不到会话对象
        sessionId: current.session === '' ? undefined : current.session,
      })
      // 名单是全局权威，**活状态也要照它过滤**：会话状态由会话日志派生，宿主侧命令
      // （`/mind forget`、`/mind reset-memory`）改不了它。不在这一步滤，清完之后的
      // 面板与注入会一直显示已经划掉的条目，看着就像"命令没生效"（2026-11-13 真机现场）。
      let next = applied
      if (applied !== null && typeof applied === 'object') {
        const before = (applied as MindState).memory
        let memory = before
        // 先按遗忘名单过滤（宿主侧划掉的要立刻消失），再把捞回来的补上——
        // 顺序不能反：反了的话，刚恢复的条目会在同一步里又被名单吃掉。
        if (deps.pruneForgotten !== undefined) memory = deps.pruneForgotten(memory)
        if (deps.revive !== undefined) memory = deps.revive(memory)
        if (memory !== before) next = { ...(applied as MindState), memory }
      }
      if (next !== null && typeof next === 'object') normalizedStates.add(next)
      return next
    },
    wire: {
      // `viewSchema` 与 `view` 必须成对（缺一个，"客户端可见"就不成立，见 buildViewSchema 的注释）
      viewSchema: buildViewSchema(),
      view: (state) => {
        const cached = viewCache.get(state as object)
        if (cached !== undefined) return cached
        const t = deps.tunables()
        const view = makeView(ensureNormalized(state, t), t)
        viewCache.set(state as object, view)
        return view
      },
    },
  }

  // DSH 0.2.x 的 `register` 返回**可调用的 thenable**：await 它得到带 `stateOf`/`dispose` 的句柄。
  // 老宿主（以及测试里的假宿主）返回的是释放函数——await 一个非 thenable 会原样返回它。
  // 两种形状都留着，取状态时按"有没有 stateOf"分支（见 `stateOfVia`）。
  try {
    return (await projections.register(definition)) as ProjectionHandle | Disposable
  } catch (error) {
    logger.warn('[dsh-mind] 注册投影失败：面板与注入会没有数据', error)
    return undefined
  }
}

/**
 * 从会话上取状态；拿不到就返回 `undefined`（绝不用空状态掩盖问题）。
 *
 * 优先用注册时拿到的**句柄**（DSH 0.2.x 的推荐路径，自己折叠、不打弃用警告）；
 * 句柄不可用（老宿主 / 假宿主）才回落注册表级读取——那条从 0.2.1-rc.2 起已弃用。
 */
export function stateOfVia(
  registration: ProjectionHandle | Disposable | undefined,
  projections: SessionProjectionsService,
  session: unknown,
): MindState | undefined {
  try {
    const handle = registration as Partial<ProjectionHandle> | undefined
    if (handle !== undefined && typeof handle.stateOf === 'function') {
      const value = handle.stateOf(session)
      if (value === null || value === undefined || typeof value !== 'object') return undefined
      return value as MindState
    }
    const fallback = projections.stateOf
    if (typeof fallback !== 'function') return undefined
    const value = fallback.call(projections, session, PROJECTION_KEY)
    if (value === null || value === undefined || typeof value !== 'object') return undefined
    return value as MindState
  } catch (error) {
    logger.warn('[dsh-mind] 取会话状态失败', error)
    return undefined
  }
}

/**
 * 老入口：直接按注册表读。
 *
 * @deprecated 用 `stateOfVia(句柄, …)`。这里只为向后兼容而保留。
 */
export function stateOf(projections: SessionProjectionsService, session: unknown): MindState | undefined {
  return stateOfVia(undefined, projections, session)
}
