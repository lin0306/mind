/**
 * 适配层（Host 半边）的接线测试。
 *
 * ## 为什么必须有这一份
 *
 * feiyu-memory 的教训写在它自己的 AGENTS.md 里：**测试全绿 ≠ 插件能用**。
 * 内核的单元测试（mind-core/test）测的是"机制对不对"，而这里测的是
 * "**事件进得来、状态出得去、提示词真有那一段、档案真落盘**"——
 * 那是接线错误唯一能被抓到的地方。
 *
 * 这一份用**假宿主**：自己实现 `get/on/inject`、假 systemPrompt、假投影注册表，
 * 按 DSH 的事件形状投喂，再断言产物。不需要真的装进 DSH。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const HOME = mkdtempSync(path.join(tmpdir(), 'dsh-mind-home-'))
process.env.DSH_HOME = HOME

const { apply, name, inject, safeKey, saveSession, saveShort, loadGlobal, loadShort, loadPersonaState, globalMemoryFile, shortFile, readZstdLines, sessionMemoryFile } =
  await import('../lib/index.js')
const { emptyState } = await import('dsh-mind-core')

/** 假宿主。 */
function makeHost() {
  const listeners = new Map()
  const services = new Map()
  const sections = []
  const contexts = []
  const tools = []
  const commands = []
  const logs = []
  const registry = new Map()
  const states = new Map()

  services.set('systemPrompt', {
    section(spec) {
      sections.push(spec)
      return () => {}
    },
    context(spec) {
      contexts.push(spec)
      return () => {}
    },
  })
  services.set('sessionProjections', {
    register(definition) {
      registry.set(definition.key, definition)
      return () => {}
    },
    stateOf(session, key) {
      return key === 'mind' ? states.get(session?.id) : undefined
    },
  })
  services.set('tools', {
    register(spec) {
      tools.push(spec)
      return () => {}
    },
  })
  services.set('commands', {
    register(spec) {
      commands.push(spec)
      return () => {}
    },
  })

  const ctx = {
    get: (n) => services.get(n),
    on(event, listener) {
      const arr = listeners.get(event) ?? []
      arr.push(listener)
      listeners.set(event, arr)
      return () => {}
    },
    inject(_names, cb) {
      cb(ctx)
      return () => {}
    },
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
      debug: () => {},
    },
  }

  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) ?? []) fn(...args)
  }
  return { ctx, emit, sections, contexts, tools, commands, logs, registry, states, followups: [] }
}

let clock = 1_700_000_000_000
const nextTime = () => (clock += 1000)

/** 造一个会话，走完"agent 创建 → 起始状态"。
 *
 * `cwd` 决定这个会话绑哪个工作区：不给就是 `workspace: ''`（未分组会话，记忆会落进
 * 那个会话自己的日记层）。要验证跨会话库的行为，就必须给一个 cwd。
 */
function birth(host, id = 's1', cwd) {
  const session = { id }
  // `followup()` 是真 agent 身上的方法：主动开口最后就是靠它起新回合，所以这里必须能观察
  const agent = {
    id,
    ctx: host.ctx,
    session,
    // 真 followup 需要一条消息（不带参数会报 reading 'id'），所以这里把整条消息记下来
    followup: (message) => {
      host.followups.push(message)
    },
  }
  host.emit('agent/created', { agent, source: 'user', signal: undefined })
  const definition = host.registry.get('mind')
  host.states.set(id, definition.init(cwd === undefined ? undefined : { id, cwd }))
  return { session, agent }
}

/** 投喂一条会话事件：先折叠，再通知插件。 */
function feed(host, session, type, data) {
  const definition = host.registry.get('mind')
  const before = host.states.get(session.id)
  const after = definition.apply(before, { type, seq: 1, time: nextTime(), data })
  host.states.set(session.id, after)
  host.emit('session/event', session, { type, seq: 1, time: nextTime(), data })
  return { before, after }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 把状态推到"心里搁着事、情绪也真的在"：这是主动开口的前提。 */
function stirUp(host, session) {
  feed(host, session, 'tool/call', {
    callId: 'c-note',
    name: 'inner_note',
    arguments: JSON.stringify({ intent: '需求还没确认', tension: 0.9 }),
  })
  feed(host, session, 'tool/result', { callId: 'c-f1', message: { isError: true } })
  feed(host, session, 'tool/result', { callId: 'c-f2', message: { isError: true } })
}

test('主动开口：默认关 —— 连监听都不挂，一次都不会开口', async () => {
  const host = makeHost()
  apply(host.ctx, { proactive: false })
  const { session, agent } = birth(host, 's-pro-off')
  stirUp(host, session)

  host.emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  await sleep(5)
  assert.equal(host.followups.length, 0, '没开开关就开口了')
})

test('主动开口：开了之后，心里有事 + 情绪在 + 冷却已过 → 自己起一个回合；冷却内不再说', async () => {
  const host = makeHost()
  apply(host.ctx, { proactive: true })
  const { session, agent } = birth(host, 's-pro-on')
  stirUp(host, session)

  host.emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  await sleep(10)
  assert.equal(host.followups.length, 1, '该开口时没开口')

  // 唤醒消息的形状：真机不带这条消息会报 `Cannot read properties of undefined (reading 'id')`
  const message = host.followups[0]
  assert.ok(message && message.id, 'followup 必须收到一条带 id 的消息')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin:dsh-mind', '来源标记要能一眼看出是插件自己叫醒的')
  assert.equal(message.content[0].type, 'text')
  assert.ok(message.content[0].text.length > 0, '唤醒消息不能是空的')
  assert.ok(
    host.logs.some((line) => (Array.isArray(line) ? line.join(' ') : String(line)).includes('[proactive] 主动开口')),
    '开口必须在自己的日志里留一行（用户要求：只记日志，不进对话）',
  )

  // 紧接着再来一次：冷却（45 分钟）应该挡住
  host.emit('agent/turn-stopping', { agent, turn: 2, signal: { aborted: false } })
  await sleep(10)
  assert.equal(host.followups.length, 1, '冷却没到却又说了一句')
})

test('主动开口：被用户打断的那一轮不说话', async () => {
  const host = makeHost()
  apply(host.ctx, { proactive: true })
  const { session, agent } = birth(host, 's-pro-abort')
  stirUp(host, session)

  host.emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: true } })
  await sleep(10)
  assert.equal(host.followups.length, 0, '被打断时不该主动开口')
})

