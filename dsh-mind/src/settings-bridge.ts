/**
 * 设置页的宿主半边：把"心念"的配置接到 DSH 的设置服务上，再开一条受围栏的路由给客户端读写。
 *
 * ## 为什么要有这一层
 *
 * 光导出 `Config` 只够让宿主画出**它自己的**那张自动表单；用户要的是在 **DSH 设置面板**里
 * 有一页自己的界面（左侧导航里点得进去）。平台给的路是两条：
 *
 * 1. **宿主侧**：从 `settings` 服务拿到本插件这个 **profile entry** 的配置（值与版本号），
 *    再注册一条路由让客户端能读能写；
 * 2. **客户端侧**：`ctx.slots.inject('settings.section', …)` 注册一页（见 `client/src/index.ts`）。
 *
 * 这一层只做第 1 条。契约是照 `dsh-better-sidebar` 的实测实现抄的（本机
 * `~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/src/index.ts:1311/1334-1426`）：
 *
 * - 命名空间 = **loader entry 的 id**（不是包名，也不是 `Config` 的名字）；
 * - 读：`settings.describe({ redactSecrets: true })` → 找到 `ns` 那一条的 `{ value, revision }`；
 * - 写：`await settings.update(ns, patch, expectedRevision)`（版本对不上会抛冲突错）；
 * - 围栏：`ctx.connection.requestRejection(req) === undefined` 才算可信请求。
 *
 * ## 三条自己定的规矩（写进注释，免得以后被"简化"掉）
 *
 * 1. **拿不到就不假装。** 没有 `settings` 服务时，`settings.get` 会如实带上 `available: false`
 *    与一句中文原因；客户端拿它显示实话，而不是回落成一份"看起来正常的默认值"。
 * 2. **不吞错。** 冲突映射 409、参数错映射 400、服务缺失映射 503，原始 `message` 原样带出去。
 * 3. **宁可不开门，也不开没人把守的门。** 拿不到 `connection` 时整条路由不注册：
 *    它是一条**写入口**（能改配置），围栏缺失就意味着任何碰到这个端口的进程都能改。
 */

import { configCatalog } from './config.js'
import { service, warn, type MindContext } from './host.js'

/** 本包名（loader 用它把 entry 与包对上）。 */
export const MIND_PACKAGE_NAME = 'dsh-mind'

/** 路由前缀：客户端把 `<前缀>/settings.get` 与 `<前缀>/settings.update` POST 过来。 */
export const SETTINGS_ROUTE_PREFIX = '/dsh-mind/api'

/** 请求体上限：设置页只发几十个字段，给到 256 KiB 已经很宽松。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * "这台宿主没有提供设置服务"的**唯一说法**。
 *
 * 单独拎成常量，是因为它会出现在三个地方（未接通、注入后确认缺失、路由 503），
 * 三处各写一遍迟早会漂成三句不同的话，用户看到的就成了三种毛病。
 */
export const MISSING_SETTINGS_REASON = '这台宿主没有提供设置服务，只能用配置文件改。'

/* ───────────────────────── 命名空间来源 ───────────────────────── */

/** loader 条目里我们用到的最小形状。 */
interface LoaderEntryLike {
  options?: { name?: unknown; id?: unknown }
  disabled?: unknown
  fiber?: unknown
}

interface LoaderLike {
  entries?: () => Iterable<LoaderEntryLike>
}

/**
 * 取本插件在组合里的 **entry id**——它就是设置服务的命名空间。
 *
 * 为什么要遍历、不能写死：`id` 由**挂载点**决定（本仓库的 `cordis.patch.yml` 写的是 `id: mind`，
 * 但别的组合可以挂成别的 id，比如被聚合包内联时）。写死一个值，在别人的组合里就会读到空。
 * 取法照 better-sidebar：优先 `entry.fiber === ctx.fiber`（那就是"我"这一条），
 * 否则拿第一个未禁用的同包名条目兜底；整段 try/catch，取不到返回 undefined（由上层如实说明）。
 */
