/**
 * 遗忘与查看的测试（v1.1 的另一半：能记，也要能看、能忘）。
 *
 * 这一半存在的理由，是记忆最招人烦的地方：**它凭什么记着这个**。
 * 所以每个机制都要能自证：
 * - 「凭什么记着」——`describeEntry` 把类型 / 重要度 / 取回次数 / 时间 / 缘由都写出来；
 * - 「怎么划掉」——`forgetEntries` 短期长期一起删，并留下**遗忘名单**（不然下次落盘会长回来）；
 * - 「划错了怎么办」——指认不明就什么都不删，宁可没删掉，不可删错。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TUNABLES,
  agoText,
  applyEvent,
  describeEntry,
  describeMemory,
  emptyMemory,
  emptyState,
  findEntries,
  forgetEntries,
  normalizeMemory,
  rememberLong,
  rememberShort,
  solidify,
} from '../lib/index.js'

const T = DEFAULT_TUNABLES
const fold = (state, event) => applyEvent(state, event, { tunables: T })
const toolCall = (name, args, time) => ({
  type: 'tool/call',
  seq: 1,
  time,
  data: { name, arguments: JSON.stringify(args) },
})

test('人话的时间差：从「刚刚」到「年前」', () => {
  assert.equal(agoText(0), '刚刚')
  assert.equal(agoText(5 * 60_000), '5 分钟前')
  assert.equal(agoText(3 * 3_600_000), '3 小时前')
  assert.equal(agoText(2 * 86_400_000), '2 天前')
  assert.equal(agoText(70 * 86_400_000), '2 个月前')
  assert.equal(agoText(400 * 86_400_000), '1 年前')
  // 时钟回拨也不该说出"负 3 分钟前"这种话
  assert.equal(agoText(-5000), '刚刚')
})

test('describeEntry 要能回答「凭什么记着它」', () => {
  const memory = rememberLong(
    emptyMemory(0),
    { kind: 'agreement', text: '这个项目用 pnpm', importance: 0.85, because: '用户明确要求记住的做法', at: 1000 },
    T,
  )
  const entry = memory.global[0]
  const line = describeEntry(entry, 1, 1000 + 3_600_000)
  assert.match(line, /^1\. \[约定\] 这个项目用 pnpm/)
  assert.match(line, /重要度 0\.85/)
  // 给人看的说法："被翻到"而不是内部动词"取回"
  assert.match(line, /还没被翻到过/)
  assert.match(line, /记于 1 小时前/)
  assert.match(line, /因为：用户明确要求记住的做法/)
})

test('findEntries：不带词列全部，带词按重合度排，对不上就是空', () => {
  let memory = emptyMemory(0)
  memory = rememberLong(
    memory,
    { kind: 'agreement', text: '这个项目用 pnpm，不要用 npm', importance: 0.85, at: 1000 },
    T,
  )
  memory = rememberLong(memory, { kind: 'preference', text: '注释一律用中文', importance: 0.7, at: 2000 }, T)

  const all = findEntries(memory, '', 20)
  assert.equal(all.length, 2, '不带词时把库里有的都列出来（人只是想看看里面有什么）')
  assert.match(all[0].entry.text, /pnpm/, '不带词时按重要度倒序')

  // 换个说法也要能对上，靠的是字面重合（README 里写明的限制）；
  // 而只共享一个常用字**不算命中**——那正是"硬凑"。
  const hit = findEntries(memory, '这个项目用什么装依赖', 5)
  assert.ok(hit.length >= 1, '共享「这个项目 / 用」这样的词就该能对上')
  assert.match(hit[0].entry.text, /pnpm/, '最像的那条排第一')

  assert.ok(findEntries(memory, 'pnpm', 5).length >= 1, '直接写关键词是最可靠的用法')

  assert.equal(findEntries(memory, '今天天气不错', 5).length, 0, '只对一个「不」字不算命中，对不上就该是空')
})

test('forgetEntries：三层一起删，并留下遗忘名单', () => {
  let memory = emptyMemory(0)
  memory = rememberShort(memory, { kind: 'agreement', text: '这个项目用 pnpm', importance: 0.85, at: 1000 }, T)
  // 固化才是"同一条进入全局库"的正路：`rememberLong` 会把已有的近重复条目当重复而跳过（这是对的，
  // 不然短期里记过一句、全局库里又存一遍，检索时就会看到两条一模一样的东西）。
  memory = solidify(memory, 1000, T)
  // v2.4.y：升格是**搬走**，不是复制——手边不再留同一份，库里只有一条。
  assert.equal(memory.short.length, 0, '搬走之后手边没了（不再有同一条的两个副本）')
  assert.equal(memory.global.length, 1, '重要度 0.85 ≥ 0.75，够固化条件')

  // 再放一条**不够格固化**的手边条目，这样"三层一起删"才真的有两层可删
  memory = rememberShort(memory, { kind: 'fact', text: '手边只留这一条', importance: 0.5, at: 1500 }, T)
  assert.equal(memory.short.length, 1)

  const shortId = memory.short[0].id
  const globalId = memory.global[0].id
  const after = forgetEntries(memory, [shortId, globalId], 2000)
  assert.equal(after.short.length, 0)
  assert.equal(after.global.length, 0, '全局库里那条也要删（按它自己的 id）')
  assert.deepEqual(after.forgotten, [shortId, globalId], '名单必须记下来，否则下次落盘它会长回来')
  assert.match(describeMemory(after).join('\n'), /已遗忘：2 条/, '划掉过几条也要如实说')

  assert.equal(forgetEntries(memory, [], 3000), memory, '没给 id 就原样返回（引用不变）')

  // 已经不在库里的 id：列表不动，但名单仍然记它——这是"别的会话接管档案时不许长回来"的保证
  const ghost = forgetEntries(memory, ['m不存在'], 3000)
  assert.equal(ghost.short.length, memory.short.length)
  assert.equal(ghost.global.length, memory.global.length)
  assert.deepEqual(ghost.forgotten, ['m不存在'])
})

test('遗忘名单要能穿过规范化（跨会话落盘再读回来还在）', () => {
  // 这里喂的是**老档案**形状（只有 `long`、没有 `global`/`session`），顺便测回落
  const normalized = normalizeMemory({ short: [], long: [], pendingSignals: 0, forgotten: ['m1', 42, null, 'm2'], updatedAt: 5 }, 0)
  assert.deepEqual(normalized.forgotten, ['m1', 'm2'], '非字符串的丢掉，字符串留下')

  const old = normalizeMemory({ short: [], long: [], pendingSignals: 0, updatedAt: 0 }, 0)
  assert.deepEqual(old.forgotten, [], '老档案没有这个字段 → 空名单，绝不能是 undefined')
  assert.deepEqual(old.session, [], 'v2.0 的三层必须在（老档案没有会话日记）')
  assert.deepEqual(old.global, [])
})

test('模型调 forget_memory：折叠时删掉，且同一份日志重放得到同一结果', () => {
  // 记忆只能由它自己写（v2.3：用户的原话一概不入库），所以日志里是它自己的一次 inner_note。
  const events = [toolCall('inner_note', { remember: '这个项目用 pnpm', rememberKind: 'agreement' }, 1000)]
  let state = emptyState(T, 0)
  for (const event of events) state = fold(state, event)
  // 没有工作区的会话：条目落在**本会话日记**那一层（v2.0 的 resolveScope），
  // 所以"库里有几条"得把三层都数上，不能只看 short。
  const count = (m) => m.short.length + m.session.length + m.global.length
  const entriesOf = (m) => [...m.short, ...m.session, ...m.global]
  assert.equal(count(state.memory), 1, '它自己写了一条')

  const id = entriesOf(state.memory)[0].id
  const withForget = [...events, toolCall('forget_memory', { id }, 2000)]
  let replayed = emptyState(T, 0)
  for (const event of withForget) replayed = fold(replayed, event)

  assert.equal(count(replayed.memory), 0, '折叠时把它删了')
  assert.deepEqual(replayed.memory.forgotten, [id])

  // 用原文片段也能指认（重叠 1.0 ≥ 0.3）
  let byText = emptyState(T, 0)
  for (const event of events) byText = fold(byText, event)
  byText = fold(byText, toolCall('forget_memory', { text: '这个项目用 pnpm' }, 2000))
  assert.equal(count(byText.memory), 0, '给原文片段也要删得掉')
})

test('forget_memory 指认不明时什么都不删（遗忘不可逆，宁可不动）', () => {
  let state = emptyState(T, 0)
  state = fold(state, toolCall('inner_note', { remember: '这个项目用 pnpm', rememberKind: 'agreement' }, 1000))
  // v2.0 起了三层，所以"库里有几条"要把三层都数上
  const count = (m) => m.short.length + m.session.length + m.global.length
  const entriesOf = (m) => [...m.short, ...m.session, ...m.global]
  const before = count(state.memory)

  const noMatch = fold(state, toolCall('forget_memory', { text: '完全不相干的一句话' }, 2000))
  assert.equal(count(noMatch.memory), before, '对不上就什么都不删')
  const noArgs = fold(state, toolCall('forget_memory', {}, 2000))
  assert.equal(count(noArgs.memory), before, '一个指认都没给也不删')
  assert.equal(entriesOf(noMatch.memory)[0].id, entriesOf(state.memory)[0].id, '原来那条还在')
})
