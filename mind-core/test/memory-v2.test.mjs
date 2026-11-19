/**
 * 记忆 v2.0 的机制测试（DESIGN §22 / REQUIREMENTS §9）。
 *
 * 这一版把"记忆"拆成三种，**更新语义各不相同**，所以分开测：
 *
 *   1. 短期 `short`：**全量**——重新算、整份覆盖；
 *   2. 会话 `session`：**增量追加**——只 push，旧条目一个字都不许改；
 *   3. 全局 `global`：**全量整理成一份**——也是整份覆盖。
 *
 * 外加三个"该总结了"的触发点（按步到点 / 上下文压缩 / 会话结束）与 `recall` 的三个 scope。
 * 数值好看不在契约里，这里测的是"哪一层被谁改了"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TUNABLES as T,
  appendSession,
  applyEvent,
  consumeSummary,
  emptyMemory,
  emptyStats,
  finalize,
  makeEntry,
  normalizeState,
  organizeGlobal,
  recall,
  rememberShort,
  rewriteShort,
  toPersist,
  withDefaults,
} from '../lib/index.js'

const HERE = 'E:/code/thought'
const OTHER = 'E:/code/others'

const fold = (state, event, tunables = T, sessionId = 's-1') =>
  applyEvent(state, event, { tunables, sessionId })
const fresh = (tunables = T) => normalizeState({ workspace: HERE }, tunables, 0)
const stepEnd = (seq, time) => ({ type: 'step/end', seq, time, data: {} })
const turnStart = (turn, seq, time) => ({ type: 'turn/start', seq, time, data: { turn } })
const turnEnd = (turn, seq, time) => ({ type: 'turn/end', seq, time, data: { turn, reason: 'completed' } })
const said = (text, seq, time) => ({ type: 'user/message', seq, time, data: { text } })

// ── 三种记忆的更新语义 ──────────────────────────────────

test('会话记忆是增量追加：新的一段进去，旧条目一个字都不改', () => {
  let memory = emptyMemory(0)
  memory = appendSession(memory, { kind: 'fact', text: '这一段在改记忆三层', importance: 0.5, at: 10 }, T)
  const first = { ...memory.session[0] }
  assert.equal(memory.session.length, 1)

  memory = appendSession(memory, { kind: 'agreement', text: '定下了：日记只增不改', importance: 0.8, at: 20 }, T)
  assert.equal(memory.session.length, 2, '只 push，不合并、不重排')
  assert.deepEqual(memory.session[0], first, '旧条目必须一字不改（这是"只增不改"的字面意思）')

  // 再来一条差不多的话：当作重复**直接原样返回**，连 hits 都不加固——
  // 加固也是一种改写，而日记不允许被改写。
  const again = appendSession(memory, { kind: 'agreement', text: '定下了，日记只增不改', importance: 0.8, at: 30 }, T)
  assert.equal(again, memory, '近重复连新对象都不该产生')
  assert.deepEqual(again.session[0], first)
})

test('短期是全量层：整份重算，不在新名单里的就没了', () => {
  let memory = emptyMemory(0)
  memory = rememberShort(memory, { kind: 'fact', text: '临时记一下构建脚本的位置', at: 10 }, T)
  assert.equal(memory.short.length, 1)

  memory = rewriteShort(
    memory,
    [
      { kind: 'agreement', text: '提交前一定要跑全量测试', importance: 0.85, at: 20 },
      { kind: 'fact', text: '仓库是 pnpm workspace 双包', importance: 0.5, at: 20 },
    ],
    20,
    T,
  )
  assert.equal(memory.short.length, 2, '短期的内容就是"这一轮算出来的那几条"')
  assert.ok(!memory.short.some((e) => e.text.includes('临时记一下')), '不在新名单里的必须消失（全量 = 覆盖）')
  assert.ok(memory.short[0].importance >= memory.short[1].importance, '按重要度排好序')
})

test('全局是全量层：organizeGlobal 是"整理成一份"，不是往里塞', () => {
  let memory = emptyMemory(0)
  memory = organizeGlobal(
    memory,
    [{ kind: 'fact', text: '旧的一条：构建脚本在 scripts 目录', at: 10 }],
    10,
    T,
  )
  assert.equal(memory.global.length, 1)

  memory = organizeGlobal(memory, [{ kind: 'preference', text: '回复先给结论', importance: 0.7, at: 20 }], 20, T)
  assert.equal(memory.global.length, 1, '整份覆盖：上一轮整理出来的那份不留着')
  assert.equal(memory.global[0].text, '回复先给结论')
})

test('写短期不会碰会话日记（日记里的东西不算"记过了"）', () => {
  let memory = emptyMemory(0)
  memory = appendSession(memory, { kind: 'fact', text: '构建脚本在 scripts/build.mjs', importance: 0.5, at: 10 }, T)
  const diary = { ...memory.session[0] }

  memory = rememberShort(memory, { kind: 'fact', text: '构建脚本放在 scripts/build.mjs 里', at: 20 }, T)
  assert.equal(memory.short.length, 1, '短期照常收下')
  assert.equal(memory.session.length, 1)
  assert.deepEqual(memory.session[0], diary, '日记不许被短期那边的写入改写或加固')
})

// ── 触发点①：按步到点 ──────────────────────────────────

test('触发点①：按步到点（计数单位是步不是轮），到点归零并置信号', () => {
  const t = withDefaults({ memorySummarySteps: 3 })
  let state = fresh(t)

  state = fold(state, stepEnd(1, 100), t)
  state = fold(state, stepEnd(2, 200), t)
  assert.equal(state.progress.steps, 2, '走两步数两步')
  assert.equal(state.progress.summaryDue, false, '没到点不许喊总结')

  state = fold(state, stepEnd(3, 300), t)
  assert.equal(state.progress.steps, 0, '到点就归零——不归零的话之后每一步都会再喊一次')
  assert.equal(state.progress.summaryDue, true)
  assert.equal(state.progress.summaryReason, 'steps')

  // 一轮里走多少步都算数：`turn/end` 不动步计数
  let one = fold(fresh(t), stepEnd(1, 100), t)
  one = fold(one, turnEnd(1, 2, 150), t)
  assert.equal(one.progress.steps, 1, '回合收束不重置步计数（单位是步，回合只管回合）')

  // 新一轮对话重新数（REQUIREMENTS §9：计数不跨对话）
  one = fold(one, turnStart(2, 3, 200), t)
  assert.equal(one.progress.steps, 0, 'turn/start 才是归零点')
})

test('触发点①的信号是"先置的来路说了算"，而且消费掉之后才安静', () => {
  const t = withDefaults({ memorySummarySteps: 1 })
  let state = fold(fresh(t), stepEnd(1, 100), t)
  assert.equal(state.progress.summaryDue, true)
  assert.equal(state.progress.summaryReason, 'steps')

  // 再来一步：信号还亮着，来路不被顶掉（先置的那个才是原因）
  state = fold(state, stepEnd(2, 200), t)
  assert.equal(state.progress.summaryReason, 'steps')

  const quiet = consumeSummary(state, 300)
  assert.equal(quiet.progress.summaryDue, false)
  assert.equal(quiet.progress.summaryReason, null)
  assert.equal(quiet.progress.steps, 0, '消费只清信号，不动计数')
  assert.equal(consumeSummary(quiet, 400), quiet, '本来就安静：原样返回同一引用')
})

// ── 触发点②：上下文压缩之后 ─────────────────────────────

test('触发点②：压缩（surfaceOp.op = replace）→ 置信号并把步数归零', () => {
  let state = fresh()
  for (let i = 1; i <= 5; i += 1) state = fold(state, stepEnd(i, i * 100))
  assert.equal(state.progress.steps, 5)

  const compacted = fold(state, {
    type: 'request/context',
    seq: 9,
    time: 900,
    data: {},
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 8 },
  })
  assert.equal(compacted.progress.steps, 0, '旧账追不回来了，从 0 重数')
  assert.equal(compacted.progress.summaryDue, true)
  assert.equal(compacted.progress.summaryReason, 'compaction')

  // 追加式表面操作与不带 surfaceOp 的事件都原样返回（高频路径，别多造对象）
  const appended = fold(state, { type: 'request/context', seq: 10, time: 1000, data: {}, surfaceOp: 'append' })
  assert.equal(appended, state, "surfaceOp: 'append' 不该改任何东西")
  assert.equal(fold(state, { type: 'request/header', seq: 11, time: 1100, data: {} }), state)
})

test('触发点②：压缩不该顶掉已经亮着的来路', () => {
  const t = withDefaults({ memorySummarySteps: 2 })
  let state = fresh(t)
  state = fold(state, stepEnd(1, 100), t)
  state = fold(state, stepEnd(2, 200), t)
  assert.equal(state.progress.summaryReason, 'steps')

  state = fold(state, { type: 'request/context', seq: 3, time: 300, data: {}, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } })
  assert.equal(state.progress.summaryReason, 'steps', '先置的来路保留：是"按步到点"先喊的')
  assert.equal(state.progress.steps, 0, '但步数照样归零')
})

// ── 触发点③：会话结束（只允许规则兜底） ──────────────────

test('触发点③：会话结束按规则兜底拼一段日记，只用这一段自己的材料', () => {
  // v2.3：材料只能来自**它自己写下的**条目（用户的原话一概不入库），所以先让它写一条。
  const note = (args, seq, time) => ({
    type: 'tool/call',
    seq,
    time,
    data: { name: 'inner_note', arguments: JSON.stringify(args) },
  })
  let state = fresh()
  state = fold(state, note({ remember: '这个项目用 pnpm，不要用 npm', rememberKind: 'agreement' }, 1, 100))

  const notes = []
  const done = finalize(state, 200, { tunables: T, sessionId: 's-1', note: (m) => notes.push(m) }, 2)

  assert.equal(done.memory.session.length >= 1, true, '有材料就该写出日记')
  const text = done.memory.session.map((e) => e.text).join('\n')
  assert.match(text, /定下了什么/, '约定归到"定下了什么"那一桶')
  // v2.2：`[seq N]` 是机器坐标，**不进正文**——出处保留在条目的 seq 字段上
  assert.doesNotMatch(text, /\[seq/, '正文里不许出现机器坐标（那读起来像调试输出，不像日记）')
  assert.ok(
    done.memory.session.every((e) => e.scope === 'session' && e.sessionId === 's-1'),
    '写进去的是本会话日记',
  )
  // v2.2：来源如实——这是规则拼的，不是它自己说的（早先标成 self，用户一眼就看出不对）
  assert.ok(
    done.memory.session.every((e) => e.origin === 'digest' && e.because !== ''),
    '兜底拼的日记来源必须是 digest，并带上人话的来由',
  )
  assert.ok(
    done.memory.session.every((e) => typeof e.seq === 'number'),
    '出处仍然保留在结构化字段上（随时能回到日志）',
  )
  assert.equal(done.progress.summaryDue, true, '这个点也要置"该总结了"')
  assert.equal(done.progress.summaryReason, 'final')
  assert.equal(done.memory.pending, undefined, 'v2.3 起没有 pending 这一档了（用户的原话不入库）')
  assert.ok(
    done.memory.digested.length >= done.memory.session.length,
    '拼过的材料 id 要记进 digested（下一次兜底不许拿它再拼一遍）',
  )

  // 再说一件事：旧日记一个字都不改，而且只有"新长出来的材料"才配写新日记
  const before = { ...done.memory.session[0] }
  const sessionCount = done.memory.session.length
  let more = fold(done, note({ remember: '提交前一定要跑全量测试', rememberKind: 'agreement' }, 3, 300))
  const twice = finalize(more, 400, { tunables: T, sessionId: 's-1' }, 4)
  assert.ok(twice.memory.session.length > sessionCount, '新长出来的材料才配写新日记')
  assert.deepEqual(twice.memory.session[0], before, '补总结也得只增不改')

  // 没有材料就什么都不写，只如实说一声（适配层据此写 summary.md）
  const empty = finalize(fresh(), 500, { tunables: T, sessionId: 's-1', note: (m) => notes.push(m) }, 5)
  assert.equal(empty.memory.session.length, 0, '一条材料都没有 → 不写空话')
  assert.equal(empty.progress.summaryReason, 'final')
  assert.ok(notes.some((m) => m.includes('没有值得留下的')), '要如实说"这一段没有值得留下的"')
})

test('规则兜底复用时，来路不被改写成 final', () => {
  const t = withDefaults({ memorySummarySteps: 1 })
  let state = fold(fresh(t), stepEnd(1, 100), t)
  assert.equal(state.progress.summaryReason, 'steps')

  // 到点了，模型没写 → 适配层调 finalize 兜底。来路必须还是 'steps'。
  const done = finalize(state, 200, { tunables: t, sessionId: 's-1' }, 1)
  assert.equal(done.progress.summaryReason, 'steps')
  assert.equal(done.progress.summaryDue, true)
})

// ── recall 的三个 scope ─────────────────────────────────

/** 一个库：本会话日记一条、全局库里两条（一条属于本工作区、一条属于别的工作区）。 */
function stocked() {
  let memory = emptyMemory(0)
  memory = appendSession(
    memory,
    // `ws: null` = "当时不知道在哪个工作区"，这正是会话日记那一档（DESIGN §22.8）
    { kind: 'fact', text: '这次会话里定的：密码策略每周换一次', importance: 0.6, at: 1, ws: null, sessionId: 's-1', seq: 3 },
    T,
  )
  memory = organizeGlobal(
    memory,
    [
      { kind: 'fact', text: '构建脚本放在 scripts/build.mjs', importance: 0.6, at: 1, ws: HERE },
      { kind: 'fact', text: '隔壁项目用 vite 打包前端', importance: 0.6, at: 1, ws: OTHER },
    ],
    1,
    T,
  )
  return memory
}

