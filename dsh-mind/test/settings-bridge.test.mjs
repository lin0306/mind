/**
 * 设置页宿主半边的测试。
 *
 * 这一层是**写入口**（客户端能改配置），所以每条测试盯的都是"边界上的实话"：
 * 拿不到服务时不许假装有值、冲突必须是 409 而不是 200、围栏判不了就不放行。
 * 全部用假对象驱动，不碰真的 HTTP——测的是契约，不是 node 的 http 模块。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  MIND_PACKAGE_NAME,
  MISSING_SETTINGS_REASON,
  SETTINGS_ROUTE_PREFIX,
  RouteFailure,
  configCatalog,
  createSettingsApi,
  handleSettingsRequest,
  isSettingsConflict,
  makeSettingsFace,
  methodOfPath,
  entryIdCandidates,
  ownEntryId,
  registerSettingsBridge,
  resolveSettingsNamespace,
  serviceVia,
} from '../lib/index.js'

/* ───────────────────────── 测试用假件 ───────────────────────── */

/** 造一个假请求：给出方法与路径，body 可以是对象（会被 JSON 序列化）或原始字符串。 */
function fakeReq({ method = 'POST', url = `${SETTINGS_ROUTE_PREFIX}/settings.get`, body } = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield text
    },
  }
}

/** 造一个假响应，把状态码与响应体收下来。 */
function fakeRes() {
  const seen = { status: undefined, headers: undefined, body: undefined }
  return {
    seen,
    writeHead(status, headers) {
      seen.status = status
      seen.headers = headers
    },
    end(body) {
      seen.body = body
    },
  }
}

/** 发一次请求，返回 `{ status, json, headers }`。 */
async function call(req, deps) {
  const res = fakeRes()
  await handleSettingsRequest(req, res, deps)
  return {
    status: res.seen.status,
    headers: res.seen.headers,
    json: res.seen.body === undefined ? undefined : JSON.parse(res.seen.body),
  }
}

const allowAll = () => true
const denyAll = () => false

/** 一个内存版设置服务：记录 update 调用，支持注入失败。 */
function fakeSettings({ ns = 'mind', value = {}, revision = 3, fail } = {}) {
  const calls = []
  const state = { value, revision }
  return {
    calls,
    describe(options) {
      assert.equal(options.redactSecrets, true, 'describe 必须按脱敏模式调用')
      return [{ ns, value: state.value, revision: state.revision }]
    },
    async update(ns, patch, expectedRevision) {
      calls.push({ ns, patch, expectedRevision })
      if (fail !== undefined) throw fail
      state.value = { ...state.value, ...patch }
      state.revision = Number(state.revision ?? 0) + 1
      return undefined
    },
  }
}

/* ───────────────────────── 命名空间来源 ───────────────────────── */

test('ownEntryId：优先取与 ctx.fiber 相同的那一条', () => {
  const mine = { options: { name: MIND_PACKAGE_NAME, id: 'mind' }, fiber: { tag: 'me' } }
  const other = { options: { name: MIND_PACKAGE_NAME, id: 'other' }, fiber: { tag: 'other' } }
  const ctx = { fiber: mine.fiber, loader: { entries: () => [other, mine] } }
  assert.equal(ownEntryId(ctx), 'mind')
})

test('ownEntryId：fiber 对不上时拿第一个未禁用的同包名条目兜底', () => {
  const disabled = { options: { name: MIND_PACKAGE_NAME, id: 'disabled' }, disabled: true }
  const live = { options: { name: MIND_PACKAGE_NAME, id: 'live' }, fiber: { tag: 'x' } }
  const ctx = { fiber: { tag: 'me' }, loader: { entries: () => [disabled, live] } }
  assert.equal(ownEntryId(ctx), 'live')
})

test('ownEntryId：没有 loader / 没有匹配 / entries 抛错 → undefined（不猜）', () => {
  assert.equal(ownEntryId({}), undefined)
  assert.equal(ownEntryId({ loader: {} }), undefined)
  assert.equal(ownEntryId({ loader: { entries: () => [] } }), undefined)
  assert.equal(
    ownEntryId({ loader: { entries: () => [{ options: { name: 'other-plugin', id: 'x' } }] } }),
    undefined,
  )
  assert.equal(
    ownEntryId({
      loader: {
        entries: () => {
          throw new Error('loader 坏了')
        },
      },
    }),
    undefined,
  )
})