test('接线：投影、人设段、实况段、工具、命令都挂上了', () => {
  const host = makeHost()
  apply(host.ctx, { debugLog: false })
  assert.equal(name, 'dsh-mind')
  assert.deepEqual(inject, ['systemPrompt', 'sessionProjections'])
  assert.ok(host.registry.get('mind'), '投影要注册')
  assert.equal(host.registry.get('mind').key, 'mind')
  assert.equal(host.registry.get('mind').stateVersion, 3, 'v3 多了 session（未分组会话的来源）')
  assert.equal(host.contexts.length, 1, '实况段注册一次')
  birth(host)
  assert.equal(host.sections.length, 1, '人设段按 agent 注册')
  assert.equal(host.tools.length, 3, 'inner_note（写思想）、recall_memory（查长期记忆）、forget_memory（划掉某条）都要挂上')
  assert.deepEqual(host.tools.map((tool) => tool.name).sort(), [
    'forget_memory',
    'inner_note',
    'recall_memory',
  ])
  assert.equal(host.commands.length, 1)
  assert.equal(host.commands[0].name, 'mind')
})

test('实况段：工具连续失败后，请求末尾出现情绪词', () => {
  const host = makeHost()
  apply(host.ctx, {})
  const { session, agent } = birth(host)

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'user/message', { source: { kind: 'user' }, text: '帮我把这个跑通' })
  feed(host, session, 'tool/call', { name: 'bash', arguments: '{"command":"pnpm test"}' })
  feed(host, session, 'tool/result', { name: 'bash', error: { name: 'ExitError' } })
  feed(host, session, 'tool/call', { name: 'bash', arguments: '{"command":"pnpm test"}' })
  feed(host, session, 'tool/result', { name: 'bash', error: { name: 'ExitError' } })

  const text = host.contexts[0].text({ agent })
  assert.match(text, /【内部状态/, '实况段要有明确边界（真跑里没有边界时，模型会把状态行接在自己回复后面）')
  assert.ok(/挫败|烦躁/.test(text), `连续失败后要有负向情绪词，实际：${text}`)
})

test('人设段：在系统提示词里，且不含短期记忆（短期记忆会毁前缀缓存）', () => {
  const host = makeHost()
  apply(host.ctx, {})
  // 短期池按工作区过滤（inScope），所以这个会话必须有工作区、条目也得带同一个 ws
  const { session } = birth(host, 's1', 'E:/code/thought')
  const state = host.states.get(session.id)
  state.memory.short.push({ id: 'm1', kind: 'fact', text: '用户的工作区在 E 盘', importance: 0.8, hits: 1, createdAt: nextTime(), lastAt: nextTime(), because: '用户说的', scope: 'workspace', ws: 'E:/code/thought' })

  const text = host.sections[0].text()
  assert.match(text, /【我的人设】/)
  assert.match(text, /说话习惯/)
  assert.ok(!text.includes('用户的工作区在 E 盘'), '短期记忆不能进系统提示词')
  assert.equal(host.sections[0].interpolate, false)
  assert.equal(host.sections[0].order, 132)
  assert.equal(host.contexts[0].order, 133)

  // 手边记忆改去请求末尾
  const realtime = host.contexts[0].text({ agent: { session } })
  assert.match(realtime, /【手边记着的事】/)
  assert.match(realtime, /用户的工作区在 E 盘/)
})

