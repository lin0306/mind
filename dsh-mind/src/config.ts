/**
 * 插件配置：接到 DSH 的设置表单上，再翻译成内核参数。
 *
 * ## 为什么不能"拿不到 schemastery 就算了"
 *
 * feiyu-memory 实测（社区报告 + 自己的铁证）：**`Config` 导出 undefined 时，DSH 会传一份空模板**
 * （每个字段都是 `{}`），于是所有回落默认，**用户改的任何配置都不生效**。
 * 证据是 `cordis.patch.yml` 里显式写 `config: { debugLog: true }`，传进来还是 `{}`。
 *
 * 所以这里兜一个**纯 JS 的形状等价物**：loader 只用到 `Config(dict)` 与 `Config.toString()/.dict`，
 * 手写一个最小的即可。
 *
 * ## 另一个坑
 *
 * `@deepseek-ai/schemastery` 是宿主自带的包，插件里不一定解析得到；静态 import 失败会让
 * **整个插件加载失败**。所以走 `resolveModule` 多基准试探 + 降级。
 */

import { withDefaults, type MindTunables } from 'dsh-mind-core'
import { resolveModule, type LoggerLike } from './host.js'

/** 一个配置字段的形状（降级 schema 与翻译都要用它）。 */
interface ConfigField {
  key: string
  kind: 'boolean' | 'number' | 'string'
  fallback: boolean | number | string
  description: string
  /**
   * 设置页上显示的短名（中文）。
   *
   * 为什么要单独有一栏：`key` 是给代码看的（`baselineValence`），
   * `description` 是完整解释（一句话，适合放控件下面），而设置页左侧那一列需要一个**扫一眼就懂**的名字。
   * 三样东西是三种用途，不能互相顶替——把 `key` 直接当名字摆出来，用户看的就是一列英文驼峰。
   */
  label: string
  min?: number
  max?: number
  /**
   * 进不进**设置页**（默认进）。
   *
   * 为什么要有这一栏：有些项是内核参数，不是给用户拧的旋钮——比如短期记忆条数
   * （该由对话内容自己决定）、BM25 权重、路径。把它们摆在设置页上，等于暗示"调大就能多记"，
   * 那种误导比少一个开关更贵。
   *
   * 注意它**只影响设置页**：字段仍在 `Config` 里，配置文件（`cordis.patch.yml`）照旧能写。
   */
  exposed?: boolean
}