test('recall scope=this（默认）：本会话日记 + 全局库，别的工作区只降权不消失', () => {
  const memory = stocked()

  const diary = recall(memory, '密码策略每周换一次', 1000, T, HERE)
  assert.equal(diary.length, 1)
  assert.equal(diary[0].layer, 'session', '命中要能说出"来自哪一层"')
  assert.equal(diary[0].entry.sessionId, 's-1', '来自哪个会话也要带出来')

  const here = recall(memory, '构建脚本放在哪里', 1000, T, HERE)
  assert.equal(here.length, 1)
  assert.equal(here[0].layer, 'global')
  assert.ok(!here[0].foreign, '本工作区的不算外来')

  const other = recall(memory, '隔壁项目用 vite 打包', 1000, T, HERE)
  assert.equal(other.length, 1, '别的工作区的也查得到（不静默丢掉）')
  assert.equal(other[0].foreign, true, '但要标出来源、并且降权')

  // 不知道自己在哪个工作区时（空串），不做归属降权——宁可当全局，也不误伤
  const nowhere = recall(memory, '隔壁项目用 vite 打包', 1000, T, '')
  assert.ok(!nowhere[0].foreign)
})

test('recall scope=global：只在全局库里找，本会话日记不参与', () => {
  const memory = stocked()

  assert.equal(recall(memory, '密码策略每周换一次', 1000, T, HERE, 'global').length, 0, '日记不是全局库的东西')
  assert.equal(recall(memory, '构建脚本放在哪里', 1000, T, HERE, 'global').length, 1)
})