test('inner_note：工具调用折成思想，下一轮实况段能看见', () => {
  const host = makeHost()
  apply(host.ctx, {})
  const { session, agent } = birth(host)
  feed(host, session, 'turn/start', { turn: 1 })

  const args = JSON.stringify({
    workingJudgment: '先去核对文档，不猜 API',
    tension: 0.4,
    metaCheck: '我刚才在凭印象写，不可靠',
  })
  feed(host, session, 'tool/call', { name: 'inner_note', arguments: args })

  const state = host.states.get(session.id)
  assert.equal(state.thought.judgment, '先去核对文档，不猜 API')
  assert.equal(state.thought.metaCheck, '我刚才在凭印象写，不可靠')
  assert.ok(state.thought.tension > 0.3)
  assert.equal(state.thought.noteCount, 1)

  const realtime = host.contexts[0].text({ agent })
  assert.match(realtime, /我的判断：先去核对文档，不猜 API/)
  assert.match(realtime, /自查：我刚才在凭印象写，不可靠/)
})

test('无关的高频事件必须原样返回同一个引用（否则每一步都白干活）', () => {
  const host = makeHost()
  apply(host.ctx, {})
  const { session } = birth(host)
  const before = host.states.get(session.id)
  const { after } = feed(host, session, 'assistant/stream', { frame: {} })
  assert.equal(after, before, '引用必须不变')
})

test('状态 schema 不吞字段：emptyState 解析后与原来深相等', () => {
  const host = makeHost()
  apply(host.ctx, {})
  const definition = host.registry.get('mind')
  const state = emptyState(undefined, clock)
  const parsed = definition.stateSchema.parse(state)
  assert.deepEqual(parsed, state, 'zod 若剥掉未声明的键，状态会每轮悄悄丢字段')
})

test('/mind 只读：面板能出，且不动状态', () => {
  const host = makeHost()
  apply(host.ctx, {})
  const { session, agent } = birth(host)
  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'user/message', { text: '谢谢，这个思路对' })

  const before = host.states.get(session.id)
  const panel = host.commands[0].handler({ agent, rawInput: '' })
  // 命令必须返回 CommandResult **对象**：裸字符串会让宿主报 reading 'layers'（真机实测）
  assert.equal(panel.kind, 'success')
  assert.match(panel.text, /# dsh-mind 状态/)
  assert.match(panel.text, /## 情感/)
  assert.equal(host.states.get(session.id), before, '命令不许改状态')

  const why = host.commands[0].handler({ agent, rawInput: 'why' })
  assert.equal(why.kind, 'success')
  assert.ok(why.text.length > 0)
  const explain = host.commands[0].handler({ agent, rawInput: 'reset' })
  assert.equal(explain.kind, 'success')
  assert.match(explain.text, /不能重置/)
})

test('/mind rollback：没有快照就如实说没有，并给出用法', () => {
  const host = makeHost()
  apply(host.ctx, {})
  const { session, agent } = birth(host, 's-rollback')
  feed(host, session, 'turn/start', { turn: 1 })

  // 不合法参数 → 给用法，而不是装作回滚了
  const bad = host.commands[0].handler({ agent, rawInput: 'rollback' })
  assert.equal(bad.kind, 'success')
  assert.match(bad.text, /用法：\/mind rollback/)

  // 合法序号但还没有任何快照 → 如实说没有（内核走年尺度闸门，刚认识不会有）
  const none = host.commands[0].handler({ agent, rawInput: 'rollback 1' })
  assert.equal(none.kind, 'success')
  assert.match(none.text, /没有快照可回滚/)
})

test('人设内核文件：首次运行生成模板，写进去的内核能进人设段', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-persona-'))
  const file = path.join(dir, 'persona.md')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, ['名字: 小和', '价值观:', '  - 诚实: 0.9', '边界:', '  - 不做破坏性操作'].join('\n'), 'utf8')

  const host = makeHost()
  apply(host.ctx, { personaPath: file, stateDir: dir })
  const { session } = birth(host, 's-persona')

  const text = host.sections[0].text()
  assert.match(text, /自称：小和/)
  assert.match(text, /诚实/)
  assert.match(text, /不做破坏性操作/)
  assert.ok(host.states.get(session.id).persona.kernel.boundaries.includes('不做破坏性操作'))
})

test('存档写回：跨会话的人设与统计落到 stateDir 的 v3 快照里', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-save-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session } = birth(host, 's2')

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'user/message', { text: '记住：这个项目一律用中文写注释' })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })

  await sleep(1500)
  // v3 不再有"一个 state.json 装完"：人设与统计是 global/persona.jsonl.zst 里的**一行快照**
  const stateFile = path.join(dir, 'global', 'persona.jsonl.zst')
  assert.ok(existsSync(stateFile), '去抖到点后应当落盘（global/persona.jsonl.zst）')
  const lines = readZstdLines(stateFile).lines
  assert.ok(lines.length >= 1, '至少写下一份快照')
  const last = JSON.parse(lines.at(-1))
  assert.equal(last.version, 3)
  assert.ok(last.stats.turns >= 1, '回合数要累计')
  assert.ok(existsSync(path.join(dir, 'persona.md')), '首次运行应当生成人设模板')
  assert.equal(existsSync(path.join(dir, 'state.json')), false, 'state.json 已退休：不再写它')
})

