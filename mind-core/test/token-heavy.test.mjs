/**
 * `token_heavy` 的判据（v2.4.x 真机事故）。
 *
 * 事故现场：一个聊了 460 轮的会话，每轮的 `usage.totalTokens` 都是 42 万左右
 * （那不是"这一轮烧得多"，是**上下文本来就这么长**）。旧判据拿它跟 4 万比，
 * 于是每轮都 +0.45 疲惫 → 强度 0.92、计数 33 次，面板上永远显示
 * "为什么这么高：这一轮烧了 421026 token"。
 *
 * 现在只认"这一轮新写了多少"（输出 token）；宿主没给增量数据时**宁可不判**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { DEFAULT_TUNABLES, appraiseAssistantText } = await import('../lib/index.js')

const obs = (extra) => ({ kind: 'assistant-text', chars: 120, at: 1_000, turn: 1, ...extra })

test('整包用量再大也不判：它约等于上下文长度，不是"这一轮的消耗"', () => {
  const heavy = DEFAULT_TUNABLES.heavyTokens
  assert.deepEqual(
    appraiseAssistantText(obs({ totalTokens: 421_026 }), heavy),
    [],
    '42 万 token 的整包用量不该产生任何信号（否则每轮必报）',
  )
})

test('增量超阈值才算"这一轮烧得多"', () => {
  const heavy = DEFAULT_TUNABLES.heavyTokens
  const signals = appraiseAssistantText(obs({ outputTokens: heavy + 1 }), heavy)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].kind, 'token_heavy')
  assert.match(signals[0].because, /写了特别长/, '缘由要说清"发生了什么"')
  assert.ok(
    !/\d/.test(signals[0].because),
    `缘由里不许出现数字：面板要回答"为什么"，不是"记了多少"（实际：「${signals[0].because}」）`,
  )
})

test('增量很小、但整包很大：不判（这正是真机里那种情况）', () => {
  const heavy = DEFAULT_TUNABLES.heavyTokens
  assert.deepEqual(appraiseAssistantText(obs({ outputTokens: 900, totalTokens: 421_026 }), heavy), [])
})

test('宿主没给增量数据：不判，而不是退回去拿整包猜', () => {
  const heavy = DEFAULT_TUNABLES.heavyTokens
  assert.deepEqual(appraiseAssistantText(obs({ totalTokens: heavy * 10 }), heavy), [])
})
