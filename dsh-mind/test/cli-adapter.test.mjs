/**
 * 第二个 adapter 的验收。
 *
 * v1.5 把"第二个 adapter"列为硬要求，理由是：**只做 DSH，就永远不知道 core 是不是真干净**。
 * 所以这里要证的不是"命令行能跑"，而是三件事：
 * 1. 同一份 core 在一个**完全没有 DSH 的宿主**里能跑完整条链路（折叠 → 两段文本 → 记忆 → 面板）；
 * 2. core 包里没有一行 `@deepseek-ai/*`，也没有任何运行时依赖（包边界即硬约束）；
 * 3. 那个 adapter 自己也没有偷偷依赖 DSH。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'adapters', 'cli', 'mind-cli.mjs')
const CORE_SRC = path.join(ROOT, '..', 'mind-core', 'src')

function runCli(args = ['--demo']) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

test('第二个 adapter 能独立跑完整条链路（没有 DSH）', () => {
  const out = runCli()

  assert.match(out, /命令行 adapter（没有一行 DSH）/)
  // stable：人设段（给系统提示词的那一段）
  assert.match(out, /【我是谁】/)
  // dynamic：此刻（给请求末尾的那一段）——它带闭合边界，免得模型把它当风格接在回复后面
  assert.match(out, /【此刻】/)
  assert.match(out, /【此刻结束】/)
  // 折出来的情绪真的有名字，不是只涨一个数字
  assert.match(out, /挫败/)
  // 长期记忆：它自己写下的那句（不是用户原话），一轮结束时固化，之后靠主动查才出现
  assert.match(out, /这个项目用 pnpm/)
  // 空段落不许硬凑：第一轮收束时它应该是在说"没有值得说的东西"或者是平静那一段
  assert.match(out, /第 1 轮收束/)
  assert.match(out, /第 3 轮收束/)
})

test('第二个 adapter 也能吃外部事件流（JSONL）', () => {
  const json = runCli(['--demo', '--json'])
  const parsed = JSON.parse(json)
  assert.ok(parsed.stable.includes('【我是谁】'))
  assert.equal(parsed.turns.length, 3)
  assert.ok(parsed.recall.length > 0, '道谢那轮之后，「包管理器 pnpm」应该查得到')
  assert.equal(parsed.persist.stats.turns, 3)
})

/** 把一个模块里所有 import/require 的**模块名**取出来（注释里提到 Cordis 不算数）。 */
function importedModules(text) {
  const out = []
  const re = /(?:from|import|require\()\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1])
  return out
}

test('core 仍然零依赖：每条 import 要么是相对的，要么是 node: 内建', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, '..', 'mind-core', 'package.json'), 'utf8'))
  // 允许写成空对象（pnpm workspace 常见），但**不许真有一条**
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'core 不许有运行时依赖')
  assert.deepEqual(pkg.peerDependencies ?? {}, {}, 'core 不许有 peerDependencies')

  const files = readdirSync(CORE_SRC).filter((name) => name.endsWith('.ts'))
  assert.ok(files.length >= 12, `core 的源码文件数不对：${files.length}`)
  for (const name of files) {
    for (const spec of importedModules(readFileSync(path.join(CORE_SRC, name), 'utf8'))) {
      assert.ok(
        spec.startsWith('.') || spec.startsWith('node:'),
        `${name} import 了外部模块：${spec}（core 必须是零依赖、零 DSH）`,
      )
    }
  }
})

test('CLI adapter 自己也不许碰 DSH', () => {
  const text = readFileSync(CLI, 'utf8')
  for (const spec of importedModules(text)) {
    assert.ok(spec.startsWith('.') || spec.startsWith('node:'), `CLI adapter import 了 ${spec}`)
  }
  // 注释里提一句不要紧（上面那条 import 检查才是硬约束），有说明就行
  assert.match(text, /dsh-mind-core/)
  assert.match(text, /是不是真的干净/)
})
