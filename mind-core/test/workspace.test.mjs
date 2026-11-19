/**
 * 记忆归属的测试（**v2.0 起按层分开**）。
 *
 * v1.x 只有一个长期库，靠 `ws` 的四态（`''` / 具体工作区 / `null` / 缺省）去**猜**归属，
 * 猜不出第三种就都塞在一起。v2.0 起归属直接写进 `scope` 字段，存储也按层分开：
 *
 *   - 短期 `short`：手边那几条，**全量重算**（会注入；它不属于任何一层，是"候选池"）
 *   - 会话 `session`：这一次会话的日记，**增量追加、永不改写旧条目**
 *   - 全局 `global`：**全量整理成一份**，不注入，只能主动 `recall`
 *
 * `ws` 仍然留着——它回答的是"这事发生在哪个工作区"，不是"存在哪一层"。两件事分开之后，
 * 上一版那个"null 跟 '' 是不是同一档"的纠结就没有了：看 `scope` 就行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TUNABLES,
  applyEvent,
  memoryCounts,
  normalizePersist,
  normalizeState,
  rememberLong,
  toPersist,
} from '../lib/index.js'

const T = DEFAULT_TUNABLES
const HERE = 'E:/code/thought'
const OTHER = 'E:/code/others'

const fresh = () => normalizeState({}, T, 0)
const fold = (state, event) => applyEvent(state, event, { tunables: T })
const said = (text, seq = 1, time = 100) => ({ type: 'user/message', seq, time, data: { text } })
// 记忆在**回合收束**时才落库（听来的原句要让位给它自己写的那条），所以测试里要补上收束事件。
const turnEnd = (seq, time) => ({ type: 'turn/end', seq, time, data: { turn: 1, reason: 'completed' } })

test('分级写库：偏好不带工作区，约定/事实带当前工作区', () => {
  // v2.3：记忆只能由它自己写下来（用户的原话一概不入库），所以这里直接喂 inner_note。
  const note = (args, seq, time) => ({
    type: 'tool/call',
    seq,
    time,
    data: { name: 'inner_note', arguments: JSON.stringify(args) },
  })

  let state = { ...fresh(), workspace: HERE }
  state = fold(state, note({ remember: '回复先给结论，不要长篇铺垫', rememberKind: 'preference' }, 2, 150))

  const pref = state.memory.short.find((e) => e.kind === 'preference')
  assert.ok(pref, '偏好要被认出来并进短期')
  assert.equal(pref.ws, '', '关于"人"的偏好显式标成全局（空串），不是缺省——两者面板上是两档')
  assert.equal(pref.scope, 'global', 'v2.0：归属写进 scope，不再靠 ws 猜')

  state = fold(state, note({ remember: '这个项目用 pnpm，不要用 npm', rememberKind: 'agreement' }, 3, 200))
  const rule = state.memory.short.find((e) => e.kind === 'agreement')
  assert.ok(rule, '明确的规矩要被认出来')
  assert.equal(rule.ws, HERE, '关于"项目"的记忆带写入时的工作区键')
  assert.equal(rule.scope, 'workspace', '有工作区就是"这个项目的"，与"关于人"的全局不是同一档')
})

/** 造三条不同归属的记忆：会话日记 / 显式全局 / 某个工作区。 */
function layered() {
  let memory = fresh().memory
  memory = rememberLong(
    memory,
    { kind: 'agreement', text: '这个会话里先用 pnpm 试试依赖', importance: 0.8, ws: null, sessionId: 's-1', seq: 7, at: 0 },
    T,
  )
  memory = rememberLong(memory, { kind: 'preference', text: '我讨厌长篇铺垫，回复要先给结论', importance: 0.9, ws: '', at: 0 }, T)
  memory = rememberLong(memory, { kind: 'fact', text: '本项目的构建脚本放在 scripts 目录', importance: 0.7, ws: HERE, at: 0 }, T)
  return memory
}

