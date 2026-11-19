/**
 * dsh-mind 的**客户端半边**：侧栏上方一排里的「心念」入口 + 中间那一栏的状态页。
 *
 * 三条硬规矩（写在最前面，免得以后手滑）：
 *
 * 1. 这个文件最后会被包成 **CJS factory**（见 `scripts/build-client.mjs`）：
 *    `window.__ModuleLoader__.load({ id: 'dsh-mind', factory: (require) => { … } })`。
 *    所以这里**不能用 ESM import、不能用 JSX**，只能 `require('react')`；
 * 2. 面板**不做任何格式化**：把中枢通过会话投影 wire 过来的 `sections` 原样画出来。
 *    这样「中文措辞」只有一处真相（core 里那组 describe / render 函数），不会两端各写一套然后慢慢跑偏。
 *    （写注释时注意：不要在块注释里写出星号加斜杠那两个字符，会**提前关闭注释**，报错还指向后面几行。）
 * 3. 拿不到数据就**如实说拿不到**，绝不编一个看起来正常的空面板——那是最难查的一类错。
 *
 * 这里同时挂着**两个座位**：
 * - `sidebar.panellist` + `main`：侧栏那一格与中间的状态页（就是上面说的"侧栏一排 + 中间页"）；
 * - `settings.section`：DSH **设置**面板里的一页「心念」——用户点名要的那个（"设置面板里根本就看不到"）。
 *   它通过宿主自己的受围栏路由 `/dsh-mind/api/settings.get|settings.update` 读写配置，
 *   值的真相在宿主那边（这条路由的宿主半边是 `src/settings-bridge.ts`），
 *   客户端**不另存一份**——存一份就是两个真相，改完在别处一看还是旧的。
 *
 * ## 为什么是「侧栏一排 + 中间页」，而不是「底部按钮 + 浮层弹窗」
 *
 * 试过弹窗，结果是错的：侧栏那一排（`sidebar.panellist`）的**点击权在宿主**。
 * 官方目录里写得明明白白——"Global panel icons. Each list id addresses the matching main panel;
 * the sidebar owns the button and resolves its label from list metadata."
 * shell 拥有那一格的按钮、标签、高亮与切换，它把点击翻译成"用同一个 id 打开 `main` 槽里的页面"。
 *
 * 也就是说：**要么进来当一排里的一格（那就开中间页），要么就别进那一排**。
 * 想做弹窗只能挪到 `sidebar.footer.action` + `shell.overlay`，但那个位置在左下角、和"设置"挤在一起，
 * 而且自己画的浮层永远不像宿主自己的东西。所以按平台给的正路走：占一格 + 开一页。
 */

// 客户端 bundle 里没有 Node 类型，`require` 由宿主工厂注入，所以要自己声明。
// （`window` / `setInterval` 由 DOM lib 提供，别再声明一次，会撞名。）
declare const require: (name: string) => unknown

interface ReactLike {
  createElement: (...args: unknown[]) => unknown
  useState: <T>(initial: T | (() => T)) => [T, (next: T) => void]
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void
}

const react = require('react') as ReactLike
const h = react.createElement

/** 中枢 wire 过来的视图（与 `dsh-mind/src/projection.ts` 的 `MindView` 一一对应）。 */
interface MindView {
  summary: string
  emotion: string | null
  sections: { title: string; lines: string[] }[]
  text: string
  /**
   * 情绪与强度（各自独立）；`emotionWords` 是词表全序，扇区槽位靠它固定。
   * `inner`/`because`/`count`/`lastAt` 是悬浮说明的材料（旧宿主不送就只说能说的）。
   */
  emotions: {
    word: string
    strength: number
    inner?: string
    because?: string
    count?: number
    lastAt?: number
  }[]
  emotionWords?: string[]
  tension: number
  folded: number
  /** 它**最近一次**写下内心记录的时间（后加；旧宿主不送，那时小标题就只说"它写下的"）。0 = 从没写过。 */
  thoughtAt?: number
  // 下面这几个是**后加的**：旧版宿主不会送它们（会话没重启时拿到的就是旧视图）。
  // 所以是可选的——缺了就说缺了，绝不编一个看着正常的数字（编数字比空白更难查）。
  mood?: { valence: number; arousal: number; dominance: number }
  /** 说话习惯四轴 + 漂移半径；`initiative` 是后加的一根（旧宿主不送，面板按 0.5 显示）。 */
  voice?: {
    brevity: number
    warmth: number
    directness: number
    initiative?: number
    drift: number
  }
  /** 候选中的自我认知（旧宿主不送就是空）。 */
  voiceTraits?: { label: string; hits: number; spanDays: number }[]
  shortMemory: MemoryRowView[]
  /** 手边记忆按项目分好的组（后加；旧宿主只给 `shortMemory`，那时退回平铺）。 */
  shortGroups?: MemoryGroupView[]
  longGroups: MemoryGroupView[]
  memoryKinds: { kind: string; label: string; count: number }[]
  /** 本会话日记：只增不改，最多最近几条（后加；旧宿主不送）。 */
  sessionMemory?: MemoryRowView[]
}

/** 一条记忆（文字与标签都由中枢给好，这里只画）。 */
interface MemoryRowView {
  kind: string
  label: string
  text: string
  hits: number
  at: number
  because: string
  /** 本项目 / 未标注（老档案） / 未分组会话 / 全局 / 其他项目（旧宿主不给 → 当作"本项目的"）。 */
  scope?: 'here' | 'unknown' | 'ungrouped' | 'global' | 'other'
  /**
   * 谁写的：`self` = 它自己写下的，`digest` = 收尾时按规则拼的，`heard` = 从用户原话里摘的兜底。
   * 旧宿主不给这个字段，按 `heard` 画——老实标"听来的原话"，
   * 不能把不知道来源的说成"它自己记的"（那是替它冒领）。
   */
  origin?: 'self' | 'heard' | 'digest'
}

/** 记忆的一组：一个工作区一组。 */
interface MemoryGroupView {
  scope: 'here' | 'unknown' | 'ungrouped' | 'global' | 'other'
  key: string
  label: string
  count: number
  entries: MemoryRowView[]
  /**
   * 未分组会话的组：这是哪个会话写的。
   *
   * 只在这一档有值（宿主从 v4 视图开始送）。有它才能去会话列表里查那个会话的名字，
   * 用作组标题；会话已经删了就查不到，那时组标题退回「会话 xxxxxx」。
   */
  sessionId?: string
}

/** 客户端插件上下文（只声明我用到的部分）。 */
interface ClientCtx {
  slots: {
    register: (definition: Record<string, unknown>, component: unknown) => () => void
    inject: (key: string, callback: () => unknown) => () => void
  }
  get: (name: string) => unknown
}

/** 会话列表快照（宿主给客户端的公开形状；`dsh-context` 与 `dsh-mneme` 都用它）。 */
interface SessionRow {
  projectionValues?: Record<string, unknown>
  /**
   * 会话标题。
   *
   * 字段名不是猜的：`dsh-better-sidebar` 的 `jobs-client.ts:119` 就是
   * `byId[job.owner ?? watched]?.displayTitle`，`tasks-model.ts:426` 也拿它当标题。
   * `label` 是同源的别名，有的行只带它。
   */
  displayTitle?: string
  label?: string
}
interface SessionsService {
  list?: {
    getSnapshot?: () => { byId?: Record<string, SessionRow> } | null
    subscribe?: (fn: () => void) => (() => void) | void
  }
}

/**
 * 查一个会话的标题。
 *
 * 为什么按 id 当场查、不把标题存进记忆条目：条目可能来自早就删掉的会话，
 * 那会儿的标题在这儿已经查不到了——查不到就如实说"会话 xxxxxx"，
 * 不能编一个出来，也不能把当时的标题冻进记忆里（那是新的信息源，会过期）。
 */
function sessionTitle(ctx: ClientCtx | undefined, sessionId: string | undefined): string | undefined {
  if (ctx === undefined || sessionId === undefined || sessionId === '') return undefined
  const row = snapshotOf(ctx)?.byId?.[sessionId]
  const title = row?.displayTitle ?? row?.label
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
}

/** 只依赖 `slots`：多声明一个服务就多一次"它不在就不激活"的风险。 */
export const inject = ['slots']

/**
 * 座位 id：侧栏那一格与 `main` 那一页用同一个 id，宿主就是靠它把两者对上的。
 *
 * 它等于**包名**（`@lin0306/dsh-mind`）——这条是有测试盯着的：
 * 设置页那一栏的 id 必须和侧栏那一格一致，而侧栏那格的 id 又必须与 loader 的 id 同源。
 * 注意它**不参与** HTTP 路由（路由是下面独立的 `SETTINGS_ROUTE`），所以带 `/` 不会破路由。
 */
const PANEL_ID = '@lin0306/dsh-mind'

/**
 * 排在哪儿。
 *
 * 现有占位（`sidebar.panellist` 的实测 occupants）：宿主自己的 Plugins = 0、Scheduled tasks = 10，
 * 插件们的上下文洞察 = 20、任务看板 = 20。取 30 → 紧挨在那几个之后、仍在**上方这一排**里，
 * 既不在底部，也不去抢宿主自己页面的位置。
 */
const PANEL_ORDER = 30

export function apply(ctx: ClientCtx): void {
  // 钉住的那块说明要能用 Esc 关掉（装一次就够，插件只 apply 一次）
  installTipEscape()

  // ① 侧栏上方那一排里的一格。宿主负责按钮、标签、高亮与切换，我只提供图标与标签文字。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => '心念' },
      MindIcon,
    ),
  )

  // ② 中间那一栏的页面。宿主按 id 找到它；座位上把当前会话 id 交过来（收不到也有兜底）。
  //
  // `inject` 的返回值就是页面的 props——**必须把 ctx 一起交过去**。
  // 只给 `sessionId` 的话，页面里拿不到 `ctx.slots` / `ctx.get`，点开就是一片空（这里栽过一次）。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, inject: (sessionId: unknown) => ({ sessionId, ctx }) },
      MindPage,
    ),
  )

  // ③ DSH **设置**面板里的一页。用户点名要的就是这一页：
  //    "设置面板里根本就看不到"——`sidebar.panellist` 那一格是侧栏，不是设置面板，两者互不相干。
  //
  // `order` 取 40：设置面板里的页是按这个数排的（实测 better-sidebar 用 100、llm-retry-settings 用 15），
  // 放在它们之间，不抢最前面。
  // DSH 0.1.x **不通过这个注册传图标**——宿主给每页画一个通用齿轮，传了也不认。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: PANEL_ID, order: SETTINGS_SECTION_ORDER, label: () => '心念', inject: () => ({}) },
      SettingsSection,
    ),
  )
}

/**
 * 侧栏那一格的图标：一颗心 + 一条穿过它的脉搏（和仓库里的 `icon.svg` 同一个意思，只是缩到十几个像素）。
 *
 * 宿主给的 props 是 `{ size, active }`：`size` 是它要的边长，`active` 表示这一格当前是否被选中。
 * 跟着它走，才不会和相邻那几格的大小、粗细对不齐。
 */
function MindIcon(props: { size?: number; active?: boolean }): unknown {
  const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
  const active = props?.active === true
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: active ? 'currentColor' : 'none',
      fillOpacity: active ? 0.16 : 0,
      stroke: 'currentColor',
      strokeWidth: active ? 1.5 : 1.35,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('path', {
      key: 'heart',
      d: 'M8 13.5C4.3 10.9 2.3 8.9 2.3 6.6 2.3 4.9 3.7 3.7 5.2 3.7c1 0 1.9.5 2.8 1.6.9-1.1 1.8-1.6 2.8-1.6 1.5 0 2.9 1.2 2.9 2.9 0 2.3-2 4.3-5.7 6.9Z',
    }),
    h('path', { key: 'pulse', d: 'M3.1 7.9h1.6l.6-1.5.9 2.8.7-1.3h1.6' }),
  )
}

/** 会话列表快照。 */
function snapshotOf(ctx: ClientCtx): { byId?: Record<string, SessionRow> } | null {
  try {
    const sessions = ctx.get('sessions') as SessionsService | undefined
    return sessions?.list?.getSnapshot?.() ?? null
  } catch {
    return null
  }
}

/** 订阅快照变化；宿主没给订阅口就返回个空的清理函数（由页面里的轮询兜底）。 */
function subscribe(ctx: ClientCtx, onChange: () => void): () => void {
  try {
    const sessions = ctx.get('sessions') as SessionsService | undefined
    const off = sessions?.list?.subscribe?.(onChange)
    return typeof off === 'function' ? off : () => {}
  } catch {
    return () => {}
  }
}

/**
 * 找出该显示哪个会话的状态。
 *
 * 顺序是"从最可信到最兜底"：
 * 1. 座位交过来的 `sessionId`（宿主要给了，它就是权威）；
 * 2. `ctx.get('sidebarRight').mounted`——DSH 公布的"哪个会话的座位正显示着"；
 * 3. 任何**有 mind 投影**的会话（宿主没给会话 id 时，宁可显示一个真会话并**标出是哪个**，
 *    也不假装自己有数据）。
 */
function resolveSession(ctx: ClientCtx, injected?: string): { sessionId: string; view: MindView } | undefined {
  const byId = snapshotOf(ctx)?.byId ?? {}
  const read = (id: string): MindView | undefined => {
    const value = byId[id]?.projectionValues?.['mind']
    return (value as MindView | undefined) ?? undefined
  }

  if (typeof injected === 'string' && injected !== '') {
    const view = read(injected)
    if (view !== undefined) return { sessionId: injected, view }
  }

  try {
    const right = ctx.get('sidebarRight') as { mounted?: { getSnapshot?: () => unknown } } | undefined
    const mounted = right?.mounted?.getSnapshot?.()
    if (typeof mounted === 'string' && mounted !== '') {
      const view = read(mounted)
      if (view !== undefined) return { sessionId: mounted, view }
    }
  } catch {
    /* 没有这个服务就往下走 */
  }

  for (const id of Object.keys(byId)) {
    const view = read(id)
    if (view !== undefined) return { sessionId: id, view }
  }
  return undefined
}