/** 配置项全集。想加一项就加在这里，别处不用改。 */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  { key: 'enabled', kind: 'boolean', fallback: true, label: '总开关', description: '关掉之后所有行为停用，状态仍继续折叠。' },
  { key: 'injectPersona', kind: 'boolean', fallback: true, label: '注入人设段', description: '把「我是谁、我怎么说话」放进系统提示词。' },
  { key: 'injectRealtime', kind: 'boolean', fallback: true, label: '注入实况段', description: '把「此刻的状态」放在每次请求末尾；关掉就没有这份开销。' },
  { key: 'allowExpose', kind: 'boolean', fallback: true, label: '允许外露情绪', description: '只在高强度时偶尔在回复里外露一句。' },
  { key: 'proactive', kind: 'boolean', fallback: false, label: '允许主动开口', description: '打开后它可能自己起一个回合。' },
  { key: 'baselineValence', kind: 'number', fallback: 0.05, min: -1, max: 1, label: '静息效价', description: '平时的心情底色：负=偏沉，正=偏亮。' },
  { key: 'baselineArousal', kind: 'number', fallback: 0.25, min: 0, max: 1, label: '静息唤醒', description: '平时偏安静还是偏紧绷。' },
  { key: 'baselineDominance', kind: 'number', fallback: 0.5, min: 0, max: 1, label: '静息支配感', description: '平时觉得事情在不在自己手里。' },
  { key: 'halfLifeMin', kind: 'number', fallback: 90, min: 1, label: '情绪半衰期', description: '一次情绪多久退掉一半（分钟）。' },
  { key: 'moodHalfLifeHours', kind: 'number', fallback: 12, min: 0.1, label: '心境半衰期', description: '整体心情多久退掉一半（小时），比单次情绪慢一个量级。' },
  { key: 'gain', kind: 'number', fallback: 1, min: 0, label: '情绪增益', description: '情绪有多容易被带起来：1 是标准，越大越容易被点着。' },
  { key: 'decisionGain', kind: 'number', fallback: 0.6, min: 0, max: 2, label: '决策增益', description: '情绪能左右"这一轮该怎么想"的强度。0 = 情绪不参与参数决定。', exposed: false },
  { key: 'decisionUrgencyFloor', kind: 'number', fallback: 0.45, min: 0, max: 1, label: '紧迫门槛', description: '张力高到这个程度才"多推一步"（上调推理强度）。', exposed: false },
  { key: 'decisionTempTilt', kind: 'number', fallback: 0.15, min: 0, max: 1, label: '温度倾斜上限', description: '情绪最多能把温度推多远。这一层只碰温度与推理强度。', exposed: false },
  { key: 'proactiveTensionFloor', kind: 'number', fallback: 0.35, min: 0, max: 1, label: '开口张力门槛', description: '张力高到这个程度才值得主动开口。', exposed: false },
  { key: 'proactiveDeviationFloor', kind: 'number', fallback: 0.15, min: 0, max: 1, label: '开口偏离门槛', description: '离静息状态至少这么远才主动开口。', exposed: false },
  { key: 'proactiveCooldownMin', kind: 'number', fallback: 45, min: 1, label: '开口冷却', description: '两次主动开口之间至少隔多少分钟。', exposed: false },
  { key: 'voiceDrift', kind: 'number', fallback: 0.2, min: 0, max: 1, label: '说话习惯漂移上限', description: '说话习惯最多能离开出厂值多远（0.2 = 上下两成）。' },
  { key: 'traitDrift', kind: 'number', fallback: 0.1, min: 0, max: 1, label: '自我认知漂移上限', description: '对"我是谁"的认识最多能挪多远（按月算）。' },
  { key: 'kernelDrift', kind: 'number', fallback: 0.02, min: 0, max: 1, label: '内核漂移上限', description: '内核一次最多能动多少（这类东西一年才可能动一次）。' },
  { key: 'memoryShortMax', kind: 'number', fallback: 6, min: 0, label: '短期记忆条数', description: '短期记忆（会被注入）最多留几条。它该由对话内容自己决定，不摆到设置页。', exposed: false },
  { key: 'memorySummarySteps', kind: 'number', fallback: 20, min: 1, label: '总结间隔（步）', description: '每走这么多步，就提醒它回头总结一次。' },
  { key: 'memoryLongMax', kind: 'number', fallback: 400, min: 10, label: '跨会话库上限', description: '跨会话库（全局记忆）的条数上限。', exposed: false },
  { key: 'recallLimit', kind: 'number', fallback: 5, min: 1, label: '单次取回上限', description: '它去翻一次记忆，最多拿回几条。' },
  { key: 'heavyTokens', kind: 'number', fallback: 8000, min: 100, label: '重轮 token 门槛', description: '单轮 token 超过多少算"这一轮很重"。', exposed: false },
  // fallback 与内核的 `DEFAULT_TUNABLES` 必须一致（那边也是 800），否则设置页显示的和实际跑的对不上
  { key: 'longUserChars', kind: 'number', fallback: 800, min: 100, label: '长消息字数门槛', description: '你一条消息超过多少字，算"一次给了很多"。', exposed: false },
  { key: 'personaPath', kind: 'string', fallback: '', label: '人设内核路径', description: '人设内核文件（persona.md）路径。留空则用 DSH_HOME/dsh-mind/persona.md。', exposed: false },
  { key: 'stateDir', kind: 'string', fallback: '', label: '档案目录', description: '跨会话档案目录。留空则用 DSH_HOME/dsh-mind。', exposed: false },
  { key: 'debugLog', kind: 'boolean', fallback: false, label: '调试日志', description: '打印调试日志。', exposed: false },
]

/**
 * 设置页的分组。
 *
 * 分组是**给人看的次序**，不是内核概念：内核那 29 项按"开关 → 情绪 → 决策 → 主动 → 变化 → 记忆 → 信号 → 杂项"
 * 排，用户才能顺着"先想它像不像个人，再想它记不记得住"读下来。
 * `configCatalog()` 会校验"每个字段恰好归一组"，漏一个或重一个都有测试盯着。
 */
export interface ConfigGroup {
  id: string
  title: string
  note: string
  keys: readonly string[]
}

