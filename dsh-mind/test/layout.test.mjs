// v3.0 存储布局的单元测试。
//
// 这一层是纯路径与落盘动作，不依赖状态形状，所以单独测：
// 路径算错、原子写写坏、zstd 读不动就抛——都是那种"跑起来看着没事、真出事时数据没了"的错，
// 必须有断言兜着。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  SNAPSHOT_KEEP,
  archiveDir,
  archiveFile,
  globalDir,
  globalMemoryFile,
  globalPersonaFile,
  globalSummaryFile,
  listSessionIds,
  listShortFiles,
  logFile,
  migrationFile,
  readJson,
  readText,
  readZstdLines,
  rootDir,
  safeKey,
  sessionDir,
  sessionMemoryFile,
  sessionSummaryFile,
  sessionsDir,
  shortDir,
  shortFile,
  writeJsonAtomic,
  writeTextAtomic,
  writeZstdLines,
} from '../lib/index.js'

/** 每个用例一个临时根目录，用完就删。 */
function tempRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mind-layout-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('safeKey：空键叫 _global，不同的工作区键不会撞名，且不含路径分隔符', () => {
  assert.equal(safeKey(''), '_global')
  assert.equal(safeKey('   '), '_global')

  const here = safeKey('E:/code/thought')
  const there = safeKey('E:/code/other')

  // 不该出现 `/`、`\`、`:` —— 它们是分隔符或非法字符
  for (const key of [here, there]) {
    assert.equal(/[/\\:]/.test(key), false, `安全检查：${key}`)
  }
  assert.notEqual(here, there, '两个不同的工作区必须落到两个文件')

  // 可读 slug 还在（人能一眼看出是哪个工作区的），哈希在尾部兜底
  assert.match(here, /-/, '要有 slug 与哈希两段')
  assert.equal(here, safeKey('E:/code/thought'), '同一个键必须稳定')

  // 归一化前后只差斜杠风格的键，算**不同**工作区也没问题（宁可多一份，不许串味），
  // 但必须各自稳定、且都不含非法字符
  const backslash = safeKey('E:\\code\\thought')
  assert.equal(/[/\\:]/.test(backslash), false)
  assert.equal(backslash, safeKey('E:\\code\\thought'))
})

test('路径全在根目录下，会话 id 被归一化后不会跑到目录外面', () => {
  const root = 'E:/tmp/mind'
  assert.equal(rootDir(root), path.normalize(root))
  assert.equal(rootDir('E:\\tmp\\mind\\'), path.normalize(root), '反斜杠与尾斜杠都要归一化')
  for (const file of [
    globalDir(root),
    globalMemoryFile(root),
    globalPersonaFile(root),
    globalSummaryFile(root),
    sessionsDir(root),
    shortDir(root),
    archiveDir(root),
    logFile(root),
    migrationFile(root),
  ]) {
    assert.equal(file.startsWith(path.normalize(root) + path.sep), true, `越界了：${file}`)
  }
  // v3 一律 jsonl.zst（快照）与 summary.md（人读的那份）
  assert.equal(globalMemoryFile(root).endsWith(path.join('global', 'memory.jsonl.zst')), true)
  assert.equal(globalPersonaFile(root).endsWith(path.join('global', 'persona.jsonl.zst')), true)
  assert.equal(globalSummaryFile(root).endsWith(path.join('global', 'summary.md')), true)
  assert.equal(logFile(root).endsWith(path.join('log', 'mind.log')), true)
  assert.equal(shortFile(root, 'E:/code/thought').endsWith(`${safeKey('E:/code/thought')}.jsonl.zst`), true)
  assert.equal(migrationFile(root).endsWith('migrated-to-v3'), true)
  assert.equal(archiveDir(root).endsWith(`${path.sep}archive`), true)

  // 恶意/意外的 id：不许跨目录
  const evil = sessionMemoryFile(root, '../../etc/passwd')
  assert.equal(evil.startsWith(sessionsDir(root) + path.sep), true, `归一化失败：${evil}`)
  assert.equal(evil.includes('..'), false)
  const evilDir = sessionDir(root, 'a/b')
  assert.equal(evilDir.startsWith(sessionsDir(root) + path.sep), true)
  assert.equal(path.basename(evilDir).includes('/'), false)
  assert.equal(sessionSummaryFile(root, 's').endsWith(path.join('summary.md')), true)
})

test('原子写：会建父目录、读得回来；文件缺失或内容坏掉都返回 undefined', () => {
  const { dir, done } = tempRoot()
  try {
    const file = globalMemoryFile(dir)
    assert.equal(writeJsonAtomic(file, { entries: [{ text: '这个项目用 pnpm' }] }), true)
    assert.equal(existsSync(file), true)
    assert.equal(existsSync(`${file}.tmp`), false, '不许留下 .tmp')

    const back = readJson(file)
    assert.deepEqual(back, { entries: [{ text: '这个项目用 pnpm' }] })

    // 人可读：缩进过的 JSON + 结尾换行
    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /\n {2}"entries"/, '要缩进，人能直接打开看')
    assert.equal(raw.endsWith('\n'), true)

    // 缺失
    assert.equal(readJson(path.join(dir, 'nope.json')), undefined)
    assert.equal(readText(path.join(dir, 'nope.json')), undefined)

    // 坏内容
    const broken = path.join(dir, 'broken.json')
    writeTextAtomic(broken, '{ 不是 JSON')
    assert.equal(readJson(broken), undefined, '坏文件要回落，而不是抛出去')
    assert.equal(readText(broken), '{ 不是 JSON', '文本读法照旧读得到')
  } finally {
    done()
  }
})

