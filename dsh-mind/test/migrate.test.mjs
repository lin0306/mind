// 老档案 → v3.0 布局的迁移：一条不丢地拆到新布局，并且只拆一次。
//
// 这份测试守两条底线：
// 1. **迁移不许编造归属**：当年没记 ws 的条目进全局时带 `legacy: true`，有工作区的带 `where`，
//    未分组会话的进那个会话——三种都得能验，否则"不替历史编证据"就只是口号。
// 2. **旧文件是改名不是删除**：`state.json` 与 v2 的 `.json` 都要进 `archive/`，出问题还能翻回来对。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  globalMemoryFile,
  globalPersonaFile,
  globalSummaryFile,
  loadGlobal,
  loadPersonaState,
  loadSession,
  loadShort,
  migrateToV3,
  migrationFile,
  safeKey,
  sessionMemoryFile,
  shortFile,
} from '../lib/index.js'

const HERE = 'E:/code/thought'
const SESSION = 'session-abc'
const NOW = 1_800_000_000_000

/** 一条旧档案里的记忆（v1/v2 的形状）。 */
function entry(over) {
  return {
    id: over.id,
    kind: over.kind,
    text: over.text,
    importance: over.importance ?? 0.5,
    hits: over.hits ?? 0,
    createdAt: 1_700_000_000_000,
    lastAt: 1_700_000_000_000,
    ...(over.ws === undefined ? {} : { ws: over.ws }),
    ...(over.sessionId === undefined ? {} : { sessionId: over.sessionId }),
    ...(over.origin === undefined ? {} : { origin: over.origin }),
  }
}

/** 一份"什么情况都有"的 v1 档案（`long` 是老字段名）。 */
function legacyArchive() {
  return {
    format: 1,
    mind: {
      version: 1,
      persona: { voice: { brevity: 0.3, warmth: 0.52, directness: 0.56 }, traits: [], kernelHistory: [] },
      baseline: { valence: 0.04, arousal: 0.25, dominance: 0.49 },
      stats: { sessions: 1, turns: 2, pulses: 224, notes: 0, recalls: 0 },
      memory: {
        short: [
          entry({ id: 's1', kind: 'lesson', text: '这个项目用 pnpm 装依赖', ws: HERE, origin: 'heard' }),
          entry({ id: 's2', kind: 'fact', text: '还没选工作区时说过的一句话' }),
        ],
        long: [
          entry({ id: 'l1', kind: 'preference', text: '注释一律用中文', ws: '', importance: 0.7 }),
          entry({ id: 'l2', kind: 'agreement', text: '这个项目用 pnpm，不要用 npm', ws: HERE, importance: 0.85 }),
          entry({ id: 'l3', kind: 'lesson', text: '未分组会话里定下的做法', ws: null, sessionId: SESSION }),
          entry({ id: 'l4', kind: 'fact', text: '当年没记归属的一条' }),
          entry({ id: 'l5', kind: 'lesson', text: '未分组但不知道是哪个会话', ws: null }),
          { id: 'bad', kind: '说不清的种类', text: '读不懂的那种' },
        ],
        forgotten: [{ id: 'gone-1', at: 1_700_000_001_000 }],
        pendingSignals: 0,
        updatedAt: 1_700_000_002_000,
      },
      savedAt: 1_700_000_002_000,
    },
  }
}

function tempDir(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), tag))
  mkdirSync(dir, { recursive: true })
  return dir
}