test('ownEntryId：空 id 与空名字都不算数', () => {
  const ctx = { loader: { entries: () => [{ options: { name: MIND_PACKAGE_NAME, id: '' } }] } }
  assert.equal(ownEntryId(ctx), undefined)
})

test('ownEntryId：也可以从 ctx.get("loader") 拿 loader', () => {
  const ctx = {
    get: (name) => (name === 'loader' ? { entries: () => [{ options: { name: MIND_PACKAGE_NAME, id: 'via-get' } }] } : undefined),
  }
  assert.equal(ownEntryId(ctx), 'via-get')
})

/* ───────────────────────── 设置读写面 ───────────────────────── */

test('makeSettingsFace：按命名空间取值，找不到就是 undefined（不编默认值）', () => {
  const settings = fakeSettings({ value: { gain: 2 }, revision: 7 })
  const face = makeSettingsFace(settings, 'mind')
  assert.deepEqual(face.get(), { ns: 'mind', value: { gain: 2 }, revision: 7, found: true })
  // 提示对不上名字也照样认得出：`mind` 是我们自己的名字之一（patch id），不该指望调用方给对提示。
  assert.deepEqual(makeSettingsFace(settings, 'not-mine').get(), {
    ns: 'mind',
    value: { gain: 2 },
    revision: 7,
    found: true,
  })
  // 真不是我们（名字不相干、值里也没有我们的键）时：**不编命名空间**，返回空串 + found:false。
  const stranger = fakeSettings({ ns: 'someone-else', value: { something: true } })
  assert.deepEqual(makeSettingsFace(stranger, 'not-mine').get(), {
    ns: '',
    value: undefined,
    revision: undefined,
    found: false,
  })
  // 真机上 entry id 是 `include:<patch id>` 这种写法：提示给哪一种写法都要能对上。
  assert.equal(makeSettingsFace(settings, 'include:mind').get().ns, 'mind', '带 include: 前缀的 id 也要认得出')
  assert.equal(entryIdCandidates('include:mind').includes('mind'), true)
})

test('makeSettingsFace：update 把 patch 与 expectedRevision 原样交给设置服务，并回读最新值', async () => {
  const settings = fakeSettings({ value: { gain: 1 }, revision: 4 })
  const face = makeSettingsFace(settings, 'mind')
  const after = await face.update({ gain: 5 }, 4)
  assert.deepEqual(settings.calls, [{ ns: 'mind', patch: { gain: 5 }, expectedRevision: 4 }])
  assert.deepEqual(after, { ns: 'mind', value: { gain: 5 }, revision: 5, found: true })
})

test('makeSettingsFace：没带 expectedRevision 时只传两个参数（不硬塞 undefined）', async () => {
  const settings = fakeSettings()
  const face = makeSettingsFace(settings, 'mind')
  await face.update({ gain: 5 }, undefined)
  assert.equal(settings.calls[0].expectedRevision, undefined)
  assert.equal(settings.calls[0].patch.gain, 5)
})

test('isSettingsConflict：按名字/code 认冲突，认不出来就是 false（不许把普通错误当冲突）', () => {
  class SettingsConflictError extends Error {}
  assert.equal(isSettingsConflict(new SettingsConflictError('版本不对')), true)
  const byName = new Error('x')
  byName.name = 'SettingsConflictError'
  assert.equal(isSettingsConflict(byName), true)
  assert.equal(isSettingsConflict({ code: 'settings-conflict' }), true)
  assert.equal(isSettingsConflict(new Error('普通错误')), false)
  assert.equal(isSettingsConflict(null), false)
  assert.equal(isSettingsConflict('字符串'), false)
})

/* ───────────────────────── 方法表 ───────────────────────── */