test('zstd 快照：中文往返、原子写；文件缺失或不是 zstd 都只报原因，绝不抛', () => {
  const { dir, done } = tempRoot()
  try {
    // v2.4.x 把这档从 20 提到了 50（快照是"假删"的第二层保证：写满以后一次清空就会把
    // 旧内容挤出窗口——真机上实测过）。所以这里不钉死数字，钉"它是个够大的正经历史窗口"；
    // 真正的裁剪行为由 store.test.mjs 断言（用同一个常数，不写死）。
    assert.ok(Number.isInteger(SNAPSHOT_KEEP) && SNAPSHOT_KEEP >= 20, `裁剪上限要够大：现在 ${SNAPSHOT_KEEP}`)

    const file = globalMemoryFile(dir)
    assert.equal(writeZstdLines(file, ['{"a":1}', '{"b":"中文也要原样回来"}']), true)
    assert.equal(existsSync(file), true)
    assert.equal(existsSync(`${file}.tmp`), false, '不许留下 .tmp')
    const back = readZstdLines(file)
    assert.equal(back.error, undefined)
    assert.deepEqual(back.lines, ['{"a":1}', '{"b":"中文也要原样回来"}'])

    // 缺文件是常态（首次运行），不是"坏了"
    assert.deepEqual(readZstdLines(path.join(dir, 'nope.jsonl.zst')), { lines: [], error: 'missing' })

    // 不是 zstd（被外部工具改坏、或写了一半）：读不动，但要给得出原因
    const broken = path.join(dir, 'broken.jsonl.zst')
    writeTextAtomic(broken, '这不是 zstd')
    assert.deepEqual(readZstdLines(broken), { lines: [], error: 'unreadable' })

    // 空行不认：写的时候不留，读的时候也滤掉
    const blank = path.join(dir, 'blank.jsonl.zst')
    assert.equal(writeZstdLines(blank, ['', '  ', '{"x":1}']), true)
    assert.deepEqual(readZstdLines(blank).lines, ['{"x":1}'])

    // 覆盖写：旧内容不许残留
    assert.equal(writeZstdLines(file, ['{"only":true}']), true)
    assert.deepEqual(readZstdLines(file).lines, ['{"only":true}'])
  } finally {
    done()
  }
})

test('listSessionIds / listShortFiles：只认自己那一种，坏路径给空数组', () => {
  const { dir, done } = tempRoot()
  try {
    assert.deepEqual(listSessionIds(dir), [], '还没有任何会话目录')
    assert.deepEqual(listShortFiles(dir), [], '还没有任何短期文件')
    for (const id of ['session-b', 'session-a']) {
      assert.equal(writeZstdLines(sessionMemoryFile(dir, id), ['{}']), true)
    }
    // 顺带放一个不是目录的东西，别把它算进来
    writeTextAtomic(path.join(sessionsDir(dir), 'stray.txt'), 'x')
    assert.deepEqual(listSessionIds(dir), ['session-a', 'session-b'])

    assert.equal(writeZstdLines(shortFile(dir, 'E:/code/thought'), ['{}']), true)
    writeTextAtomic(path.join(shortDir(dir), 'notes.txt'), 'x')
    assert.deepEqual(listShortFiles(dir), [shortFile(dir, 'E:/code/thought')])
  } finally {
    done()
  }
})

test('archiveFile：搬进 archive/ 是改名不是复制；目标已存在时不覆盖也不删源', () => {
  const { dir, done } = tempRoot()
  try {
    const source = path.join(dir, 'state.json')
    const target = path.join(archiveDir(dir), 'state.v1.json')
    writeTextAtomic(source, 'v1 的档案')

    assert.equal(archiveFile(source, target), true)
    assert.equal(existsSync(source), false, '是改名，不是复制')
    assert.equal(readText(target), 'v1 的档案')

    writeTextAtomic(source, '后来的另一份')
    assert.equal(archiveFile(source, target), true)
    assert.equal(readText(target), 'v1 的档案', 'archive 里的证据不许被后来的盖掉')
    assert.equal(existsSync(source), true, '盖不成就留在原地，不删它')

    // 源不存在也算成功："本来就没有"不是失败
    assert.equal(archiveFile(path.join(dir, 'nope.json'), target), true)

    // 目标目录会被建出来（archive/ 一开始并不存在）
    const deep = path.join(archiveDir(dir), 'sessions', 'session-x', 'memory.json')
    writeTextAtomic(path.join(dir, 'memory.json'), 'x')
    assert.equal(archiveFile(path.join(dir, 'memory.json'), deep), true)
    assert.equal(existsSync(deep), true)
    mkdirSync(dir, { recursive: true })
  } finally {
    done()
  }
})
