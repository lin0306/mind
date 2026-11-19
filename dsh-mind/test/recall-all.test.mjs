/**
 * `recall_memory` 跨会话（`scope: "all"`）的两段式检索。
 *
 * 用户原话："查其他会话的记忆，首先读这个会话记忆的简介，看是不是自己需要的，
 * 不是就查下一题，是的话，就进这个会话里去查，数据量大的话，可以分页去查"。
 *
 * 这里守四件事：
 *   1. 第一段只看简介，**只进选中的会话**；
 *   2. 简介全不相关就如实说"没一个像"，不硬凑；
 *   3. 分页按命中数切：第 p 页、共 N 条、有没有下一页都要写清楚；
 *   4. 跨会话命中要标出来自哪个会话。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { DEFAULT_TUNABLES as T, normalizeState } from '../../mind-core/lib/index.js'
import {
  crossSessionRecall,
  recallTool,
  saveSession,
  selectSessionsBySummary,
  sessionSummaryFile,
  sessionsDir,
  toStored,
  writeTextAtomic,
} from '../lib/index.js'

const NOW = Date.now()

/** 一份空的长期记忆：这些测试只关心跨会话那一段。 */
const EMPTY = () => normalizeState({}, T, 0).memory

function entry(over) {
  return {
    id: over.id,
    kind: over.kind ?? 'fact',
    text: over.text,
    importance: over.importance ?? 0.9,
    hits: 0,
    createdAt: over.createdAt ?? NOW,
    lastAt: over.lastAt ?? NOW,
    because: over.because ?? '测试',
    origin: 'heard',
    sessionId: over.sessionId,
  }
}

/** 造一个会话：一份条目快照 + 一份自定义简介（saveSession 会先写简介，这里覆盖成想测的样子）。 */
function seedSession(dir, id, summary, text = '一条无关的日记') {
  saveSession(dir, id, [toStored(entry({ id: `${id}-e1`, text, sessionId: id }), 'session')], NOW, { reason: 'manual' })
  writeTextAtomic(sessionSummaryFile(dir, id), `# 会话记忆简介 · ${id}\n\n${summary}\n`)
}

/** 数结果里有几行命中（每条命中都以全角项目符号开头）。 */
const hitLines = (ok) => (ok.match(/^　· /gm) ?? []).length

