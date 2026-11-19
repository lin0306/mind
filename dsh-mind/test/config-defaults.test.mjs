/**
 * 设置页的默认值 vs 内核的默认值：**必须一致**。
 *
 * 真机事故（2026-11-18）：`heavyTokens` 设置页写 8000、内核 DEFAULT_TUNABLES 写 40000，
 * `longUserChars` 一处 800、一处 1200。用户在设置页看到的是一个数，实际跑的是另一个——
 * 调了也不生效，而且没有任何地方报错。这类"两处真相"只能靠测试盯着。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { CONFIG_FIELDS } = await import('../lib/index.js')
const { DEFAULT_TUNABLES } = await import('dsh-mind-core')

test('设置页每个字段的 fallback 都等于内核的默认值', () => {
  const tunables = DEFAULT_TUNABLES
  const shared = CONFIG_FIELDS.filter((field) => Object.hasOwn(tunables, field.key))
  assert.ok(shared.length >= 15, `比对的字段太少（${shared.length}），这条测试会形同虚设`)

  const mismatched = shared
    .filter((field) => tunables[field.key] !== field.fallback)
    .map((field) => `${field.key}：设置页 ${String(field.fallback)} / 内核 ${String(tunables[field.key])}`)

  assert.deepEqual(mismatched, [], `这些字段两处默认值不一致（调了不生效）：\n${mismatched.join('\n')}`)
})
