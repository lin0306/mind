/**
 * 记忆闸门（v1.1）的机制测试。
 *
 * 这一层测的是"什么值得记、什么时候固化、被想起来会不会加固"，
 * 不测数值美观，也不测检索排序的分值——那些是调参，不是契约。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyEvent, DEFAULT_TUNABLES as T, normalizeState, recall, worthRemembering } from '../lib/index.js'

/** 这个文件测的是"知道自己在哪个工作区"那条主线：条目归属工作区，固化之后进全局库。 */
const HERE = '/e/code/thought'
// （没有工作区的会话，条目会落进"本会话日记"那一层——只增不改、到点才写，见 memory-v2.test.mjs）
const fresh = () => normalizeState({ workspace: HERE }, T, 0)
// 与其他测试同一套写法：折叠 = applyEvent + 参数
const fold = (state, event) => applyEvent(state, event, { tunables: T })

test('记忆闸门：闲聊不点亮信号，值得记的才点亮（而且只回种类、不摘原句）', () => {
  // v2.3 起它只判"这句话里有没有值得记的东西"，**不再摘原句**：
  // 摘下来的文本一个字都不落库（用户的要求：「所有的记忆，都让 ai 自己整理生成，
  // 不要直接引用用户的原话」）。所以这里返回值是种类，不是候选条目。
  assert.equal(worthRemembering('今天天气不错，先歇会儿吧').length, 0, '闲聊不该有信号')
  assert.equal(worthRemembering('嗯').length, 0, '太短的不算')

  assert.deepEqual(worthRemembering('记住：这个项目用 pnpm，不要用 npm'), ['agreement'], '"记住…"属于约定')
  assert.ok(
    worthRemembering('我希望以后回复都先给结论，我不喜欢长篇铺垫').includes('preference'),
    '偏好要被认出来',
  )
})

test('记忆闸门：用户的原话一个字都不落库，只点亮"该总结了"', () => {
  let state = fresh()
  state = fold(state, {
    type: 'user/message',
    seq: 1,
    time: 100,
    data: { text: '记住：以后回答都用中文，注释也用中文' },
  })
  // v2.3：听来的原句**不落库**。用户的原话是"素材"，不是记忆；记忆必须是它自己消化过的一句话。
  // （早先是先攒进 `pending`、回合收束时兜底落库——那条路摘出来的半句话把库里塞满了，
  //   用户一眼就看出来"这不是它自己总结的"。整条路连同 `pending` 一起删掉了。）
  assert.equal(state.memory.short.length, 0, '原话不入库')
  assert.equal(state.progress.summaryDue, true, '但要点亮信号：这里有值得记的东西')
  assert.equal(state.progress.summaryReason, 'signal', '理由是"刚说的话里有值得记的"')

  state = fold(state, { type: 'turn/end', seq: 2, time: 200, data: { turn: 1, reason: 'completed' } })
  assert.equal(state.memory.short.length, 0, '它这一轮没写 → 就没有记忆（宁可少，也不抄原话）')
  assert.equal(state.memory.global.length, 0, '更不该固化一条抄来的原话')
})

test('记忆闸门：它自己整理的一句话进短期；重要度高的一轮结束时固化进全局库', () => {
  let state = fresh()
  state = fold(state, {
    type: 'tool/call',
    seq: 1,
    time: 100,
    data: {
      name: 'inner_note',
      arguments: JSON.stringify({ remember: '回答与注释一律用中文', rememberKind: 'agreement' }),
    },
  })
  assert.equal(state.memory.short.length, 1, '它写的这一句进短期')
  assert.equal(state.memory.short[0].origin, 'self', '来源是"它自己写的"')

  state = fold(state, { type: 'turn/end', seq: 2, time: 200, data: { turn: 1, reason: 'completed' } })
  // v2.0：长期库改名"全局层"（`.long` → `.global`），固化这条路径没变——
  // 之所以进得了全局层，是因为上面给了工作区；没工作区时它会留在本会话日记那一层。
  assert.equal(state.memory.global.length, 1, '重要度高的一条，同一轮结束就该固化进全局库')

  const hits = recall(state.memory, '回答用什么语言', 300, T)
  assert.ok(hits.length >= 1, '换一种问法也要能检索到（否则全局库等于没有）')
})

test('记忆闸门：同一件事写两遍，只加固、不新增', () => {
  const note = (args, seq, time) => ({
    type: 'tool/call',
    seq,
    time,
    data: { name: 'inner_note', arguments: JSON.stringify(args) },
  })
  let state = fresh()
  state = fold(state, note({ remember: '回答一律用中文', rememberKind: 'agreement' }, 1, 100))
  const hitsBefore = state.memory.short[0].hits
  state = fold(state, note({ remember: '回答一律用中文', rememberKind: 'agreement' }, 2, 200))
  assert.equal(state.memory.short.length, 1, '重复的只是加固')
  assert.ok(state.memory.short[0].hits > hitsBefore, '加固要看得到')
})

