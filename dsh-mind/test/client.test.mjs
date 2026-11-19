/**
 * v1.5 客户端半边 + 面板数据链路的自检。
 *
 * 这一份盯的是三件**只在真机上才会暴露、而且暴露得很晚**的事：
 *
 * 1. **manifest 声明**：`dsh.client` 少写、或者把 `betterSidebar` 这类服务写进 `inject`，
 *    表现都是"整个客户端 entry 不激活"（loader 对 inject 的服务是硬等待）；
 * 2. **产物形状**：客户端 bundle 必须是 `window.__ModuleLoader__.load({ id: 包名, factory })`
 *    的 CJS factory，不能有 ESM import / JSX —— 这些靠人眼盯不住，靠测试就能；
 * 3. **面板的数据链路**：`wire` 里 `viewSchema` 与 `view` 必须成对出现。
 *    早先这里只写了 `view`，于是投影对客户端**根本不成立**：面板永远拿不到数据，
 *    而插件表面上一切正常（这条是修完才补上的回归测试）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_TUNABLES } from '../../mind-core/lib/index.js'
import { SETTINGS_ROUTE_PREFIX, registerProjection } from '../lib/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readText = (file) => readFileSync(file, 'utf8')

test('manifest：客户端半边声明齐全，且没把软依赖写进 inject', () => {
  const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')))

  assert.ok(pkg.dsh.client, 'dsh.client 缺了客户端就不会被加载')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject), 'inject 必须是数组')
  assert.ok(pkg.dsh.client.inject.includes('slots'), '侧栏与面板都要 slots')

  // 软依赖进 inject = 整个 entry 永远 pending（mneme issue #88 的实锤）
  for (const risky of ['betterSidebar', 'locale', 'theme', 'sessions']) {
    assert.ok(
      !pkg.dsh.client.inject.includes(risky),
      `${risky} 不该进客户端 inject：loader 会硬等待，它不在这个 entry 就永远不激活`,
    )
  }

  assert.equal(pkg.exports['./client'], './client/index.js')
  assert.ok(pkg.files.includes('client/index.js'), '客户端产物必须进发布白名单（否则上架后加载不到）')
})

test('产物：client/index.js 是合法的 CJS factory，id 等于包名', () => {
  const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')))
  const bundle = readText(path.join(ROOT, 'client/index.js'))

  assert.match(bundle, /window\.__ModuleLoader__\.load\(/)
  assert.ok(
    bundle.includes(`id: ${JSON.stringify(pkg.name)}`),
    'id 必须**等于包名**（两个来源解析到同一包名会让组合直接失败）',
  )
  assert.match(bundle, /factory: \(require\) => \{/)
  assert.match(bundle, /return module\.exports;/)

  // 客户端 bundle 的环境里没有 ESM、没有 JSX
  assert.ok(!/^\s*import\s[\s\S]*?from\s/m.test(bundle), '不能有 ESM import')
  assert.ok(!/<[A-Z][A-Za-z]*[\s>]/.test(bundle), '不能有 JSX')
  assert.ok(/require\(["']react["']\)/.test(bundle), '只能 require(react)')
  assert.ok(bundle.includes('exports.apply'), '必须导出 apply')
  assert.ok(bundle.includes('exports.inject'), '必须导出 inject')
})

test('面板数据链路：wire 里 viewSchema 与 view 成对，且 view 给的是中枢格式化好的 sections', () => {
  const registered = []
  registerProjection(
    { register: (definition) => (registered.push(definition), () => {}), stateOf: () => undefined },
    { tunables: () => DEFAULT_TUNABLES, adoptPersist: (state) => state },
  )
  const definition = registered[0]
  assert.equal(definition.key, 'mind')
  assert.ok(definition.wire, 'wire 必须存在，否则这个投影对客户端不可见')
  assert.equal(typeof definition.wire.view, 'function')
  assert.equal(
    typeof definition.wire.viewSchema?.parse,
    'function',
    'viewSchema 必须与 view 成对：宿主把值交给客户端之前会先过 viewSchema',
  )

  // 折几条真事件：约定记忆 + 一次工具失败（挫败）+ 一条 inner_note（思想）
  let state = definition.init()
  const events = [
    { type: 'user/message', seq: 1, time: 1_000, data: { text: '记住：这个项目用 pnpm，不要用 npm' } },
    { type: 'tool/result', seq: 2, time: 2_000, data: { callId: 'c1', message: { isError: true } } },
    {
      type: 'tool/call',
      seq: 3,
      time: 3_000,
      data: {
        callId: 'c2',
        name: 'inner_note',
        arguments: JSON.stringify({
          intent: '先确认需求再动手',
          metaCheck: '别急着写',
          // v2.3：记忆由它自己整理成一句话（用户的原话一概不入库）
          remember: '这个项目用 pnpm，不要用 npm',
          rememberKind: 'agreement',
        }),
      },
    },
  ]
  for (const event of events) state = definition.apply(state, event)

  const view = definition.wire.view(state)
  assert.ok(Array.isArray(view.sections) && view.sections.length >= 3, '面板至少要有人设/此刻/记忆几区')
  const titles = view.sections.map((section) => section.title)
  for (const want of ['此刻', '人设', '记忆']) {
    assert.ok(titles.includes(want), `面板缺「${want}」区（实际：${titles.join('、')}）`)
  }
  for (const section of view.sections) {
    assert.ok(Array.isArray(section.lines) && section.lines.length > 0, `「${section.title}」区不该是空的`)
    for (const line of section.lines) assert.equal(typeof line, 'string')
  }
  assert.equal(typeof view.summary, 'string')
  assert.equal(typeof view.tension, 'number')

  // 悬浮说明那条链路：内核得把"当时是什么情况"（`Signal.because`）带到情绪痕迹上，
  // 投影再把它和词表原话（`EmotionWord.inner`）一起送出来——面板才答得出"为什么这么高"。
  // 这条断言是防"测试全绿、链路断在中间"的：三样缺一样，悬浮框里就只剩一个数字。
  assert.ok(
    Array.isArray(view.emotionWords) && view.emotionWords.includes('焦虑'),
    '词表全序要送出来（扇区的固定槽位靠它）',
  )
  const lit = view.emotions.find((item) => item.strength > 0)
  assert.ok(lit !== undefined, 'tool/result 报错之后应该有情绪被点起来')
  assert.ok(typeof lit.inner === 'string' && lit.inner.length > 0, `情绪说明要从词表带出来（实际：${lit.inner}）`)
  assert.ok(
    typeof lit.because === 'string' && lit.because.length > 0,
    `触发缘由要随痕迹记下来（实际：「${lit.because}」）—— 这条空了，悬浮框就答不出"为什么这么高"`,
  )
  assert.ok(lit.count >= 1, '被点起的次数要记')
  assert.ok(lit.lastAt > 0, '最近一次被点起的时点要记')

  // 自己签发的视图必须能过自己的 schema：过不了的话，客户端收到的是"解析失败"而不是数据
  assert.deepEqual(definition.wire.viewSchema.parse(view), view)

  // 视图缓存：同一个状态引用必须复用同一个视图引用（否则每步都通知客户端重画）
  assert.equal(definition.wire.view(state), view)
})

/**
 * 设置页这一条**真把 bundle 跑起来**再断言（前面那条只是文本匹配）。
 *
 * 文本匹配挡不住的是：注册的 id / label 写错、`inject` 忘了给、组件没挂上——
 * 这些在真机上的表现都是"设置面板里就是看不到这一页"，而测试全绿。
 * 所以这里给一个假的宿主 ctx，把 `apply` 真的跑一遍，看它到底注册了什么。
 */