/** 命令的返回值是适配后的 `{kind:'success', text}`，测试里统一取文本。 */
const textOf = (result) => (typeof result === 'string' ? result : String(result?.text ?? ''))

test('记忆管理：/mind remember 逐条说明凭什么记着，/mind forget 划掉后不会长回来', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-forget-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-forget', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'user/message', { text: '记住：这个项目用 pnpm，不要用 npm' })
  // v2.3：记忆只能由它自己写下来（用户的原话一概不入库），所以这里要投一条 inner_note。
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c-note',
    arguments: JSON.stringify({ remember: '这个项目用 pnpm，不要用 npm', rememberKind: 'agreement' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500) // 等它落盘，好验证"改的是档案"

  // 「凭什么记着它」必须能答上来：类型、重要度、次数、时间、缘由
  const all = cmd('remember')
  assert.match(all, /\[约定\]/, `要写清类型，实际：${all}`)
  assert.match(all, /pnpm/)
  assert.match(all, /凭什么|因为|重要度/, `要说明为什么记着，实际：${all}`)

  // 带关键词只列相关的
  const one = cmd('remember pnpm')
  assert.match(one, /pnpm/)
  assert.ok(!one.includes('注释一律用中文'), '带词时不该把不相干的也列出来')

  // 划掉它（改的是档案），并如实说明本会话内还在
  const forgotten = cmd('forget 1')
  assert.match(forgotten, /忘|划/, `要如实说做了什么，实际：${forgotten}`)
  assert.match(forgotten, /本会话|forget_memory/, '要告诉用户"本会话内它还在"以及怎么立刻删')

  // 关键：新会话接管档案时要按名单过滤，否则下次落盘它又长回来
  const second = birth(host, 's-forget-2')
  const adopted = host.states.get(second.session.id)
  assert.ok(!adopted.memory.global.some((e) => /pnpm/.test(e.text)), '被划掉的条目不许再被接管')
  assert.ok(adopted.memory.forgotten.length >= 1, '遗忘名单要跟着档案走')
})

test('forget_memory 工具：折叠时删掉（可重放），并对不上时什么都不删', () => {
  const host = makeHost()
  apply(host.ctx, {})
  // 有工作区才落进短期池（没选工作区的会话写下的东西进它自己的日记）
  const { session } = birth(host, 's-forget-tool', 'E:/code/thought')

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c-note',
    // 用 lesson（0.65）而不是 agreement（0.85）：这条测试要的是"手边有一条可供工具删"，
    // 而 agreement 会在收束时被**搬进**跨会话库（升格＝搬走，不留副本）。
    arguments: JSON.stringify({ remember: '这个项目用 pnpm，不要用 npm', rememberKind: 'lesson' }),
  })
  assert.equal(host.states.get(session.id).memory.short.length, 1, '它写下的这一条立刻进短期池')
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  assert.equal(host.states.get(session.id).memory.short.length, 1, '收束之后照样在（不够固化门槛）')

  // 先来一条对不上的：什么都没删
  feed(host, session, 'tool/call', {
    name: 'forget_memory',
    callId: 'c-miss',
    arguments: JSON.stringify({ text: '完全不相干的一句话' }),
  })
  assert.equal(host.states.get(session.id).memory.short.length, 1, '对不上就该什么都不删')

  // 再用原文片段指认：删掉，并记进名单
  feed(host, session, 'tool/call', {
    name: 'forget_memory',
    callId: 'c-hit',
    arguments: JSON.stringify({ text: '这个项目用 pnpm' }),
  })
  const after = host.states.get(session.id)
  assert.equal(after.memory.short.length, 0, '折叠时删掉')
  assert.equal(after.memory.forgotten.length, 1, '名单里记一笔')
})

test('reset-once 标记：下次启动从空档案开始，且只清一次', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-reset-'))
  const file = path.join(dir, 'state.json')
  mkdirSync(dir, { recursive: true })
  // 先捏一份"有内容"的档案：一条长期记忆
  writeFileSync(
    file,
    JSON.stringify({
      format: 1,
      mind: {
        memory: {
          short: [],
          long: [
            {
              id: 'old-1',
              kind: 'agreement',
              text: '这个项目用 pnpm',
              importance: 0.9,
              hits: 3,
              createdAt: 1,
              lastAt: 1,
              because: '测试',
            },
          ],
          forgotten: [],
          updatedAt: 1,
        },
      },
    }),
    'utf8',
  )
  writeFileSync(path.join(dir, 'reset-once'), 'test\n', 'utf8')

  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })

  // v3 的"清空"是在每一层追加一份**空快照**，读取只认最后一行
  assert.equal(loadGlobal(dir).entries.length, 0, '标记在，就该按空存档起步')
  assert.equal(loadShort(dir, '').entries.length, 0, '短期那几份也一样清掉')
  assert.ok(existsSync(path.join(dir, 'archive', 'state.v1.json')), '旧 state.json 退休进 archive/')
  assert.equal(existsSync(path.join(dir, 'reset-once')), false, '标记是一次性的：吃完就删')
})


