/**
 * 记忆管线的完整性回归（v2.2）。
 *
 * 这一轮修的**不是某个阈值好不好看，而是"东西有没有被静默丢掉"**。四条都是真实发生过的：
 *
 *   1. **规范化吃掉字段**：规范化出口漏掉一个字段，那个字段就静默失效（v2.2 漏的是 `pending`——
 *      用户原话的"候选池"，于是"从用户原话里自动摘句"整条路径是死的，而且一声不响；
 *      v2.3 把这条路径整个删了，现在盯的是 `digested` 与进度里那几档来路）。
 *   2. **参数形态**：`inner_note` 的参数只要是对象（不是 JSON 字符串），思想与记忆一起静默
 *      失效（`parseNote` / `parseRemember` 只认字符串）。
 *   3. **收尾兜底拿错材料**：`finalize` 把"手边这一池"（按工作区从磁盘载入的、别的会话留下的
 *      陈年条目）当成本段材料，于是日记里出现几个月前的旧账，还带着 `[seq 433]` 这种机器坐标、
 *      被标成 `self`（它自己说的）。
 *   4. **淘汰尺子**：短期池按 `importance + hits*0.1` 排，`hits` 无上限，旧条目攒够了就再也
 *      挤不掉——看起来在长，实际从某一刻起长不进去了。
 *
 * 所以这里测的都是**契约**：字段不许丢、来源不许假、材料不许串、新写的必须挤得进去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TUNABLES as T,
  applyEvent,
  capFor,
  clipText,
  emptyMemory,
  finalize,
  normalizeState,
  rememberShort,
} from '../lib/index.js'

const HERE = 'E:/code/thought'
const DAY = 86_400_000

const fold = (state, event, tunables = T, sessionId = 's-1') =>
  applyEvent(state, event, { tunables, sessionId })
/** 适配层对每个"没见过的状态引用"都会做的事（`projection.ts` 的 `ensureNormalized`）。 */
const norm = (state, now) => normalizeState(state, T, now)
const said = (text, seq, time) => ({ type: 'user/message', seq, time, data: { text } })
const turnEnd = (turn, seq, time) => ({ type: 'turn/end', seq, time, data: { turn, reason: 'completed' } })

// ── ① 规范化不许有损 ────────────────────────────────────

test('规范化不许有损：已消化名单与进度来路必须穿过 normalizeState', () => {
  const raw = {
    workspace: HERE,
    memory: {
      short: [],
      session: [],
      global: [],
      digested: ['m-aaa', 'm-bbb'],
      pendingSignals: 3,
      forgotten: [],
      updatedAt: 5,
    },
    progress: { summaryDue: true, summaryReason: 'signal' },
  }
  const state = norm(raw, 10)

  assert.deepEqual(state.memory.digested, ['m-aaa', 'm-bbb'], '已消化名单必须活下来')
  assert.equal(state.memory.pending, undefined, 'v2.3 起没有 pending 这一档（用户的原话不入库）')
  assert.equal(state.progress.summaryReason, 'signal', '第四档来路（signal）要接得住')

  // 幂等：它每个事件都会被调一次，来回漂一点点是灾难
  const again = norm(state, 20)
  assert.deepEqual(again.memory.digested, state.memory.digested)
  assert.equal(again.progress.summaryReason, 'signal')
})

test('用户的话只点亮信号、一个字都不落库；信号要活过中间那些无关事件', () => {
  let state = norm({ workspace: HERE }, 0)
  state = norm(fold(state, said('记住：这个项目用 pnpm，不要用 npm', 1, 100)), 100)
  assert.equal(state.memory.short.length, 0, '原话不入库（v2.3：记忆一律由它自己整理）')
  assert.equal(state.progress.summaryDue, true, '但要点亮"该总结了"')
  assert.equal(state.progress.summaryReason, 'signal', '来路是"刚说的话里有值得记的"')

  // 中间隔几个无关事件——旧版本就是在这里把候选连信号一起悄悄清空的
  state = norm(fold(state, { type: 'step/end', seq: 2, time: 120, data: {} }), 120)
  assert.equal(state.progress.summaryDue, true, '一个无关事件不许吃掉信号')
  state = norm(fold(state, { type: 'assistant/message', seq: 3, time: 130, data: { text: '好' } }), 130)
  assert.equal(state.progress.summaryDue, true, '规范化来回跑也不许吃掉信号')

  state = norm(fold(state, turnEnd(1, 4, 150)), 150)
  assert.equal(state.memory.short.length, 0, '收束也不会凭空长出记忆——得它自己写一条')
})

// ── ② 参数形态不许决定生死 ──────────────────────────────

test('inner_note 的参数是对象也照样记（对象形态下思想与记忆一起静默失效过）', () => {
  let state = norm({ workspace: HERE }, 0)
  state = fold(state, {
    type: 'tool/call',
    seq: 10,
    time: 100,
    data: {
      name: 'inner_note',
      // 真实宿主给的是 JSON 字符串，但别的调用方/未来的适配层给对象也合情合理：
      // 解析层该宽容，而不是把它当成"空参数"静默丢掉。
      arguments: { intent: '把它记下来', workingJudgment: '以后先看进度文档', remember: '这个项目用 pnpm', rememberKind: 'fact' },
    },
  })

  assert.ok(state.memory.short.some((e) => e.text.includes('pnpm')), '记忆那条腿要落地')
  assert.equal(state.progress.notesThisTurn, 1, '思想那条腿也要落地')
})

