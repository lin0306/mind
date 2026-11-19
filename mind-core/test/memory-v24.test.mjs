/**
 * 会话记忆 → 跨会话库的固化（v2.4）。
 *
 * 病：`solidify` 只收手边（`scope !== 'session'`），于是"在本会话日记里被反复取用、
 * 或被明确要求记住的事"**永远升不到跨会话库**——下个会话就真没了。
 *
 * 药：层源加上本会话日记，闸门照旧（反复取用 `hits>=2` / 重要度 `>=0.75`），
 * 而且**升格只改 `scope`**：`sessionId` / `ws` / `seq` / 正文原样带过去——出处不能丢，
 * 否则到了全局库里就分不清"这是关于人的长期事"还是"某一次会话里的细节"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_TUNABLES as T, applyEvent, emptyState } from '../lib/index.js'

const fold = (state, event) => applyEvent(state, event, { tunables: T, sessionId: 's-1' })
const note = (args, seq, time) => ({
  type: 'tool/call',
  seq,
  time,
  data: { name: 'inner_note', arguments: JSON.stringify(args) },
})
const recallCall = (query, seq, time) => ({
  type: 'tool/call',
  seq,
  time,
  data: { name: 'recall_memory', arguments: JSON.stringify({ query, scope: 'all' }) },
})
const turnEnd = (seq, time) => ({ type: 'turn/end', seq, time, data: { turn: 1, reason: 'completed' } })

test('本会话日记里的约定（重要度高）在收束时升格进跨会话库，出处原样带过去', () => {
  // 没有工作区 → 条目落进**本会话日记**那一层（这正是 v2.4 要打开的那条路）
  let state = emptyState(T, 0)
  state = fold(state, note({ remember: '提交前跑全量测试', rememberKind: 'agreement' }, 1, 100))
  assert.equal(state.memory.session.length, 1, '先落在本会话日记里')
  assert.equal(state.memory.global.length, 0, '没到收束点，还没沉淀')

  state = fold(state, turnEnd(2, 200))
  assert.equal(state.memory.global.length, 1, '会话日记里的约定（0.85）该升格进跨会话库')
  const promoted = state.memory.global[0]
  assert.equal(promoted.scope, 'global', '归属改写成全局')
  assert.equal(promoted.text, '提交前跑全量测试', '正文一个字不动')
  assert.equal(promoted.seq, 1, '出处（seq）留着，随时能回到日志')
  assert.equal(promoted.sessionId, 's-1', '出处（哪个会话）也留着——这就是"防串味"的办法')
  assert.equal(state.memory.session.length, 1, '日记本身不动（只增不改）')

  // 同一个事实（文本重合）再说一遍：不许在跨会话库里长第二条
  state = fold(state, note({ remember: '提交前跑全量测试', rememberKind: 'agreement' }, 3, 300))
  state = fold(state, turnEnd(4, 400))
  assert.equal(state.memory.global.length, 1, '文本重合的再写一遍只算重复，不新增')
})

test('低重要度的会话条目先留在日记里；被取回两次才够格沉淀', () => {
  let state = emptyState(T, 0)
  state = fold(state, note({ remember: '大文件不要一次全读进来', rememberKind: 'lesson' }, 1, 100))
  assert.equal(state.memory.session.length, 1, 'lesson（0.65）落在日记里')

  state = fold(state, turnEnd(2, 200))
  assert.equal(state.memory.global.length, 0, '重要度不够、又没被用到 → 先留在日记里')

  state = fold(state, recallCall('大文件 全读', 3, 300))
  const once = state.memory.session[0].hits
  assert.ok(once >= 1, `取回一次就该加固：hits=${once}`)
  state = fold(state, recallCall('大文件 全读', 4, 400))
  assert.ok(state.memory.session[0].hits > once, '再取回一次还要加固')
  assert.equal(state.memory.global.length, 0, '加固到位但还没到收束点——固化只发生在 turn/end')

  state = fold(state, turnEnd(5, 500))
  assert.equal(state.memory.global.length, 1, '被反复取用（hits>=2）→ 沉淀进跨会话库')
  assert.equal(state.memory.global[0].text, '大文件不要一次全读进来')
  assert.equal(state.memory.global[0].scope, 'global')
})

test('升格是"搬走"：源层不再留它，库里那条沿用同一个身份', () => {
  const events = [note({ remember: '这个项目用 pnpm', rememberKind: 'agreement' }, 1, 100), turnEnd(2, 200)]
  let state = { ...emptyState(T, 0), workspace: 'E:/code/thought' }
  for (const event of events) state = fold(state, event)

  const promoted = state.memory.global[0]
  assert.equal(promoted.text, '这个项目用 pnpm')
  assert.equal(promoted.scope, 'global', '归属改写成全局')
  // 关键：手边（＝每次说话都装载进上下文的那几条）里**不再有它**。
  // 两层是两种**用途**、不是两份数据：同一条留在两处会让面板重复出现、
  // 额度被占两份、召回时撞见两次（用户：不重复存储）。
  assert.equal(state.memory.short.length, 0, '升格之后手边不再留同一份')
  assert.equal(state.memory.global.length, 1, '库里只有一条，不是两条同义条目')

  // 可回放：同一份日志重放，结果一致
  let again = { ...emptyState(T, 0), workspace: 'E:/code/thought' }
  for (const event of events) again = fold(again, event)
  assert.deepEqual(
    again.memory.global.map((e) => e.id),
    [promoted.id],
    'id 是纯函数指纹，可回放',
  )

  // 划掉库里那条之后不会被"下一轮从手边重新固化"顶回来——
  // 因为源已经搬走了，天然没有第二份可以再固化。
  const pruned = fold(state, {
    type: 'tool/call',
    seq: 4,
    time: 400,
    data: { name: 'forget_memory', arguments: JSON.stringify({ id: promoted.id }) },
  })
  assert.equal(pruned.memory.global.length, 0, '库里那条删掉了')
  const nextTurn = fold(pruned, turnEnd(5, 500))
  assert.equal(nextTurn.memory.global.length, 0, '划掉就是划掉，不许被重新固化回来')
})

test('手边那条路照旧：短期里够格的条目一样沉淀（别为了新路把老路弄丢）', () => {
  let state = { ...emptyState(T, 0), workspace: 'E:/code/thought' }
  state = fold(state, note({ remember: '这个项目用 pnpm', rememberKind: 'agreement' }, 1, 100))
  assert.equal(state.memory.short.length, 1, '有工作区 → 进手边')
  state = fold(state, turnEnd(2, 200))
  assert.equal(state.memory.global.length, 1, '手边里重要度高的照样固化')
  assert.equal(state.memory.global[0].ws, 'E:/code/thought', '工作区键原样带过去（它说明这条属于哪个项目）')
})