test('两段式：只进简介相关的会话，别的会话一条都不读', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-recall-all-'))
  try {
    seedSession(dir, 'session-aaaa1111', '在讨论分页检索：先读简介，再进会话。')
    seedSession(dir, 'session-bbbb2222', '今天天气不错，出去走了走。')
    seedSession(dir, 'session-cccc3333', '晚饭吃了面，顺便买了点水果。')

    const result = crossSessionRecall(dir, 'session-current', '分页检索', 1, 20, 5)

    assert.equal(result.reason, undefined, '有当前会话 id，不该报 no-session')
    assert.deepEqual(result.entered, ['session-aaaa1111'], '只有简介相关的那个会话该被进去')
    assert.equal(result.lookedAt, 3, '三个会话的简介都要看过（当前会话不在目录里）')
    assert.equal(result.entries.length, 1, '只搬选中会话的条目，别的会话一条都不带')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两段式：简介都不相关时如实说"没一个像"，不进任何会话', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-recall-none-'))
  try {
    seedSession(dir, 'session-aaaa1111', '今天天气不错，出去走了走。')
    seedSession(dir, 'session-bbbb2222', '晚饭吃了面，顺便买了点水果。')
    seedSession(dir, 'session-cccc3333', '把阳台的花浇了一遍。')
    // 第四个会话没有简介：跳过，但要计数。
    mkdirSync(path.join(sessionsDir(dir), 'session-dddd4444'), { recursive: true })

    const selection = selectSessionsBySummary(dir, '分页检索', 5, 'session-current')
    assert.equal(selection.lookedAt, 4, '缺简介的目录也算"看过"')
    assert.equal(selection.missing, 1, '缺简介要单独计数')
    assert.deepEqual(selection.entered, [])

    const result = crossSessionRecall(dir, 'session-current', '分页检索', 1, 20, 5)
    assert.deepEqual(result.entered, [])
    assert.deepEqual(result.entries, [], '一个都不像，就一条都不要硬凑')

    const tool = recallTool({
      memory: EMPTY,
      tunables: () => T,
      crossSession: (query, page, pageSize) => crossSessionRecall(dir, 'session-current', query, page, pageSize),
    })
    const out = await tool.execute({ query: '分页检索', scope: 'all' })
    assert.match(out.ok, /看了 4 个会话的简介，没有一个像在说这件事/)
    assert.match(out.ok, /没想起来/)
    assert.equal(hitLines(out.ok), 0, '没一个像的时候不能列出任何条目')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 假的跨会话依赖：返回 25 条真命中 + 25 条无关条目（用来稀释 IDF，让 25 条都过阈值）。 */
function fakeCross(decoy = true) {
  const entries = []
  for (let i = 0; i < 25; i += 1) {
    entries.push(
      entry({
        id: `hit-${i}`,
        text: `分页检索 第 ${i} 条 独特词${i}`,
        sessionId: 'session-ab12cd34deadbeef',
      }),
    )
  }
  if (decoy) {
    for (let i = 0; i < 25; i += 1) {
      entries.push(entry({ id: `decoy-${i}`, text: `完全无关的闲聊 编号${i}`, sessionId: 'session-ab12cd34deadbeef' }))
    }
  }
  return entries
}

function depsWith(entries) {
  return {
    memory: EMPTY,
    tunables: () => T,
    crossSession: (query, page) => ({
      entries,
      lookedAt: 1,
      entered: ['session-ab12cd34deadbeef'],
      page,
      total: entries.length,
    }),
  }
}

test('分页：25 条命中，pageSize=10 时第 1 页 10 条、第 3 页 5 条、第 4 页空且说明范围', async () => {
  const tool = recallTool(depsWith(fakeCross()))

  const first = await tool.execute({ query: '分页检索', scope: 'all', pageSize: 10 })
  assert.equal(hitLines(first.ok), 10, '第 1 页只放 10 条')
  assert.match(first.ok, /第 1 页，共 25 条命中/)
  assert.match(first.ok, /还有下一页：想看更多就再问一次，带上 page=2/, '有下一页就要告诉模型怎么继续')
  assert.match(first.ok, /进了 1 个（ab12cd34）/, '开头要交代进了哪个会话')

  const third = await tool.execute({ query: '分页检索', scope: 'all', pageSize: 10, page: 3 })
  assert.equal(hitLines(third.ok), 5, '第 3 页只剩 5 条')
  assert.match(third.ok, /第 3 页，共 25 条命中/)
  assert.match(third.ok, /没有下一页了/)

  const fourth = await tool.execute({ query: '分页检索', scope: 'all', pageSize: 10, page: 4 })
  assert.equal(hitLines(fourth.ok), 0, '越界页不能重复给出内容')
  assert.match(fourth.ok, /第 4 页没有内容：共 25 条命中/)
  assert.match(fourth.ok, /只有 3 页/)
  assert.match(fourth.ok, /带上 page=3/, '要指回最后一页，不能只说空')
})

test('默认分页：pageSize 默认 20，第 2 页是剩下的 5 条', async () => {
  const tool = recallTool(depsWith(fakeCross()))
  const first = await tool.execute({ query: '分页检索', scope: 'all' })
  assert.equal(hitLines(first.ok), 20, '默认一页 20 条')
  assert.match(first.ok, /page=2/)
  const second = await tool.execute({ query: '分页检索', scope: 'all', page: 2 })
  assert.equal(hitLines(second.ok), 5)
  assert.match(second.ok, /第 2 页，共 25 条命中，没有下一页了/)
})

test('跨会话命中要标出来源会话，且不再自称"本会话日记"', async () => {
  // 掺一半无关条目：全都含查询词会让 IDF 归零，那样根本不会命中，也就没得可标。
  const tool = recallTool(depsWith(fakeCross()))
  const out = await tool.execute({ query: '分页检索', scope: 'all', pageSize: 10 })
  assert.match(out.ok, /来自会话 ab12cd34/, '每条跨会话命中都要能追到来源')
  assert.ok(!out.ok.includes('本会话日记'), '别的会话的条目不能标成"本会话日记"')
  assert.match(out.ok, /看了 1 个会话的简介，进了 1 个（ab12cd34）/)
})

test('拿不到当前会话 id 时不抛错，如实说跨会话查不了', async () => {
  const tool = recallTool({
    memory: EMPTY,
    tunables: () => T,
    crossSession: (_query, page) => ({
      entries: [],
      lookedAt: 0,
      entered: [],
      page,
      total: 0,
      reason: 'no-session',
    }),
  })
  const out = await tool.execute({ query: '分页检索', scope: 'all' })
  assert.match(out.ok, /这个会话没有记下自己的 id，跨会话查不了/)
})