test('v1→v3：老档案按归属拆成快照，读不懂的报数、只搬一次，旧文件改名进 archive/', () => {
  const dir = tempDir('mind-migrate-v1-')
  try {
    const archiveFile = path.join(dir, 'state.json')
    writeFileSync(archiveFile, JSON.stringify(legacyArchive()), 'utf8')
    writeFileSync(path.join(dir, 'memory.md'), '# 旧的只读镜像\n', 'utf8')

    const res = migrateToV3({ stateDir: dir, archiveFile, now: NOW })

    assert.equal(res.migrated, true, '第一次要真的搬')
    assert.equal(res.from, 'v1', '认出这是 v1 的档案（没有 global/session 那些 v2 字段名）')
    assert.equal(res.counts.global, 4, '全局：显式全局 + 带工作区 + 两条 legacy')
    assert.equal(res.counts.workspace, 1, '其中一条带出处')
    assert.equal(res.counts.session, 1, '未分组会话那条进会话记忆')
    assert.equal(res.counts.short, 2)
    assert.deepEqual(res.counts.sessions, [SESSION])
    assert.equal(res.counts.dropped, 1, '种类读不懂的那条要被丢掉并报数')
    assert.equal(res.counts.files, 5, '全局 1 + 人设 1 + 会话 1 + 短期 2 份快照')

    // ---- 全局：四条，归属如实 ----
    const global = loadGlobal(dir)
    assert.equal(global.dropped, 0)
    assert.equal(global.entries.length, 4)

    const pref = global.entries.find((e) => e.id === 'l1')
    assert.equal(pref.scope, 'global')
    assert.equal(pref.legacy, undefined, '显式全局不是"老档案"')
    assert.equal(pref.where, undefined)

    const wsEntry = global.entries.find((e) => e.id === 'l2')
    assert.equal(wsEntry.scope, 'workspace')
    assert.equal(wsEntry.where, HERE, '要明写出处')
    assert.equal(wsEntry.ws, HERE)

    const legacy = global.entries.find((e) => e.id === 'l4')
    assert.equal(legacy.legacy, true, '当年没记归属就要如实标出来')
    assert.equal(legacy.scope, 'global')

    const noSession = global.entries.find((e) => e.id === 'l5')
    assert.equal(noSession.legacy, true, '不知道是哪个会话，也不能编一个')
    assert.equal(noSession.sessionId, undefined)

    // ---- 会话日记：独立一份快照文件，带上 sessionId ----
    assert.equal(sessionMemoryFile(dir, SESSION).endsWith('.jsonl.zst'), true)
    const session = loadSession(dir, SESSION)
    assert.equal(session.entries.length, 1)
    assert.equal(session.entries[0].id, 'l3')
    assert.equal(session.entries[0].sessionId, SESSION)

    // ---- 短期：按工作区两份（空工作区那份落在 `_global`）----
    const here = loadShort(dir, HERE)
    assert.equal(here.entries.length, 1)
    assert.equal(here.entries[0].id, 's1')
    assert.equal(here.entries[0].scope, 'workspace')
    const ungrouped = loadShort(dir, '')
    assert.equal(ungrouped.entries.length, 1)
    assert.equal(ungrouped.entries[0].id, 's2')
    assert.equal(ungrouped.entries[0].ws, undefined, '不知道工作区就不写 ws')

    // ---- 人设的跨会话部分 + 遗忘名单（丢了它会自己冒回来）----
    const persona = loadPersonaState(dir)
    assert.equal(persona.baseline.arousal, 0.25)
    assert.equal(persona.forgotten.length, 1, '遗忘名单必须跟着走')

    // ---- 简介写给人看（v3 只剩这两份 md：全局的与会话目录里的）----
    const summary = readFileSync(globalSummaryFile(dir), 'utf8')
    assert.match(summary, /# 全局记忆简介/)
    assert.match(summary, /这个工作区里说的/)
    assert.match(summary, /当年没记归属/)
    assert.equal(existsSync(path.join(dir, 'mirror', 'memory.md')), false, 'v3 不再产出镜像')

    // ---- 退休：改名进 archive/，不删 ----
    assert.equal(existsSync(path.join(dir, 'state.json')), false, '旧 state.json 不在原位了')
    const boxed = JSON.parse(readFileSync(path.join(dir, 'archive', 'state.v1.json'), 'utf8'))
    assert.equal(boxed.format, 1, 'archive 里那份是原样的源头')
    assert.equal(readFileSync(path.join(dir, 'archive', 'memory.v1.md'), 'utf8'), '# 旧的只读镜像\n')

    // ---- 幂等：第二次什么都不做 ----
    const again = migrateToV3({ stateDir: dir, archiveFile, now: NOW })
    assert.equal(again.migrated, false)
    assert.equal(again.from, 'none')
    assert.match(again.note, /标记/)
    assert.match(readFileSync(migrationFile(dir), 'utf8'), /migrated-to-v3|来源：v1/)
    assert.equal(globalPersonaFile(dir).endsWith(path.join('global', 'persona.jsonl.zst')), true)
    assert.equal(globalMemoryFile(dir).endsWith(path.join('global', 'memory.jsonl.zst')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v2→v3：聚合档案是活的权威（落地文件里多出来的条目不复活）；9 类旧文件全部改名进 archive/', () => {
  const dir = tempDir('mind-migrate-v2-')
  try {
    mkdirSync(path.join(dir, 'global'), { recursive: true })
    mkdirSync(path.join(dir, 'short'), { recursive: true })
    mkdirSync(path.join(dir, 'sessions', SESSION), { recursive: true })
    mkdirSync(path.join(dir, 'mirror'), { recursive: true })

    // v2 的落地文件（运行时那份其实是死的，但迁移路径必须读得动它）
    writeFileSync(
      path.join(dir, 'global', 'memory.json'),
      JSON.stringify({ version: 2, scope: 'global', updatedAt: 1, entries: [entry({ id: 'landed-only', kind: 'fact', text: '只在落地文件里的一条' })] }),
      'utf8',
    )
    writeFileSync(
      path.join(dir, 'global', 'persona.json'),
      JSON.stringify({ version: 2, savedAt: 1, persona: null, baseline: null, stats: null, forgotten: ['落地那份的名单'] }),
      'utf8',
    )
    writeFileSync(
      path.join(dir, 'short', `${safeKey(HERE)}.json`),
      JSON.stringify({ version: 2, scope: 'workspace', owner: HERE, updatedAt: 1, entries: [entry({ id: 's-landed', kind: 'fact', text: '落地文件里的手边事', ws: HERE })] }),
      'utf8',
    )
    writeFileSync(
      path.join(dir, 'sessions', SESSION, 'memory.json'),
      JSON.stringify({ version: 2, scope: 'session', owner: SESSION, updatedAt: 1, entries: [entry({ id: 'd-1', kind: 'lesson', text: '那段会话里学到的事', sessionId: SESSION, seq: 7 })] }),
      'utf8',
    )
    writeFileSync(path.join(dir, 'mirror', 'memory.md'), '# 旧的只读镜像\n', 'utf8')
    writeFileSync(path.join(dir, 'migrated-to-v2'), '2026-11-01T00:00:00.000Z\nv2 跑过了\n', 'utf8')

    // v2 的聚合档案：这一份才是每次 flush 都在写的那个
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        format: 1,
        mind: {
          persona: { voice: { brevity: 0.3, warmth: 0.5, directness: 0.5 }, traits: [], kernelHistory: [] },
          baseline: { valence: 0.04, arousal: 0.3, dominance: 0.49 },
          stats: { sessions: 4, turns: 9, pulses: 100, notes: 0, recalls: 0 },
          memory: {
            short: [entry({ id: 's-1', kind: 'fact', text: '手边的一条', ws: HERE })],
            session: [entry({ id: 'd-2', kind: 'agreement', text: '聚合档案里的会话日记', sessionId: SESSION, seq: 9 })],
            global: [entry({ id: 'g-1', kind: 'preference', text: '注释一律用中文', ws: '' })],
            forgotten: ['忘掉的那条'],
            updatedAt: 1,
          },
        },
      }),
      'utf8',
    )

    const res = migrateToV3({ stateDir: dir, archiveFile: path.join(dir, 'state.json'), now: NOW })

    assert.equal(res.migrated, true)
    assert.equal(res.from, 'v2', 'memory 里已经有 global/session 字段名，是 v2 的档案')
    assert.equal(res.counts.global, 1)
    assert.equal(res.counts.short, 1)
    assert.equal(res.counts.session, 2, '聚合档案 1 条 + 会话文件 1 条，按会话并起来')
    assert.deepEqual(res.counts.sessions, [SESSION])
    assert.equal(res.counts.dropped, 0)
    assert.equal(res.counts.files, 4, '全局 1 + 人设 1 + 会话 1 + 短期 1')

    // 聚合档案赢：只在落地文件里的那条不复活（两份真相正是用户抱怨的"前后不一致"）
    const global = loadGlobal(dir)
    assert.deepEqual(global.entries.map((e) => e.id), ['g-1'])
    assert.equal(global.entries.some((e) => e.id === 'landed-only'), false)

    // 会话日记按会话 id 并集去重
    assert.deepEqual(loadSession(dir, SESSION).entries.map((e) => e.id).sort(), ['d-1', 'd-2'])

    // 短期：聚合档案里的那一份（也带出处）
    const short = loadShort(dir, HERE)
    assert.equal(short.entries.length, 1)
    assert.equal(short.entries[0].id, 's-1')
    assert.equal(short.entries[0].where, undefined, '短期层不再重复写 where，出处看文件名与 ws')

    // 人设 / 基线 / 统计 / 遗忘名单：聚合档案优先
    const persona = loadPersonaState(dir)
    assert.equal(persona.baseline.arousal, 0.3)
    assert.equal(persona.stats.turns, 9)
    assert.deepEqual(persona.forgotten, ['忘掉的那条'], '聚合档案里的名单优先于落地副本')

    // 退休：9 类旧文件全部改名进 archive/，原位一个都不留
    for (const gone of [
      'state.json',
      path.join('global', 'memory.json'),
      path.join('global', 'persona.json'),
      path.join('short', `${safeKey(HERE)}.json`),
      path.join('sessions', SESSION, 'memory.json'),
      'migrated-to-v2',
      path.join('mirror', 'memory.md'),
    ]) {
      assert.equal(existsSync(path.join(dir, gone)), false, `该搬走的还在原位：${gone}`)
    }
    for (const boxed of [
      path.join('archive', 'state.v1.json'),
      path.join('archive', 'global', 'memory.json'),
      path.join('archive', 'global', 'persona.json'),
      path.join('archive', 'short', `${safeKey(HERE)}.json`),
      path.join('archive', 'sessions', SESSION, 'memory.json'),
      path.join('archive', 'migrated-to-v2'),
      path.join('archive', 'mirror', 'memory.md'),
    ]) {
      assert.equal(existsSync(path.join(dir, boxed)), true, `archive 里少了：${boxed}`)
    }
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'archive', 'state.v1.json'), 'utf8')).format, 1)

    // 幂等
    const again = migrateToV3({ stateDir: dir, archiveFile: path.join(dir, 'state.json'), now: NOW })
    assert.equal(again.migrated, false)
    assert.match(readFileSync(migrationFile(dir), 'utf8'), /来源：v2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('迁移：没有旧档案时按空档案起步，也不写标记（不把"没什么可搬"记成"搬过了"）', () => {
  const dir = tempDir('mind-migrate-empty-')
  try {
    const res = migrateToV3({ stateDir: dir, archiveFile: path.join(dir, 'state.json'), now: NOW })
    assert.equal(res.migrated, false)
    assert.equal(res.from, 'none')
    assert.match(res.note, /空档案/)
    assert.equal(existsSync(migrationFile(dir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