test('recall scope=all：别的会话的日记要主动传进来才看得到，并标成外来', () => {
  const memory = stocked()
  const elsewhere = makeEntry({
    kind: 'fact',
    text: '另一个会话里定的：周三之前不动线上库',
    importance: 0.6,
    at: 1,
    maxChars: 160,
    ws: null,
    sessionId: 's-2',
    scope: 'session',
  })

  assert.equal(
    recall(memory, '周三之前不动线上库', 1000, T, HERE, 'this', [elsewhere]).length,
    0,
    '默认 scope=this 不串味：别的会话的日记不该自己冒出来',
  )

  const all = recall(memory, '周三之前不动线上库', 1000, T, HERE, 'all', [elsewhere])
  assert.equal(all.length, 1)
  assert.equal(all[0].layer, 'session')
  assert.equal(all[0].entry.sessionId, 's-2')
  assert.equal(all[0].foreign, true, '跨会话命中必须标出来源')
})

// ── 规范化对老档案的回落 ────────────────────────────────

test('normalizeState：老档案（只有 long）回落到三层，缺的字段不编', () => {
  const old = normalizeState(
    {
      memory: {
        short: [{ kind: 'fact', text: '短期里的一条', importance: 0.5, hits: 0, createdAt: 1, lastAt: 1 }],
        long: [
          { kind: 'fact', text: '老条目一', importance: 0.6, hits: 2, createdAt: 1, lastAt: 5, seq: 12 },
          { kind: 'preference', text: '老条目二', importance: 0.7, hits: 0, createdAt: 1, lastAt: 1, ws: '' },
        ],
        pendingSignals: 0,
        forgotten: [],
        updatedAt: 5,
      },
    },
    T,
    9,
  )

  assert.deepEqual(old.memory.global.map((e) => e.text), ['老条目一', '老条目二'], '老 long 顶进 global')
  assert.deepEqual(old.memory.session, [], '老档案没有会话日记')
  assert.equal(old.memory.global[0].seq, 12, 'seq 要接住（回放日志要用）')
  assert.equal(old.memory.global[0].scope, 'global', '缺省的老条目不替它编归属')
  assert.equal(old.memory.global[1].scope, 'global', 'ws:"" 也是全局')
  assert.equal(old.memory.short[0].scope, 'global')

  // 两层都给时以 global 为准（免得同一条读两遍）
  const both = normalizeState({ memory: { long: [{ kind: 'fact', text: '旧的', at: 1 }], global: [{ kind: 'fact', text: '新的', at: 1 }] } }, T, 9)
  assert.deepEqual(both.memory.global.map((e) => e.text), ['新的'])

  // 进度里的步计数：老档案完全没有这几个字段
  const progress = normalizeState({ progress: { turn: 3 } }, T, 9).progress
  assert.equal(progress.steps, 0, '回落成"刚归零"')
  assert.equal(progress.summaryDue, false)
  assert.equal(progress.summaryReason, null)
  assert.equal(progress.turn, 3, '老字段照旧接住')

  // 落盘：`digested` 是"这一段已经消化过哪些条目"（这一段对话进行到哪了），不进档案
  let live = fresh()
  live = fold(live, said('记住：这个项目用 pnpm', 1, 100))
  assert.equal(live.memory.short.length, 0, 'v2.3：用户的原话不入库')
  assert.deepEqual(toPersist(live, emptyStats(), 0).memory.digested ?? [], [], '档案里不写 digested')
})
