// v3.0 存储层的读写语义，守三条最容易写错的规矩：
//   · 一个记忆文件 = 一行一份**完整快照**，读取只认最后一行（旧快照留着可追溯，但不参与读取）
//   · 会话记忆**可修订**（后一次把前一次没说清、没做完的改掉或删掉，而不是并排留着两句矛盾的）
//   · 短期与全局是**全量**（每次整份重算，旧条目该消失就消失）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  SNAPSHOT_KEEP,
  asWorkspaceEntry,
  globalPersonaFile,
  globalSummaryFile,
  loadGlobal,
  loadPersonaState,
  loadSession,
  loadShort,
  readZstdLines,
  saveGlobal,
  savePersonaState,
  saveSession,
  saveShort,
  sessionMemoryFile,
  shortFile,
  toStored,
  writeZstdLines,
} from '../lib/index.js'

const HERE = 'E:/code/thought'
const SESSION = 'session-store'

function entry(over) {
  return {
    id: over.id,
    kind: over.kind ?? 'fact',
    text: over.text,
    importance: over.importance ?? 0.5,
    hits: over.hits ?? 0,
    createdAt: over.createdAt ?? 1_700_000_000_000,
    lastAt: over.lastAt ?? 1_700_000_000_000,
    because: over.because,
    origin: over.origin,
    ws: over.ws,
    sessionId: over.sessionId,
    seq: over.seq,
  }
}