test('按层路由：会话归属进日记，别的进全局库', () => {
  const memory = layered()

  assert.equal(memory.session.length, 1, 'ws=null（当时不知道在哪）的会话归属 → 日记那一层')
  assert.equal(memory.session[0].scope, 'session')
  assert.equal(memory.session[0].ws, null, 'null 是"当时不知道在哪"，要原样留着，不能被读成全局')
  assert.equal(memory.session[0].sessionId, 's-1', '日记要知道自己是谁的')

  assert.equal(memory.global.length, 2, '显式全局 / 某个工作区，都进全局库（一个库，两种归属）')
  assert.equal(memory.global.find((e) => e.kind === 'preference').scope, 'global')
  const fact = memory.global.find((e) => e.kind === 'fact')
  assert.equal(fact.scope, 'workspace')
  assert.equal(fact.ws, HERE, '空串与具体工作区在存储层是同一条路，靠 scope 区分')
})

test('计数按层分：日记不算"别处"，只有别的工作区才叫 other', () => {
  const memory = layered()

  // 在 HERE 里看：HERE 的 fact 算 here，偏好（关于人）算 global；日记不参与这里的计数。
  assert.deepEqual(memoryCounts(memory, HERE), { here: 1, global: 1, other: 0, unknown: 0 })
  // 在别处看（这里借 OTHER 的位置……用 '' 表达"没有工作区的会话"）：fact 成了 other。
  assert.deepEqual(memoryCounts(memory, ''), { here: 0, global: 1, other: 1, unknown: 0 })
  assert.deepEqual(memoryCounts(memory, OTHER), { here: 0, global: 1, other: 1, unknown: 0 })
})

test('落盘往返：归属（scope / ws / sessionId）与 seq 都要原样回来', () => {
  const memory = layered()
  const persist = toPersist({ ...fresh(), memory }, 0)
  const back = normalizePersist(persist, 0, T)

  assert.equal(back.memory.session.length, 1, '日记要落盘——它就是这个会话的记忆')
  assert.equal(back.memory.session[0].scope, 'session')
  assert.equal(back.memory.session[0].ws, null, '往返之后仍然是"不知道在哪个工作区"')
  assert.equal(back.memory.session[0].sessionId, 's-1')
  assert.equal(back.memory.session[0].seq, 7, 'seq 记的是"写在第几个事件上"，回放日志要用')
  assert.equal(back.memory.global.length, 2)
  assert.equal(back.memory.global.find((e) => e.kind === 'fact').scope, 'workspace', 'scope 不能被规范化吃掉')
})

test('老档案没有归属信息：按 ws 的老语义推导，不替历史编归属', () => {
  // v1.x 的档案里没有 scope / session，只有 `long` 与 `ws` 四态
  const old = normalizeState(
    {
      workspace: HERE,
      memory: {
        short: [],
        long: [
          { kind: 'preference', text: '回复先给结论', importance: 0.7, hits: 0, createdAt: 1, lastAt: 1, ws: '' },
          { kind: 'fact', text: '构建脚本在 scripts 目录', importance: 0.6, hits: 0, createdAt: 1, lastAt: 1, ws: HERE },
          { kind: 'fact', text: '那次会话里说的事', importance: 0.6, hits: 0, createdAt: 1, lastAt: 1, ws: null, sessionId: 's-9' },
          { kind: 'lesson', text: '什么都没写的条目', importance: 0.5, hits: 0, createdAt: 1, lastAt: 1 },
        ],
      },
    },
    T,
    0,
  )

  assert.equal(old.memory.short.length, 0)
  assert.equal(old.memory.session.length, 1, 'ws:null + sessionId 的老条目 → 会话日记那一层')
  assert.equal(old.memory.session[0].text, '那次会话里说的事')
  assert.equal(old.memory.global.length, 3, '其余进全局库')
  const byText = (text) => old.memory.global.find((e) => e.text === text)
  assert.equal(byText('回复先给结论').scope, 'global', '明确全局（ws:""）→ global')
  assert.equal(byText('构建脚本在 scripts 目录').scope, 'workspace', '带具体工作区 → workspace')
  assert.equal(byText('什么都没写的条目').scope, 'global', '缺省的老条目不替它编归属，回落到全局')
  assert.equal(byText('什么都没写的条目').ws, undefined, '也不要凭空给它造一个 ws')
})