/** 饼图配色：固定一组、循环取用。颜色不跟语义绑定（情绪词多，绑不过来）。 */
const PIE_COLORS = ['#8ab4ff', '#63e6be', '#b39ddb', '#ffb74d', '#ef6c6c', '#4dd0e1', '#a5d6a7', '#f48fb1']

/**
 * 每个情绪一个**专属固定色**：14 个词、14 种颜色，不随机、也不按下标轮换。
 *
 * 为什么必须固定：颜色在这张图里是第二个坐标——扫一眼"那块蓝的又长了"就知道是焦虑，
 * 不必去读标签。轮换配色会让同一个情绪今天蓝明天绿，这份记忆就废了。
 *
 * 配色原则：负向偏深偏冷（闷、压着），正向偏亮偏暖（透气、亮起来）——
 * 与"亮色＝正向、深色＝负向"的约定一致，同时保证 14 个词彼此分得开。
 */
const EMOTION_COLORS: Record<string, string> = {
  // 负向 8（深、冷、闷）
  挫败: '#6E5470',
  烦躁: '#C4603C',
  焦虑: '#4F63A6',
  疲惫: '#5B6E7C',
  困惑: '#6B5A93',
  内疚: '#8C5454',
  委屈: '#A45F76',
  无聊: '#6E7379',
  // 正向 6（亮、暖、透）
  认可: '#4E9FD1',
  满足: '#3FA98B',
  好奇: '#79C05A',
  感激: '#D9A03C',
  自豪: '#B96BB4',
  期待: '#E08A4B',
}

/**
 * 取一个情绪的固定色。
 *
 * 词表将来加新词时走兜底：按词名哈希从备用色里取一个**稳定的**颜色
 * （同一个名字永远同一个色），绝不随机——随机等于每次刷新换一套配色。
 */
function emotionColor(word: string): string {
  const known = EMOTION_COLORS[word]
  if (typeof known === 'string') return known
  const pool = ['#7C8AA0', '#9A7C6A', '#6A9A8A', '#8A6A9A']
  let sum = 0
  for (let i = 0; i < word.length; i += 1) sum = (sum + word.charCodeAt(i) * (i + 1)) % 997
  return pool[sum % pool.length] ?? '#7C8AA0'
}

/** 一个环形扇段的 path：内半径 rIn、外半径 rOut，角度 a0→a1（弧度，顺时针）。 */
function ringSector(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0
  const at = (r: number, a: number): string =>
    `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`
  return (
    `M ${at(rIn, a0)} L ${at(rOut, a0)} ` +
    `A ${rOut} ${rOut} 0 ${large} 1 ${at(rOut, a1)} ` +
    `L ${at(rIn, a1)} A ${rIn} ${rIn} 0 ${large} 0 ${at(rIn, a0)} Z`
  )
}

/**
 * 情绪玫瑰图（南丁格尔式）：**每个词一个固定槽位**，半径＝强度，一个词一种固定颜色。
 *
 * 三条纪律，都是为了"两次刷新能对比"：
 * - 槽位按词表全序**固定等分**，不按"当前有几个情绪"重排（否则每次形状都变，等于不能比）；
 * - 14 个扇区**全画**：没点亮的那个就是贴着内孔的一小段，槽位留着、不抢眼；
 * - 半径从内孔起算到外缘，`0` 落在内孔、`1` 落在最外——**不按当前最大值归一化**，
 *   否则"全都在衰减"这件事会被归一化吃掉（那正是饼图的老毛病）。
 *
 * 标签只给强度 ≥0.08 的扇区：14 个标签全标会绕成一圈糊。
 */
function RoseChart(props: {
  words: string[]
  points: {
    word: string
    strength: number
    inner?: string
    because?: string
    count?: number
    lastAt?: number
  }[]
}): unknown {
  // 圆要**顶到画布高度**：半径按高度算（rMax ≈ hgt/2 − 标签边距 28），
  // 宽度只是留给左右两侧的引线和标签。上一次错在"画布加宽了、圆没加"，
  // 半径 112 在 560 宽的画布里只占 20%，看着就是缩在中间一小团。
  // 比例按"卡片内宽 ≈ 500、图区高 ≈ 380"来定：圆直径顶到高度的八成，
  // 左右各留 100 给引线和标签。宽高比要贴近卡片，否则 SVG 等比缩放又会留边。
  const w = 500
  const hgt = 380
  const cx = w / 2
  const cy = hgt / 2
  const r0 = 36
  const rMax = 150
  const words = props.words.length > 0 ? props.words : props.points.map((point) => point.word)
  const gap = 0.02
  const start = -Math.PI / 2
  const byWord = new Map(props.points.map((point) => [point.word, point]))
  const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  /**
   * **角度按数值分配**：谁大谁占得多，合起来正好一整圈，所以环永远是满的。
   *
   * 之前我做的是"角度等分、只让半径变长"——那是另一种图，看着就是每块一样宽、
   * 剩下的槽位空着（用户两次点出这件事："色块没有铺满整个圆环"）。
   * 代价：角度会随数值变化重排，不再有"同一情绪永远在同一格"的可比性，
   * 换来的是他要的观感。
   */
  const total = words.reduce((sum, word) => sum + clamp01(byWord.get(word)?.strength ?? 0), 0)

  /**
   * 一个词的说明文字。扇区与它的标签**共用同一份**——
   * 用户明确说过"悬浮在文字上没有任何显示"，所以标签也必须挂同一组说明。
   */
  const linesOf = (word: string): string[] => {
    const point = byWord.get(word)
    const strength = clamp01(point?.strength ?? 0)
    return [
      `${word}　强度 ${strength.toFixed(2)}`,
      point?.inner === undefined || point.inner === '' ? '' : point.inner,
      strength >= 0.02
        ? point?.because === undefined || point.because === ''
          ? '为什么这么高：这一条是升级前点起来的，当时没记下缘由。'
          : `为什么这么高：最近一次是「${point.because}」。`
        : '这个情绪现在没被点起来。',
      point === undefined
        ? ''
        : `这一段被点起过 ${point.count ?? 0} 次${point.lastAt === undefined ? '' : `，最近一次 ${hhmm(point.lastAt)}`}。`,
    ].filter((line): line is string => line !== '')
  }

  const parts: unknown[] = []
  // 第一遍：画扇区，同时把"要标标签的"收集起来——标签位置得整体避让，不能边算边放
  const labels: {
    index: number
    word: string
    strength: number
    side: -1 | 1
    x: number
    y: number
    from: [number, number]
  }[] = []
  let cursor = start
  words.forEach((word, index) => {
    const strength = clamp01(byWord.get(word)?.strength ?? 0)
    const span = total <= 0 ? 0 : (strength / total) * Math.PI * 2
    // 没数值的情绪不占角度（它没有强度，占一格就等于替它编了一个份额）
    if (span <= 0.0005) return
    const a0 = cursor + gap / 2
    const a1 = cursor + span - gap / 2
    cursor += span
    const end = Math.max(a1, a0 + 0.002) // 极窄的扇区也要留一丝可见的边
    const mid = (a0 + end) / 2
    parts.push(
      h('path', {
        key: `s${index}`,
        d: ringSector(cx, cy, r0, rMax, a0, end),
        fill: emotionColor(word),
        ...hoverTip(linesOf(word)),
      }),
    )
    // **每个有数值的都标**：之前砍到"最强 6 个 + 强度 ≥0.12"，于是有几块没标签（用户点出来了）
    const side: -1 | 1 = Math.cos(mid) >= 0 ? 1 : -1
    labels.push({
      index,
      word,
      strength,
      side,
      x: cx + side * (rMax + 30),
      y: cy + Math.sin(mid) * (rMax + 10),
      from: [cx + Math.cos(mid) * (rMax + 3), cy + Math.sin(mid) * (rMax + 3)],
    })
  })

  // 第二遍：同侧标签按 y 排序后强制最小间距（角度接近的几根不推开会叠成一坨），再画引线
  for (const side of [-1, 1] as const) {
    const group = labels.filter((label) => label.side === side).sort((a, b) => a.y - b.y)
    const MIN_GAP = 23
    for (let i = 1; i < group.length; i += 1) {
      const prev = group[i - 1] as (typeof group)[number]
      const cur = group[i] as (typeof group)[number]
      if (cur.y - prev.y < MIN_GAP) cur.y = prev.y + MIN_GAP
    }
    for (const label of group) {
      const y = Math.max(16, Math.min(hgt - 8, label.y))
      const elbowX = cx + label.side * (rMax + 12)
      // 引线：扇区外缘 → 拐点 → 标签前的一小段横线。没有它，读者不知道这个标签属于哪块
      parts.push(
        h('path', {
          key: `g${label.index}`,
          d:
            `M ${label.from[0].toFixed(1)} ${label.from[1].toFixed(1)} ` +
            `L ${elbowX.toFixed(1)} ${y.toFixed(1)} ` +
            `L ${(label.x - label.side * 5).toFixed(1)} ${y.toFixed(1)}`,
          fill: 'none',
          stroke: 'rgba(150,150,160,0.4)',
          strokeWidth: 1,
        }),
      )
      parts.push(
        h(
          'text',
          {
            key: `t${label.index}`,
            x: label.x,
            y: y + 3,
            // 字号按 viewBox 单位给：图会被缩放到卡片宽，所以要比"屏幕目标字号"大一号。
            // 15 号 + 深灰（#6b7280 那一档）——原来 13 号配浅灰，视力差一点就糊了。
            fontSize: 15,
            fill: '#6b7280',
            textAnchor: label.side > 0 ? 'start' : 'end',
            ...hoverTip(linesOf(label.word)),
          },
          `${label.word} ${label.strength.toFixed(2)}`,
        ),
      )
    }
  }

  const top = props.points.reduce<{ word: string; strength: number } | null>(
    (best, point) => (best === null || point.strength > best.strength ? point : best),
    null,
  )
  // 内孔直径就 44px：只写"词名 + 数值"两行刚好填满；写"最强 焦虑 0.94"会横着顶出孔外
  parts.push(
    h(
      'text',
      { key: 'c1', x: cx, y: cy - 3, fontSize: 19, fill: '#4b5563', textAnchor: 'middle' },
      top === null ? '平静' : top.word,
    ),
  )
  // 中心只写词名：数值在它自己的标签上已经有一次了，同一个数写两遍只是噪音
  if (top !== null) {
    parts.push(
      h(
        'text',
        { key: 'c2', x: cx, y: cy + 18, fontSize: 11, fill: '#9ca3af', textAnchor: 'middle' },
        '最强',
      ),
    )
  }

  // 外面套一层 `aspect-ratio` 容器：它的高度由宽度和这个比例算出来，
  // 里面的 SVG 用 width/height 100% 填满。之前直接给 svg 设 `height: auto`，
  // 宿主里没按 viewBox 换算，结果图只渲染出 430×260、四周全是空白。
  return h(
    'div',
    { key: 'rose', style: { width: '100%', aspectRatio: `${w} / ${hgt}`, margin: '4px 0 6px' } },
    h(
      'svg',
      {
        viewBox: `0 0 ${w} ${hgt}`,
        preserveAspectRatio: 'xMidYMid meet',
        style: { display: 'block', width: '100%', height: '100%' },
      },
      ...parts,
    ),
  )
}

/**
 * 三角雷达：三个轴都是 0–1 的独立刻度，画两层——**出厂基线（0.5 的正三角，灰虚线）**与**当前值**。
 *
 * 雷达只在这"固定少数几轴"的场合成立。拿它画 14 个情绪会变成蜘蛛网，
 * 而且闭合多边形会让相邻的词看着"有关联"，那是误导。
 */