export function ownEntryId(ctx: MindContext): string | undefined {
  try {
    const loader = loaderOf(ctx)
    if (loader === undefined || typeof loader.entries !== 'function') return undefined
    const fiber = (ctx as { fiber?: unknown }).fiber
    let fallback: string | undefined
    for (const entry of loader.entries()) {
      const name = entry?.options?.name
      const id = entry?.options?.id
      if (name !== MIND_PACKAGE_NAME || typeof id !== 'string' || id === '') continue
      if (fiber !== undefined && entry.fiber === fiber) return id
      if (entry.disabled !== true && fallback === undefined) fallback = id
    }
    return fallback
  } catch {
    return undefined
  }
}

/**
 * 拿 loader 服务。
 *
 * 先读属性、再问 `ctx.get`：cordis 的 `ctx.loader` 是个常驻属性，
 * 而 `get('loader')` 在不同部署里未必挂得上（这一层只做"两条路都试一下"）。
 */
function loaderOf(ctx: MindContext): LoaderLike | undefined {
  const loader = serviceVia<LoaderLike>(ctx, 'loader')
  return loader !== undefined && typeof loader.entries === 'function' ? loader : undefined
}

/**
 * 拿一个服务：先 `ctx.get(name)`，再退到直接读属性。
 *
 * 两条都试是有原因的：cordis 的注入回调里，服务**也可以**当属性直接读
 * （better-sidebar 就是 `sctx.settings.describe(...)`），而 `ctx.get(name)` 是另一条路。
 * 只认一条的话，换一个宿主版本就可能整个功能静默失效——"设置页永远是空的"，
 * 而且不报任何错。多试一次的成本是一次属性读取。
 */
export function serviceVia<T>(ctx: MindContext, name: string): T | undefined {
  const viaGet = service<T>(ctx, name)
  if (viaGet !== undefined && viaGet !== null) return viaGet
  const direct = ctx[name]
  return direct === undefined || direct === null ? undefined : (direct as T)
}

/* ───────────────────────── 设置服务 ───────────────────────── */

interface SettingsDescriptorLike {
  ns?: unknown
  value?: unknown
  revision?: unknown
  schema?: unknown
}

/**
 * 只在我们的字段表里出现的键：名字对不上时，用它认出"我们这一条"。
 *
 * 为什么需要这个兜底：命名空间是 profile 里那条 Loader entry 的 id，而 id 由**挂载方式**决定。
 * 实测本机：`Config/listConfigs` 报的 id 是 `include:mind`（而 `cordis.patch.yml` 里写的 patch id
 * 才是 `mind`）。`describe()` 里的 `ns` 到底是哪一个，不该靠猜——猜错的代价是**整页读不到值**。
 * 所以先用 id 的几种写法对名字，对不上就用"这份 schema 里有只有我们才有的键"做指纹。
 */
const NAMESPACE_PROBE_KEYS = ['memorySummarySteps', 'injectRealtime', 'baselineValence', 'voiceDrift', 'proactive']

/**
 * 本插件在设置里的命名空间的候选写法。
 *
 * 为什么有固定别名：命名空间**由挂载方式决定**，真机上见过三种写法——
 * `Config/listConfigs` 报的 entry id（本机是 `include:mind`）、包/条目的名字（`dsh-mind`）、
 * 以及 `cordis.patch.yml` 里的 patch id（`mind`）。它们都是**我们自己的名字**，不是瞎猜；
 * 真正的把关在 `resolveSettingsNamespace`（唯一命中，或键名指纹；都不成立就认输）。
 */
export function entryIdCandidates(id: string | undefined): string[] {
  const out = new Set<string>(['dsh-mind', 'include:dsh-mind', 'mind', 'include:mind'])
  if (id !== undefined) {
    const trimmed = id.trim()
    if (trimmed !== '') {
      const bare = trimmed.replace(/^include:/, '')
      out.add(trimmed)
      out.add(bare)
      out.add(`include:${bare}`)
    }
  }
  return [...out]
}