test('迁移调用点：apply() 真的把 v1 档案拆到新布局（标记与文件都要出现）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-migrate-'))
  mkdirSync(dir, { recursive: true })
  // 一份 v1 档案：一条长期 + 一条短期 + 一条被忘掉的
  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      format: 1,
      mind: {
        memory: {
          short: [
            {
              id: 's-1',
              kind: 'fact',
              text: '这个项目的测试要跑全量',
              importance: 0.5,
              hits: 0,
              createdAt: 1,
              lastAt: 1,
              because: '测试',
              ws: 'E:/code/thought',
            },
          ],
          long: [
            {
              id: 'l-1',
              kind: 'agreement',
              text: '这个项目用 pnpm',
              importance: 0.9,
              hits: 3,
              createdAt: 1,
              lastAt: 1,
              because: '测试',
            },
          ],
          forgotten: ['忘掉的那条'],
          updatedAt: 1,
        },
      },
    }),
    'utf8',
  )

  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })

  // 这条测的是**调用点**。以前这里把档案的 JSON 文本当成 stateDir 传进 migrateV1，
  // 于是标记与文件全落到一个乱路径、写入静默失败，日志却报「迁移成功」——
  // `test/migrate.test.mjs` 测的是函数本身（传的是真目录），所以漏了整条链路。
  assert.ok(existsSync(path.join(dir, 'migrated-to-v3')), '迁移标记要出现，否则每次启动都重跑')
  assert.ok(existsSync(globalMemoryFile(dir)), '全局库快照文件要出现')
  assert.ok(existsSync(shortFile(dir, 'E:/code/thought')), '短期要按工作区分桶落地')
  assert.equal(loadGlobal(dir).entries.length, 1, '那条约定要真的拆过去')
  assert.deepEqual(loadPersonaState(dir).forgotten, ['忘掉的那条'], '遗忘名单必须跟着走')
  assert.ok(existsSync(path.join(dir, 'archive', 'state.v1.json')), '旧 state.json 改名进 archive/')
})

test('短期层跨会话：本工作区的落地文件会被新会话接管', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-short-'))
  mkdirSync(dir, { recursive: true })
  const ws = 'E:/code/thought'
  // 先按 v2 的正式落点写一份"这个项目手边的事"
  saveShort(
    dir,
    ws,
    [
      {
        id: 'short-1',
        kind: 'lesson',
        text: '不许为了让测试变绿而放宽断言',
        importance: 0.9,
        hits: 0,
        createdAt: 1,
        lastAt: 1,
        because: '我自己记下的',
        origin: 'self',
        scope: 'workspace',
        ws,
      },
    ],
    1_700_000_000_000,
    { reason: 'manual' },
  )

  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session } = birth(host, 's-short', ws)

  // 短期层不带过来的话，同一个项目里新开的会话手边记忆是空的，
  // 前一段对话里说好的事就接不上了——那正是 v2.0 改动带进来的回归。
  const state = host.states.get(session.id)
  assert.equal(state.memory.short.length, 1, '新会话该带上前一段留下的手边记忆')
  assert.equal(state.memory.short[0].text, '不许为了让测试变绿而放宽断言')
  // 但"带过来"不等于"是这一段的材料"：载入的这批是**上一个会话**留下的，新会话一开始就得
  // 标成"已消化"，否则收尾兜底会拿它们替这一段代笔——旧日记里
  // "还没解决什么：[seq 433] 你这个包结构…"就是这么写出来的（内核侧有同一条回归）。
  assert.deepEqual(state.memory.digested, ['short-1'], '载入的短期条目要标成已消化')
})

// ── 清库（v2.4）：三层全清、人设保留，而且划掉的不会被正在跑的会话写回来 ──────────

/**
 * 最后一份快照里的条目（三层都用它看"盘上现在是什么"）。
 *
 * 文件不存在也算空：升格是"搬走"，所以"那条已经不在手边这一层了"这件事
 * 会表现为 short 文件根本没被创建过（不是"有个文件但里面空"）。
 */
const lastEntries = (file) => {
  const lines = readZstdLines(file).lines
  const last = lines?.[lines.length - 1]
  return last === undefined ? [] : JSON.parse(last).entries
}