test('settings.get：没有读写面时如实说 available:false，并给出原因', () => {
  const api = createSettingsApi(() => ({ reason: MISSING_SETTINGS_REASON }))
  const snapshot = api['settings.get']({})
  assert.equal(snapshot.available, false)
  assert.equal(snapshot.namespaceFound, false)
  assert.equal(snapshot.value, undefined)
  assert.equal(snapshot.revision, undefined)
  assert.equal(snapshot.reason, MISSING_SETTINGS_REASON)
  // 拿不到服务也要把字段清单给出去，页面还能把配置项和说明列出来
  assert.equal(snapshot.fields.length, configCatalog().fields.length)
  assert.equal(snapshot.groups.length, configCatalog().groups.length)
  assert.equal(snapshot.groups.length, 4, '裁剪 + 丢空组之后只剩 4 组')
})

test('settings.get：有读写面时给出值、版本号与命名空间', () => {
  const settings = fakeSettings({ value: { enabled: true }, revision: 11 })
  const api = createSettingsApi(() => ({ face: makeSettingsFace(settings, 'mind'), reason: '' }))
  const snapshot = api['settings.get']({})
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.namespace, 'mind')
  assert.deepEqual(snapshot.value, { enabled: true })
  assert.equal(snapshot.revision, 11)
})

test('settings.get：服务在、命名空间没有记录时，说的话与"没有设置服务"不是同一句', () => {
  const settings = fakeSettings({ ns: 'someone-else', value: { something: true } })
  const api = createSettingsApi(() => ({ face: makeSettingsFace(settings, 'absent'), reason: '' }))
  const snapshot = api['settings.get']({})
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.namespaceFound, false)
  assert.equal(snapshot.value, undefined)
  assert.equal(snapshot.namespace, undefined, '认不出来就别说名字（名字本身也是实现细节）')
  assert.match(snapshot.reason, /还没有「心念」这一条记录/)
  assert.doesNotMatch(snapshot.reason, /没有提供设置服务/)
  assert.doesNotMatch(snapshot.reason, /mind/, '不许把命名空间名字印给用户看')
})

test('settings.update：没有读写面 → 503，且不假装成功', async () => {
  const api = createSettingsApi(() => ({ reason: MISSING_SETTINGS_REASON }))
  await assert.rejects(
    () => api['settings.update']({ patch: { gain: 1 } }),
    (error) => {
      assert.ok(error instanceof RouteFailure)
      assert.equal(error.status, 503)
      assert.equal(error.code, 'settings-unavailable')
      assert.match(error.message, /没有提供设置服务/)
      return true
    },
  )
})

test('settings.update：patch 不是普通对象 → 400', async () => {
  const settings = fakeSettings()
  const api = createSettingsApi(() => ({ face: makeSettingsFace(settings, 'mind'), reason: '' }))
  for (const bad of [undefined, null, {}, { patch: null }, { patch: [] }, { patch: 'x' }, { patch: 3 }]) {
    await assert.rejects(
      () => api['settings.update'](bad),
      (error) => {
        assert.ok(error instanceof RouteFailure, `payload=${JSON.stringify(bad)} 应该被拒`)
        assert.equal(error.status, 400)
        assert.equal(error.code, 'bad-request')
        return true
      },
    )
  }
  assert.equal(settings.calls.length, 0, '参数不合法时不该碰设置服务')
})

test('settings.update：expectedRevision 是数字或非空字符串才带过去，别的形状当没带（不猜）', async () => {
  const settings = fakeSettings()
  const api = createSettingsApi(() => ({ face: makeSettingsFace(settings, 'mind'), reason: '' }))
  await api['settings.update']({ patch: { gain: 1 }, expectedRevision: 9 })
  await api['settings.update']({ patch: { gain: 1 }, expectedRevision: 'rev-9' })
  await api['settings.update']({ patch: { gain: 1 }, expectedRevision: {} })
  await api['settings.update']({ patch: { gain: 1 }, expectedRevision: true })
  await api['settings.update']({ patch: { gain: 1 }, expectedRevision: '' })
  assert.deepEqual(
    settings.calls.map((call) => call.expectedRevision),
    [9, 'rev-9', undefined, undefined, undefined],
  )
})