test('参数不是合法 JSON 要说一声，而不是静默什么都不做', () => {
  const notes = []
  let state = norm({ workspace: HERE }, 0)
  state = applyEvent(
    state,
    { type: 'tool/call', seq: 10, time: 100, data: { name: 'inner_note', arguments: '{"remember": ' } },
    { tunables: T, sessionId: 's-1', note: (m) => notes.push(m) },
  )

  assert.ok(notes.some((m) => m.includes('不是合法 JSON')), '要如实说"这一次没生效"')
  assert.equal(state.memory.short.length, 0, '解析不出来就不写——但不许一声不响')
})

// ── ③ 收尾兜底只许用这一段自己的材料 ────────────────────

test('收尾兜底不拿别的会话的旧条目替这一段代笔（digested 名单）', () => {
  const oldAt = 1000
  let seeded = emptyMemory(oldAt)
  seeded = rememberShort(
    seeded,
    { kind: 'lesson', text: '上一个会话留下的旧账：包结构那事还没定', importance: 1, at: oldAt, ws: HERE, seq: 433 },
    T,
  )
  const oldId = seeded.short[0].id

  // 适配层载入短期池时就该把这批标成"已消化"（`index.ts` 的 `adoptPersist`）
  let state = norm({ workspace: HERE, memory: { ...seeded, digested: [oldId] } }, 0)
  // 这一段它自己写了一条（v2.3：用户的原话不入库，材料只能是它写下的）
  state = fold(state, {
    type: 'tool/call',
    seq: 1,
    time: oldAt + 1000,
    data: {
      name: 'inner_note',
      arguments: JSON.stringify({ remember: '提交前跑全量测试', rememberKind: 'agreement' }),
    },
  })

  const done = finalize(state, oldAt + 1200, { tunables: T, sessionId: 's-1' }, 2)
  const text = done.memory.session.map((e) => e.text).join('\n')
  assert.ok(!text.includes('旧账'), '别的会话的旧条目不许进这一段的日记')
  assert.ok(text.includes('全量测试'), '这一段自己的材料要进日记')
  assert.ok(
    done.memory.session.every((e) => e.origin === 'digest'),
    '规则拼的日记来源如实标 digest（不许冒充它自己写的）',
  )
})

// ── ④ 文本长度与淘汰 ────────────────────────────────────

test('长材料在子句边界截断，不切在半句上；尺子按来源分档', () => {
  const long = '第一句话说到这里就该停了，第二句话再补一点内容'.repeat(6)
  const clipped = clipText(long, 20)
  assert.equal(clipped, '第一句话说到这里就该停了，…', '退到最近的子句边界，并留一个省略号')
  assert.ok(clipText('短句子。', 20) === '短句子。', '放得下就一个字都不动')

  assert.equal(capFor('self', T), T.memorySelfMaxChars, '它自己写的那一句给得更宽')
  assert.equal(capFor('digest', T), T.digestMaxChars, '兜底拼的一段最宽')
  assert.equal(capFor(undefined, T), T.memoryMaxChars, '听来的原句还是紧的')
  assert.ok(T.memorySelfMaxChars > T.memoryMaxChars && T.digestMaxChars > T.memorySelfMaxChars)
})

test('短期池满了先保这一段新长出来的，不让攒了几个月 hits 的旧条目把它挤掉', () => {
  const now = 10 * DAY
  // 十二条**互不相同**的陈年旧账（说得太像的话会被当成重复，只加固不新增）
  const old = [
    '构建脚本放在 dsh-mind/scripts 目录下面',
    '两个包：内核是 mind-core，适配层是 dsh-mind',
    '心念入口在左侧栏上方那一格，点开是中间页',
    '情绪饱和按强度乘以剩余额度收敛',
    '存储只读快照文件的最后一行',
    '设置页十六个字段分成四组展示',
    '内核注入用 order 132，实况用 133',
    '短期记忆每轮全量注入上下文',
    '跨会话库不注入，只能主动去查',
    '总结有三个触发点：步数、压缩、会话结束',
    '面板措辞只有内核一处真相',
    '插件日志要落 mind.log 才看得见',
  ]
  let memory = emptyMemory(now)
  for (const text of old.slice(0, T.memoryShortMax)) {
    memory = rememberShort(memory, { kind: 'lesson', text, importance: 0.65, at: now - 10 * DAY, ws: HERE }, T)
  }
  assert.equal(memory.short.length, T.memoryShortMax, '先把池子填满')

  memory = rememberShort(
    memory,
    { kind: 'agreement', text: '这一段刚定下的：提交前跑全量测试', importance: 0.85, at: now, ws: HERE, origin: 'self' },
    T,
  )
  assert.equal(memory.short.length, T.memoryShortMax, '池子有上限，超了就淘汰')
  assert.ok(memory.short.some((e) => e.text.includes('全量测试')), '这一段自己写下的必须留下')
})
