/**
 * 记忆库四项升级里能纯函数验证的三条（v1.7）：
 *
 *   1. **写入前扫敏感内容**（密钥 / 口令 / 证件号）：整条不记、返回同一引用、
 *      只报"是什么"而**不回显内容**；
 *   2. **检索文本分 = BM25 原始分 + 饱和映射**：多打几个无关词不该把已命中的词压下去。
 *      这是踩过的坑：早先按"查询里所有词"归一化，提问的人词越多分越低——
 *      明明命中 `pnpm` 也被拦在阈值外，而噪声句反而过线；
 *   3. **短期记忆按轮次轮换**：钉住的常驻，其余名额轮流露面（不轮换的话，
 *      库里其余的条目永远不会出现在注入里）。
 *
 * 第四条（Markdown 镜像）是适配层写文件，测在 `dsh-mind/test/mirror.test.mjs`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TUNABLES as T,
  bm25Scores,
  bm25Text,
  describeShort,
  emptyMemory,
  rememberLong,
  rememberShort,
  sensitiveReason,
} from '../lib/index.js'

/** 小库：三条常见事实，用来算 BM25。 */
const docs = ['这个项目用 pnpm，不要用 npm', '注释一律用中文', '提交前要跑全量测试']

test('敏感内容整条不入库：认得出、返回同一引用、不回显内容', () => {
  assert.equal(sensitiveReason('这个项目用 pnpm'), null, '普通的话不该被拦')
  assert.equal(sensitiveReason('token 是 sk-abcdefghijklmnopqrstuvwx'), 'sk- 开头的密钥')
  assert.equal(sensitiveReason('api_key = 9f8e7d6c5b4a39281706'), '赋值形式的密钥')

  // 只报"是什么"：原因里不能出现那段内容（日志也会被人看到、被贴出去）
  const text = 'api_key = 9f8e7d6c5b4a39281706'
  assert.ok(!String(sensitiveReason(text)).includes('9f8e7d6c'), '原因里不能回显内容')

  // 入库被整条拦下，而且**返回同一引用**——换了新对象会让适配层的 Object.is 闸门
  // 以为状态变了，白写一次盘（也会白白多出一次投影版本）。
  const memory = emptyMemory(0)
  assert.equal(rememberShort(memory, { kind: 'fact', text, at: 1000 }, T), memory)
  assert.equal(rememberLong(memory, { kind: 'fact', text, at: 1000 }, T), memory)
  assert.equal(memory.short.length, 0)
  // v2.0：长期库改名"全局层"（`.long` → `.global`），三层都得是空的
  assert.equal(memory.global.length, 0)
  assert.equal(memory.session.length, 0, '敏感内容也不许漏进会话日记')
})

test('多打无关词不该把命中压下去（旧版按全查询词归一化就会）', () => {
  const base = bm25Scores('pnpm', docs)
  const noisy = bm25Scores('pnpm 顺便问一下今天天气怎么样', docs)
  assert.equal(noisy[0], base[0], 'BM25 原始分只按命中的词累加，无关词贡献 0，分不该变')
  assert.ok(base[0] > 0, '确实命中了第一条')

  // 饱和映射：命中就该撑得起排序权重（0.25），没命中就是 0，再高也不会到 1。
  assert.ok(bm25Text(base[0], T) > 0.25, '命中 pnpm 要能过排序门槛')
  assert.equal(bm25Text(0, T), 0, '完全没命中就是 0')
  assert.ok(bm25Text(1000, T) < 1, '饱和映射有上界')
  assert.ok(bm25Text(1000, T) > bm25Text(1, T), '单调递增（分越高越大，但有上限）')
})

test('短期注入按轮次轮换：钉住的常驻，其余轮流露面', () => {
  // 六条**互不相似**的事（相似度高会被 `isDuplicate` 判成重复，只剩一条，测试就成了假通过）
  const facts = [
    '这个项目用 pnpm 装依赖',
    '注释一律用中文',
    '提交前跑全量测试',
    '不要写 as any',
    '英文标识符保持原样',
    '临时文件丢到 tmp 目录',
  ]
  let memory = emptyMemory(0)
  facts.forEach((text, i) => {
    memory = rememberShort(memory, { kind: 'fact', text, importance: 0.3 + i * 0.02, at: 1000 + i }, T)
  })
  assert.equal(memory.short.length, 6, '六条互不相似的事都该留下')
  const batch = (offset) => describeShort(memory, 3, undefined, { offset, pinned: 1 })

  const first = batch(0)
  assert.equal(first.length, 3)
  const anchored = first[0]
  for (const offset of [1, 2, 3]) {
    assert.equal(batch(offset)[0], anchored, '钉住的那条（最重的）每轮都在')
  }
  assert.notDeepEqual(first.slice(1), batch(1).slice(1), '轮次一变，其余名额就换人')

  // 不传 rotation 就是老行为：老老实实取前 limit 条（旧调用方不受影响）
  assert.deepEqual(
    describeShort(memory, 3),
    describeShort(memory, 3, undefined, { offset: 0, pinned: 0 }),
    '省略 rotation 时与"不钉住、从第 0 个开始"等价',
  )
})