test('settings.update：冲突 → 409，原始 message 原样带出（不吞错）', async () => {
  class SettingsConflictError extends Error {
    constructor(message) {
      super(message)
      this.name = 'SettingsConflictError'
    }
  }
  const settings = fakeSettings({ fail: new SettingsConflictError('revision 3 已被别人改过') })
  const api = createSettingsApi(() => ({ face: makeSettingsFace(settings, 'mind'), reason: '' }))
  await assert.rejects(
    () => api['settings.update']({ patch: { gain: 1 }, expectedRevision: 3 }),
    (error) => {
      assert.ok(error instanceof RouteFailure)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'settings-conflict')
      assert.equal(error.message, 'revision 3 已被别人改过')
      return true
    },
  )
})

test('settings.update：非冲突失败 → 400，错误信息不许被吞掉', async () => {
  const settings = fakeSettings({ fail: new Error('gain 必须小于 5') })
  const api = createSettingsApi(() => ({ face: makeSettingsFace(settings, 'mind'), reason: '' }))
  await assert.rejects(
    () => api['settings.update']({ patch: { gain: 99 } }),
    (error) => {
      assert.ok(error instanceof RouteFailure)
      assert.equal(error.status, 400)
      assert.equal(error.code, 'settings-rejected')
      assert.equal(error.message, 'gain 必须小于 5')
      return true
    },
  )
})

test('settings.update：成功时返回更新后的快照（带新 revision）', async () => {
  const settings = fakeSettings({ value: { gain: 1 }, revision: 2 })
  const api = createSettingsApi(() => ({ face: makeSettingsFace(settings, 'mind'), reason: '' }))
  const snapshot = await api['settings.update']({ patch: { gain: 4 }, expectedRevision: 2 })
  assert.equal(snapshot.available, true)
  assert.deepEqual(snapshot.value, { gain: 4 })
  assert.equal(snapshot.revision, 3)
})

/* ───────────────────────── 路径解析 ───────────────────────── */

test('methodOfPath：只认前缀下的一层方法名，别的一律 undefined', () => {
  assert.equal(methodOfPath(`${SETTINGS_ROUTE_PREFIX}/settings.get`), 'settings.get')
  assert.equal(methodOfPath(`${SETTINGS_ROUTE_PREFIX}/settings.get?x=1`), 'settings.get')
  assert.equal(methodOfPath(SETTINGS_ROUTE_PREFIX), undefined)
  assert.equal(methodOfPath(`${SETTINGS_ROUTE_PREFIX}/`), undefined)
  assert.equal(methodOfPath(`${SETTINGS_ROUTE_PREFIX}/a/b`), undefined)
  assert.equal(methodOfPath('/somewhere/else'), undefined)
  assert.equal(methodOfPath(undefined), undefined)
  assert.equal(methodOfPath('/dsh-mind/api/%E0%A4%A'), undefined, '坏的百分号转义不该抛')
})

/* ───────────────────────── HTTP 契约 ───────────────────────── */

test('路由：围栏拒绝 → 403，且不碰方法表', async () => {
  let touched = false
  const api = { 'settings.get': () => { touched = true; return {} } }
  const { status, json } = await call(fakeReq(), { api, fence: denyAll })
  assert.equal(status, 403)
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'forbidden')
  assert.equal(touched, false)
})

test('路由：围栏自己抛错 → 403（判不了可信就不放行）', async () => {
  const { status } = await call(fakeReq(), {
    api: { 'settings.get': () => ({}) },
    fence: () => { throw new Error('connection 坏了') },
  })
  assert.equal(status, 403)
})

test('路由：非 POST → 405', async () => {
  const { status, json } = await call(fakeReq({ method: 'GET' }), { api: {}, fence: allowAll })
  assert.equal(status, 405)
  assert.equal(json.error.code, 'method-not-allowed')
})

test('路由：路径不对或方法不存在 → 404', async () => {
  const wrongPath = await call(fakeReq({ url: '/elsewhere' }), { api: { 'settings.get': () => ({}) }, fence: allowAll })
  assert.equal(wrongPath.status, 404)
  const unknown = await call(fakeReq({ url: `${SETTINGS_ROUTE_PREFIX}/nope` }), { api: {}, fence: allowAll })
  assert.equal(unknown.status, 404)
  assert.match(unknown.json.error.message, /nope/)
})