function describeList(settings: SettingsServiceLike): SettingsDescriptorLike[] {
  let list: unknown
  try {
    list = settings.describe?.({ redactSecrets: true })
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is SettingsDescriptorLike => entry !== null && typeof entry === 'object')
}

/** 这份描述里有没有只有我们才有的键（键名出现在 schema 或值里都算）。 */
function looksLikeOurs(entry: SettingsDescriptorLike): boolean {
  let text: string
  try {
    text = JSON.stringify(entry.schema ?? entry.value ?? {})
  } catch {
    return false
  }
  let hits = 0
  for (const key of NAMESPACE_PROBE_KEYS) if (text.includes(key)) hits += 1
  return hits >= 2
}

/**
 * 在设置服务的描述表里认出"我们这一条"：先用 entry id 的几种写法对名字，再用键名指纹兜底。
 * 两个都认不出就返回 undefined——由上层如实说"存不进去"，不猜、不假装。
 */
export function resolveSettingsNamespace(
  settings: SettingsServiceLike,
  hint: string | undefined,
): { ns: string; via: 'id' | 'fingerprint' } | undefined {
  const descriptors = describeList(settings)
  const candidates = entryIdCandidates(hint)
  const byId = descriptors.find((entry) => typeof entry.ns === 'string' && candidates.includes(entry.ns))
  if (byId !== undefined && typeof byId.ns === 'string') return { ns: byId.ns, via: 'id' }
  // 名字都没对上：如果描述表里**只有一个**命名空间的名字里带我们的包名或 patch id，那就是它。
  // 要求"只有一个"是因为这条规则比前一条松——松的规则必须更保守，宁可认输也不能认错。
  const aliased = descriptors.filter((entry) => typeof entry.ns === 'string' && /dsh-mind|(^|[._-])mind([._-]|$)/.test(entry.ns))
  if (aliased.length === 1 && typeof aliased[0]?.ns === 'string') return { ns: aliased[0].ns, via: 'id' }
  const byFingerprint = descriptors.find((entry) => typeof entry.ns === 'string' && looksLikeOurs(entry))
  if (byFingerprint !== undefined && typeof byFingerprint.ns === 'string') return { ns: byFingerprint.ns, via: 'fingerprint' }
  return undefined
}

/** 设置服务的最小形状（只声明我们用到的三个方法）。 */
export interface SettingsServiceLike {
  describe?: (options?: { redactSecrets?: boolean }) => unknown
  update?: (ns: string, patch: Record<string, unknown>, expectedRevision?: unknown) => unknown
  configure?: (options: { auto: boolean }, fiber: unknown) => unknown
}

export interface SettingsView {
  /** 认出来的命名空间。没认出来时是空串，`found` 是 false。 */
  ns: string
  value: unknown
  revision: unknown
  /** 设置服务里到底有没有"我们这一条"。false 时页面如实说存不进去，不假装成功。 */
  found: boolean
}

/**
 * 一个命名空间的读写面。
 *
 * **命名空间每次现认**（`resolveSettingsNamespace`），不缓存：缓存下来的名字一旦不对，
 * 整页就永久读不到值（本机真发生过——名字猜成了 patch id `mind`，而宿主用的是 entry id）；
 * 重新解析一次的成本可以忽略。
 */
export interface SettingsFace {
  get: () => SettingsView
  update: (patch: Record<string, unknown>, expectedRevision: unknown) => Promise<SettingsView>
}

/** 桥的当前状态：`face` 有就是接通了；没有时 `reason` 是一句给用户看的中文实话。 */
export interface SettingsBridgeState {
  face?: SettingsFace
  reason: string
}

/**
 * 把设置服务包成一个读写面。
 *
 * 值永远是**从设置服务现读的**（`viewOf`），不在插件里存第二份：
 * 存一份就成了"两个真相"，用户在外面改了、面板里还显示旧的。
 */