test('短期：全量语义（旧的该消失就消失）+ 按工作区一份', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-store-short-'))
  try {
    const first = [
      toStored(entry({ id: 'a', text: '这个项目用 pnpm 装依赖', ws: HERE }), 'workspace'),
      toStored(entry({ id: 'b', text: '提交前跑全量测试', ws: HERE }), 'workspace'),
    ]
    saveShort(dir, HERE, first, 1_800_000_000_000, { reason: 'steps' })
    assert.equal(loadShort(dir, HERE).entries.length, 2)
    assert.equal(shortFile(dir, HERE).endsWith('.jsonl.zst'), true, 'v3 的短期是 jsonl.zst')

    // 全量重写：只留一条，另一条就真的没了
    saveShort(dir, HERE, [first[0]], 1_800_000_000_001, { reason: 'steps' })
    const back = loadShort(dir, HERE)
    assert.equal(back.entries.length, 1)
    assert.equal(back.entries[0].id, 'a')
    assert.equal(back.entries[0].scope, 'workspace')

    // 清空也要写下去：不然盘上那份旧的会在下一个会话里复活
    saveShort(dir, HERE, [], 1_800_000_000_002, { reason: 'manual' })
    assert.equal(loadShort(dir, HERE).entries.length, 0, '空快照也是内容，别当成"没写"')

    // 另一个工作区是另一份文件，互不影响
    assert.equal(loadShort(dir, 'E:/code/other').entries.length, 0)
    assert.notEqual(shortFile(dir, HERE), shortFile(dir, 'E:/code/other'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话记忆：每次写一整份完整快照——可改写、可删除，读的永远是最后一行', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-store-session-'))
  try {
    const a = toStored(entry({ id: 'j1', kind: 'lesson', text: '定下：先定需求再动手', sessionId: SESSION, seq: 12 }), 'session')
    const b = toStored(
      entry({ id: 'j2', kind: 'fact', text: '试过用脚本改文件，被采样噪声写坏了', sessionId: SESSION, seq: 40 }),
      'session',
    )

    saveSession(dir, SESSION, [a], 1_800_000_000_000, { reason: 'steps' })
    saveSession(dir, SESSION, [a, b], 1_800_000_000_001, { reason: 'steps' })
    assert.equal(loadSession(dir, SESSION).entries.length, 2, '快照是整份的，不是增量')

    // 后一次"做完了"：改掉旧正文、删掉那条已经不作数的
    const fixed = toStored(
      entry({ id: 'j2', kind: 'fact', text: '后来确认：是采样噪声写坏的，已改用原子写', sessionId: SESSION, seq: 40 }),
      'session',
    )
    const c = toStored(entry({ id: 'j3', kind: 'agreement', text: '以后改文件一律走 edit 工具', sessionId: SESSION, seq: 88 }), 'session')
    saveSession(dir, SESSION, [fixed, c], 1_800_000_000_002, { reason: 'final' })

    const now = loadSession(dir, SESSION)
    assert.equal(now.entries.length, 2, '旧快照还留在文件里，但读取只认最后一行')
    assert.deepEqual(
      now.entries.map((e) => e.id),
      ['j2', 'j3'],
      'j1 在新快照里没出现，就等于删了（v2 是"永不改写"，这里必须能删）',
    )
    assert.match(now.entries[0].text, /已改用原子写/, '改过的正文要生效')
    assert.equal(now.entries[0].seq, 40, '出处（seq）要留住，能追回会话日志')
    assert.equal(now.entries[0].sessionId, SESSION)

    // 文件里确实留着三份快照（可追溯），但"当前内容"只有最后一行
    const lines = readZstdLines(sessionMemoryFile(dir, SESSION)).lines
    assert.equal(lines.length, 3, '旧快照不删，能追溯')
    const last = JSON.parse(lines.at(-1))
    assert.equal(last.version, 3)
    assert.equal(last.reason, 'final')
    assert.equal(last.owner, SESSION)
    assert.equal(last.entries.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('快照裁剪：超过 SNAPSHOT_KEEP 行就静默裁掉最老的，只留最近 20 行', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-store-keep-'))
  try {
    const total = SNAPSHOT_KEEP + 5
    for (let i = 0; i < total; i += 1) {
      const one = toStored(entry({ id: `s-${i}`, text: `第 ${i} 次写下的正文`, ws: HERE }), 'workspace')
      saveShort(dir, HERE, [one], 1_800_000_000_000 + i, { reason: 'steps' })
    }
    const lines = readZstdLines(shortFile(dir, HERE)).lines
    assert.equal(lines.length, SNAPSHOT_KEEP, `最多留 ${SNAPSHOT_KEEP} 行`)
    assert.equal(JSON.parse(lines[0]).entries[0].id, 's-5', '最老的 5 行被裁掉了')
    assert.equal(JSON.parse(lines.at(-1)).entries[0].id, `s-${total - 1}`, '最后一行是最新的')
    assert.equal(loadShort(dir, HERE).entries[0].id, `s-${total - 1}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('全局：全量 + 顺手写简介；工作区条目要明写出处', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-store-global-'))
  try {
    const pref = toStored(entry({ id: 'g1', kind: 'preference', text: '注释一律用中文', origin: 'self' }), 'global')
    const heard = asWorkspaceEntry(entry({ id: 'g2', kind: 'agreement', text: '这个项目用 pnpm' }), HERE)
    // 收尾兜底拼的日记（v2.2 起是独立一档）：落盘再读回来必须还是 `digest`，
    // 不许被窄化成"听来的原话"——那句话既不是用户说的，也不是它自己说的。
    const digest = toStored(entry({ id: 'g3', kind: 'lesson', text: '这一段收尾时按规则拼的', origin: 'digest' }), 'global')
    saveGlobal(dir, [pref, heard, digest], 1_800_000_000_000, { reason: 'steps' })

    const back = loadGlobal(dir)
    assert.equal(back.entries.length, 3)
    assert.equal(back.dropped, 0)
    const stored = back.entries.find((e) => e.id === 'g2')
    assert.equal(stored.scope, 'workspace')
    assert.equal(stored.where, HERE)
    assert.equal(stored.origin, 'heard', '没写 origin 就按听来的算')
    assert.equal(back.entries.find((e) => e.id === 'g3')?.origin, 'digest', 'digest 不许被降级成 heard')

    const summary = readFileSync(globalSummaryFile(dir), 'utf8')
    assert.match(summary, /# 全局记忆简介/)
    assert.match(summary, /注释一律用中文/)
    assert.match(summary, /这个工作区里说的/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏文件、坏行、坏条目都不许挡住聊天：能读多少读多少、丢掉要报数', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-store-bad-'))
  try {
    const target = shortFile(dir, HERE)
    // （先建目录：`short/<工作区键>.jsonl.zst` 在子目录里，直接 writeFileSync 会 ENOENT）
    mkdirSync(path.dirname(target), { recursive: true })

    // ① 整个文件读不动（不是 zstd）：按"丢了一份"报 1，绝不抛
    writeFileSync(target, '这不是 zstd', 'utf8')
    assert.deepEqual(loadShort(dir, HERE), { entries: [], dropped: 1 })

    const good = JSON.stringify({
      version: 3,
      scope: 'workspace',
      at: 1,
      reason: 'steps',
      entries: [{ id: 'ok', kind: 'fact', text: '好的一条' }],
    })

    // ② 最后一行是坏 JSON：丢掉那一行并报数
    writeZstdLines(target, [good, '{ 这不是 JSON'])
    assert.deepEqual(loadShort(dir, HERE), { entries: [], dropped: 1 })

    // ③ 坏的是**旧的**快照：既然只读最后一行，当前内容一点没受影响
    writeZstdLines(target, ['{ 坏掉的旧快照', good])
    const older = loadShort(dir, HERE)
    assert.equal(older.entries.length, 1)
    assert.equal(older.dropped, 0, '旧快照不参与读取，坏了也不算丢')

    // ④ 行是好的，里面有一条没正文：丢掉那一条，其余照旧
    writeZstdLines(target, [
      JSON.stringify({
        version: 3,
        scope: 'workspace',
        at: 3,
        reason: 'steps',
        entries: [
          { id: 'ok', kind: 'fact', text: '好的那条' },
          { id: 'empty', kind: 'fact', text: '   ' },
        ],
      }),
    ])
    const mixed = loadShort(dir, HERE)
    assert.equal(mixed.entries.length, 1)
    assert.equal(mixed.dropped, 1, '丢掉的条数要能报出来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('人设快照：一行一份，读最后一个；内容与来由都没变时不重复追加', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-store-persona-'))
  try {
    assert.equal(loadPersonaState(dir), undefined, '还没有这份文件')

    const source = (turns, forgotten) => ({
      persona: { voice: { brevity: 0.3 } },
      baseline: { valence: 0.01, arousal: 0.25, dominance: 0.5 },
      stats: { turns },
      memory: { forgotten },
    })

    assert.equal(savePersonaState(dir, source(1, ['gone-1']), 1_800_000_000_000, { reason: 'manual' }), true)
    const first = loadPersonaState(dir)
    assert.equal(first.baseline.arousal, 0.25)
    assert.deepEqual(first.forgotten, ['gone-1'], '遗忘名单必须跟着走：丢了它被划掉的东西会自己冒出来')

    // 同内容 + 同理由：不追加（否则统计一变就会堆一串一模一样的行）
    savePersonaState(dir, source(1, ['gone-1']), 1_800_000_000_001, { reason: 'manual' })
    assert.equal(readZstdLines(globalPersonaFile(dir)).lines.length, 1, '一样的快照不重复写')

    // 内容变了就写；理由变了也写（那是"这次为什么又看了一遍"的痕迹）
    savePersonaState(dir, source(2, []), 1_800_000_000_002, { reason: 'steps' })
    savePersonaState(dir, source(2, []), 1_800_000_000_003, { reason: 'final' })
    const back = loadPersonaState(dir)
    assert.equal(back.stats.turns, 2, '读最后一个快照')
    assert.deepEqual(back.forgotten, [])
    assert.equal(readZstdLines(globalPersonaFile(dir)).lines.length, 3)
    assert.equal(JSON.parse(readZstdLines(globalPersonaFile(dir)).lines.at(-1)).reason, 'final')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
