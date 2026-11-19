/**
 * `recall_memory` 工具本身的测试（不需要宿主）。
 *
 * 三条契约：
 *   1. 查得到 → 返回条目，并且带上"因为"（让人能判断这条可不可信）；
 *   2. 查不到 → **如实说想不起来**，并明确告诉模型不要凭印象编；
 *   3. 没给查询词 → 什么都不返回，不瞎猜。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// 注意路径：core 的东西在 mind-core 下，根包的 lib/ 只是 DSH 适配层
import { DEFAULT_TUNABLES as T, normalizeState, rememberLong } from '../../mind-core/lib/index.js'
import { recallTool } from '../lib/index.js'

function archiveWith(entries) {
  let memory = normalizeState({}, T, 0).memory
  for (const entry of entries) {
    memory = rememberLong(memory, { at: 0, ...entry }, T)
  }
  return memory
}

const deps = (memory) => ({ memory: () => memory, tunables: () => T })

test('recall_memory：查得到就返回条目，并带上原因', async () => {
  const memory = archiveWith([
    { kind: 'agreement', text: '这个项目用 pnpm，不要用 npm', importance: 0.9, because: '用户明确要求' },
  ])
  const tool = recallTool(deps(memory))
  assert.equal(tool.name, 'recall_memory')

  // 检索是**字面重合**：关键词对得上就一定查得到（这也是工具描述要求"写关键词"的原因）
  const hit = await tool.execute({ query: 'pnpm 还是 npm' })
  assert.match(hit.ok, /pnpm/)
  assert.match(hit.ok, /用户明确要求/)
  assert.match(hit.ok, /事实|约定|偏好|教训/, '要带中文分类名（数据存英文键，展示永远是中文）')
})

test('recall_memory：查不到就老实说，并提醒不要编', async () => {
  const memory = archiveWith([{ kind: 'agreement', text: '这个项目用 pnpm', importance: 0.9, because: '用户要求' }])
  const tool = recallTool(deps(memory))

  const miss = await tool.execute({ query: '客户的电话号码是多少' })
  assert.match(miss.ok, /没想起来/)
  assert.match(miss.ok, /不要凭印象编/, '必须明确禁止硬答')
})

test('recall_memory：没给查询词就不乱返回', async () => {
  const tool = recallTool(deps(archiveWith([{ kind: 'fact', text: '工作区在 E 盘', importance: 0.5, because: '用户说的' }])))
  const empty = await tool.execute({})
  assert.match(empty.ok, /没有给查询词/)
  const blank = await tool.execute({ query: '   ' })
  assert.match(blank.ok, /没有给查询词/)
})

test('recall_memory：长期库为空时也不会崩（第一次装插件就是这种状态）', async () => {
  const tool = recallTool(deps(normalizeState({}, T, 0).memory))
  const result = await tool.execute({ query: '随便什么' })
  assert.match(result.ok, /没想起来/)
})