export function makeSettingsFace(settings: SettingsServiceLike, hint: string | undefined): SettingsFace {
  const viewOf = (): SettingsView => {
    const match = resolveSettingsNamespace(settings, hint)
    if (match === undefined) return { ns: '', value: undefined, revision: undefined, found: false }
    const entry = describeList(settings).find((candidate) => candidate.ns === match.ns)
    return { ns: match.ns, value: entry?.value, revision: entry?.revision, found: entry !== undefined }
  }
  return {
    get: viewOf,
    update: async (patch, expectedRevision) => {
      const update = settings.update
      if (typeof update !== 'function') throw new Error('设置服务没有 update 方法')
      const match = resolveSettingsNamespace(settings, hint)
      // 认不出来是"设置服务里没有这一条"，属于**环境没到位**，不是用户填错了参数：
      // 用 503 而不是 400，免得把"这一页暂时存不进去"说成"你的改动有问题"。
      if (match === undefined) throw new RouteFailure('settings-unavailable', '设置里找不到「心念」这一条记录，暂时存不进去。', 503)
      if (expectedRevision === undefined) await update.call(settings, match.ns, patch)
      else await update.call(settings, match.ns, patch, expectedRevision)
      return viewOf()
    },
  }
}

/**
 * 这是不是一个"版本冲突"。
 *
 * 为什么按名字判、不 `instanceof SettingsConflictError`：那个类在 `@deepseek-ai/dsh-settings` 里，
 * 而该包**不在** profile 的 node_modules 里（只在 DSH 自己的安装目录 / asar 内），
 * 静态 import 解析不到会让整个插件加载失败——这一层的头号禁忌。
 * 所以按名字与 code 认；认不出来时走 400 而不是 409，**不会把冲突伪装成成功**。
 */
export function isSettingsConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const holder = error as { name?: unknown; code?: unknown; constructor?: { name?: unknown } }
  const names = [holder.name, holder.constructor?.name].filter((name): name is string => typeof name === 'string')
  if (names.includes('SettingsConflictError')) return true
  const code = typeof holder.code === 'string' ? holder.code.toLowerCase() : ''
  return code === 'settings-conflict' || code === 'conflict' || code === 'revision-conflict'
}

/* ───────────────────────── 路由 ───────────────────────── */

/** 一条路由失败：带 HTTP 状态码，交给 `handleSettingsRequest` 写出去。 */
export class RouteFailure extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'RouteFailure'
    this.code = code
    this.status = status
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * 路由的方法表。
 *
 * 两个方法返回的都是**同一形状**的快照（含字段清单），这样客户端一次请求就能把整页画出来，
 * 不用先问字段、再问值（两次往返之间还会出现"字段是新的、值是旧的"的中间态）。
 */