export const CONFIG_GROUPS: readonly ConfigGroup[] = [
  {
    id: 'switch',
    title: '开关与注入',
    note: '决定它开不开、以及往提示词里放什么。关掉注入可以做到零提示词开销。',
    keys: ['enabled', 'injectPersona', 'injectRealtime', 'allowExpose', 'proactive'],
  },
  {
    id: 'mood',
    title: '情绪基调',
    note: '性情底色与"情绪起来得多快、退得多快"。',
    keys: ['baselineValence', 'baselineArousal', 'baselineDominance', 'halfLifeMin', 'moodHalfLifeHours', 'gain'],
  },
  {
    id: 'decision',
    title: '情绪如何参与决策',
    note: '这一层只碰温度与推理强度，不动模型与工具选择。',
    keys: ['decisionGain', 'decisionUrgencyFloor', 'decisionTempTilt'],
  },
  {
    id: 'proactive',
    title: '主动开口',
    note: '三个门槛同时满足才会开口：够紧张、够偏离静息、且离上次够久。',
    keys: ['proactiveTensionFloor', 'proactiveDeviationFloor', 'proactiveCooldownMin'],
  },
  {
    id: 'drift',
    title: '变化速度与幅度',
    note: '三层的尺度不一样：说话习惯按周、自我认知按月、内核按年。',
    keys: ['voiceDrift', 'traitDrift', 'kernelDrift'],
  },
  {
    id: 'memory',
    title: '记忆',
    note: '短期那几条每次说话都会带上；跨会话库要靠它自己主动去翻。',
    keys: ['memoryShortMax', 'memorySummarySteps', 'memoryLongMax', 'recallLimit'],
  },
  {
    id: 'signal',
    title: '信号判定',
    note: '多大的输入算"这一次很重"。',
    keys: ['heavyTokens', 'longUserChars'],
  },
  {
    id: 'advanced',
    title: '路径与调试',
    note: '留空就用 DSH_HOME 下的默认位置。改之前先看清路径。',
    keys: ['personaPath', 'stateDir', 'debugLog'],
  },
]

/** 设置页要用的字段元数据（可 JSON 化，直接随路由发给客户端）。 */
export interface CatalogField {
  key: string
  label: string
  kind: 'boolean' | 'number' | 'string'
  fallback: boolean | number | string
  description: string
  group: string
  min?: number
  max?: number
}

export interface CatalogGroup {
  id: string
  title: string
  note: string
  keys: readonly string[]
}

/**
 * 字段表的**可传输**形态：客户端的设置页就是照它画的。
 *
 * 为什么让宿主把字段清单发下去、而不是客户端各写一份：
 * 两端各写一份，改一个配置项就得记得改两处，迟早对不上（那时界面显示的说明就是假话）。
 * 这里只有一处真相（`CONFIG_FIELDS` + `CONFIG_GROUPS`），客户端只管画。
 */
export function configCatalog(): { fields: CatalogField[]; groups: CatalogGroup[] } {
  // 只有 `exposed !== false` 的字段进设置页。分组里的键也要跟着筛，
  // 否则分组会列出页面上根本没有的行（点不到、还占标题）。
  const exposed = CONFIG_FIELDS.filter((field) => field.exposed !== false)
  const visible = new Set(exposed.map((field) => field.key))
  const groupOf = new Map<string, string>()
  for (const group of CONFIG_GROUPS) for (const key of group.keys) groupOf.set(key, group.id)
  const fields = exposed.map((field) => {
    const catalogField: CatalogField = {
      key: field.key,
      label: field.label,
      kind: field.kind,
      fallback: field.fallback,
      description: field.description,
      group: groupOf.get(field.key) ?? 'other',
    }
    if (field.min !== undefined) catalogField.min = field.min
    if (field.max !== undefined) catalogField.max = field.max
    return catalogField
  })
  const known = new Set(fields.map((field) => field.group))
  const groups: CatalogGroup[] = []
  for (const group of CONFIG_GROUPS) {
    if (!known.has(group.id)) continue
    const keys = group.keys.filter((key) => visible.has(key))
    // 一组里全是隐藏项时整组不出现：空标题比没有更让人困惑。
    if (keys.length === 0) continue
    groups.push({ id: group.id, title: group.title, note: group.note, keys })
  }
  return { fields, groups }
}

/** 按字段表补默认值（降级 schema 与 schemastery 两条路都用它兜底）。 */
function fillDefaults(fields: readonly ConfigField[], dict?: unknown): Record<string, unknown> {
  const source = dict !== null && typeof dict === 'object' ? (dict as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = source[field.key]
    out[field.key] = value === undefined || value === null ? field.fallback : value
  }
  return out
}

/**
 * 给一个"不像 Standard Schema 的东西"补上 `~standard.validate`。
 *
 * ⚠️ 这段是**实测出来的契约**，不是猜的。`cordis/lib/index.js:956-962`：
 *
 * ```js
 * function resolveConfig(runtime, config) {
 *   if (!runtime.Config) return config
 *   const result = runtime.Config["~standard"].validate(config)
 *   if ("then" in result) throw new TypeError("Async config validation is not supported")
 *   if (result.issues) throw new ValidationError(result.issues)
 *   else return result.value
 * }
 * ```
 *
 * 也就是说 loader **只认 `Config["~standard"].validate`**。
 * 早先的降级版只提供"可调用 + toString/dict"（那是照 feiyu 注释里写的用法做的），
 * 真实加载时报：
 *
 * ```
 * dsh: warning: 1 entry did not activate
 * mind (dsh-mind): TypeError: Cannot read properties of undefined (reading 'validate')
 * ```
 *
 * ——**整个插件不激活**。所以降级路径必须自己实现 `~standard`。
 */