test('路由：成功 → 200 且信封是 { ok: true, value }，声明 JSON 编码', async () => {
  const { status, json, headers } = await call(fakeReq({ body: { hello: true } }), {
    api: { 'settings.get': (payload) => ({ got: payload }) },
    fence: allowAll,
  })
  assert.equal(status, 200)
  assert.deepEqual(json, { ok: true, value: { got: { hello: true } } })
  assert.match(headers['content-type'], /application\/json/)
  assert.match(headers['content-type'], /utf-8/)
})

test('路由：空体当空对象传下去（客户端不需要为了读一次值造 body）', async () => {
  const { status, json } = await call(fakeReq(), {
    api: { 'settings.get': (payload) => ({ payload }) },
    fence: allowAll,
  })
  assert.equal(status, 200)
  assert.equal(json.value.payload, null)
})

test('路由：请求体不是 JSON / 太大 → 400 与 413', async () => {
  const broken = await call(fakeReq({ body: '{不是 JSON' }), { api: { 'settings.get': () => ({}) }, fence: allowAll })
  assert.equal(broken.status, 400)
  assert.equal(broken.json.error.code, 'bad-request')
  assert.match(broken.json.error.message, /JSON/)

  const huge = await call(fakeReq({ body: `"${'x'.repeat(300 * 1024)}"` }), {
    api: { 'settings.get': () => ({}) },
    fence: allowAll,
  })
  assert.equal(huge.status, 413)
})

test('路由：RouteFailure 的 status 与 code 原样写出去', async () => {
  const { status, json } = await call(fakeReq({ url: `${SETTINGS_ROUTE_PREFIX}/settings.update` }), {
    api: {
      'settings.update': () => {
        throw new RouteFailure('settings-conflict', 'revision 对不上', 409)
      },
    },
    fence: allowAll,
  })
  assert.equal(status, 409)
  assert.deepEqual(json, { ok: false, error: { code: 'settings-conflict', message: 'revision 对不上' } })
})

test('路由：没预料到的错 → 500（不伪装成"参数不对"）', async () => {
  const { status, json } = await call(fakeReq(), {
    api: {
      'settings.get': () => {
        throw new TypeError('内部炸了')
      },
    },
    fence: allowAll,
  })
  assert.equal(status, 500)
  assert.equal(json.error.code, 'internal-error')
  assert.equal(json.error.message, '内部炸了')
})

/* ───────────────────────── 接线 ───────────────────────── */

/** 攒一个假 ctx：能动态注入服务，并记录 effect 注册。 */
function fakeCtx(services = {}) {
  const registered = { effects: [], injects: [] }
  const ctx = {
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    effect(callback, label) {
      registered.effects.push(label)
      return callback()
    },
    inject(names, register) {
      registered.injects.push([...names])
      const available = {}
      let complete = true
      for (const name of names) {
        if (services[name] === undefined) complete = false
        available[name] = services[name]
      }
      if (complete) register({ get: (name) => available[name], effect: ctx.effect })
      return () => {}
    },
  }
  return { ctx, registered, services }
}

test('接线：没有 webServer 时不注册路由（不留悬空注册）', () => {
  const { ctx } = fakeCtx({ connection: { requestRejection: () => undefined } })
  registerSettingsBridge(ctx)
  assert.equal(ctx.__routes, undefined)
})

test('接线：没有 connection 围栏时也不注册路由——这是写入口，宁可不可用', () => {
  const routes = []
  const settings = fakeSettings()
  const ctx = {
    logger: { warn() {}, info() {} },
    loader: { entries: () => [{ options: { name: MIND_PACKAGE_NAME, id: 'mind' }, fiber: {} }] },
    fiber: {},
    effect: (callback) => callback(),
    inject(names, register) {
      const available = {
        settings,
        webServer: { register: (spec) => routes.push(spec) },
      }
      if (names.every((name) => available[name] !== undefined)) register({ get: (n) => available[n], effect: ctx.effect })
      return () => {}
    },
  }
  registerSettingsBridge(ctx)
  assert.equal(routes.length, 0)
})