test('记忆闸门：recall_memory 的查询会加固被想起来的条目（纯函数、可回放）', () => {
  let state = fresh()
  state = fold(state, {
    type: 'tool/call',
    seq: 1,
    time: 100,
    data: {
      name: 'inner_note',
      arguments: JSON.stringify({ remember: '回答一律用中文', rememberKind: 'agreement' }),
    },
  })
  state = fold(state, { type: 'turn/end', seq: 2, time: 200, data: { turn: 1, reason: 'completed' } })
  const before = state.memory.global[0].hits

  state = fold(state, {
    type: 'tool/call',
    seq: 3,
    time: 300,
    data: { name: 'recall_memory', arguments: JSON.stringify({ query: '回答语言' }) },
  })
  assert.ok(state.memory.global[0].hits > before, '被想起来的事要加固')

  // 参数坏掉时不能炸（工具参数是模型给的，什么形状都可能）
  const broken = fold(state, {
    type: 'tool/call',
    seq: 4,
    time: 400,
    data: { name: 'recall_memory', arguments: '{不是 JSON' },
  })
  assert.ok(broken, '坏参数不该让折叠崩掉')
})

test('记忆闸门不能破坏"无关事件原样返回同一引用"（这是缓存纪律）', () => {
  const state = fresh()
  assert.equal(fold(state, { type: 'request/header', seq: 1, time: 5, data: {} }), state)
  assert.equal(fold(state, { type: 'step/start', seq: 2, time: 6, data: { turn: 1 } }), state)
  // 合成消息（runtime-context 之类）不算"用户亲口说的"，不该写记忆
  const synthetic = fold(state, {
    type: 'user/message',
    seq: 3,
    time: 7,
    data: { source: { kind: 'runtime-context' }, text: '记住：这是合成消息' },
  })
  assert.equal(synthetic, state, '合成消息不写记忆，也不该产生新引用')
})

test('当前想法是它自己写的：库里存的是它整理过的一句话，不是用户的原句', () => {
  const note = (args, seq, time) => ({
    type: 'tool/call',
    seq,
    time,
    data: { name: 'inner_note', arguments: JSON.stringify(args) },
  })

  // ① 用户说了一件事 → 只点亮信号；它用自己的话写下来 → 这才进库
  let state = fresh()
  state = fold(state, {
    type: 'user/message',
    seq: 1,
    time: 100,
    data: { text: '顺手把构建脚本挪到 scripts/build.mjs 里了' },
  })
  assert.equal(state.memory.short.length, 0, '用户的原话不落库')
  assert.equal(state.progress.summaryReason, 'signal', '只点信号，提醒它自己写一条')

  state = fold(state, note({ workingJudgment: '把结论放最前面。', remember: '构建脚本在 scripts/build.mjs', rememberKind: 'fact' }, 2, 150))
  assert.equal(state.memory.short.length, 1, '短期里只有它自己写的那条')
  assert.equal(state.memory.short[0].origin, 'self', '来源要标成"它自己记的"')
  assert.equal(state.memory.short[0].text, '构建脚本在 scripts/build.mjs', '存的是它的话，不是用户原句')

  // ② 用户明确要求记住的也一样：得它自己说一遍才进库（原话永远不进）
  state = fresh()
  state = fold(state, {
    type: 'user/message',
    seq: 1,
    time: 100,
    data: { text: '记住：提交前一定要跑全量测试' },
  })
  state = fold(state, note({ remember: '提交前跑全量测试（用户明确的约定）', rememberKind: 'agreement' }, 2, 150))
  state = fold(state, { type: 'turn/end', seq: 3, time: 200, data: { turn: 1, reason: 'completed' } })
  // 这条约定重要度高（0.85），收束时会被**搬进**跨会话库，所以不指定"它在哪一层"，
  // 只断言"整个记忆里只有它写的那一条，而且不是用户原句"。
  const kept = [...state.memory.short, ...state.memory.global]
  assert.equal(kept.length, 1, '只有它自己写的那一条（原话一个字都不进库）')
  assert.ok(kept.every((e) => e.origin === 'self'), '全部是它自己写的——没有"听来的原话"这一档')
  assert.ok(kept.some((e) => e.kind === 'agreement'), '它把这条约定写下来了')
  assert.ok(!kept.some((e) => e.text.includes('记住：')), '用户原句没被搬进记忆')
})