export function createSettingsApi(
  bridge: () => SettingsBridgeState,
): Record<string, (payload: unknown) => unknown> {
  const snapshotOf = (view: SettingsView | undefined, state: SettingsBridgeState): Record<string, unknown> => {
    const catalog = configCatalog()
    if (view === undefined) {
      return {
        available: false,
        namespace: undefined,
        namespaceFound: false,
        value: undefined,
        revision: undefined,
        reason: state.reason,
        fields: catalog.fields,
        groups: catalog.groups,
      }
    }
    return {
      available: true,
      namespace: view.ns === '' ? undefined : view.ns,
      namespaceFound: view.found,
      value: view.value,
      revision: view.revision,
      // 服务在、却认不出"我们这一条"：不是"没提供设置服务"，而是"这一页还没落进当前 profile"。
      // 两句话不一样，不能混成一句（混了会让人以为要写配置文件，其实只是没落进这个 profile）。
      // 注意：**不印命名空间名字**——那个名字是实现细节，对用户没有意义，印错了还更糟。
      reason: view.found ? undefined : '设置里还没有「心念」这一条记录，这一页暂时存不进去。',
      fields: catalog.fields,
      groups: catalog.groups,
    }
  }

  return {
    'settings.get': () => {
      const state = bridge()
      return snapshotOf(state.face?.get(), state)
    },

    'settings.update': async (payload) => {
      const state = bridge()
      const face = state.face
      if (face === undefined) {
        throw new RouteFailure('settings-unavailable', state.reason, 503)
      }
      const record = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}
      const patch = record['patch']
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new RouteFailure('bad-request', 'patch 必须是一个普通对象。', 400)
      }
      // 版本号只接受数字或非空字符串：宿主给什么，客户端就原样带回来。
      // 别的形状（对象/布尔/空串）当"没带"，**不猜**——猜错的版本号会让宿主拒掉一次合法保存。
      const raw = record['expectedRevision']
      const expected = typeof raw === 'number' || (typeof raw === 'string' && raw !== '') ? raw : undefined
      try {
        const view = await face.update(patch as Record<string, unknown>, expected)
        return snapshotOf(view, state)
      } catch (error) {
        // 不吞错：原始 message 带出去，状态码按性质分。
        // 下层已经分好类的失败（比如"认不出命名空间"就是 503）原样放行——
        // 重新包一层只会把"环境没到位"改写成"你的参数不对"，那是把话说错。
        if (error instanceof RouteFailure) throw error
        if (isSettingsConflict(error)) throw new RouteFailure('settings-conflict', messageOf(error), 409)
        throw new RouteFailure('settings-rejected', messageOf(error), 400)
      }
    },
  }
}

/** 请求与响应的最小形状（够真机的 `IncomingMessage` / `ServerResponse` 用，也够测试里的假对象用）。 */
export interface HttpRequestLike {
  method?: string
  url?: string
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
}

export interface HttpResponseLike {
  writeHead?: (status: number, headers: Record<string, string>) => unknown
  end?: (body?: string) => unknown
}

export interface SettingsRouteDeps {
  api: Record<string, (payload: unknown) => unknown>
  /** 围栏：**只对可信连接**放行。返回 false 一律 403。 */
  fence: (req: unknown) => boolean
}