test('接线：服务齐了 → 注册一条 prefix 路由，且只有围栏放行才响应', async () => {
  const routes = []
  const settings = fakeSettings({ value: { gain: 3 }, revision: 1 })
  const fiber = { tag: 'me' }
  const ctx = {
    logger: { warn() {}, info() {} },
    loader: { entries: () => [{ options: { name: MIND_PACKAGE_NAME, id: 'mind' }, fiber }] },
    fiber,
    effect: (callback) => callback(),
    inject(names, register) {
      const available = {
        settings,
        webServer: { register: (spec) => routes.push(spec) },
        connection: { requestRejection: (req) => (req.trusted === true ? undefined : new Error('拒')) },
      }
      if (names.every((name) => available[name] !== undefined)) register({ get: (n) => available[n], effect: ctx.effect })
      return () => {}
    },
  }
  registerSettingsBridge(ctx)

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, SETTINGS_ROUTE_PREFIX)

  const handler = routes[0].handler
  const read = async (req) => {
    const res = fakeRes()
    await handler(req, res)
    // handler 内部是异步的，让出一个微任务队列再读
    await new Promise((resolve) => setImmediate(resolve))
    return { status: res.seen.status, json: JSON.parse(res.seen.body) }
  }

  const denied = await read({ ...fakeReq(), trusted: false })
  assert.equal(denied.status, 403)

  const allowed = await read({ ...fakeReq(), trusted: true })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.json.value.available, true)
  assert.deepEqual(allowed.json.value.value, { gain: 3 })
  assert.equal(allowed.json.value.namespace, 'mind')

  const written = await read({
    ...fakeReq({ url: `${SETTINGS_ROUTE_PREFIX}/settings.update`, body: { patch: { gain: 8 }, expectedRevision: 1 } }),
    trusted: true,
  })
  assert.equal(written.status, 200)
  assert.deepEqual(settings.calls, [{ ns: 'mind', patch: { gain: 8 }, expectedRevision: 1 }])
})

test('接线：拿不到 settings 服务时，settings.get 如实报不可用（不编默认值）', async () => {
  const routes = []
  const ctx = {
    logger: { warn() {}, info() {} },
    effect: (callback) => callback(),
    inject(names, register) {
      const available = {
        webServer: { register: (spec) => routes.push(spec) },
        connection: { requestRejection: () => undefined },
      }
      if (names.every((name) => available[name] !== undefined)) register({ get: (n) => available[n], effect: ctx.effect })
      return () => {}
    },
  }
  registerSettingsBridge(ctx)
  const res = fakeRes()
  await routes[0].handler(fakeReq(), res)
  await new Promise((resolve) => setImmediate(resolve))
  const json = JSON.parse(res.seen.body)
  assert.equal(res.seen.status, 200)
  assert.equal(json.value.available, false)
  assert.equal(json.value.namespaceFound, false)
  assert.equal(json.value.reason, MISSING_SETTINGS_REASON)
  assert.equal(json.value.value, undefined)
  // 字段清单照给：没有设置服务也要能看见"这个插件有哪些配置项、各是什么说明"
  assert.equal(json.value.fields.length, configCatalog().fields.length)
})

test('接线：拿不到 entry id 时也说清楚（不硬用一个猜出来的命名空间）', async () => {
  const routes = []
  const settings = fakeSettings({ ns: 'someone-else', value: { something: true } })
  const ctx = {
    logger: { warn() {}, info() {} },
    loader: { entries: () => [] },
    effect: (callback) => callback(),
    inject(names, register) {
      const available = {
        settings,
        webServer: { register: (spec) => routes.push(spec) },
        connection: { requestRejection: () => undefined },
      }
      if (names.every((name) => available[name] !== undefined)) register({ get: (n) => available[n], effect: ctx.effect })
      return () => {}
    },
  }
  registerSettingsBridge(ctx)
  const res = fakeRes()
  await routes[0].handler(fakeReq(), res)
  await new Promise((resolve) => setImmediate(resolve))
  const json = JSON.parse(res.seen.body)
  // 拿不到 entry id 不再让整页不可用：提示没了就用**键名指纹**认（这里假件的值里没有我们的键，
  // 所以认不出来）。认不出来就如实说"这一条记录还没有"——照旧不许用猜出来的命名空间去写。
  assert.equal(json.value.available, true)
  assert.equal(json.value.namespaceFound, false)
  assert.match(json.value.reason, /还没有「心念」这一条记录/)
  assert.equal(settings.calls.length, 0)

  // 认不出来时**写请求必须失败**，而且要说是"这一页暂时存不进去"，不是"你填错了"。
  const write = fakeRes()
  await routes[0].handler(
    fakeReq({ url: `${SETTINGS_ROUTE_PREFIX}/settings.update`, body: { patch: { gain: 9 } } }),
    write,
  )
  await new Promise((resolve) => setImmediate(resolve))
  const written = JSON.parse(write.seen.body)
  assert.equal(write.seen.status, 503)
  assert.match(written.error.message, /暂时存不进去/)
  assert.equal(settings.calls.length, 0, '认不出命名空间就一个字节都不许写进去')
})