function attachStandardSchema(target: unknown, validate: (value: unknown) => unknown): unknown {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return target
  const holder = target as Record<string, unknown>
  const existing = holder['~standard'] as
    | { version?: unknown; vendor?: unknown; validate?: (value: unknown) => unknown }
    | undefined

  // schemastery 自带 `~standard`——它是 `Schema.prototype` 上的**只读 getter**，
  // 自己就会做类型/范围校验**并补默认值**（实测 `validate({})` 会吐出填好默认值的对象）。
  // 所以这里**不要碰它**：曾经想"包一层再合并默认值"，对真 Schema 赋值会撞上那个只读 getter
  // 抛 `TypeError: Cannot set property ~standard of [object Object] which has only a getter`，
  // 异常被下面那层 `catch {}` 吞掉 → 降级成手写形状 → 宿主投影不出 AST →
  // 设置页里我们的配置被判成 `unsupported`，一个字段都改不了。
  // 保留原对象 = 保留它的 AST 与校验，宿主的设置页才能把配置项画成可编辑字段。
  if (typeof existing?.validate === 'function') return target

  holder['~standard'] = {
    version: 1,
    vendor: 'dsh-mind',
    validate(value: unknown) {
      try {
        return { value: validate(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  }
  return target
}

/**
 * 降级 schema：可调用 + `toString/.dict`（给人看）+ **`~standard.validate`（给 loader 用）**。
 */
function plainSchema(fields: readonly ConfigField[]): unknown {
  const fill = (dict?: unknown): Record<string, unknown> => fillDefaults(fields, dict)
  const schema = fill as unknown as Record<string, unknown> & ((dict?: unknown) => Record<string, unknown>)
  schema['toString'] = () => fields.map((f) => `${f.key}: ${f.kind}`).join('\n')
  schema['dict'] = Object.fromEntries(fields.map((f) => [f.key, { type: f.kind }]))
  schema['_dshMind'] = 'plain'
  return attachStandardSchema(schema, fill)
}

/** 拿 schemastery 失败时的最后一条线索（降级时要说清为什么，不能只说"缺失"）。 */
let schemasteryError = ''

/** 宿主自带的 schemastery（拿不到就 null）。 */
const schemastery = (() => {
  const loaded = resolveModule(
    '@deepseek-ai/schemastery',
    'schemastery',
    (base, error) => {
      const code = (error as { code?: string } | undefined)?.code
      const message = error instanceof Error ? error.message : String(error)
      schemasteryError = `${base} → ${code ?? message}`
    },
    // 能用的判据就是"有 object 构造器"——不满足就换下一个基准继续找
    (candidate) => typeof (candidate as Record<string, unknown> | null | undefined)?.['object'] === 'function',
  )
  // ⚠️ 必须同时接受 **function**：schemastery 的模块导出本身是个可调用对象
  // （`typeof m === 'function'`，构造器挂在它自己的属性上：`m.object/m.string/...`）。
  // 只认 `typeof === 'object'` 会把它判成"拿不到"，然后**在没有失败记录的情况下降级**——
  // 这就是启动日志里那句"宿主没有可用的 schemastery"的真正原因。
  return loaded !== null && (typeof loaded === 'object' || typeof loaded === 'function')
    ? (loaded as Record<string, unknown>)
    : null
})()

/** 有没有用上真的 schemastery（诊断输出要如实报告）。 */
export const hasSchemastery = schemastery !== null && typeof schemastery['object'] === 'function'

/** 插件配置 schema。拿不到 schemastery 就是手写形状等价物。 */
export const Config = (() => {
  const fallback = (): unknown => plainSchema(CONFIG_FIELDS)
  if (hasSchemastery) {
    try {
      const builder = schemastery as Record<string, (...args: unknown[]) => any>
      const shape: Record<string, unknown> = {}
      for (const field of CONFIG_FIELDS) {
        // 逐个字段各自 try：一个方法名对不上，不该把整张表单搞没
        let node: unknown
        try {
          node = builder[field.kind]?.()
          const chain = node as Record<string, (...args: unknown[]) => unknown> | undefined
          if (typeof chain?.['default'] === 'function') node = chain['default'](field.fallback)
          const after = node as Record<string, (...args: unknown[]) => unknown> | undefined
          if (field.min !== undefined && typeof after?.['min'] === 'function') node = after['min'](field.min)
          const afterMin = node as Record<string, (...args: unknown[]) => unknown> | undefined
          if (field.max !== undefined && typeof afterMin?.['max'] === 'function') node = afterMin['max'](field.max)
          const afterMax = node as Record<string, (...args: unknown[]) => unknown> | undefined
          if (typeof afterMax?.['description'] === 'function') node = afterMax['description'](field.description)
        } catch {
          node = undefined
        }
        shape[field.key] = node
      }
      const built = builder['object']?.(shape)
      // 就算 schemastery 建出来了，只要缺 `~standard` 就补一个——loader 只认这个
      if (built !== undefined && built !== null) {
        return attachStandardSchema(built, (value) => fillDefaults(CONFIG_FIELDS, value))
      }
    } catch {
      /* 退化到手写 schema，绝不因为配置表单把插件搞挂 */
    }
  }
  return fallback()
})()

/** 传入的配置（可能是任意形状：patch 里的、空模板的、甚至 undefined）。 */
export type MindConfig = Record<string, unknown> | undefined

function pick<T extends boolean | number | string>(raw: MindConfig, key: string, fallback: T): T {
  const value = raw?.[key]
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === typeof fallback) return value as T
  if (typeof fallback === 'number' && typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? (parsed as T) : fallback
  }
  if (typeof fallback === 'boolean' && typeof value === 'string') return (value === 'true') as T
  return fallback
}

/** 读一个布尔开关。 */
export function flag(raw: MindConfig, key: string): boolean {
  const field = CONFIG_FIELDS.find((f) => f.key === key)
  return pick(raw, key, (field?.fallback as boolean | undefined) ?? false)
}

/** 读一个数字项。 */
export function num(raw: MindConfig, key: string): number {
  const field = CONFIG_FIELDS.find((f) => f.key === key)
  return pick(raw, key, (field?.fallback as number | undefined) ?? 0)
}

/** 读一个字符串项。 */
export function str(raw: MindConfig, key: string): string {
  const field = CONFIG_FIELDS.find((f) => f.key === key)
  return pick(raw, key, (field?.fallback as string | undefined) ?? '')
}

/**
 * 配置 → 内核参数。
 *
 * 只有"用户真的可能想调"的量会覆盖默认值，剩下的沿用 core 的默认（core 才是权威）。
 */
export function toTunables(raw: MindConfig): MindTunables {
  return withDefaults({
    baseline: {
      valence: num(raw, 'baselineValence'),
      arousal: num(raw, 'baselineArousal'),
      dominance: num(raw, 'baselineDominance'),
    },
    halfLifeMin: num(raw, 'halfLifeMin'),
    moodHalfLifeHours: num(raw, 'moodHalfLifeHours'),
    gain: num(raw, 'gain'),
    decisionGain: num(raw, 'decisionGain'),
    decisionUrgencyFloor: num(raw, 'decisionUrgencyFloor'),
    voiceDrift: num(raw, 'voiceDrift'),
    traitDrift: num(raw, 'traitDrift'),
    kernelDrift: num(raw, 'kernelDrift'),
    memoryShortMax: num(raw, 'memoryShortMax'),
    memorySummarySteps: num(raw, 'memorySummarySteps'),
    memoryLongMax: num(raw, 'memoryLongMax'),
    recallLimit: num(raw, 'recallLimit'),
    heavyTokens: num(raw, 'heavyTokens'),
    longUserChars: num(raw, 'longUserChars'),
  })
}

/**
 * 配置自检：给 `/mind config` 与启动日志用的一句话。
 *
 * 降级条数是**数出来的**，不是写死的——写死"有两处"会在条数变化时变成假话。
 */
export function describeConfig(raw: MindConfig, logger?: LoggerLike): string {
  const degraded: string[] = []
  if (!hasSchemastery) {
    degraded.push(
      `宿主没有可用的 schemastery（设置表单用降级形状，配置仍会生效${schemasteryError === '' ? '' : `；最后失败：${schemasteryError}`}）`,
    )
  }
  if (!logger) degraded.push('logger 未接入（headless 下正常，日志仍会落到 stateDir/log/mind.log）')
  const enabled = flag(raw, 'enabled')
  if (degraded.length === 0) return `配置正常（enabled=${enabled}）`
  return `配置可用，${degraded.length} 处降级：${degraded.map((item, index) => `${index + 1}. ${item}`).join('；')}（enabled=${enabled}）`
}