function RadarChart(props: {
  axes: { label: string; value: number; note?: string; tip?: string[] }[]
}): unknown {
  // 画布要比圆大一圈：三个轴端外侧都要放"名字 + 数值"，按 240 见方的话左右两个标签会出界
  // 同玫瑰图：比例贴近卡片、半径按高度算，别让三角缩在中间
  const w = 500
  const hgt = 380
  const cx = w / 2
  const cy = hgt / 2 + 6
  const rMax = 132
  const n = Math.max(3, props.axes.length)
  const angle = (index: number): number => -Math.PI / 2 + (Math.PI * 2 * index) / n
  const pt = (index: number, value: number): [number, number] => {
    const r = rMax * Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
    return [cx + r * Math.cos(angle(index)), cy + r * Math.sin(angle(index))]
  }
  const poly = (values: number[]): string =>
    values.map((value, index) => pt(index, value).map((v) => v.toFixed(1)).join(',')).join(' ')

  const parts: unknown[] = []
  // 三层网格 + 外圈：给"0.62 大概在哪"一个参照
  for (const level of [0.25, 0.5, 0.75, 1]) {
    parts.push(
      h('polygon', {
        key: `g${level}`,
        points: poly(props.axes.map(() => level)),
        fill: 'none',
        stroke: 'rgba(140,140,150,0.18)',
        strokeWidth: 1,
      }),
    )
  }
  props.axes.forEach((_, index) => {
    const [x, y] = pt(index, 1)
    parts.push(
      h('line', { key: `sp${index}`, x1: cx, y1: cy, x2: x, y2: y, stroke: 'rgba(140,140,150,0.22)', strokeWidth: 1 }),
    )
  })
  // 出厂基线：三个轴都是 0.5
  parts.push(
    h('polygon', {
      key: 'base',
      points: poly(props.axes.map(() => 0.5)),
      fill: 'none',
      stroke: 'rgba(140,140,150,0.5)',
      strokeWidth: 1,
      strokeDasharray: '4 3',
    }),
  )
  parts.push(
    h('polygon', {
      key: 'now',
      points: poly(props.axes.map((axis) => axis.value)),
      fill: 'rgba(90,120,200,0.16)',
      stroke: '#5A78C8',
      strokeWidth: 1.8,
    }),
  )
  props.axes.forEach((axis, index) => {
    const [x, y] = pt(index, axis.value)
    const hover = axis.tip === undefined ? {} : hoverTip(axis.tip)
    parts.push(h('circle', { key: `d${index}`, cx: x, cy: y, r: 4.5, fill: '#5A78C8', ...hover }))
    // 3px 的点几乎没有可点面积（用户原话：「右侧这个人设，也没有任何显示」）：
    // 给顶点套一个透明的 12px 热区，鼠标扫过就有说明。
    parts.push(h('circle', { key: `h${index}`, cx: x, cy: y, r: 12, fill: 'transparent', ...hover }))
    // 标签摆到轴端外侧，数值直接跟着标签——雷达读不出精确值，只能靠文字补
    const [ex, ey] = pt(index, 1)
    const dx = (ex - cx) / rMax
    const dy = (ey - cy) / rMax
    parts.push(
      h(
        'text',
        {
          key: `l${index}`,
          x: cx + dx * (rMax + 22),
          y: cy + dy * (rMax + 22) + 3,
          fontSize: 15,
          fill: '#6b7280',
          textAnchor: Math.abs(dx) < 0.2 ? 'middle' : dx > 0 ? 'start' : 'end',
          // 轴端文字也是悬浮热区：文字比圆点大得多，最容易命中
          ...hover,
        },
        `${axis.label} ${axis.value.toFixed(2)}`,
      ),
    )
    // 第二行写"这一档是什么样"（偏长 / 偏冷 / 偏铺垫 / 只答所问）：
    // 光有 0.30 这种数字，读者没法判断它是多是少。
    if (axis.note !== undefined) {
      parts.push(
        h(
          'text',
          {
            key: `n${index}`,
            x: cx + dx * (rMax + 22),
            y: cy + dy * (rMax + 22) + 18,
            fontSize: 12,
            fill: '#9ca3af',
            textAnchor: Math.abs(dx) < 0.2 ? 'middle' : dx > 0 ? 'start' : 'end',
            ...hover,
          },
          axis.note,
        ),
      )
    }
  })

  return h(
    'div',
    { key: 'radar', style: { width: '100%', aspectRatio: `${w} / ${hgt}`, margin: '4px 0 6px' } },
    h(
      'svg',
      {
        viewBox: `0 0 ${w} ${hgt}`,
        preserveAspectRatio: 'xMidYMid meet',
        style: { display: 'block', width: '100%', height: '100%' },
      },
      ...parts,
    ),
  )
}

/** 时间戳 → `14:32`（不走 toLocaleTimeString：面板不该被运行环境的语言/时区设置改写格式）。 */
function hhmm(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 这个元素（或它内部真正做截断的那一块）**到底有没有被省略号吃掉**。
 *
 * 为什么要实测而不是看配置：`-webkit-line-clamp: 2` 挂在每个条目上，但短的那几条根本
 * 没被裁——配置在、省略没发生。那时还弹浮层，弹出来的是一模一样的内容，纯粹挡视线。
 *
 * 判据用 `scrollWidth/Height` 与 `clientWidth/Height` 的差（留 1px 容差，
 * 有些浏览器会因为舍入差一点点）。SVG 元素没有这两个属性，直接跳过——图表标签的
 * 说明是靠 `hoverTip` 无条件弹的，不归这条规则管。
 */
function isTruncated(root: Element): boolean {
  const nodes: Element[] = [root, ...Array.from(root.querySelectorAll('*'))]
  for (const node of nodes) {
    const box = node as { scrollWidth?: number; clientWidth?: number; scrollHeight?: number; clientHeight?: number }
    if (typeof box.scrollWidth !== 'number' || typeof box.clientWidth !== 'number') continue
    if (box.scrollWidth > box.clientWidth + 1) return true
    if (typeof box.scrollHeight === 'number' && typeof box.clientHeight === 'number') {
      if (box.scrollHeight > box.clientHeight + 1) return true
    }
  }
  return false
}

/**
 * 图表元素怎么"悬浮出说明"。
 *
 * 复用 `?` 徽标那套浮层（同一处渲染、同一套"移走立刻消失"），只是把触发点从图标换成
 * 图表元素本身：玫瑰的扇区、雷达的顶点、心境那几条都能挂。
 * 坐标取元素的实时视口位置，靠右往左让、靠下往上让，免得浮层被裁掉。
 */
function hoverTip(lines: string[]): { onMouseEnter: (event: unknown) => void; onMouseLeave: () => void } {
  return {
    onMouseEnter: (event: unknown) => {
      const target = (event as { currentTarget?: unknown })?.currentTarget
      const rect = (
        target as { getBoundingClientRect?: () => { left: number; top: number; bottom: number } }
      )?.getBoundingClientRect?.()
      if (rect === undefined) return
      setTip({
        lines,
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 360)),
        y: Math.min(rect.bottom + 6, window.innerHeight - 140),
        pinned: false,
      })
    },
    onMouseLeave: () => {
      if (tipState !== undefined && !tipState.pinned) setTip(undefined)
    },
  }
}

/**
 * 只在**真的被裁掉**时才弹的悬浮（内容类条目用它）。
 *
 * 规则：配了 `line-clamp` 不等于被裁——短的条目本来就装得下，这时弹出来只是把同一段话
 * 再说一遍，还挡视线。所以进鼠标的那一刻实测一次（见 `isTruncated`），没裁就什么都不弹。
 * 说明类悬浮（图表标签、轴含义、徽标）仍然用 `hoverTip`：它们弹的不是重复内容。
 */
function hoverTipIfClamped(lines: string[]): { onMouseEnter: (event: unknown) => void; onMouseLeave: () => void } {
  const base = hoverTip(lines)
  return {
    onMouseEnter: (event: unknown) => {
      const target = (event as { currentTarget?: Element | null })?.currentTarget
      if (!target) return
      if (!isTruncated(target)) return
      base.onMouseEnter(event)
    },
    onMouseLeave: base.onMouseLeave,
  }
}

/**
 * 把 0–1 的刻度翻成一句人话：0.5 附近算"正常"，两侧各给一个方向词。
 *
 * 面板上光有 0.30 / 0.70 这些数字，读者判断不了"这是多还是少、偏哪边"——
 * 所以每根轴都要配一个词（偏长 / 偏冷 / 偏铺垫 / 只答所问）。
 */
function voiceWord(value: number, low: string, high: string): string {
  if (value >= 0.6) return high
  if (value <= 0.4) return low
  return '正常'
}

/** 带正负号的数值（效价那种 −1～1 的）。 */
function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

