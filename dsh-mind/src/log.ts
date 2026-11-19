/**
 * 插件自己的日志。
 *
 * 为什么不用 `ctx.logger` 就够了：**headless 下没人接它**，调试日志完全看不见
 * （feiyu-memory 在真实 DSH 里踩到的 7 个致命问题之一）。
 * 所以这里留一个内存环形缓冲（`/mind log` 能看），并可选落文件。
 *
 * 两条纪律：
 * 1. 日志本身**永远不许抛**（日志把插件搞挂是最蠢的死法）；
 * 2. 缓冲有上限（不许无限增长）。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { LoggerLike, MindContext } from './host.js'

/** 环形缓冲最多留多少行。 */
const RING_MAX = 200

const ring: string[] = []
let sink: LoggerLike | undefined
let filePath: string | undefined
let verbose = false

function push(level: string, args: unknown[]): void {
  try {
    const line = `${new Date().toISOString()} [${level}] ${args.map(format).join(' ')}`
    ring.push(line)
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
    if (filePath !== undefined) {
      try {
        mkdirSync(path.dirname(filePath), { recursive: true })
        appendFileSync(filePath, `${line}\n`, 'utf8')
      } catch {
        /* 落盘失败不影响任何事 */
      }
    }
  } catch {
    /* 连格式化都失败就算了 */
  }
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 接上宿主的日志器（可选）。 */
export function configureLogger(
  ctx: MindContext,
  options: { verbose: boolean; file?: string | undefined },
): void {
  sink = ctx.logger
  verbose = options.verbose
  filePath = options.file !== undefined && options.file !== '' ? options.file : undefined
}

export const logger = {
  info(...args: unknown[]): void {
    push('info', args)
    try {
      sink?.info?.(...args)
    } catch {
      /* 忽略 */
    }
  },
  warn(...args: unknown[]): void {
    push('warn', args)
    try {
      sink?.warn?.(...args)
    } catch {
      /* 忽略 */
    }
  },
  error(...args: unknown[]): void {
    push('error', args)
    try {
      sink?.error?.(...args)
    } catch {
      /* 忽略 */
    }
  },
  /** 只有开了 `debugLog` 才落缓冲（不然每步都在写）。 */
  debug(...args: unknown[]): void {
    if (!verbose) return
    push('debug', args)
    try {
      sink?.debug?.(...args)
    } catch {
      /* 忽略 */
    }
  },
  /** 最近若干行（`/mind log` 用）。 */
  tail(limit = 20): string[] {
    return ring.slice(-limit)
  },
  /** 是否在写缓冲（诊断用）。 */
  get verbose(): boolean {
    return verbose
  },
}
