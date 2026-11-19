#!/usr/bin/env node
/**
 * 第二个 adapter：命令行。
 *
 * 它存在的理由不是"多一个功能"，而是**验收 `dsh-mind-core` 是不是真的干净**：
 * 这里一行 DSH 的东西都没有（不 import `@deepseek-ai/*`、不认识会话日志对象，
 * 也不认识 Cordis），只把事件翻译成 `{ type, seq, time, data }` 喂给 core，
 * 再把 core 出来的两段文本按自己的方式用掉。
 *
 * 如果哪天 core 里偷偷长出了 DSH 专有的东西，这个文件会第一个跑不起来。
 *
 * 用法：
 *   node adapters/cli/mind-cli.mjs --demo               内置情景（三轮对话）
 *   node adapters/cli/mind-cli.mjs --events x.jsonl    每行一个事件：{type, time?, data?}
 *   node adapters/cli/mind-cli.mjs --demo --json       把结果打成 JSON（给别的程序用）
 */

import { readFileSync } from 'node:fs'
import { createEventStream, createMind, KIND_LABEL } from '../../../mind-core/lib/index.js'

const ARGS = process.argv.slice(2)
const has = (flag) => ARGS.includes(flag)
const valueOf = (flag) => {
  const i = ARGS.indexOf(flag)
  return i >= 0 ? ARGS[i + 1] : undefined
}

const MIN = 60_000
/** 固定起点，让输出可复现（core 里所有时间都来自事件，从不读时钟）。 */
const T0 = Date.parse('2026-01-01T09:00:00+08:00')
const at = (min) => T0 + Math.round(min * MIN)

/** 内置情景：约定 → 连续失败 → 道谢。正好覆盖记忆、情绪、思想三条线。 */
function demoEvents(es) {
  return [
    es.turnStart(1, at(0)),
    es.userMessage('记住：这个项目用 pnpm，不要用 npm', at(0.1)),
    es.assistantMessage('好，记下了。', at(0.3), 120),
    es.turnEnd(1, at(0.4)),

    es.turnStart(2, at(2)),
    es.userMessage('帮我把依赖装上', at(2.1)),
    es.toolCall('bash', { command: 'npm install' }, at(2.2), 'c1'),
    es.toolResult('bash', at(2.4), { callId: 'c1', error: 'CommandNotFound', isError: true }),
    es.toolCall('bash', { command: 'npm i' }, at(2.5), 'c2'),
    es.toolResult('bash', at(2.7), { callId: 'c2', error: 'CommandNotFound', isError: true }),
    es.toolCall(
      'inner_note',
      {
        intent: '装不上依赖',
        workingJudgment: '换 pnpm 试',
        tension: 0.6,
        // v2.3：记忆必须由它自己整理成一句话写下来（用户的原话一概不入库），
        // 所以这里顺手记一条——demo 里这三轮要覆盖记忆那条线。
        remember: '这个项目用 pnpm，不要用 npm',
        rememberKind: 'agreement',
      },
      at(2.8),
      'n1',
    ),
    es.assistantMessage('npm 好像不在，我换 pnpm 试。', at(2.9), 200),
    es.turnEnd(2, at(3)),

    es.turnStart(3, at(5)),
    es.userMessage('谢谢，这次对了', at(5.1)),
    es.assistantMessage('不客气。', at(5.3), 80),
    es.turnEnd(3, at(5.4)),
  ]
}

/** 从 JSONL 读事件（每行 `{type, time?, data?}`，`time` 缺省就用行号推）。 */
function loadEvents(file) {
  const out = []
  let seq = 1
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim()
    if (text === '' || text.startsWith('#')) continue
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`第 ${i + 1} 行不是合法 JSON：${text.slice(0, 60)}（${error.message}）`)
    }
    seq += 1
    out.push({
      type: String(parsed.type),
      seq,
      time: typeof parsed.time === 'number' ? parsed.time : T0 + seq,
      data: parsed.data,
    })
  }
  return out
}

function main() {
  const mind = createMind({ now: T0 })
  const es = createEventStream()
  const events = has('--events') ? loadEvents(valueOf('--events')) : demoEvents(es)

  const say = (s = '') => {
    if (!has('--json')) process.stdout.write(`${s}\n`)
  }

  const turns = []
  const stable = mind.assemble(T0).stable
  say('# dsh-mind-core · 命令行 adapter（没有一行 DSH）')
  say()
  say('## 事实核查：core 包的外部依赖')
  say('　零依赖、零 peerDependencies。它只认 `{ type, seq, time, data }`。')
  say()
  say('## 系统提示词那一段（stable，改动很少）')
  say(stable)
  say()
  say('## 请求末尾那一段（dynamic，每步都在变）')

  let folded = 0
  for (const event of events) {
    mind.observe(event)
    folded += 1
    if (event.type !== 'turn/end') continue

    const now = event.time
    const segments = mind.assemble(now)
    const state = mind.state()
    const emotions = state.affect.emotions
      .filter((trace) => Math.abs(trace.strength) >= 0.15)
      .map((trace) => `${trace.word}(${trace.strength.toFixed(2)})`)
      .join('、')
    const report = {
      turn: event.data?.turn,
      folded,
      dynamic: segments.dynamic,
      emotions,
      tension: Number(state.thought.tension.toFixed(2)),
      short: state.memory.short.length,
      session: state.memory.session.length,
      global: state.memory.global.length,
    }
    turns.push(report)

    say()
    say(`── 第 ${report.turn} 轮收束（已折 ${folded} 个事件）`)
    say(report.dynamic || '（这一段是空的——没有值得说的东西时它就该空着）')
    say(
      `　情绪：${report.emotions || '平静'}｜张力 ${report.tension}｜手边记忆 ${report.short} 条｜本会话日记 ${report.session} 条｜跨会话库 ${report.global} 条`,
    )
  }

  say()
  say('## 跨会话库：只能主动去查（"我想想"）')
  const query = '包管理器 pnpm'
  const hits = mind.recall(query, at(6), 3)
  say(`　查「${query}」→ ${hits.length === 0 ? '想不起来（不硬凑）' : ''}`)
  for (const hit of hits) {
    const label = KIND_LABEL[hit.entry.kind] ?? hit.entry.kind
    say(`　· [${label}] ${hit.entry.text}｜相似 ${hit.score.toFixed(2)}｜因为：${hit.entry.because}`)
  }

  say()
  say('## 面板 / 跨会话档案')
  const persist = mind.persist(at(6))
  say(`　档案里有：人设 1 份、跨会话库 ${persist.memory.global.length} 条、本会话日记 ${persist.memory.session.length} 条、手边记忆 ${persist.memory.short.length} 条`)
  say(`　性情基线 ${persist.baseline.valence.toFixed(2)}/${persist.baseline.arousal.toFixed(2)}/${persist.baseline.dominance.toFixed(2)}`)
  say('　落盘三处（v3：一行一份快照，读最后一行）：global/memory.jsonl.zst（跨会话库）、sessions/<会话 id>/memory.jsonl.zst（本会话日记，可修订）、short/<工作区>.jsonl.zst（短期，全量覆盖）')
  say(`　累计：回合 ${persist.stats.turns}｜情绪脉冲 ${persist.stats.pulses}｜主动开口 ${persist.stats.proactive}`)

  if (has('--json')) {
    process.stdout.write(`${JSON.stringify({ stable, turns, recall: hits.map((h) => h.entry.text), persist }, null, 2)}\n`)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`mind-cli 出错：${error.message}\n`)
  process.exit(1)
}