/** 时间戳 → `2026-11-05`（不用 toLocaleDateString：面板不该被运行环境的语言设置影响）。 */
function dayOf(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 时间戳 → `11-06 13:23`（要的是"它这条是不是刚写的"，精确到分钟就够）。 */
function clockOf(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 「当前想法」卡里内心记录那一段的小标题。
 *
 * 说「最近一次」而不是「这一轮」：`state.thought` 存的是它**最近**写下的那一条，
 * 可能已经是几天前的了（原来的小标题写"它这一轮的"，等于在骗读者）。
 * 拿不到时间就只说"它写下的"——不知道就说不知道，不编。
 */
function thoughtTitle(view: MindView): string {
  const stamp = clockOf(typeof view.thoughtAt === 'number' ? view.thoughtAt : 0)
  return stamp === '' ? '它写下的内心记录' : `它最近一次写下的内心记录（${stamp}）`
}

/**
 * 环形图。
 *
 * 用 `stroke-dasharray` 拼弧：每个扇区画成一个圆，只让其中一段显形。
 * 比手算 `path` 的弧线坐标短得多，也不会在 100% 和 0% 这两个极端上画歪。
 */
function Donut(props: {
  slices: { label: string; value: number; color: string }[]
  center?: string
  size?: number
}): unknown {
  const size = typeof props.size === 'number' ? props.size : 132
  const stroke = 13
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const total = props.slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0)

  let carried = 0
  const arcs = props.slices.map((slice, index) => {
    const length = total > 0 ? (Math.max(0, slice.value) / total) * circumference : 0
    const arc = h('circle', {
      key: `arc${index}`,
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      stroke: slice.color,
      strokeWidth: stroke,
      strokeDasharray: `${length} ${Math.max(0, circumference - length)}`,
      strokeDashoffset: -carried,
    })
    carried += length
    return arc
  })

  return h(
    'div',
    { style: { ...S.donutWrap, width: size, height: size } },
    h('svg', { key: 'svg', width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: { transform: 'rotate(-90deg)' } }, ...arcs),
    h('div', { key: 'center', style: S.donutCenter }, props.center ?? ''),
  )
}

/**
 * 一根横条：`value` 落在 `[min, max]` 上的位置。
 *
 * `band` 是"允许漂移的带宽"（说话习惯那种 0.5±0.2）——它在轨道里画成一段半透明区间，
 * 于是"现在偏了多少、还能偏多远"一眼能看出来，不用读数字。
 */
function Bar(props: {
  name: string
  value: number
  min?: number
  max?: number
  band?: { center: number; half: number }
  /** 一条额外刻线（比如人设的"出厂 0.5"），画在条的最上层。 */
  tick?: number
  /** 悬浮说明：这一项是什么、这个值是怎么来的。 */
  tip?: string[]
  fmt?: (value: number) => string
}): unknown {
  const min = typeof props.min === 'number' ? props.min : 0
  const max = typeof props.max === 'number' ? props.max : 1
  const span = max - min === 0 ? 1 : max - min
  // 值 → [0,1] 的比例。图里所有位置都从这一个函数算，免得条和刻度各算一套。
  const ratio = (value: number): number => Math.max(0, Math.min(1, (value - min) / span))
  const at = (value: number): string => `${ratio(value) * 100}%`

  const layers: unknown[] = [h('div', { key: 'track', style: S.barTrack })]
  // 允许漂移的带宽**只画两条边界刻度**，不画成一段色块。
  // 画成色块时，带内（0.3–0.7）比带外更"实"，于是填充条看起来像延长到了 0.7，
  // 右边剩下的那点就觉得不够 0.33（用户就是照这个问的）；而「此刻」那四条没有带宽，
  // 两张卡于是像两套皮。现在两边共用同一条轨道、同一套填充，带宽只剩两道细刻度。
  if (props.band !== undefined) {
    const lo = ratio(props.band.center - props.band.half)
    const hi = ratio(props.band.center + props.band.half)
    layers.push(h('div', { key: 'lo', style: { ...S.bandTick, left: `${lo * 100}%` } }))
    layers.push(h('div', { key: 'hi', style: { ...S.bandTick, left: `${hi * 100}%` } }))
  }
  // 跨零的量（效价 −1～1）从**中间**往两边长，并画一条零刻度：
  // 否则 −1 那半截看着像"没走完的空档"，+0.06 也被画成半个条（用户就是照这个问"最大应该是 1 吧"）。
  if (min < 0 && max > 0) {
    const from = ratio(Math.min(0, props.value))
    const to = ratio(Math.max(0, props.value))
    // 值贴着 0 时宽度会小到看不见，给 1.2% 的下限，让它至少还是"零刻度旁边的一点"，而不是消失
    layers.push(h('div', { key: 'fill', style: { ...S.barFill, left: `${from * 100}%`, width: `${Math.max((to - from) * 100, 1.2)}%` } }))
    layers.push(h('div', { key: 'mid', style: { ...S.barMid, left: at(0) } }))
  } else {
    layers.push(h('div', { key: 'fill', style: { ...S.barFill, width: at(props.value) } }))
  }
  // 额外刻线画在最上层：它要说的是"出厂线在哪"，被填充条压住就没意义了
  if (typeof props.tick === 'number') {
    layers.push(
      h('div', { key: 'tick', style: { ...S.bandTick, left: at(props.tick), background: 'rgba(130,130,140,0.8)' } }),
    )
  }

  return h(
    'div',
    { style: S.barRow, ...(props.tip === undefined ? {} : hoverTip(props.tip)) },
    h(
      'div',
      { key: 'label', style: S.barLabel },
      h('span', { key: 'n' }, props.name),
      h('span', { key: 'v', style: S.barValue }, props.fmt === undefined ? props.value.toFixed(2) : props.fmt(props.value)),
    ),
    h('div', { key: 'wrap', style: S.barWrap }, ...layers),
  )
}

/**
 * 给视图补上缺的字段。
 *
 * 为什么需要：**宿主那半边改了、而会话还没重启**时，客户端拿到的仍是旧视图（没有 mood / longGroups 这些新字段），
 * 页面会直接崩在 `view.longGroups.map` 上。缺字段就按"没有"处理，比让整页白屏好得多。
 */
function normalizeView(view: MindView): MindView {
  return {
    ...view,
    emotions: Array.isArray(view.emotions) ? view.emotions : [],
    sections: Array.isArray(view.sections) ? view.sections : [],
    shortMemory: Array.isArray(view.shortMemory) ? view.shortMemory : [],
    shortGroups: Array.isArray(view.shortGroups) ? view.shortGroups : [],
    longGroups: Array.isArray(view.longGroups) ? view.longGroups : [],
    memoryKinds: Array.isArray(view.memoryKinds) ? view.memoryKinds : [],
    sessionMemory: Array.isArray(view.sessionMemory) ? view.sessionMemory : [],
  }
}

/**
 * 旧视图的提示语。
 *
 * 此刻与人设那两张卡的数字来自**后加的**字段（`mood` / `voice`）。宿主那半边换了、而会话没重启时，
 * 客户端拿到的仍是旧视图：这几个字段根本不存在。
 *
 * 第一版在这里填了 0 和 0.5 当兜底，于是页面上出现了一排**看着很正常、其实是编出来的数字**——
 * 用户拿截图来问"这四条是什么"，我才发现它骗了人。宁可什么都不画，直说"重启这个会话之后才有"。
 */
const STALE_HOST = '页面还是旧版本，重启这个会话之后这里才会有数。'

/** 一条记忆：类型徽标 + 来源 + 正文 + 凭什么记着。 */
function MemoryRow(props: { entry: MemoryRowView }): unknown {
  const entry = props.entry
  const meta: unknown[] = []
  // "被翻到"而不是"取回"：后者是内部动词（recall 的直译），给人看不像话
  if (entry.hits > 0) meta.push(h('span', { key: 'hits', style: S.memMeta }, `被翻到 ${entry.hits} 次`))
  if (dayOf(entry.at) !== '') meta.push(h('span', { key: 'day', style: S.memMeta }, dayOf(entry.at)))

  // 三档来源：它自己记的 / 收尾时按规则拼的 / 听来的原话。拼的那一档**不能算它说的**，
  // 也不能混进"听来的原话"里——用户一眼就能认出机器味的句子（v2.2）。
  const src =
    entry.origin === 'self'
      ? { label: '它自己记的', style: S.srcSelf }
      : entry.origin === 'digest'
        ? { label: '收尾时拼的', style: S.srcHeard }
        : { label: '听来的原话', style: S.srcHeard }

  // "因为什么记着"从常显改成**悬浮**：面板上每条记忆都多一行「因为：它自己记下的」，
  // 四条就把一屏吃掉，而那行几乎从不提供新信息（"它自己记的"徽标已经说过一遍）。
  // 内容没删——鼠标移上去还在。
  const tip = [
    entry.text,
    entry.because === '' ? '' : `因为：${entry.because}`,
    ...(entry.hits > 0 ? [`被翻到过 ${entry.hits} 次`] : []),
    ...(dayOf(entry.at) === '' ? [] : [`记于 ${dayOf(entry.at)}`]),
  ].filter((line): line is string => line !== '')

  return h(
    'li',
    // 正文不截断时不弹（弹出来只是把同一段话再说一遍）；将来若给它加 clamp，这条自动生效
    { style: S.memRow, ...hoverTipIfClamped(tip) },
    h(
      'div',
      { key: 'top', style: S.memTop },
      h('span', { key: 'kind', style: S.badge }, entry.label),
      h('span', { key: 'src', style: src.style }, src.label),
      // 次数与日期推到行尾：它们不该跟正文抢注意力
      h('span', { key: 'sp', style: { marginLeft: 'auto' } }),
      ...meta,
    ),
    h('div', { key: 'text', style: S.memText }, entry.text),
  )
}

/** 折叠组下面那句说明：同一档含义只在这里说一次。 */
// 这些是给人看的说明，不是字段解释：一律用"项目/会话/关于你"这些日常说法，
// 不出现"工作区""老档案""scope"这种内部词。
const FOLD_NOTE: Record<MemoryGroupView['scope'], string> = {
  here: '只在这个项目里成立，换个项目就不带过去。',
  unknown: '很早以前记的，那时候还不分项目，所以哪儿都看得见——但别当成"关于你"的。',
  ungrouped: '来自一个没有选项目的会话，跟别的会话里说过的不是一回事，所以单独列。',
  global: '跟项目无关的事（关于"你"的偏好），在哪个项目里都成立。',
  other: '别的项目里说过的话，看得见，但不带过来。',
}

/**
 * 一组记忆的组头该写什么。
 *
 * 用户两次点过同一件事：光看标题不知道这些记忆是哪个工作区的。所以这里的规矩是
 * **每一组都要自己说清出处**：
 *  · 绑了工作区的组，标题就是那个项目路径；别的项目再加一个「其他项目」徽标。
 *  · 未分组会话的组，标题是**那个会话的名字**（拿 `sessionId` 去会话列表里查），
 *    再挂「会话未分组」徽标说明它凭什么单独成组。查不到标题就写 `会话 xxxxxx`，不编。
 *  · 老档案与全局各有自己的徽标，含义见 `FOLD_NOTE`。
 *
 * 标题与徽标都在这里算，调用处只负责传 `ctx`：两处折叠（当前想法 / 记忆）必须一致。
 */
function groupHeadOf(
  ctx: ClientCtx | undefined,
  group: MemoryGroupView,
): { title: string; badge?: string } {
  if (group.scope === 'ungrouped') {
    const id = group.sessionId
    const title = id === undefined ? group.label : (sessionTitle(ctx, id) ?? `会话 ${id.slice(0, 8)}`)
    return { title, badge: '会话未分组' }
  }
  if (group.scope === 'unknown') return { title: group.label, badge: '早于工作区绑定' }
  if (group.scope === 'other') return { title: group.label, badge: '其他项目' }
  if (group.scope === 'global') return { title: group.label, badge: '跨项目' }
  return { title: group.label }
}

/**
 * 可折叠的一段（「当前想法」按项目 / 按会话折叠就是用这个）。
 *
 * 为什么不用 `<details>`：页面每 2 秒重渲染一次，`open` 作为属性会被 React 每次写回原值，
 * 用户刚展开的那一组会被自动合上。折叠状态必须攥在自己手里。
 *
 * `badge` 与 `subtitle` 是给"这一组凭什么算一组"用的：绑了工作区的组，标题就是项目路径；
 * 未分组会话的组，标题是那个会话的名字，再用徽标说明"它是因为会话没选工作区才单独成组的"。
 */
function Fold(props: {
  id: string
  title: string
  count: number
  badge?: string
  subtitle?: string
  note?: string
  defaultOpen?: boolean
  children: unknown[]
}): unknown {
  const [open, setOpen] = react.useState<boolean>(props.defaultOpen === true)
  return h(
    'div',
    { key: props.id, style: S.fold },
    h(
      'div',
      { key: 'head', style: S.foldHead, onClick: () => setOpen(!open) },
      // 三角和标题必须在**同一个** span 里：`foldHead` 是两头布局（space-between），
      // 三个并列的孩子会把标题挤到正中间——用户看到的就是"工作区名字居中"。
      h(
        'span',
        { key: 'label', style: S.foldLabel },
        h('span', { key: 'caret', style: S.foldCaret }, open ? '▾' : '▸'),
        h('span', { key: 'title', style: S.foldTitle }, props.title),
        props.badge === undefined ? null : h('span', { key: 'badge', style: S.foldBadge }, props.badge),
      ),
      h('span', { key: 'count', style: S.foldCount }, `${props.count} 条`),
    ),
    props.subtitle === undefined ? null : h('p', { key: 'sub', style: S.foldSub }, props.subtitle),
    open ? h('div', { key: 'body', style: S.foldBody }, ...props.children) : null,
    props.note === undefined ? null : h('p', { key: 'note', style: S.foldNote }, props.note),
  )
}

/**
 * 数值怎么读。
 *
 * 这几行是**刻度说明**（UI 帮助文本），不是它的状态内容，所以放在客户端。
 *
 * 第一版是页面底部一张常驻的"数值怎么读"卡，太长、也没人愿意每次往下翻，
 * 现在改成标题右侧那个小问号，悬浮/点一下才展开，而且**分成两组**：
 * 看「此刻」的时候只解释心情那些数，看「人设」的时候只解释语气那些数。
 *
 * 以后要挪进 core 的视图模型里，让 `/mind` 命令和这个页面共用一份——现在是两处措辞，
 * 迟早会漂。
 */
/**
 * 「此刻」这块说的是什么。
 *
 * 用户在 m06561 点明过：这两块说明应该是**这个数值系统的介绍**（它由哪些项构成、
 * 每个数的区间与口径），不是评论。所以只写"是什么、有几项、区间多少"，
 * 评价性的句子一律不写。
 */
const TIP_NOW = [
  '环里每一块是一个情绪，**占多大角度＝它有多强**，所有块合起来正好一圈。',
  '颜色固定：同一个词永远是同一种颜色。',
  '鼠标放到色块或文字上：它是什么意思、最近因为什么涨起来、这段被点起过几次。',
  '下面四条是心境：效价（难受↔舒服）、唤醒（松↔紧）、支配感、张力。',
]
const TIP_PERSONA = [
  '雷达图：三个轴是说话习惯（简洁 / 温度 / 直给），0–1，出厂都是 0.50。',
  '灰虚线＝出厂形状，蓝实线＝现在；偏出去多少就是被改了多少。',
  '鼠标放到轴端文字或顶点上：这一轴管什么、偏了多少、还能漂多少。',
]

/**
 * 刻度说明浮层：状态提到**模块级**，浮层由页面根部统一画一次。
 *
 * 为什么不能画在卡片里面（第一版就是这样，被用户逮到"这个面板显示在饼状图下方了"）：
 * 浮层是 `position: fixed`，但卡片里只要有任何一个祖先建了层叠上下文（`opacity<1`、
 * `transform`、`will-change` 都算），`z-index: 9999` 就只在这个上下文里比大小 —— 于是它
 * 被卡片外面的饼图盖住。把浮层挂成页面根部的最后一个孩子，它就在所有卡片之上，
 * 也不再受滚动容器裁剪。
 */
interface TipState {
  lines: string[]
  x: number
  y: number
  /** 点开过就"钉住"：鼠标移开也不关，再点一下或按 Esc 才关（触屏上 tap 不会有 mouseenter）。 */
  pinned: boolean
}
let tipState: TipState | undefined
const tipWatchers = new Set<() => void>()

function setTip(state: TipState | undefined): void {
  tipState = state
  for (const notify of tipWatchers) notify()
}

function useTip(): TipState | undefined {
  // 客户端的 `react` 是运行时 require 来的，类型上只暴露了"直接给值"这一种 setter；
  // 这里要用更新函数（否则闭包里的旧值会让它永远停在 1），所以把类型放宽一下。
  const [, force] = react.useState<number>(0) as [number, (next: number | ((n: number) => number)) => void]
  react.useEffect(() => {
    const notify = (): void => force((n: number) => n + 1)
    tipWatchers.add(notify)
    return () => {
      tipWatchers.delete(notify)
    }
  }, [])
  return tipState
}

/**
 * 页面根部画一次：没有开着的说明就什么都不画。
 *
 * 参数是页面那边订阅到的值，而不是模块里的 `tipState`——因为**必须有人订阅**才会重画：
 * 第一版只让那张小问号图标订阅，于是鼠标移进/移出只是图标自己重画，浮层得等页面
 * 因为 2 秒轮询或会话事件重画时才跟上，看着就是"要等一会才出来、移走也不立刻消失"。
 */
function tipLayer(state: TipState | undefined): unknown {
  if (state === undefined) return null
  return h(
    'div',
    { key: 'tiplayer', style: { ...S.tipPanel, left: `${state.x}px`, top: `${state.y}px` } },
    ...state.lines.map((line, index) => h('div', { key: `t${index}`, style: S.tipLine }, line)),
  )
}

/** Esc 关掉钉住的说明。装一次即可，`apply` 里调。 */
function installTipEscape(): void {
  const doc = (globalThis as { document?: { addEventListener?: unknown } }).document
  const listen = doc?.addEventListener as ((type: string, fn: (event: unknown) => void) => void) | undefined
  listen?.('keydown', (event: unknown) => {
    if ((event as { key?: string })?.key === 'Escape' && tipState !== undefined) setTip(undefined)
  })
}

/**
 * 标题右侧那个小问号：悬浮（或点一下钉住）才把说明展开。
 *
 * 只负责图标本身 —— 浮层在 `tipLayer()` 里画。坐标用按钮的实时视口位置，
 * 靠右时往左让一点，免得浮层跑出屏幕。
 */
function Tip(props: { lines: string[] }): unknown {
  // 订阅一下，好让"钉住期间点第二次"能正确关掉
  useTip()
  const at = (event: unknown): { x: number; y: number } | undefined => {
    const target = (event as { currentTarget?: unknown })?.currentTarget
    const rect = (target as { getBoundingClientRect?: () => { left: number; bottom: number } })?.getBoundingClientRect?.()
    if (rect === undefined) return undefined
    return { x: Math.max(8, Math.min(rect.left, window.innerWidth - 350)), y: rect.bottom + 6 }
  }
  const open = (event: unknown, pinned: boolean): void => {
    const spot = at(event)
    if (spot === undefined) return
    const same = tipState !== undefined && tipState.pinned === pinned && tipState.lines === props.lines
    // 已经钉住时再点一次 = 关掉
    setTip(same && pinned ? undefined : { lines: props.lines, ...spot, pinned })
  }
  return h(
    'span',
    {
      key: 'tipWrap',
      style: S.tipWrap,
      onMouseLeave: () => {
        if (tipState !== undefined && !tipState.pinned) setTip(undefined)
      },
    },
    h(
      'span',
      {
        key: 'icon',
        style: S.tipIcon,
        onMouseEnter: (event: unknown) => open(event, false),
        // 点一下钉住（触屏上 tap 不一定先来 mouseenter；做成"点了就没了"反而更糟）
        onClick: (event: unknown) => open(event, true),
      },
      '?',
    ),
  )
}

/** 中间那一栏的状态页：一句话现状 + 四区，外加"没话说"时的自查线索。 */
function MindPage(props: { sessionId?: string; ctx?: ClientCtx }): unknown {
  // 正常情况下来自座位注入（见 `apply` 里的 `inject`）；真拿不到就按"没有状态"如实显示，不编。
  const ctx = props?.ctx as ClientCtx
  const [found, setFound] = react.useState<{ sessionId: string; view: MindView } | undefined>(undefined)
  const [seen, setSeen] = react.useState(false)
  // 页面自己也订阅一遍说明浮层的状态：浮层是这一页画的，不订阅就得等下一次轮询才跟上
  // （用户原话："不是悬浮后立刻显示的，而是要等一会，而且鼠标移走也不会立刻消失"）。
  const tip = useTip()

  react.useEffect(() => {
    let alive = true
    const refresh = (): void => {
      if (!alive) return
      setFound(resolveSession(ctx, props?.sessionId))
      setSeen(true)
    }
    refresh()
    const off = subscribe(ctx, refresh)
    // 兜底轮询：万一套位的订阅口以后变了形状，页面也不会僵在那里（2 秒一次，纯本地读，零网络）。
    const timer = window.setInterval(refresh, 2000)
    return () => {
      alive = false
      off()
      window.clearInterval(timer)
    }
  }, [ctx, props?.sessionId])

  // 页面顶部只留标题：会话 id 前缀、折叠了多少事件、"不进对话"这类都是内部说明，
  // 不是给读者看的（用户点名删掉）。空状态的说明留在各卡片里，哪儿缺就说哪儿。
  const head = h('header', { key: 'head', style: S.head }, h('h1', { key: 't', style: S.title }, '心念'))

  /**
   * 页面按**用途**分三个 tab：此刻（状态）/ 想法（桌面 + 这段的流水账）/ 记忆（要自己查的那批）。
   *
   * 为什么分：内容一多，一屏同时挤着图表、记忆、日记、内心记录，既扫不出重点也不好找东西。
   * tab 先把用途分开，块内再折叠（`Fold`）——层级只有两级，不玩第三级。
   */
  const [tab, setTab] = react.useState<string>('now')
  const tabNow: unknown[] = []
  const tabThink: unknown[] = []
  const tabMemory: unknown[] = []
  const body: unknown[] = []
  if (!seen) {
    body.push(h('p', { key: 'reading', style: S.sub }, '正在读…'))
  } else if (found === undefined) {
    body.push(
      h(
        'section',
        { key: 'none', style: S.card },
        h('h2', { key: 'h', style: S.cardTitle }, '这个会话还没有状态'),
        h(
          'ul',
          { key: 'u', style: S.list },
          h('li', { key: 'a' }, '状态在事件提交之后才折叠出来——还没走完一个回合时它就是空的。'),
          h('li', { key: 'b' }, '插件刚装上、或者这个会话是装之前开的（旧会话不会补算）。'),
          h('li', { key: 'c' }, '会话投影没注册上（headless 里看 ~/.dsh/dsh-mind/mind.log 会有记录）。'),
        ),
      ),
    )
  } else {
    const view = normalizeView(found.view)
    // 四区的**文字**仍然来自中枢（措辞只有一处真相）；这里另外把结构化数据画成图。
    const linesOf = (title: string): string[] => {
      const section = view.sections.find((item) => item.title === title)
      return section === undefined ? [] : section.lines
    }
    const asLines = (lines: string[], prefix: string): unknown[] =>
      lines.map((line, index) => h('li', { key: `${prefix}${index}`, style: S.line }, line))

    // 顶部那行 `view.summary`（"焦虑(1.00)、疲惫(1.00)｜张力 0.00"）不画了：
    // 同样的信息在下面饼图与条里本来就有，重复一遍只是噪声（用户 m06561 点名删掉）。

    // 这里原来有个 `legend()`：饼图旁边那串"颜色 + 名字 + 数值"。
    // 情绪改气泡（标签画在泡泡旁边）、人设改刻度条之后，只剩记忆种类那块还有环图，
    // 那条图例已经没有调用点——留着就是一段走不到的代码，删掉。

    // ── ① 此刻：情绪环散点（位置＝哪种、面积＝多强）+ 心境与张力（条）──
    //
    // 这里原来是饼图。饼只能表达"份额"，而这些强度各自独立、加起来不等于 1——
    // 画成扇区等于编一份不存在的比例；而且环永远画满，"整体在变弱"这件事根本画不出来。
    const points = view.emotions.filter((item) => item.strength > 0.01)
    const strongest = view.emotions.reduce<{ word: string; strength: number } | null>(
      (best, item) =>
        best === null || item.strength > best.strength ? { word: item.word, strength: item.strength } : best,
      null,
    )
    const nowCard = h(
      'section',
      { key: 'now', style: { ...S.card, marginTop: 0 } },
      h(
        'h2',
        { key: 'h', style: S.cardTitle },
        '此刻',
        h(Tip, { key: 'tip', lines: TIP_NOW }),
        strongest === null
          ? null
          : h(
              'span',
              { key: 'top', style: { ...S.sub, marginLeft: 'auto', fontSize: '11px' } },
              `最强 ${strongest.word} ${strongest.strength.toFixed(2)}`,
            ),
      ),
      points.length > 0
        ? h(RoseChart, { key: 'rose', words: view.emotionWords ?? [], points: view.emotions })
        : h('p', { key: 'calm', style: S.sub }, '此刻没有情绪在。'),
      view.mood === undefined
        ? h('p', { key: 'stale', style: S.hint }, STALE_HOST)
        : h(
            'div',
            { key: 'bars', style: S.bars },
            h(Bar, {
              key: 'v',
              name: '效价',
              value: view.mood.valence,
              min: -1,
              max: 1,
              fmt: signed,
              tip: [
                `效价（−1～1）：方向——左边难受、右边舒服。现在是 ${signed(view.mood.valence)}。`,
                '它不是单独记的：所有被点起的情绪各自往一个方向推，合成一个合力。',
                '负向情绪多，它就往左；正向多，往右。',
              ],
            }),
            h(Bar, {
              key: 'a',
              name: '唤醒',
              value: view.mood.arousal,
              tip: [
                `唤醒（0～1）：松 ↔ 紧。现在是 ${view.mood.arousal.toFixed(2)}。`,
                '事情在推着它走的程度：连着来的一串工具调用、报错、催促会把它顶高；',
                '安静下来（长时间没有新信号）会自己回落。',
              ],
            }),
            h(Bar, {
              key: 'd',
              name: '支配感',
              value: view.mood.dominance,
              tip: [
                `支配感（0～1）：使不使得上劲。现在是 ${view.mood.dominance.toFixed(2)}。`,
                '能不能推动局面：连着失败、被驳回会压低它；自己把问题修好、事情推进会抬高它。',
              ],
            }),
            h(Bar, {
              key: 't',
              name: '张力',
              value: view.tension,
              tip: [
                `张力（0～1）：心里搁着没解决的事。现在是 ${view.tension.toFixed(2)}。`,
                '有事悬着它就高；回合正常收束时会自己降一点。它和情绪是两条线——',
                '情绪是"感觉"，张力是"还没落地的事"。',
              ],
            }),
          ),
    )

    // ── ② 人设：三条刻度条（当前值 + 出厂线 0.5 + 漂移带 ±drift）──
    //
    // 这里原来也是饼图。三个轴是**各自独立的刻度**（0.30 / 0.62 / 0.70，加起来不等于 1），
    // 画成扇区同样是在编比例。刻度条还多一层用处：能画出"离出厂线多远、还能漂多远"。
    // 出厂基线不进档案（见 types.ts：「出厂基线不在档案里」），所以画的是 0.5 这条出厂线
    // 加允许漂移带，**不编一个"档案基线"**。
    const voice = view.voice
    const personaCard = h(
      'section',
      { key: 'persona', style: { ...S.card, marginTop: 0 } },
      h(
        'h2',
        { key: 'h', style: S.cardTitle },
        '人设',
        h(Tip, { key: 'tip', lines: TIP_PERSONA }),
        voice === undefined
          ? null
          : h(
              'span',
              { key: 'drift', style: { ...S.sub, marginLeft: 'auto', fontSize: '11px' } },
              `出厂 0.50｜可漂 ±${voice.drift.toFixed(2)}`,
            ),
      ),
      voice === undefined
        ? h('p', { key: 'stale', style: S.hint }, STALE_HOST)
        : h(RadarChart, {
            key: 'radar',
            axes: [
              {
                label: '简洁',
                value: voice.brevity,
                note: voiceWord(voice.brevity, '偏长', '偏短'),
                tip: [
                  `简洁：说话**说多少**。现在是 ${voice.brevity.toFixed(2)}（${voiceWord(voice.brevity, '偏长', '偏短')}）。`,
                  '低（0.3）：背景、权衡、例子都讲一遍；高（0.7）：能一句就一句。',
                  '谁在推它：它自己上一轮说了多少字——超过 1200 字往下压，不到 200 字往上抬。',
                ],
              },
              {
                label: '温度',
                value: voice.warmth,
                note: voiceWord(voice.warmth, '偏冷', '偏暖'),
                tip: [
                  `温度：说话**什么口气**。现在是 ${voice.warmth.toFixed(2)}（${voiceWord(voice.warmth, '偏冷', '偏暖')}）。`,
                  '低（0.3）：只给事实、不寒暄；高（0.7）：先接住你的情绪再说事。',
                  '谁在推它：你道谢/夸它会暖一点；你驳回或打断它会冷一点。',
                ],
              },
              {
                label: '直给',
                value: voice.directness,
                note: voiceWord(voice.directness, '偏铺垫', '偏直接'),
                tip: [
                  `直给：说话**什么顺序**。现在是 ${voice.directness.toFixed(2)}（${voiceWord(voice.directness, '偏铺垫', '偏直接')}）。`,
                  '低（0.3）：先铺垫、再给结论；高（0.7）：结论第一、理由随后。',
                  '谁在推它：被驳回 → 少绕弯直接改；同一件事被重复说 → 上一遍没讲清，得铺垫。',
                ],
              },
              {
                label: '主动',
                // 旧宿主没有这一根：按出厂 0.5 显示，而不是画一个 0
                value: voice.initiative ?? 0.5,
                note: voiceWord(voice.initiative ?? 0.5, '只答所问', '会多给一层'),
                tip: [
                  `主动：说话**给多大范围**。现在是 ${(voice.initiative ?? 0.5).toFixed(2)}（${voiceWord(voice.initiative ?? 0.5, '只答所问', '会多给一层')}）。`,
                  '低（0.3）：问什么答什么，不多嘴；高（0.7）：会多提一层——提醒、追问、给建议。',
                  '谁在推它：你追问 → 多给一层；你打断 → 说明多嘴了，收着点。',
                ],
              },
            ],
          }),
      // 四根轴各管一件不同的事，得写出来——否则看着像三个重复的东西
      voice === undefined
        ? null
        : h(
            'p',
            { key: 'voicenote', style: S.sub },
            '四条轴出厂都是 0.50，偏离多少就是最近几轮改了多少：说多少 / 什么口气 / 什么顺序 / 给多大范围。它们之间没有"综合分"。',
          ),
      (view.voiceTraits ?? []).length === 0
        ? null
        : h(
            'div',
            { key: 'traits' },
            h('h3', { key: 'th', style: S.groupTitle }, '候选自我认知'),
            h(
              'ul',
              { key: 'tu', style: S.bulletList },
              // 每条**两行**、带项目符号：一行的话只剩半句，读者会以为这里只有一条
              //（用户原话："我还以为是一条或者两条，结果你这一行是一条"）。
              ...(view.voiceTraits ?? []).map((trait, index) =>
                h(
                  'li',
                  {
                    key: `tr${index}`,
                    // 圆点是 li 自己的（list-item），两行截断交给里面的 span——
                    // 两者不能塞进同一个元素：`display: list-item` 和 `-webkit-box` 打架。
                    // 所以这里**不套 S.line**（它就是 -webkit-box），只给 list-item。
                    style: { display: 'list-item', listStyleType: 'disc', marginBottom: '5px' },
                    // 两行装得下就不弹：短条目弹出同一段话只是挡视线
                    ...hoverTipIfClamped([
                      trait.label,
                      `它这么表现过 ${trait.hits} 次${trait.spanDays >= 1 ? `，前后跨了 ${trait.spanDays} 天` : ''}——还不足以写进"我是谁"`,
                    ]),
                  },
                  h('span', { key: 't', style: S.clamp2 }, trait.label),
                  h(
                    'span',
                    { key: 'm', style: { ...S.memMeta, marginLeft: '6px' } },
                    `见过 ${trait.hits} 次${trait.spanDays >= 1 ? ` / 跨 ${trait.spanDays} 天` : ''}`,
                  ),
                ),
              ),
            ),
          ),
      h(
        'ul',
        { key: 'u', style: S.list },
        // 「语气：…」那一行在有饼图时不重复画——同一个数两处出现（一处饼、一处文字），
        // 反而看不出哪个是准的。饼图缺失（旧宿主）时它还是唯一的信息源，照旧显示。
        ...asLines(
          linesOf('人设').filter(
            (line) =>
              // 「语气」那行在雷达已经在画时不重复列
              !(voice !== undefined && line.startsWith('语气')) &&
              // 候选列表已经展开时，不再重复那行"N 条"汇总；旧宿主没送列表时它才兜底
              !((view.voiceTraits ?? []).length > 0 && line.startsWith('候选自我认知')),
          ),
          'p',
        ),
      ),
    )

    // 两张卡并排：宽屏一左一右，窄屏自己折成上下（auto-fit）
    tabNow.push(h('div', { key: 'row1', style: S.row }, nowCard, personaCard))

    // ── ③ 当前想法：手边搁着的事，**按项目折叠**（折叠标题就是项目路径）+ 它自己写下的 ──
    //
    // 为什么把短期记忆从"记忆"那张卡里挪出来：它不是"存下来的东西"，而是此刻手上握着的。
    // 为什么还要按项目折叠：短记忆跟着档案跨会话活下来，别的项目里说过的话也可能躺在这里。
    // 以前只写「这个项目的 6 条」，用户没法知道是哪个项目——标题直接写路径。
    const shortFolds: unknown[] = (() => {
      const groups = view.shortGroups ?? []
      if (groups.length === 0) {
        // 旧宿主（没送 shortGroups）：退回平铺，别让这张卡空着
        return [
          h(
            'ul',
            { key: 'u', style: S.memList },
            ...view.shortMemory.map((entry, index) => h(MemoryRow, { key: `e${index}`, entry })),
          ),
        ]
      }
      return groups.map((group, index) => {
        const head = groupHeadOf(ctx, group)
        return h(
          Fold,
          {
            key: `f${index}`,
            id: `f${index}`,
            title: head.title,
            badge: head.badge,
            count: group.count,
            note: FOLD_NOTE[group.scope] ?? FOLD_NOTE.here,
            defaultOpen: index === 0,
          },
          group.entries.length > 0
            ? [
                h(
                  'ul',
                  { key: 'u', style: S.memList },
                  ...group.entries.map((entry, inner) => h(MemoryRow, { key: `e${inner}`, entry })),
                ),
              ]
            : [h('p', { key: 'none', style: S.foldNote }, '这组现在空着。')],
        )
      })
    })()
    tabThink.push(
      h(
        'section',
        { key: 'mind', style: S.card },
        h('h2', { key: 'h', style: S.cardTitle }, '当前想法'),
        h(
          'p',
          { key: 'sub', style: S.sub },
          '每次说话都会带上这几条——都是它自己写下来的，不会抄你的原话。' +
            '够重要的会被收进「记忆」，那之后就不再自动带上，它想用会自己去翻。',
        ),
        ...shortFolds,
        h('h3', { key: 'th', style: S.groupTitle }, thoughtTitle(view)),
        h('ul', { key: 'u', style: S.list }, ...asLines(linesOf('思想'), 't')),
      ),
    )

    // ── ③b 本会话日记：只增不改（v2.0 新的一层）──
    //
    // 为什么单独一张卡：它的更新方式和另外两层不一样——只往后加、永不改写旧条目，
    // 所以"这条为什么改不了"必须写在它自己身上，混进别的卡就解释不清。
    const diary = view.sessionMemory ?? []
    // 日记默认收起：它是最"流水账"的一层，占地方但不常看
    tabThink.push(
      h(Fold, {
        key: 'diary',
        id: 'diary',
        title: '本会话日记',
        count: diary.length,
        note:
          '这段对话的流水账：只往后加、不改旧条目。换个会话就看不到；'
          + '别的会话的日记它也能翻，但要它主动去查。',
        defaultOpen: false,
        children:
          diary.length > 0
            ? [
                h(
                  'ul',
                  { key: 'u', style: S.memList },
                  ...diary.map((entry, index) => h(MemoryRow, { key: `e${index}`, entry })),
                ),
              ]
            : [h('p', { key: 'none', style: S.sub }, '它还没写日记。攒够一段、或者这段对话结束时才会写。')],
      }),
    )

    // ── ④ 记忆：短期按这个会话、长期按项目分组 ──
    const kindSlices = view.memoryKinds.map((item, index) => ({
      label: item.label,
      value: item.count,
      color: PIE_COLORS[index % PIE_COLORS.length],
    }))
    const kindTotal = kindSlices.reduce((sum, slice) => sum + slice.value, 0)

    tabMemory.push(
      h(
        'section',
        { key: 'memory', style: S.card },
        h('h2', { key: 'h', style: S.cardTitle }, '记忆'),
        h(
          'p',
          { key: 'sub', style: S.sub },
          '这些不会自动带上，它想用会自己去翻。「当前想法」里够重要的会搬到这里——同一条只在一处。',
        ),
        kindSlices.length > 0
          ? h(
              'div',
              { key: 'pie', style: S.pieRow },
              h(Donut, { key: 'd', slices: kindSlices, center: `${kindTotal} 条`, size: 116 }),
              h(
                'ul',
                { key: 'lg', style: S.pieLegend },
                ...kindSlices.map((slice, index) =>
                  h(
                    'li',
                    { key: `k${index}`, style: S.pieLegendItem },
                    h('span', { key: 'dot', style: { ...S.dot, background: slice.color } }),
                    h('span', { key: 'name' }, slice.label),
                    h('span', { key: 'val', style: S.pieValue }, String(slice.value)),
                  ),
                ),
              ),
            )
          : h('p', { key: 'none', style: S.sub }, '还没有记下任何事。'),
        // 每组一个折叠（默认只展开第一组）：库里的分组一多，全铺开就是一屏流水账
        ...view.longGroups.map((group, index) => {
          const groupHead = groupHeadOf(ctx, group)
          return h(Fold, {
            key: `g${index}`,
            id: `lg${index}`,
            title: groupHead.title,
            count: group.count,
            ...(groupHead.badge === undefined ? {} : { badge: groupHead.badge }),
            note: FOLD_NOTE[group.scope],
            defaultOpen: index === 0,
            children: [
              ...(group.count > group.entries.length
                ? [h('p', { key: 'more', style: S.foldNote }, `下面只列了前 ${group.entries.length} 条`)]
                : []),
              h(
                'ul',
                { key: 'u', style: S.memList },
                ...group.entries.map((entry, i) => h(MemoryRow, { key: `e${i}`, entry })),
              ),
            ],
          })
        }),
      ),
    )
  }

  // 刻度说明改成标题右侧那个小问号了（常驻一张"数值怎么读"卡太长，也没人愿意每次往下翻）。
  // 浮层必须是**页面根部的最后一个孩子**：留在卡片里会被卡片的层叠上下文压住，
  // 于是"显示在饼状图下方"（真机上就是这样）。见 `tipLayer` 上面的说明。
  const TAB_LIST = [
    { id: 'now', label: '此刻', items: tabNow },
    { id: 'think', label: '想法', items: tabThink },
    { id: 'memory', label: '记忆', items: tabMemory },
  ]
  const current = TAB_LIST.find((item) => item.id === tab) ?? (TAB_LIST[0] as (typeof TAB_LIST)[number])

  return h(
    'div',
    { style: S.page },
    h(
      'div',
      { key: 'inner', style: S.inner },
      head,
      ...body,
      h(
        'div',
        { key: 'tabs', style: S.tabBar },
        ...TAB_LIST.map((item) =>
          h(
            'button',
            {
              key: item.id,
              style: { ...S.tab, ...(current.id === item.id ? S.tabOn : {}) },
              onClick: () => setTab(item.id),
            },
            item.label,
          ),
        ),
      ),
      ...current.items,
    ),
    tipLayer(tip),
  )
}

/** 样式：颜色一律走主题 token（写死的颜色在别的皮肤下会瞎）。 */
const S: Record<string, Record<string, unknown>> = {
  page: {
    // 这一页得**自己滚**。
    //
    // 宿主给面板的是一个固定高度的容器，父层并不负责滚动；页面自己不建滚动容器，
    // 超出的部分就永远看不到（第一版就是这样：内容比屏幕长，但页面滚不动）。
    // `height:100%` + `minHeight:0` + `overflowY:auto` 是"它自己能滚"的最小集合。
    height: '100%',
    minHeight: 0,
    boxSizing: 'border-box',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: '22px 26px 40px',
    fontSize: '13px',
    lineHeight: 1.75,
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  // 滚动条挂在 page 上（贴着容器边），内容再居中，免得滚条压在文字上
  inner: { maxWidth: '760px', margin: '0 auto' },
  // ── 顶层 tab（此刻 / 想法 / 记忆）────────────────────────────────
  //
  // 一条**贯穿的细底线** + 选中项贴底的 2px 实线。第一版给每个 tab 都设了
  // `borderBottom: 2px solid transparent`，结果浏览器把它渲染成了三条断开的小灰线
  // （看着像三个各自带下划线的按钮）。现在改用 `boxShadow: inset` 画选中线：
  // 未选中项**根本不画线**，想画错也没得画。
  //
  // 左侧对齐也修了：tab 的左右 padding 改成 0、用 marginRight 拉开间距，
  // 第一个 tab 的文字才能和标题「心念」左对齐。
  tabBar: {
    display: 'flex',
    margin: '2px 0 16px',
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18))',
  },
  tab: {
    appearance: 'none',
    background: 'transparent',
    border: 'none',
    padding: '7px 0',
    marginRight: '24px',
    marginBottom: '-1px',
    fontSize: '13px',
    fontFamily: 'inherit',
    color: 'inherit',
    opacity: 0.45,
    cursor: 'pointer',
    transition: 'opacity 120ms ease',
  },
  tabOn: { opacity: 1, boxShadow: 'inset 0 -2px 0 0 currentColor' },
  // ── 标题右侧的小问号（刻度说明）────────────────────────────────
  tipWrap: { display: 'inline-flex', verticalAlign: 'middle' },
  tipIcon: {
    marginLeft: '6px',
    width: '14px',
    height: '14px',
    lineHeight: '13px',
    textAlign: 'center',
    borderRadius: '50%',
    border: '1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.25))',
    fontSize: '10px',
    fontWeight: 400,
    opacity: 0.5,
    cursor: 'help',
    userSelect: 'none',
  },
  // 浮层用 fixed：面板根部是滚动容器，绝对定位会被裁掉
  tipPanel: {
    position: 'fixed',
    zIndex: 9999,
    width: '330px',
    maxWidth: 'calc(100vw - 40px)',
    padding: '9px 11px',
    borderRadius: '9px',
    // 浮层背景用 `bg-layer-2`（宿主自己弹面板用的就是这一档，见 dsh-better-sidebar 的
    // `cm-search.ts`：`layer-2` 背景 + `border-l1` 描边），边界用 `border-l1`。
    // 原先写过两个错的：`--dsw-alias-bg-elevated`（不存在，退回半透明兜底，深色下等于没背景）
    // 和 `--dsw-alias-bg-overlay`（存在，但那是**遮罩**那一档，压在卡片上颜色对不上，
    // 用户原话："背景色不对，和系统的主题色不一致"）。
    border: '1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12))',
    background: 'var(--dsw-alias-bg-layer-2, #2a2a33)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
    fontSize: '12px',
    lineHeight: 1.6,
    fontWeight: 400,
    opacity: 1,
    pointerEvents: 'none',
    textAlign: 'left',
  },
  tipLine: { marginBottom: '5px', opacity: 0.85 },
  head: { margin: '0 0 14px' },
  title: { margin: '0 0 4px', fontSize: '18px', fontWeight: 600 },
  sub: { margin: 0, opacity: 0.6, fontSize: '12px' },
  card: {
    marginTop: '12px',
    padding: '14px 16px',
    borderRadius: '12px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08))',
    background: 'var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.02))',
  },
  cardTitle: { margin: '0 0 8px', fontSize: '13px', fontWeight: 600, opacity: 0.9 },
  // 两张卡并排：宽度够就一左一右，不够就自己折成上下（auto-fit，不用管窗口多宽）
  row: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px', marginTop: '12px' },
  hint: { margin: '12px 0 0', fontSize: '12px', opacity: 0.55 },
  list: { margin: 0, paddingLeft: '18px', display: 'grid', gap: '5px' },
  /**
   * 带圆点的列表。
   *
   * 必须用 `block` 而不是 `grid`：**grid 会把子项的 display 强制降级成 block**，
   * `li` 的 list-item 身份一没，圆点就消失了（用户盯着问"我说的无序列表要的是前面那个点"）。
   * 同理 `li` 自己也不能套 `S.line`（那是 `-webkit-box`，一样会杀掉圆点）。
   */
  bulletList: { margin: '2px 0 0', paddingLeft: '20px', display: 'block' },
  line: {
    // 两行收口：记忆条目常常很长，铺开来整个页面就没法看了
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },

  // ── 图表：饼 + 条 ──────────────────────────────────────────────
  pieRow: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', margin: '4px 0 2px' },
  donutWrap: { position: 'relative', flex: '0 0 auto' },
  donutCenter: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '0 16px',
    fontSize: '12px',
    fontWeight: 600,
    opacity: 0.85,
  },
  pieLegend: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '4px', flex: '1 1 150px', fontSize: '12px' },
  pieLegendItem: { display: 'flex', alignItems: 'center', gap: '7px', opacity: 0.9 },
  pieValue: { marginLeft: 'auto', opacity: 0.6, fontVariantNumeric: 'tabular-nums' },
  dot: { width: '9px', height: '9px', borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
  bars: { display: 'grid', gap: '9px', marginTop: '12px' },
  barRow: { display: 'grid', gap: '4px' },
  barLabel: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', opacity: 0.85 },
  barValue: { opacity: 0.6, fontVariantNumeric: 'tabular-nums' },
  barWrap: {
    position: 'relative',
    height: '8px',
    borderRadius: '4px',
    // 轨道用边框色而不是"抬升面"：`bg-layer-2` 在浅色主题下几乎和卡片同色，
    // 于是"剩下的那部分"根本看不见，0.67 看着像 0.9。边框色两个主题都够清楚。
    background: 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.10))',
    // 不能 hidden：零刻度要上下探出轨道才看得见（用户点过一次"高度不够、不明显"）
    overflow: 'visible',
  },
  barTrack: { position: 'absolute', inset: 0 },
  // 允许漂移的带宽：只留两条边界刻度（0.3 与 0.7），不铺色块——
  // 铺色块会让带内比带外"更实"，填充条看起来被拉长，右边的空档就不够数了。
  bandTick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '1px',
    background: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.28))',
  },
  barFill: { position: 'absolute', top: 0, bottom: 0, left: 0, borderRadius: '4px', background: 'var(--dsw-alias-brand-primary, #8ab4ff)' },
  // 零刻度：跨零的量（效价）从中间长出去，得让人看见那个 0 在哪儿。
  // 上下各探出轨道 3px、加宽到 2px、颜色提到 label-secondary —— 只在轨道内画一条
  // 1px 的淡线，用户在原尺寸下根本看不见（他点过一次"高度不够、不明显"）。
  barMid: {
    position: 'absolute',
    top: '-3px',
    bottom: '-3px',
    width: '2px',
    borderRadius: '1px',
    background: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55))',
  },

  // ── 记忆 ──────────────────────────────────────────────────────
  memList: { listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: '9px' },
  memRow: {
    display: 'grid',
    gap: '3px',
    paddingBottom: '8px',
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06))',
  },
  memTop: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' },
  badge: {
    fontSize: '11px',
    padding: '1px 6px',
    borderRadius: '999px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14))',
    opacity: 0.85,
  },
  memMeta: { fontSize: '11px', opacity: 0.5 },
  // 来源标签：它自己记的（品牌色，一眼看出这是它的话）/ 听来的原话（灰的，兜底）
  srcSelf: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '999px',
    whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-brand-primary, #8ab4ff)',
    border: '1px solid var(--dsw-alias-brand-primary, #8ab4ff)',
    opacity: 0.9,
  },
  srcHeard: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '999px',
    whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24))',
    opacity: 0.7,
  },
  // 折叠组头右侧的小徽标：说明"这一组凭什么算一组"（其他项目 / 会话未分组 / 跨项目…）
  foldBadge: {
    fontSize: '10px',
    lineHeight: '16px',
    padding: '0 6px',
    borderRadius: '999px',
    whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28))',
  },
  // 正文**不截断**：这是"它记着的事"，少一个字都可能变意思（用户点名过"怎么还截断了"）。
  // 面板本来就能滚，宁可让一条长一点，也不要让读者猜后半句。
  memText: { wordBreak: 'break-word', lineHeight: 1.6 },
  /**
   * 两行截断（`-webkit-box` 那套）。
   *
   * 用两行而不是一行：候选自我认知常是一整段话，压成一行只剩"用户看截图挑细节，说明要的是…"，
   * 读者根本看不出这条到底在说什么（用户就是这么以为"只有一条"的）。
   */
  clamp2: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    wordBreak: 'break-word',
    lineHeight: 1.6,
  },
  groupTitle: { display: 'flex', alignItems: 'baseline', gap: '8px', margin: '0 0 2px', fontSize: '12px', fontWeight: 600, opacity: 0.9 },
  // 折叠组：标题行整行可点，左边一个小三角；展开后正文再往下排。
  fold: { margin: '10px 0 0' },
  // 折叠组的头：做成一张卡片（有底色、有边框、可悬停），这样它一眼就是"能点开的一块"，
  // 而不是一行看不出门道的文字。展开后正文缩进一点，才能看出它是这卡片的里面。
  foldHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    cursor: 'pointer',
    userSelect: 'none',
    padding: '7px 10px',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
    border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10))',
  },
  foldLabel: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 },
  foldCaret: { fontSize: '10px', opacity: 0.55, width: '14px', flex: '0 0 14px', textAlign: 'center' },
  foldTitle: { fontSize: '12px', fontWeight: 600, opacity: 0.92, wordBreak: 'break-all' },
  // 条数做成右侧的小胶囊，跟标题拉开，眼睛一扫就知道这组有多少
  foldCount: {
    fontSize: '11px',
    fontWeight: 400,
    opacity: 0.6,
    flex: '0 0 auto',
    padding: '1px 7px',
    borderRadius: '999px',
    background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
  },
  foldNote: { margin: '4px 0 0 15px', fontSize: '11px', lineHeight: 1.6, opacity: 0.55 },
  foldBody: { margin: '2px 0 0 15px' },

  // ── 设置页（settings.section） ──
  // 页面比状态页宽一点：一行里要装下"字段名 + 说明 + 控件"，760px 会挤成一团
  setPage: { maxWidth: '860px', margin: '0 auto', padding: '4px 2px 40px' },
  setBanner: {
    marginTop: '12px',
    padding: '12px 14px',
    borderRadius: '10px',
    fontSize: '12.5px',
    lineHeight: 1.7,
    border: '1px solid var(--dsw-alias-state-warn-primary, rgba(200,140,0,0.45))',
    background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
  },
  setBannerBad: {
    border: '1px solid var(--dsw-alias-state-error-primary, rgba(220,60,60,0.45))',
  },
  setBannerQuiet: {
    border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10))',
  },
  setBar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '14px' },
  setBtn: {
    padding: '6px 14px',
    borderRadius: '8px',
    fontSize: '12.5px',
    fontFamily: 'inherit',
    cursor: 'pointer',
    // 这两个 token 是**实测过的**：`--dsw-alias-button-primary-label` / `-fill` 在主题里**不存在**，
    // 用了就会回落到 inherit 与半透明灰——深色方块上一个字都看不见（用户就是这么发现 bug 的）。
    // 主按钮用品牌色 + 白字，跟宿主自己的主按钮一个观感。
    color: '#fff',
    background: 'var(--dsw-alias-brand-primary, rgba(90, 120, 255, 0.9))',
    border: '1px solid transparent',
  },
  setBtnGhost: {
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary, inherit)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14))',
  },
  setNote: { fontSize: '12px', lineHeight: 1.6, flex: '1 1 240px', minWidth: 0 },
  setNoteOk: { color: 'var(--dsw-alias-state-success-primary, inherit)' },
  setNoteWarn: { color: 'var(--dsw-alias-state-warn-primary, inherit)' },
  setNoteBad: { color: 'var(--dsw-alias-state-error-primary, inherit)' },
  // 分组不套卡片：卡片套卡片是"自己设计一套版式"，而用户要的是**和通用设置一样**——
  // 组标题 + 一行说明 + 若干行字段，行间一条细线就够了。
  setGroup: { marginTop: '22px' },
  setGroupTitle: {
    fontSize: '13px',
    fontWeight: 600,
    paddingBottom: '6px',
    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14))',
  },
  setGroupNote: { margin: '4px 0 2px', fontSize: '11.5px', lineHeight: 1.6, opacity: 0.6 },
  setRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '14px',
    padding: '9px 0',
    borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
  },
  setInfo: { flex: '1 1 auto', minWidth: 0 },
  setLabel: { fontSize: '12.5px', fontWeight: 600, lineHeight: 1.5 },
  setDesc: { marginTop: '2px', fontSize: '11.5px', lineHeight: 1.65, opacity: 0.62 },
  setCtrl: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '7px', paddingTop: '1px' },
  setInput: {
    width: '136px',
    height: '30px',
    padding: '0 10px',
    borderRadius: '8px',
    fontSize: '13px',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    color: 'inherit',
    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
  },
  setInputBad: { border: '1px solid var(--dsw-alias-state-error-primary, rgba(220,60,60,0.6))' },
  setInputText: { width: '100%', minWidth: '300px', height: '30px' },
  setRange: { fontSize: '11px', opacity: 0.5, whiteSpace: 'nowrap' },
  setDirty: { fontSize: '11px', color: 'var(--dsw-alias-brand-primary, inherit)', whiteSpace: 'nowrap' },
  // 开关自己画：原生 `input[type=checkbox]` 是浏览器那个大方框，和设置面板里其它几页的 pill 开关
  // 放在一起像两个人做的界面。尺寸按通用设置的观感取（38×22，圆点 16）。
  setToggle: {
    position: 'relative',
    flex: '0 0 auto',
    width: '40px',
    height: '22px',
    padding: 0,
    margin: 0,
    borderRadius: '999px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14))',
    background: 'var(--dsw-alias-state-idle-primary, rgba(127, 127, 127, 0.35))',
    cursor: 'pointer',
    appearance: 'none',
    boxSizing: 'border-box',
    lineHeight: 0,
    transition: 'background 120ms ease, border-color 120ms ease',
  },
  setToggleOn: {
    background: 'var(--dsw-alias-brand-primary, rgba(90, 120, 255, 0.9))',
    borderColor: 'transparent',
  },
  setToggleKnob: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.30)',
    transition: 'left 120ms ease',
  },
  setToggleKnobOn: { left: '20px' },
  setFoot: { marginTop: '16px', fontSize: '11px', lineHeight: 1.7, opacity: 0.5 },
}