test('清库命令：/mind reset-memory 清记忆三层，人设与统计保留', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-resetmem-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-reset', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c-note',
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'agreement' }),
  })
  // 再写一条**只住在手边**的（lesson 0.65 永不固化）：2026-11-13 的漏就是漏在它身上——
  // 清库只从档案里收 id，而档案里没有手边这一层。
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c-note2',
    arguments: JSON.stringify({ remember: '大文件不要一次全读进来', rememberKind: 'lesson' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500) // 等去抖落盘
  assert.ok(loadGlobal(dir).entries.length >= 1, '先得有一条跨会话记忆，才谈得上清')
  const live = host.states.get(session.id)
  // 升格是**搬走**：pnpm（agreement 0.85）已经进了跨会话库，手边只剩 lesson 那条
  assert.equal(live.memory.short.length, 1, '手边只剩那条不值得固化的')
  const shortOnlyId = live.memory.short.find((e) => e.kind === 'lesson').id
  const personaBefore = loadPersonaState(dir)
  assert.ok(personaBefore.forgotten.length === 0, '清之前名单是空的')

  const out = cmd('reset-memory')
  assert.match(out, /记忆已清空/, `要如实说清做了什么，实际：${out}`)
  assert.match(out, /人设、性情基线、相处统计原样保留/, '要说明"我还是我"')

  assert.equal(loadGlobal(dir).entries.length, 0, '跨会话库要清空')
  assert.deepEqual(lastEntries(shortFile(dir, 'E:/code/thought')), [], '手边要清空（追加一份空快照）')
  const personaAfter = loadPersonaState(dir)
  assert.ok(personaAfter.forgotten.length >= 1, '清掉的 id 要进遗忘名单（这是"不会长回来"的保证）')
  assert.ok(personaAfter.persona !== null && personaAfter.stats !== null, '人设与统计原样保留')
  assert.ok(
    personaAfter.forgotten.includes(shortOnlyId),
    '只住在手边的那条也必须进名单——它进不去，下一次落盘就会把面板上的残留写回盘（2026-11-13 的漏）',
  )

  // 活状态也要照名单过滤：清完之后**下一个事件**起，面板与注入里就不该再看得见它们。
  feed(host, session, 'turn/start', { turn: 2 })
  assert.equal(host.states.get(session.id).memory.short.length, 0, '活状态得当场自愈（不然用户看到的就是"命令没生效"）')
  feed(host, session, 'turn/end', { turn: 2, reason: 'completed' })
  await sleep(1500)
  assert.deepEqual(lastEntries(shortFile(dir, 'E:/code/thought')), [], '接着落一次盘，盘上也不许长回来')
})

test('清完之后，会话的**下一次落盘**不许把记忆写回来（名单比对写回更权威）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-resetback-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-back', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c-note',
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'agreement' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)
  // 升格搬走之后，这条住在跨会话库里（手边已经没有了）
  assert.equal(loadGlobal(dir).entries.length, 1, '清之前库里确实有一条（否则这个测试是空转）')
  cmd('reset-memory')
  assert.deepEqual(lastEntries(shortFile(dir, 'E:/code/thought')), [], '命令当场就该把盘面清掉')

  // 关键回归：活状态里那条还在（命令改不了它），所以**下一次落盘**才是真考验。
  // 2026-11-13 真机现场：清完面板依旧是 3 条，一查盘面也被写回来了——因为写盘时用的是
  // 活状态自己的名单，宿主侧那份（hostForgotten）没并进去。这里必须喂一个**真的会触发落盘**
  // 的事件（turn/end 会 scheduleSave），不能拿 step/end 空转。
  feed(host, session, 'turn/start', { turn: 2 })
  feed(host, session, 'turn/end', { turn: 2, reason: 'completed' })
  await sleep(1500)
  assert.deepEqual(lastEntries(shortFile(dir, 'E:/code/thought')), [], '手边不许被会话写回来')
  assert.equal(loadGlobal(dir).entries.length, 0, '跨会话库也不许长回来')
})

test('手工 /mind forget 之后，会话落盘既不许覆盖名单也不许把它写回来', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-forget-keep-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-keep', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c-note',
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'agreement' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)

  assert.match(cmd('forget 1'), /已划掉/, '先划掉一条')
  const kept = loadPersonaState(dir).forgotten.length
  assert.ok(kept >= 1, '划掉之后名单里要有它')
  assert.equal(loadGlobal(dir).entries.length, 0, '命令当场就该把跨会话库里的它拿掉')

  feed(host, session, 'turn/start', { turn: 2 })
  feed(host, session, 'turn/end', { turn: 2, reason: 'completed' })
  await sleep(1500)
  assert.ok(
    loadPersonaState(dir).forgotten.length >= kept,
    '会话落盘不许把宿主侧的名单覆盖掉（覆盖了的话，重启后那条会复活）',
  )
  assert.equal(loadGlobal(dir).entries.length, 0, '被划掉的库里那份不许被写回，也不许被重新固化回来')
  // 手边本来就是空的：这条早就**搬进**库里了（升格＝搬走，不留副本）
  assert.deepEqual(lastEntries(shortFile(dir, 'E:/code/thought')), [], '手边没有副本')
})

