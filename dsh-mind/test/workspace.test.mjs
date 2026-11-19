/**
 * 适配层的工作区接线（v1.6，不需要宿主）：
 *
 *   1. 投影 `init` 从会话头 `cwd` 算出工作区键，放进状态（`STATE_VERSION` 升到 2）；
 *   2. 注入（`realtimeText`）只给「本工作区 + 全局」的手边记忆；
 *   3. 长期库非空时注入里多一行**数量索引**——这是"让它知道自己有记忆"的那一条；
 *   4. 召回结果里，来自别的项目的条目标「· 跨工作区」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// 注意路径：core 的东西在 mind-core 下，根包的 lib/ 只是 DSH 适配层
import { DEFAULT_TUNABLES as T, normalizeState, rememberLong, rememberShort } from '../../mind-core/lib/index.js'
import { PROJECTION_KEY, STATE_VERSION, realtimeText, recallTool, registerProjection } from '../lib/index.js'

const HERE = 'E:/code/thought'
const OTHER = 'E:/code/others'

/** 挂一次投影，把 definition 抓出来（和 client.test.mjs 同一套假接线）。 */
function definitionOf() {
  let definition
  registerProjection(
    {
      register: (d) => {
        definition = d
        return () => {}
      },
      stateOf: () => undefined,
    },
    { tunables: () => T, adoptPersist: (state) => state },
  )
  return definition
}

test('投影：STATE_VERSION=3，工作区键从会话头 cwd 来、会话 id 从 id 来，没有就是空串', () => {
  assert.equal(STATE_VERSION, 3, 'v3 多了 session：不升版本，zod 的 object() 会把它剥掉')

  const definition = definitionOf()
  assert.equal(definition.key, PROJECTION_KEY)

  const state = definition.init({ cwd: 'E:\\code\\thought\\' })
  assert.equal(state.workspace, HERE, '反斜杠归一成正斜杠、去掉结尾的斜杠')

  assert.equal(definition.init({}).workspace, '')
  assert.equal(definition.init().workspace, '', '不带会话头也不能炸（测试与老调用方就是这样）')
  assert.equal(definition.init({ cwd: '   ' }).workspace, '')

  // 会话 id 跟工作区一路：都从会话头派生，apply 拿不到会话对象
  assert.equal(definition.init({ id: 'session-abc' }).session, 'session-abc')
  assert.equal(definition.init({}).session, '', '拿不到会话 id 就是空串，不编一个')
  assert.equal(definition.init().session, '')

  // workspace 必须被 schema 声明，否则会被校验剥掉（老档案读回来就丢了工作区）
  assert.equal(definition.stateSchema.parse(state).workspace, HERE)
  assert.equal(definition.stateSchema.parse(definition.init({ id: 'session-xyz' })).session, 'session-xyz')
})

test('注入：手边只给本工作区+全局；长期库非空时出现数量索引', () => {
  const definition = definitionOf()
  const base = definition.init({ cwd: HERE })

  let memory = base.memory
  memory = rememberShort(memory, { kind: 'agreement', text: '本工作区记得用 pnpm', at: 0, ws: HERE }, T)
  memory = rememberShort(memory, { kind: 'lesson', text: '别的项目记得别用 npm', at: 1, ws: OTHER }, T)
  memory = rememberShort(memory, { kind: 'preference', text: '用户记得要中文回复', at: 2 }, T)
  memory = rememberLong(memory, { kind: 'agreement', text: '本工作区的长期约定：先调研再动手', importance: 0.9, at: 0, ws: HERE }, T)
  memory = rememberLong(memory, { kind: 'preference', text: '用户的长期偏好：结论先说', importance: 0.9, at: 0 }, T)

  const text = realtimeText({ ...base, memory }, T, 1000)
  assert.match(text, /本工作区记得用 pnpm/)
  assert.match(text, /用户记得要中文回复/)
  assert.ok(!text.includes('别的项目记得别用 npm'), '别的项目的手边记忆不该出现在注入里')
  assert.match(
    text,
    /【记忆】.*这个工作区 1 条、关于全局 0 条、另有 1 条没标工作区/,
    '要让它知道自己有地方可查',
  )
})

test('跨会话库为空（或只有别的工作区的库存）时，注入里不报数', () => {
  const definition = definitionOf()
  const empty = definition.init({ cwd: HERE })
  assert.ok(!realtimeText(empty, T, 1000).includes('【记忆】'), '库是空的就不该说"你有记忆"')

  let memory = empty.memory
  memory = rememberLong(memory, { kind: 'fact', text: '别的项目的长期记忆', importance: 0.9, at: 0, ws: OTHER }, T)
  assert.ok(
    !realtimeText({ ...empty, memory }, T, 1000).includes('【记忆】'),
    '只有别的工作区的库存时，本工作区/全局都是 0 条，不该报数',
  )
})