test('resolveSettingsNamespace：id 三种写法 + 键名指纹 + 都认不出', () => {
  // 指纹要求**至少命中两个**只有我们才有的键名：一个键名太容易撞（谁都能有个 `proactive`）。
  const ours = {
    ns: 'include:mind',
    value: { memorySummarySteps: 20, injectRealtime: true },
    revision: 1,
  }
  const other = { ns: 'other-plugin', value: { something: true }, revision: 1 }
  const service = { describe: () => [other, ours], update: async () => undefined }
  assert.deepEqual(resolveSettingsNamespace(service, 'include:mind'), { ns: 'include:mind', via: 'id' })
  assert.deepEqual(resolveSettingsNamespace(service, 'mind'), { ns: 'include:mind', via: 'id' })
  // 提示完全对不上时，先靠**我们自己的名字**（固定别名）对上——`include:mind` 就在别名表里
  assert.deepEqual(resolveSettingsNamespace(service, 'whatever'), { ns: 'include:mind', via: 'id' })
  // 名字不像我们、别名也对不上时，才靠"只有我们才有的键名"认出来
  const fingerprinted = {
    describe: () => [
      other,
      { ns: 'dshmind.settings', value: { memorySummarySteps: 20, injectRealtime: true }, revision: 1 },
    ],
    update: async () => undefined,
  }
  assert.deepEqual(resolveSettingsNamespace(fingerprinted, 'whatever'), { ns: 'dshmind.settings', via: 'fingerprint' })
  // 键名也不像我们 → 老实说认不出
  const stranger = { describe: () => [other], update: async () => undefined }
  assert.equal(resolveSettingsNamespace(stranger, 'mind'), undefined)
  // 名字都没对上时：描述表里**只有一个**名字带我们的包名/patch id，才认（松规则必须更保守）。
  const oneAlias = {
    describe: () => [{ ns: 'dsh-mind-settings', value: { other: 1 }, revision: 1 }],
    update: async () => undefined,
  }
  assert.deepEqual(resolveSettingsNamespace(oneAlias, 'whatever'), { ns: 'dsh-mind-settings', via: 'id' })
  const twoAliases = {
    describe: () => [
      { ns: 'mind-settings', value: { other: 1 }, revision: 1 },
      { ns: 'dsh-mind-settings', value: { other: 2 }, revision: 1 },
    ],
    update: async () => undefined,
  }
  assert.equal(resolveSettingsNamespace(twoAliases, 'whatever'), undefined, '两个都像我们 → 谁都不认')
  // describe 直接抛：也不许把整个插件搞挂
  const broken = {
    describe: () => {
      throw new Error('设置服务炸了')
    },
    update: async () => undefined,
  }
  assert.equal(resolveSettingsNamespace(broken, 'mind'), undefined)
})

/* ───────────────────────── 字段目录 ───────────────────────── */