test('设置页：客户端注册了 settings.section（导航名「心念」），且与原有两个座位并存', async () => {
  const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')))
  const loaded = []
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } }
  try {
    // 加个查询串：同一个文件之前可能已经被 import 过，模块缓存会让"再跑一次"变成空转
    await import(`${pathToFileURL(path.join(ROOT, 'client/index.js')).href}?t=${Date.now()}`)
  } finally {
    globalThis.window = previousWindow
  }

  assert.equal(loaded.length, 1, 'bundle 应当只调一次 __ModuleLoader__.load')
  assert.equal(loaded[0].id, pkg.name)

  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject: (key, callback) => {
        injected.push(key)
        callback()
        return () => {}
      },
      register: (definition, component) => {
        registered.push({ definition, component })
        return () => {}
      },
    },
    get: () => undefined,
  }

  const factoryExports = loaded[0].factory((name) => {
    if (name !== 'react') throw new Error(`客户端不该 require 别的模块：${name}`)
    return {
      createElement: () => null,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
    }
  })
  factoryExports.apply(ctx)

  const section = registered.find((entry) => entry.definition.name === 'settings.section')
  assert.ok(section, '必须注册 settings.section —— 不注册的话，DSH 设置面板里就没有这一页')
  assert.equal(section.definition.id, pkg.name, '这一页的 id 要与包名一致，跟侧栏那一格用同一个')
  assert.equal(section.definition.label(), '心念', '导航里显示的名字')
  assert.equal(typeof section.definition.inject, 'function', '注册时要给出注入函数')
  assert.equal(typeof section.component, 'function', '这一页必须挂组件，否则点进去是空白')

  // 原来那两个座位不能被挤掉（侧栏那一格 + 中间那一页）
  assert.ok(injected.includes('sidebar.panellist'), '侧栏那一格还在')
  assert.ok(injected.includes('main'), '中间那一页还在')
  assert.ok(injected.includes('settings.section'), '设置那一页要在')

  // 客户端与宿主各写了一份路由前缀常量（客户端 bundle 连 require('./x') 都解析不到，没有共享模块这条路）。
  // 两边漂开的表现是"设置页永远是空的"——这条断言就是把它钉住。
  const bundle = readText(path.join(ROOT, 'client/index.js'))
  assert.ok(
    bundle.includes(SETTINGS_ROUTE_PREFIX),
    `客户端要打到宿主的路由前缀 ${SETTINGS_ROUTE_PREFIX} 上（两边各写一份，容易悄悄漂开）`,
  )
})