/** 从 URL 里取方法名；不是我们的前缀、或者多带了一段路径，都返回 undefined（调用方回 404）。 */
export function methodOfPath(url: unknown, prefix: string = SETTINGS_ROUTE_PREFIX): string | undefined {
  const raw = typeof url === 'string' && url !== '' ? url : '/'
  let pathname: string
  try {
    pathname = new URL(raw, 'http://dsh.internal').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${prefix}/`)) return undefined
  const rest = pathname.slice(prefix.length + 1)
  if (rest === '' || rest.includes('/')) return undefined
  try {
    return decodeURIComponent(rest)
  } catch {
    return undefined
  }
}

/** 读请求体；空体当空对象。超过上限直接失败，不默默截断（截断出来的 JSON 会变成另一条错误信息）。 */
async function readJsonBody(req: unknown): Promise<unknown> {
  const source = req as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> }
  if (typeof source[Symbol.asyncIterator] !== 'function') return null
  const chunks: string[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<unknown>) {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    size += text.length
    if (size > MAX_BODY_BYTES) throw new RouteFailure('bad-request', '请求体过大。', 413)
    chunks.push(text)
  }
  const body = chunks.join('')
  if (body.trim() === '') return null
  try {
    return JSON.parse(body)
  } catch {
    throw new RouteFailure('bad-request', '请求体不是合法的 JSON。', 400)
  }
}

/**
 * 处理一次设置路由请求。
 *
 * 响应信封与 better-sidebar 一致（客户端只认这一种形状）：
 * 成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message } }`。
 */
export async function handleSettingsRequest(req: unknown, res: unknown, deps: SettingsRouteDeps): Promise<void> {
  const request = req as HttpRequestLike
  const response = res as HttpResponseLike

  const reply = (status: number, payload: unknown): void => {
    let body: string
    try {
      body = JSON.stringify(payload)
    } catch (error) {
      body = JSON.stringify({ ok: false, error: { code: 'encode-failed', message: messageOf(error) } })
      status = 500
    }
    try {
      response.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end?.(body)
    } catch {
      /* 响应都写不出去（连接已断）：没有别的可做，也不该把插件搞挂 */
    }
  }

  let trusted = false
  try {
    trusted = deps.fence(request) === true
  } catch {
    trusted = false
  }
  if (!trusted) {
    reply(403, { ok: false, error: { code: 'forbidden', message: '这条路由只对本机可信连接开放。' } })
    return
  }

  if (request.method !== 'POST') {
    reply(405, { ok: false, error: { code: 'method-not-allowed', message: '设置路由只接受 POST。' } })
    return
  }

  const method = methodOfPath(request.url)
  const handler = method === undefined ? undefined : deps.api[method]
  if (method === undefined || handler === undefined) {
    reply(404, { ok: false, error: { code: 'unknown-method', message: `没有这个方法：${method ?? '（路径不对）'}` } })
    return
  }

  try {
    const payload = await readJsonBody(request)
    const value = await handler(payload)
    reply(200, { ok: true, value })
  } catch (error) {
    if (error instanceof RouteFailure) {
      reply(error.status, { ok: false, error: { code: error.code, message: error.message } })
      return
    }
    // 没预料到的错：500（这是我们自己的 bug，不该伪装成"参数不对"让用户去改配置）
    reply(500, { ok: false, error: { code: 'internal-error', message: messageOf(error) } })
  }
}

/* ───────────────────────── 接线 ───────────────────────── */

/** 宿主网页服务的最小形状。 */
export interface WebServerServiceLike {
  register: (spec: { kind: 'prefix'; path: string; handler: (req: unknown, res: unknown) => unknown }) => unknown
}

/** 连接围栏的最小形状。 */
export interface ConnectionServiceLike {
  requestRejection: (req: unknown) => unknown
}

function fenceWith(connection: ConnectionServiceLike): (req: unknown) => boolean {
  return (req) => {
    try {
      return connection.requestRejection(req) === undefined
    } catch {
      // 围栏自己出错 = 判不了可信 = 不放行（fail closed）
      return false
    }
  }
}

/**
 * 把设置读写接上宿主。
 *
 * 三个服务全是**动态可选注入**，一个都不能进模块级 `inject`：
 * 那种写法会让整个 entry 硬等一个可能永远不出现的服务（loader 会把它判成永久 pending，
 * 整个插件不激活）。动态注入只是"它出现了就叫醒我"，不出现也不影响聊天。
 */
export function registerSettingsBridge(ctx: MindContext): void {
  // 初始就按"没有设置服务"说：宿主真有这个服务时，`inject` 会**同步**叫醒回调并把它清掉；
  // 一直是这句话，就等于它确实没出现。宁可让极短的未就绪窗口读到这句话，
  // 也不要给一句"就绪中"——用户点开设置页看到的是它，而那一刻的状态才是他要知道的。
  const bridge: SettingsBridgeState = { reason: MISSING_SETTINGS_REASON }
  const api = createSettingsApi(() => bridge)

  // ① 设置服务：接通读写面 + 关掉宿主的自动表单
  ctx.inject?.(['settings'], (scope) => {
    const settings = serviceVia<SettingsServiceLike>(scope, 'settings')
    if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.update !== 'function') {
      bridge.reason = MISSING_SETTINGS_REASON
      warn(ctx, '[dsh-mind] 拿不到 settings 服务：设置页只列字段，不提供编辑')
      return
    }
    // entry id 只是**提示**，不是答案：命名空间由宿主按 loader entry 的 id 建，而 id 的写法随挂载方式变
    // （本机实测 `Config/listConfigs` 报的是 `include:mind`，而 `cordis.patch.yml` 里写的是 patch id `mind`）。
    // 所以不猜前缀：先拿 id 的几种写法去比，比不中就用"只有我们才有的键名"做指纹（见 resolveSettingsNamespace）。
    // 认不出来的代价只是**这一页暂时存不进去**（页面会如实说），不是整页不可用，所以不早退。
    const hint = ownEntryId(ctx)
    if (hint === undefined) {
      warn(ctx, '[dsh-mind] 取不到 loader entry id：改用键名指纹认设置命名空间')
    }
    const match = resolveSettingsNamespace(settings, hint)
    if (match === undefined) {
      // 把**现有**命名空间列出来：下次认不出时，日志里就有"到底有什么"这一手证据，
      // 不用再靠猜（这条是踩出来的——上一轮日志里只有一句"还没出现"，什么也判不出来）。
      const seen = describeList(settings).map((entry) => (typeof entry.ns === 'string' ? entry.ns : '?'))
      warn(
        ctx,
        `[dsh-mind] 设置服务里还没出现「心念」这一条记录（现有命名空间：${seen.length === 0 ? '一个都没有' : seen.join('、')}）：设置页会如实说明暂时存不进去`,
      )
    } else {
      warn(ctx, `[dsh-mind] 设置命名空间已接上：${match.ns}（按${match.via === 'id' ? '条目 id' : '键名指纹'}认出）`)
    }

    /**
     * 关掉宿主的**自动**配置表单。
     *
     * 理由：我们自己在设置面板里挂了一页（`settings.section`），29 个字段两边都画就是两份一样的表单，
     * 而且它们的保存路径不同——用户在自动表单里改完，回头看我们这页还是旧值，那是真的会让人以为没保存。
     * 留着 `settings` 的读写（`describe`/`update`）不受影响：关掉的只是"宿主替我画表单"。
     * 代价写在报告里：万一客户端半边没加载，UI 上就没有可编辑的入口了（配置文件仍然照常生效）。
     */
    try {
      const configure = settings.configure
      if (typeof configure === 'function') {
        const fiber = (ctx as { fiber?: unknown }).fiber
        const turnOff = (): void => {
          configure.call(settings, { auto: false }, fiber)
        }
        if (typeof scope.effect === 'function') scope.effect(turnOff, 'dsh-mind 关掉宿主自动表单')
        else turnOff()
      }
    } catch (error) {
      warn(ctx, '[dsh-mind] 关掉宿主自动表单失败（不影响设置页读写）', error)
    }

    bridge.face = makeSettingsFace(settings, hint)
    bridge.reason = match === undefined ? '设置里还没有「心念」这一条记录，这一页暂时存不进去。' : ''
  })

  // ② 网页服务 + 连接围栏：**两个都在**才注册路由
  const mount = (scope: MindContext): void => {
    const webServer = serviceVia<WebServerServiceLike>(scope, 'webServer')
    const connection = serviceVia<ConnectionServiceLike>(scope, 'connection')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      warn(ctx, '[dsh-mind] 这台宿主没有 webServer：设置页读不到值（页面会如实说明）')
      return
    }
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      // 这是**写入口**：围栏服务缺失就不注册。宁可设置页不可用，也不开一条没人把守的门。
      warn(ctx, '[dsh-mind] 这台宿主没有 connection 围栏：设置路由不注册')
      return
    }
    const deps: SettingsRouteDeps = { api, fence: fenceWith(connection) }
    const register = (): void => {
      try {
        webServer.register({
          kind: 'prefix',
          path: SETTINGS_ROUTE_PREFIX,
          handler: (req, res) => {
            // 路由的返回值我们不关心；**必须**把 rejection 吃掉，否则宿主会看到一个未处理的 promise
            void handleSettingsRequest(req, res, deps)
          },
        })
      } catch (error) {
        warn(ctx, '[dsh-mind] 注册设置路由失败', error)
      }
    }
    try {
      if (typeof scope.effect === 'function') scope.effect(register, 'dsh-mind 设置路由')
      else register()
    } catch (error) {
      warn(ctx, '[dsh-mind] 挂设置路由失败', error)
    }
  }

  const inject = ctx.inject
  if (typeof inject === 'function') inject.call(ctx, ['webServer', 'connection'], mount)
  else mount(ctx)
}