test('configCatalog：只列 exposed 的字段（16 个），每个都有中文 label 与说明', () => {
  const catalog = configCatalog()
  const exposed = CONFIG_FIELDS.filter((field) => field.exposed !== false)
  assert.equal(catalog.fields.length, exposed.length)
  assert.equal(catalog.fields.length, 16, '设置页只放用户真会调的 16 项')
  assert.equal(CONFIG_FIELDS.length - exposed.length, 13, '另外 13 项仍在 Config 里，只是不摆到页面上')
  const keys = catalog.fields.map((field) => field.key)
  assert.equal(new Set(keys).size, keys.length, '字段 key 不许重复')
  assert.deepEqual(
    [...keys].sort(),
    exposed.map((field) => field.key).sort(),
  )
  for (const hidden of CONFIG_FIELDS.filter((field) => field.exposed === false)) {
    assert.equal(keys.includes(hidden.key), false, `${hidden.key} 不该出现在设置页`)
  }
  for (const field of catalog.fields) {
    assert.ok(typeof field.label === 'string' && field.label.trim() !== '', `${field.key} 缺 label`)
    assert.ok(typeof field.description === 'string' && field.description.trim() !== '', `${field.key} 缺说明`)
    assert.ok(['boolean', 'number', 'string'].includes(field.kind), `${field.key} 的 kind 不认识`)
    assert.ok(field.fallback !== undefined, `${field.key} 缺 fallback`)
    assert.ok(typeof field.group === 'string' && field.group !== '', `${field.key} 没归组`)
  }
})

test('configCatalog：组的 key 并集刚好等于全部字段（没有孤儿、没有重复归组）', () => {
  const catalog = configCatalog()
  const grouped = catalog.groups.flatMap((group) => group.keys)
  assert.equal(new Set(grouped).size, grouped.length, '同一个字段被归进两组')
  assert.deepEqual([...grouped].sort(), catalog.fields.map((field) => field.key).sort())
  for (const group of catalog.groups) {
    assert.ok(group.title.trim() !== '', `${group.id} 缺中文标题`)
    assert.ok(group.note.trim() !== '', `${group.id} 缺中文说明`)
  }
})

/* ───────────────────────── 服务取用 ───────────────────────── */

test('serviceVia：先 ctx.get，拿不到就退到直接读属性（两条路在真机上都存在过）', () => {
  const theService = { hello: () => 'ok' }
  const viaGet = { get: (name) => (name === 'settings' ? theService : undefined) }
  assert.equal(serviceVia(viaGet, 'settings'), theService)

  const viaProperty = { settings: theService }
  assert.equal(serviceVia(viaProperty, 'settings'), theService)

  // 关键的一条：get 存在但给不出东西时，属性那条路必须还能救回来
  assert.equal(serviceVia({ get: () => undefined, settings: theService }, 'settings'), theService)
  assert.equal(serviceVia({ get: () => null, settings: theService }, 'settings'), theService)

  assert.equal(serviceVia({}, 'settings'), undefined)
  assert.equal(serviceVia({ get: () => null, settings: null }, 'settings'), undefined, 'null 不算拿到服务')
})

test('接线：宿主只把服务挂在作用域属性上、没有 get() 时，设置页照样要能读能写', async () => {
  const routes = []
  const settings = fakeSettings({ value: { gain: 2 }, revision: 5 })
  const ctx = {
    logger: { warn() {}, info() {} },
    loader: { entries: () => [{ options: { name: MIND_PACKAGE_NAME, id: 'mind' } }] },
    effect: (callback) => callback(),
    inject(names, register) {
      // 注意：这里给出去的 scope **没有 get**，服务只作为属性挂着
      const scope = {
        effect: ctx.effect,
        settings,
        webServer: { register: (spec) => routes.push(spec) },
        connection: { requestRejection: () => undefined },
      }
      if (names.every((name) => scope[name] !== undefined)) register(scope)
      return () => {}
    },
  }
  registerSettingsBridge(ctx)

  assert.equal(routes.length, 1, '两条取服务的路只要有一条通，就不该整页失效')
  const res = fakeRes()
  await routes[0].handler(fakeReq(), res)
  await new Promise((resolve) => setImmediate(resolve))
  const json = JSON.parse(res.seen.body)
  assert.equal(json.value.available, true)
  assert.deepEqual(json.value.value, { gain: 2 })
  assert.equal(json.value.namespace, 'mind')
})

test('configCatalog：数字字段的 min/max 一起带出来（界面上要用来限制输入）', () => {
  const catalog = configCatalog()
  const withBounds = catalog.fields.filter((field) => field.kind === 'number' && (field.min !== undefined || field.max !== undefined))
  assert.ok(withBounds.length > 0)
  for (const field of withBounds) {
    if (field.min !== undefined && field.max !== undefined) assert.ok(field.min <= field.max, `${field.key} 的 min 比 max 大`)
  }
})
