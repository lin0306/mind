/**
 * 回收站（**假删的落点**）的机制测试。
 *
 * 这一层要证明的只有一件事：**从三层里消失的条目，正文一定要留一份，而且能原样捞回来。**
 *
 * 为什么单独测它：清 / 划 / 遗忘 / 池子淘汰都会让条目"不见了"，用户唯一的后悔药就是这个文件。
 * 它坏了，用户划错一条就永久没了——那正是这次要解决的问题。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const { TRASH_KEEP, loadTrash, markTrashRestored, purgeTrash, trashGone, trashFile, readZstdLines } = await import(
  '../lib/index.js'
)

const fresh = () => mkdtempSync(path.join(tmpdir(), 'dsh-mind-trash-'))
const entry = (id, text, extra = {}) => ({
  id,
  kind: 'lesson',
  text,
  importance: 0.6,
  hits: 0,
  createdAt: 1,
  lastAt: 1,
  scope: 'workspace',
  ws: 'E:/code/thought',
  ...extra,
})

test('trashGone：从三层里消失的条目进回收站，且按 id 去重', () => {
  const dir = fresh()
  const before = [entry('a', '第一条'), entry('b', '第二条'), entry('c', '第三条')]
  const after = [entry('b', '第二条')]

  assert.equal(trashGone(dir, before, after, 1000, '人工操作（命令或清库）'), 2, '消失了 2 条')
  const trashed = loadTrash(dir)
  assert.deepEqual(trashed.map((e) => e.id).sort(), ['a', 'c'], '掉的两条都在')
  assert.equal(trashed[0].trashedFrom, 'workspace', '要记住它原来在哪一层')
  assert.equal(trashed[0].trashedReason, '人工操作（命令或清库）', '要记住为什么掉的')
  assert.equal(trashed[0].text, '第一条', '**正文一个字都不能少**——这正是回收站存在的理由')

  // 同一条再掉一次（比如清完又落了一次盘）：不许重复记
  assert.equal(trashGone(dir, before, after, 2000, '又掉一次'), 0, '已经在回收站里等恢复的不重复记')
  assert.equal(loadTrash(dir).length, 2, '回收站里还是两条')

  // 什么都没掉：不写文件也不报数
  assert.equal(trashGone(dir, after, after, 3000, '没掉'), 0)
})

test('回收站有上限：超了丢最老的（它是后悔药，不是永久档案）', () => {
  const dir = fresh()
  // 关键：**整批断言**，不要断"某个具体 id 被丢"。
  // 同一批共用同一个 `trashedAt`，并列时次序由稳定排序决定，断具体 id 会挑错对象
  //（这条测试第一版就这么假失败过一次，实现其实是对的）。
  const batch = 100
  const total = TRASH_KEEP + batch // 恰好超出整整一批：丢的必然是那一批
  const many = Array.from({ length: total }, (_, i) => entry(`m${i}`, `第 ${i} 条`))
  for (let i = 0; i < many.length; i += batch) {
    trashGone(dir, many.slice(i, i + batch), [], 1000 + i, '批量掉')
  }

  const kept = loadTrash(dir)
  assert.equal(kept.length, TRASH_KEEP, `最多留 ${TRASH_KEEP} 条`)
  assert.equal(kept.some((e) => e.trashedAt === 1000), false, '最老的那一批整批被丢掉')
  assert.ok(kept.some((e) => e.id === `m${total - 1}`), '最新的那条一定要在')
})

test('恢复标记与真删：标记过的不再算"等恢复"，真删之后正文才真的没了', () => {
  const dir = fresh()
  trashGone(dir, [entry('a', '要捞回来的'), entry('b', '不要了的')], [], 1000, '清手边')
  assert.equal(loadTrash(dir).length, 2)

  markTrashRestored(dir, ['a'], 2000)
  const after = loadTrash(dir)
  assert.equal(after.find((e) => e.id === 'a')?.restoredAt, 2000, '恢复过要留痕')
  assert.equal(after.filter((e) => e.restoredAt === undefined).length, 1, '只剩 b 在等恢复')
  // 恢复过的再掉一次（这次是真删后的重来）：应当可以重新记
  assert.equal(trashGone(dir, [entry('a', '要捞回来的')], [], 3000, '又掉了'), 1, '恢复过的还能再进回收站')

  assert.equal(purgeTrash(dir, ['b'], 4000), 1, '真删一条')
  assert.ok(!loadTrash(dir).some((e) => e.id === 'b'), '真删之后它就是没了')
  assert.ok(loadTrash(dir).some((e) => e.id === 'a'), '别的条目不受影响')

  assert.equal(purgeTrash(dir, 'all', 5000) >= 1, true, '清空回收站')
  assert.equal(loadTrash(dir).length, 0, '清空之后一条不剩')
  assert.equal(readZstdLines(trashFile(dir)).lines.length >= 1, true, '文件还在（只是最后一行是空的）')
})

test('文件不在 / 读不懂时给空数组，绝不抛（坏文件不许让命令崩）', () => {
  const dir = fresh()
  assert.deepEqual(loadTrash(path.join(dir, '不存在的目录')), [], '根本没有这个文件时给空数组')
  const file = trashFile(dir)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '这不是 zstd，什么都解不出来', 'utf8')
  assert.deepEqual(loadTrash(dir), [], '文件坏了也给空数组')
})