/** 会话日记那一层也要能清（清库三层里它最容易被漏掉）。 */
test('清库把会话日记也清了，连它的 summary.md 一起重生成', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-resetdiary-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { agent } = birth(host, 's-diary')

  // 预置一份"旧会话日记"：不依赖去抖落盘的时机，测的就是"清那一层"
  saveSession(
    dir,
    's-diary',
    [
      {
        id: 'm-diary-1',
        kind: 'lesson',
        text: '大文件不要一次全读进来',
        importance: 0.65,
        hits: 0,
        createdAt: 1,
        lastAt: 1,
        scope: 'session',
        seq: 1,
      },
    ],
    Date.now(),
    { reason: 'manual' },
  )
  const diary = sessionMemoryFile(dir, 's-diary')
  assert.equal(lastEntries(diary).length, 1, '先得有一份日记在那儿，才谈得上清')

  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))
  const out = cmd('reset-memory')
  assert.match(out, /会话日记清了 1 份/, `要如实报清了几份，实际：${out}`)
  assert.deepEqual(lastEntries(diary), [], '会话日记也要清空（不然它是最脏的一层）')
})

// ── 按层看 / 按层清 / 按层划（v2.4.x：show / clear / forget <层>）──────────────

test('show：三层各自成段、序号可用；裸 clear 只列条数不真清', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-show-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-show', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c1',
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'agreement' }),
  })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c2',
    arguments: JSON.stringify({ remember: '大文件不要一次全读进来', rememberKind: 'lesson' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)

  // 升格搬走之后：约定（0.85）住库、lesson（0.65）住手边——**一条记忆只在一个地方**
  const shortView = cmd('show short')
  assert.match(shortView, /# 手边/, `要标明是哪一层：${shortView}`)
  assert.match(shortView, /大文件/)
  assert.ok(!shortView.includes('pnpm'), '搬进库的那条不该还挂手边')
  assert.match(shortView, /forget short/, '要告诉人怎么划掉这一条')

  const globalView = cmd('show global')
  assert.match(globalView, /# 跨会话库/)
  assert.match(globalView, /pnpm/, '约定（0.85）该固化进库')
  assert.ok(!globalView.includes('大文件'), 'lesson（0.65）没被反复取用，不该进库')

  const allView = cmd('show')
  for (const title of ['# 手边', '# 本会话日记', '# 跨会话库']) {
    assert.ok(allView.includes(title), `不带层名要三层都列：缺 ${title}`)
  }

  const bare = cmd('clear')
  assert.match(bare, /用法：\/mind clear/)
  assert.match(bare, /手边 1 条/)
  assert.equal(loadGlobal(dir).entries.length, 1, '裸 clear 不许真清库')
  assert.equal(host.states.get(session.id).memory.short.length, 1, '裸 clear 不许真清手边')
})

test('clear short：只清当前项目的手边，别的项目那份与跨会话库都不动', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-clearshort-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-cs', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  // 别的项目先留一条手边：这条**不许**被"清当前项目的手边"带走
  saveShort(
    dir,
    'E:/code/other',
    [
      {
        id: 'm-other-1',
        kind: 'fact',
        text: '别的项目的事',
        importance: 0.6,
        hits: 0,
        createdAt: 1,
        lastAt: 1,
        scope: 'workspace',
        ws: 'E:/code/other',
      },
    ],
    Date.now(),
    { reason: 'manual' },
  )

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c1',
    // lesson 留在手边（0.65 不够固化门槛）：这条测试要清的就是手边这一层
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'lesson' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)
  assert.equal(loadGlobal(dir).entries.length, 0, '本测试只关心手边，库里应当是空的')

  const out = cmd('clear short')
  assert.match(out, /已清掉 当前项目的手边/, `实际：${out}`)
  assert.deepEqual(lastEntries(shortFile(dir, 'E:/code/thought')), [], '当前项目的手边清空了')
  assert.equal(lastEntries(shortFile(dir, 'E:/code/other')).length, 1, '别的项目的手边一个字都不许动')
  assert.equal(loadGlobal(dir).entries.length, 0, '跨会话库不许动（本测试里它本来就是空的）')
})

test('clear global：只清跨会话库，手边留着', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-clearglobal-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-cg', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c1',
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'agreement' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)

  const out = cmd('clear global')
  assert.match(out, /已清掉 跨会话库：1 条/, `实际：${out}`)
  assert.equal(loadGlobal(dir).entries.length, 0, '库空了')
  // 手边本来就是空的：这条升格时已经搬进库，清库不欠它一份副本
  assert.equal(host.states.get(session.id).memory.short.length, 0, '手边没有副本')
  assert.deepEqual(lastEntries(shortFile(dir, 'E:/code/thought')), [], '盘上也没有')
})