test('recall_memory：跨工作区的命中标出来源，拿不到工作区时不判跨区', async () => {
  let memory = normalizeState({}, T, 0).memory
  // 两条文本要足够不像，否则 rememberLong 会当重复条目直接跳过
  memory = rememberLong(memory, { kind: 'agreement', text: '本工作区用 pnpm 管包', importance: 0.9, at: 0, ws: HERE }, T)
  memory = rememberLong(memory, { kind: 'agreement', text: '另一个项目也提过 pnpm', importance: 0.7, at: 0, ws: OTHER }, T)

  const scoped = recallTool({ memory: () => memory, tunables: () => T, workspace: () => HERE })
  const hit = await scoped.execute({ query: 'pnpm' })
  assert.match(hit.ok, /本工作区用 pnpm 管包/)
  assert.match(hit.ok, /跨工作区/, '来自别的项目的条目要标出来源')

  // 老调用方（不传 workspace）：既不标跨区，也不炸
  const plain = recallTool({ memory: () => memory, tunables: () => T })
  const noWs = await plain.execute({ query: 'pnpm' })
  assert.ok(!noWs.ok.includes('跨工作区'))

  // 工具的第二参（真机是 { agent, signal, deferContext }）要能一路传到 workspace 取值处
  let seen
  const viaContext = recallTool({
    memory: () => memory,
    tunables: () => T,
    workspace: (context) => {
      seen = context?.agent?.session
      return ''
    },
  })
  await viaContext.execute({ query: 'pnpm 管包' }, { agent: { id: 'a1', session: { id: 's1' } } })
  assert.deepEqual(seen, { id: 's1' }, 'recallTool 要把执行上下文交给 workspace 取值函数')
})

test('面板分组：未分组会话按会话各成一组，组头带 sessionId；老档案与全局各占一档', () => {
  const definition = definitionOf()
  const base = definition.init({ id: 'session-a', cwd: '' })

  // 三个未分组会话各写一条（ws: null + sessionId）+ 一条显式全局（偏好）+ 一条老档案（缺 ws）。
  // 三条文本必须**互不相似**：`rememberShort` 里有 `isDuplicate`（二元组重合 ≥ 0.6 就当重复丢掉），
  // 夹具写成"会话 A 说… / 会话 B 说…"会只剩一条，测的就不是分组而是去重了。
  let memory = base.memory
  // 第一条标成"它自己写的"：面板要能把它和听来的原话分开画
  memory = rememberShort(
    memory,
    { kind: 'agreement', text: '这个项目用 pnpm 装依赖', at: 0, ws: null, sessionId: 'session-a', origin: 'self' },
    T,
  )
  memory = rememberShort(memory, { kind: 'agreement', text: '提交之前要跑全量测试', at: 1, ws: null, sessionId: 'session-b' }, T)
  memory = rememberShort(memory, { kind: 'fact', text: '临时文件丢到 tmp 目录', at: 2, ws: null }, T)
  memory = rememberShort(memory, { kind: 'preference', text: '回复要先给结论', at: 3, ws: '' }, T)
  memory = rememberShort(memory, { kind: 'fact', text: '这条是当年还没有工作区字段的老条目', at: 4 }, T)
  assert.equal(memory.short.length, 5, '五条都要真的存进去，否则后面的断言没意义')

  const view = definition.wire.view({ ...base, memory })
  const groups = view.shortGroups
  const bySession = groups.filter((group) => group.scope === 'ungrouped' && group.sessionId !== undefined)
  assert.equal(bySession.length, 2, '两个没选工作区的会话要各自成组，不能挤成一团')
  assert.deepEqual(
    bySession.map((group) => group.sessionId).sort(),
    ['session-a', 'session-b'],
    '组里必须带出会话 id，面板才能去查那个会话叫什么',
  )
  assert.ok(
    bySession.every((group) => group.label === '未分组会话'),
    `会话组在客户端去查标题之前只给兜底标题（实际 ${JSON.stringify(bySession.map((g) => g.label))}）`,
  )

  const legacy = groups.find((group) => group.scope === 'ungrouped' && group.sessionId === undefined)
  assert.equal(legacy?.label, '未分组会话（旧记录）', '不知道是谁写的那一档要单独说清楚')
  assert.equal(groups.filter((group) => group.scope === 'unknown').length, 1, '没有 ws 的老条目算"未标注"')
  assert.equal(groups.filter((group) => group.scope === 'global').length, 1, '显式全局（偏好）自己一档')

  // 每条记忆自己也要带 scope：客户端按它决定要点哪种说明
  const scopes = new Set(view.shortMemory.map((entry) => entry.scope))
  assert.ok(scopes.has('ungrouped') && scopes.has('unknown') && scopes.has('global'))

  // 来源也要带出来：面板靠它把"它自己记的"和"听来的原话"分开画
  // （缺省 = 听来的：老档案和兜底摘句都是这一档，不能冒领成它自己写的）
  assert.equal(view.shortMemory.find((entry) => /pnpm/.test(entry.text))?.origin, 'self')
  assert.equal(view.shortMemory.find((entry) => /tmp 目录/.test(entry.text))?.origin, 'heard')
})