/* ───────────────────────── 设置页（settings.section） ───────────────────────── */

/**
 * 设置页在设置面板里的排序。
 *
 * 实测到的邻居：better-sidebar 用 100、llm-retry-settings 用 15。取 40 → 排在它们中间，
 * 既不抢最前面，也不至于沉到看不见。
 */
const SETTINGS_SECTION_ORDER = 40

/**
 * 插件自己的路由前缀。**必须**与宿主半边 `src/settings-bridge.ts` 的 `SETTINGS_ROUTE_PREFIX` 一字不差。
 *
 * 两边写死同一个字符串是刻意的：宿主与客户端是两份独立产物（客户端连 `require` 都只有 `react` 可用），
 * 没有共享模块这条路可走。改一处就要改另一处——两边的注释里都写了这句。
 */
const SETTINGS_ROUTE = 'dsh-mind/api'

/** 目录里的一个字段（宿主从 `src/config.ts` 的 `CONFIG_FIELDS` 直接送过来）。 */
interface SettingsField {
  key: string
  label: string
  kind: 'boolean' | 'number' | 'string'
  fallback: unknown
  description: string
  group: string
  min?: number
  max?: number
}

/** 目录里的一组字段。 */
interface SettingsGroup {
  id: string
  title: string
  note: string
  keys: string[]
}

