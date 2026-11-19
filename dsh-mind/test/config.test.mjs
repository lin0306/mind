// Config 必须是**真的 schemastery Schema**。这条测试守的是一个曾经发生过的真 bug：
//
// 宿主把插件导出的 `Config` 当 schemastery Schema 投影成 JSON Schema 来渲染设置页。
// 我们曾经在 `attachStandardSchema()` 里对着真 Schema 赋值 `holder['~standard'] = {...}`，
// 撞上 schemastery 原型上的**只读 getter**抛 TypeError，异常又被 `catch {}` 吞掉，
// 于是降级成手写形状（`plainSchema`，带 `_dshMind: 'plain'`）→ 宿主无 AST 可投影 →
// 设置里我们的配置被判 `unsupported`，**一个字段都改不了**，而插件表面一切正常。
//
// 所以这里断言"AST 还在"，而不是断言"能跑"。
import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../lib/index.js'

test('Config 保留 schemastery 的 AST（否则宿主设置页里一个字段都改不了）', () => {
  assert.ok(Config !== null && Config !== undefined, 'Config 要导出来')

  assert.equal(
    Config._dshMind,
    undefined,
    '不能是手写降级形状（`_dshMind: "plain"`）——那正是设置页判 unsupported 的根因',
  )
  assert.equal(Config.type, 'object', 'schemastery 的根节点要有 type；宿主靠它认出来这是 Schema')
  assert.equal(typeof Config.dict, 'object', '要有 dict（字段表），宿主靠它列出配置项')
  assert.equal(typeof Config['~standard']?.validate, 'function', 'loader 只认 ~standard.validate')

  // 字段自己也要有 meta（description/default/范围），否则设置页里是空白控件
  const fields = Object.keys(Config.dict ?? {})
  assert.ok(fields.length >= 5, `字段太少（${fields.length} 个），dict 大概被替换掉了`)
  const withMeta = fields.filter((key) => {
    const meta = Config.dict[key]?.meta
    return meta !== null && typeof meta === 'object'
  })
  assert.ok(withMeta.length > 0, '至少要有字段带 meta（默认值/说明来自这里）')
})