test('forget short 1：只划手边那条，库里那条留着；名单看得见', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-forgetlayer-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-fl', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c1',
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'agreement' }),
  })
  // 再加一条只住手边的（lesson 0.65 不固化），这样"只划手边"才有得划
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c2',
    arguments: JSON.stringify({ remember: '大文件不要一次全读进来', rememberKind: 'lesson' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)
  const shortId = host.states.get(session.id).memory.short[0].id
  const globalId = loadGlobal(dir).entries[0].id
  assert.notEqual(shortId, globalId, '手边那条与库里那条是两条不同的记忆（不是同一条的副本）')

  const out = cmd('forget short 1')
  assert.match(out, /已划掉（手边）/, `实际：${out}`)
  assert.equal(loadGlobal(dir).entries.length, 1, '库里那条不许被顺手划掉')

  // 活状态在**下一个事件**起自愈（命令改不了它，名单能）
  feed(host, session, 'turn/start', { turn: 2 })
  assert.equal(host.states.get(session.id).memory.short.length, 0, '手边那条没了')

  const list = cmd('show forgotten')
  assert.match(list, /遗忘名单/, `实际：${list}`)
  assert.ok(list.includes(shortId) || list.includes('pnpm'), '名单里要看得到它')
})

// ── 回收站：假删的闭环（清 → 列 → 捞回 → 活状态复活 → 撤销遗忘 → 真删）────────

test('清掉的东西进回收站，能捞回来并当场复活；真删是另一回事', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-trashloop-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-trash', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c1',
    // lesson（0.65）留在手边，才能测"清手边 → 进回收站"（agreement 会被搬进库）
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'lesson' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)

  assert.match(cmd('clear short'), /已清掉/)
  const listed = cmd('show trash')
  assert.match(listed, /# 回收站（\d+ 条/, `清单要列出来：${listed}`)
  assert.match(listed, /pnpm/, '正文要留在回收站里（这就是假删）')
  assert.match(listed, /手边/, '要写明它原来在哪一层')
  assert.match(listed, /为什么/, '要写明为什么掉的')

  // 捞回来：写回手边 + 撤销遗忘 + 下一个事件补回活状态
  assert.match(cmd('restore 1'), /恢复了 1 条/, '第一条应当能恢复')
  feed(host, session, 'turn/start', { turn: 2 })
  feed(host, session, 'turn/end', { turn: 2, reason: 'completed' })
  await sleep(1500)
  assert.ok(
    host.states.get(session.id).memory.short.some((e) => e.text.includes('pnpm')),
    '恢复之后活状态里要真的有它（面板与注入立刻可见）',
  )
  assert.equal(lastEntries(shortFile(dir, 'E:/code/thought')).length, 1, '盘上也写回去了')

  // 再清一次，这回真删
  cmd('clear short')
  assert.match(cmd('purge 1'), /已真删/, '真删要如实说不可逆')
  assert.equal(
    cmd('show trash').includes('pnpm'),
    false,
    '真删之后正文就没了（这是唯一不可逆的地方）',
  )
})

test('模型自己划掉的（工具走日志）也会进回收站——捕获只看"落盘时消失了"', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-trashlog-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-trashlog', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c1',
    // lesson 留在手边，这样"工具划掉手边那条"才有的划
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'lesson' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)

  const id = host.states.get(session.id).memory.short[0].id
  feed(host, session, 'tool/call', {
    name: 'forget_memory',
    callId: 'cf',
    arguments: JSON.stringify({ id }),
  })
  feed(host, session, 'turn/end', { turn: 2, reason: 'completed' })
  await sleep(1500)

  const listed = cmd('show trash')
  assert.match(listed, /pnpm/, '工具划掉的正文也要留在回收站里（用户照样能捞回来）')
})

test('撤销遗忘 + 捞回来：划错了能完整撤回', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mind-unforget-'))
  const host = makeHost()
  apply(host.ctx, { stateDir: dir, personaPath: path.join(dir, 'persona.md') })
  const { session, agent } = birth(host, 's-unforget', 'E:/code/thought')
  const cmd = (rawInput) => textOf(host.commands[0].handler({ agent, rawInput }))

  feed(host, session, 'turn/start', { turn: 1 })
  feed(host, session, 'tool/call', {
    name: 'inner_note',
    callId: 'c1',
    // lesson 留在手边：`forget short 1` 需要手边真的有一条
    arguments: JSON.stringify({ remember: '这个项目用 pnpm', rememberKind: 'lesson' }),
  })
  feed(host, session, 'turn/end', { turn: 1, reason: 'completed' })
  await sleep(1500)

  assert.match(cmd('forget short 1'), /已划掉（手边）/)
  assert.match(cmd('show forgotten'), /遗忘名单/, '划掉之后名单里能看到')
  assert.match(cmd('unforget 1'), /已从遗忘名单里撤掉/)
  assert.match(
    cmd('show forgotten'),
    /遗忘名单是空的/,
    '撤销之后名单里不该再有它（序号按 show forgotten 的当前顺序）',
  )

  // 撤销遗忘之后，正文还得从回收站捞回来才算真的回来
  assert.match(cmd('restore 1'), /恢复了 1 条/)
  feed(host, session, 'turn/start', { turn: 2 })
  feed(host, session, 'turn/end', { turn: 2, reason: 'completed' })
  await sleep(1500)
  assert.ok(
    host.states.get(session.id).memory.short.some((e) => e.text.includes('pnpm')),
    '撤销遗忘 + 捞回来之后，它真的回到手边了',
  )
})