/** `settings.get` / `settings.update` 的返回快照。 */
interface SettingsSnapshot {
  available: boolean
  /** 认出来的命名空间。它只是实现细节，**不展示给用户**（认错了印出来只会更糟）。 */
  namespace?: string
  /** 设置服务里有没有"我们这一条"。false 时这一页只能看、不能存，并且要如实说。 */
  namespaceFound?: boolean
  value?: unknown
  revision?: unknown
  reason?: string
  fields: SettingsField[]
  groups: SettingsGroup[]
}

/** 一次调用失败。`code` 原样来自宿主，用来分辨"没保存上"是哪种没保存上。 */
class SettingsCallError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SettingsCallError'
    this.code = code
  }
}

/** 页面底部的一句提示（成功 / 冲突 / 失败 / 提醒）。 */
interface SettingsNote {
  kind: 'ok' | 'warn' | 'bad'
  text: string
}

/**
 * HTTP 发到哪儿。
 *
 * 走**页面自己的 base**：桌面壳的页面是 `dsh-app://app/`，壳把非静态路径同源转发给宿主；
 * 而插件注册的路由**没有 `Access-Control-Allow-*` 头**，所以不能发到注入进来的
 * `__DSH_TRANSPORT__.streamBaseUrl`（那是宿主真实 origin，只适合 WebSocket，浏览器会按跨域拦掉）。
 * 这段等价实现是照 better-sidebar 的 `desktop-env.ts` + `host-route-url.ts` 写的——
 * 那两个文件在别人的包里，我们不能 import。
 */
function hostHttpBase(): string {
  const page = typeof document !== 'undefined' ? document.baseURI : undefined
  if (typeof page === 'string' && page !== '') return page
  const injected = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__
  const stream = injected?.streamBaseUrl
  return typeof stream === 'string' && stream !== '' ? stream : ''
}

/** 把 base 归一成"目录"（去掉 query/hash，结尾补 `/`），这样相对路径不会把最后一段吃掉。 */
function directoryBase(baseUrl: string): string {
  const placeholder = 'http://dsh.internal/'
  const url = new URL(baseUrl === '' ? placeholder : baseUrl, placeholder)
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

/** `<插件前缀>/<方法名>` 的完整地址。 */
function settingsRouteUrl(method: string): string {
  return new URL(`${SETTINGS_ROUTE}/${method}`.replace(/^\/+/, ''), directoryBase(hostHttpBase())).href
}

/**
 * 调一次设置路由。
 *
 * 信封形状与宿主一致：成功 `{ok:true,value}`、失败 `{ok:false,error:{code,message}}`。
 * **没有 `value` 就算失败**——宁可报错，也不把"没值"当成"值是空的"画出去。
 */
async function callSettings(method: string, payload: Record<string, unknown>): Promise<SettingsSnapshot> {
  let response: Response
  try {
    response = await fetch(settingsRouteUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new SettingsCallError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed = (await response.json().catch(() => null)) as
    | { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
    | null
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new SettingsCallError(parsed?.error?.code ?? 'http', parsed?.error?.message ?? `HTTP ${response.status}`)
  }
  return parsed.value as SettingsSnapshot
}

/** 把一次调用失败翻成给用户看的中文。宿主的 message 已经是中文的，就原样用。 */
function describeSettingsError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = (error as { message?: unknown } | null)?.message
  const text = typeof message === 'string' && message !== '' ? message : String(error)
  if (code === 'network') return `连不上宿主：${text}`
  if (code === 'unknown-method') {
    return '宿主没有这条设置路由（这一版 dsh-mind 或宿主需要重新加载）。'
  }
  return text
}

/** 从事件里取输入框的值（不用 DOM 类型，客户端只用得到这两种）。 */
function inputTextOf(event: unknown): string {
  const target = (event as { target?: { value?: unknown } } | null)?.target
  return typeof target?.value === 'string' ? target.value : ''
}

/** 某个字段当前显示什么值：**草稿优先**（用户刚敲的不能被一次刷新盖掉）。 */
function shownValue(snapshot: SettingsSnapshot | null, draft: Record<string, unknown>, field: SettingsField): unknown {
  if (Object.prototype.hasOwnProperty.call(draft, field.key)) return draft[field.key]
  const value = snapshot?.value
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(record, field.key)) return record[field.key]
  }
  return field.fallback
}

/** 草稿里这个字段改过没有。 */
function isDirty(draft: Record<string, unknown>, field: SettingsField): boolean {
  return Object.prototype.hasOwnProperty.call(draft, field.key)
}

/**
 * 这个值能不能交给宿主。
 *
 * 为什么在这里挡一道：宿主会把不合规的值退回来（400），但那句话是给开发者看的；
 * 用户在输入框里看到"不能小于 0"要直接得多。**两边都拦**，不是二选一。
 */
function issueOf(field: SettingsField, raw: unknown): string | undefined {
  if (field.kind === 'boolean') return typeof raw === 'boolean' ? undefined : '只能是开或关'
  if (field.kind === 'number') {
    const text = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim()
    if (text === '') return '不能留空'
    const value = Number(text)
    if (!Number.isFinite(value)) return '要填一个数字'
    if (field.min !== undefined && value < field.min) return `不能小于 ${field.min}`
    if (field.max !== undefined && value > field.max) return `不能大于 ${field.max}`
    return undefined
  }
  return typeof raw === 'string' ? undefined : '要填一段文字'
}

/** 把草稿里**改过的**字段拼成 patch（数字转成数字）。没改的字段不出现——省得把整份配置来回写一遍。 */
function patchOf(fields: readonly SettingsField[], draft: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const field of fields) {
    if (!isDirty(draft, field)) continue
    const raw = draft[field.key]
    patch[field.key] = field.kind === 'number' && typeof raw !== 'number' ? Number(String(raw).trim()) : raw
  }
  return patch
}

/** 一行控件。 */
function SettingsRow(props: {
  field: SettingsField
  shown: unknown
  dirty: boolean
  issue: string | undefined
  disabled: boolean
  onEdit: (key: string, value: unknown) => void
}): unknown {
  const { field, shown, dirty, issue, disabled } = props
  const control = ((): unknown => {
    if (field.kind === 'boolean') {
      const on = shown === true
      return h(
        'button',
        {
          key: 'c',
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          title: on ? '已开启' : '已关闭',
          style: Object.assign({}, S.setToggle, on ? S.setToggleOn : {}),
          disabled,
          onClick: () => props.onEdit(field.key, !on),
        },
        h('span', { key: 'k', style: Object.assign({}, S.setToggleKnob, on ? S.setToggleKnobOn : {}) }),
      )
    }
    if (field.kind === 'number') {
      return h('input', {
        key: 'c',
        type: 'number',
        style: Object.assign({}, S.setInput, issue === undefined ? {} : S.setInputBad),
        value: shown === undefined || shown === null ? '' : String(shown),
        min: field.min,
        max: field.max,
        disabled,
        onChange: (event: unknown) => props.onEdit(field.key, inputTextOf(event)),
      })
    }
    return h('input', {
      key: 'c',
      type: 'text',
      style: Object.assign({}, S.setInput, S.setInputText),
      value: shown === undefined || shown === null ? '' : String(shown),
      disabled,
      onChange: (event: unknown) => props.onEdit(field.key, inputTextOf(event)),
    })
  })()

  const hint =
    field.kind === 'number' && !disabled && field.min !== undefined && field.max !== undefined
      ? h('span', { key: 'h', style: S.setRange }, `${field.min} – ${field.max}`)
      : null

  return h(
    'div',
    { key: field.key, style: S.setRow },
    h(
      'div',
      { key: 'info', style: S.setInfo },
      h(
        'div',
        { key: 'label', style: S.setLabel },
        field.label,
        dirty ? h('span', { key: 'd', style: S.setDirty }, ' · 待保存') : null,
      ),
      h('div', { key: 'desc', style: S.setDesc }, field.description),
      issue === undefined ? null : h('div', { key: 'issue', style: Object.assign({}, S.setDesc, S.setNoteBad) }, issue),
    ),
    h('div', { key: 'ctrl', style: S.setCtrl }, hint, control),
  )
}

/**
 * 设置面板里的「心念」页。
 *
 * 三条自己在意的：
 *
 * 1. **值的真相在宿主**。这一页只存"用户改了但还没保存的草稿"，从不把配置存第二份——
 *    否则改完在别处一看还是旧的，那种错最难查。
 * 2. **拿不到就如实说**。宿主没提供设置服务时，页面照旧把字段和说明列出来（那是编译期就定下的知识），
 *    但控件是灰的，并在最上面写清为什么——**不编一份"看起来正常的默认值"当真的值**。
 * 3. **改的是改过的字段**。保存只发改过的那几个 key，不是把整份配置回写一遍。
 */
function SettingsSection(): unknown {
  const [snapshot, setSnapshot] = react.useState<SettingsSnapshot | null>(null)
  const [draft, setDraft] = react.useState<Record<string, unknown>>({})
  const [loadError, setLoadError] = react.useState<string | null>(null)
  const [note, setNote] = react.useState<SettingsNote | null>(null)
  const [busy, setBusy] = react.useState<boolean>(false)

  // 挂载时读一次。
  //
  // `cancelled` 是必须的：这一页可能被用户很快切走，切走之后 setState 会警告（而且那份快照也没人看）。
  // 读回来的值**不碰草稿**：显示时草稿优先（见 `shownValue`），所以用户挂载后立刻敲的字不会被盖掉。
  react.useEffect(() => {
    let cancelled = false
    void callSettings('settings.get', {})
      .then((next) => {
        if (cancelled) return
        setSnapshot(next)
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(describeSettingsError(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const edit = (key: string, value: unknown): void => {
    const next: Record<string, unknown> = {}
    for (const existing of Object.keys(draft)) next[existing] = draft[existing]
    next[key] = value
    setDraft(next)
  }

  const reset = (): void => {
    setDraft({})
    setNote({ kind: 'warn', text: '已丢弃还没保存的改动。' })
  }

  const reload = (): void => {
    setBusy(true)
    void callSettings('settings.get', {})
      .then((next) => {
        setSnapshot(next)
        setLoadError(null)
        setNote({ kind: 'ok', text: '已重新读取宿主上的值。' })
      })
      .catch((error: unknown) => {
        setLoadError(describeSettingsError(error))
      })
      .finally(() => setBusy(false))
  }

  const fields: SettingsField[] = snapshot?.fields ?? []
  const changed = fields.filter((field) => isDirty(draft, field))
  const available = snapshot?.available === true
  // 能写 = 有设置服务。**不**因为「暂时认不出自己那一条记录」就把整页禁掉：
  // 用户点了没反应，比明说"存不进去"更糟（这是真机上踩出来的）。
  // 真认不出时，保存会把宿主的原话带回来，横幅也如实写着。
  const writable = available

  const save = (): void => {
    if (busy || snapshot === null || !writable) return
    if (changed.length === 0) {
      setNote({ kind: 'warn', text: '还没有改动。' })
      return
    }
    const broken = changed.filter((field) => issueOf(field, draft[field.key]) !== undefined)
    if (broken.length > 0) {
      const first = broken[0]
      setNote({ kind: 'bad', text: `有 ${broken.length} 项填得不对，先改一下：${first.label}（${issueOf(first, draft[first.key])}）` })
      return
    }
    const patch = patchOf(fields, draft)
    setBusy(true)
    setNote(null)
    void callSettings('settings.update', { patch, expectedRevision: snapshot.revision })
      .then((next) => {
        setSnapshot(next)
        setDraft({})
        setNote({
          kind: 'ok',
          text: `已保存 ${Object.keys(patch).length} 项，现在是第 ${String(next.revision ?? '?')} 版。`,
        })
      })
      .catch((error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code
        if (code === 'settings-conflict') {
          // 冲突 = 我们手上的 revision 过期了。**不丢用户的改动**：草稿留着，
          // 只把底下的值刷成最新的，用户再点一次保存就能写进去（新 revision 会带过去）。
          setNote({
            kind: 'warn',
            text: '这些值刚在别处被改过，这次没写进去。下面的值已经刷成最新的，你的改动还留着——确认后再点一次保存。',
          })
          void callSettings('settings.get', {})
            .then((fresh) => setSnapshot(fresh))
            .catch(() => undefined)
        } else {
          setNote({ kind: 'bad', text: `保存失败：${describeSettingsError(error)}` })
        }
      })
      .finally(() => setBusy(false))
  }

  /* ── 页面骨架 ── */

  // 标题下**不印**命名空间与版本号：那是实现细节（命名空间名字还是宿主按挂载方式给的），
  // 对用户没有意义，印错了更糟。页面顶部那行内部信息被用户点名过一次了。
  const header = h(
    'div',
    { key: 'head', style: S.head },
    h(
      'div',
      { key: 't', style: { ...S.title, display: 'flex', alignItems: 'center', gap: '8px' } },
      // 左侧导航那一格的图标改不了：`settings.section` 的注册字段只有 id/order/label，
      // 宿主给每一页画统一的齿轮。所以把自己这枚"心 + 脉搏"画在页面标题旁边。
      h(MindIcon, { size: 18 }),
      '心念',
    ),
    h(
      'div',
      { key: 'sub', style: S.setFoot },
      '决定它开不开、脾气多大、记性多好、以及忘得多快。改完点「保存」就生效，不用重启。',
    ),
  )

  const banners: unknown[] = []
  if (loadError !== null) {
    banners.push(
      h('div', { key: 'load', style: Object.assign({}, S.setBanner, S.setBannerBad) }, `读不到设置：${loadError}`),
    )
  } else if (snapshot === null) {
    banners.push(h('div', { key: 'loading', style: S.setBanner }, '正在读宿主上的配置……'))
  } else if (!available) {
    // 这里用的就是宿主给的那句话（拿不到设置服务时是"这台宿主没有提供设置服务，只能用配置文件改。"）
    banners.push(
      h(
        'div',
        { key: 'none', style: S.setBanner },
        snapshot.reason ?? '这台宿主没有提供设置服务，只能用配置文件改。',
        h('div', { key: 'x', style: S.setFoot }, '下面的字段与说明仍然列出来，但控件不可编辑。'),
      ),
    )
  } else if (snapshot.reason !== undefined && snapshot.reason !== '') {
    // 认不出"我们这一条"时给一句话，但**不用警告色**：它不是错误，是"还没落进这个 profile"，
    // 拿橙色横幅喊它只会让人以为坏了（用户上一版就是这么被误导的）。
    banners.push(h('div', { key: 'norec', style: Object.assign({}, S.setBanner, S.setBannerQuiet) }, snapshot.reason))
  }

  const bar = h(
    'div',
    { key: 'bar', style: S.setBar },
    h(
      'button',
      {
        key: 'save',
        type: 'button',
        style: Object.assign({}, S.setBtn, busy || !writable || changed.length === 0 ? { opacity: 0.55 } : {}),
        disabled: busy || !writable || changed.length === 0,
        onClick: () => save(),
      },
      busy ? '保存中……' : changed.length === 0 ? '保存' : `保存 ${changed.length} 项`,
    ),
    h(
      'button',
      {
        key: 'reset',
        type: 'button',
        style: Object.assign({}, S.setBtn, S.setBtnGhost),
        disabled: busy || changed.length === 0,
        onClick: () => reset(),
      },
      '丢弃改动',
    ),
    h(
      'button',
      { key: 'reload', type: 'button', style: Object.assign({}, S.setBtn, S.setBtnGhost), disabled: busy, onClick: () => reload() },
      '重新读取',
    ),
    note === null
      ? null
      : h(
          'span',
          {
            key: 'note',
            style: Object.assign(
              {},
              S.setNote,
              note.kind === 'ok' ? S.setNoteOk : note.kind === 'warn' ? S.setNoteWarn : S.setNoteBad,
            ),
          },
          note.text,
        ),
  )

  const groups = (snapshot?.groups ?? []).map((group) => {
    const rows: unknown[] = []
    for (const key of group.keys) {
      const field = fields.find((candidate) => candidate.key === key)
      if (field === undefined) continue
      const shown = shownValue(snapshot, draft, field)
      rows.push(
        SettingsRow({
          field,
          shown,
          dirty: isDirty(draft, field),
          issue: isDirty(draft, field) ? issueOf(field, draft[field.key]) : undefined,
          disabled: !writable,
          onEdit: edit,
        }),
      )
    }
    return h(
      'section',
      { key: group.id, style: S.setGroup },
      h('div', { key: 't', style: S.setGroupTitle }, group.title),
      h('div', { key: 'n', style: S.setGroupNote }, group.note),
      rows,
    )
  })

  const foot = h(
    'div',
    { key: 'foot', style: S.setFoot },
    '改完点「保存」写入宿主，立即生效。这一页不另存一份配置。',
  )

  return h('div', { style: S.setPage }, header, banners, bar, groups, foot)
}
