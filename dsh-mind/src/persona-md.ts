/**
 * 人设内核文件（`persona.md`）的读写。
 *
 * 为什么内核要放文件而不是写死在代码里：
 * 内核是**唯一"只有用户能直接改"**的东西（硬边界尤其），放文件里用户才改得动；
 * 也因为出厂人格写死在代码里是竞品踩过的坑（包装进 profile 的 node_modules 后相对路径会变脆）。
 *
 * 格式故意做得极简——用户手写不吃力，解析器也不用写成一个 YAML 实现：
 *
 * ```
 * 名字: 小和
 * 价值观:
 *   - 诚实: 0.9
 *   - 不图快: 0.7
 * 边界:
 *   - 不做破坏性操作
 *   - 不编造事实
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 从文件里读出来的内核片段（全部可选：写多少算多少）。 */
export interface KernelPatch {
  name?: string
  values?: Record<string, number>
  boundaries?: string[]
}

/** 解析结果。 */
export interface ParsedPersona {
  patch: KernelPatch
  /** 有没有真的读到内容（空文件等于没有内核）。 */
  nonEmpty: boolean
  note: string
}

/** 读内核文件；不存在或读不动都返回 null（绝不抛）。 */
export function readPersonaKernel(file: string): ParsedPersona | null {
  try {
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8')
    return { ...parsePersonaText(text), note: '已读取人设内核文件' }
  } catch {
    return null
  }
}

/** 解析文本（与文件读取分开，方便单测）。 */
export function parsePersonaText(text: string): { patch: KernelPatch; nonEmpty: boolean } {
  const patch: KernelPatch = {}
  const values: Record<string, number> = {}
  const boundaries: string[] = []

  let section: 'values' | 'boundaries' | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    // 段落标题
    if (/^(价值观|values)\s*[:：]?$/i.test(line)) {
      section = 'values'
      continue
    }
    if (/^(边界|硬边界|boundaries)\s*[:：]?$/i.test(line)) {
      section = 'boundaries'
      continue
    }

    // 名字可以出现在任何位置
    const nameMatch = /^(名字|自称|name)\s*[:：]\s*(.+)$/i.exec(line)
    if (nameMatch !== null) {
      patch.name = nameMatch[2]?.trim() ?? ''
      section = null
      continue
    }

    // 列表项
    const item = /^[-·*]\s*(.+)$/.exec(line)
    const body = item !== null ? (item[1]?.trim() ?? '') : line

    if (section === 'values' || /[:：]/.test(body)) {
      const kv = /^(.+?)\s*[:：]\s*(-?[\d.]+)$/.exec(body)
      if (kv !== null && section !== 'boundaries') {
        const key = kv[1]?.trim() ?? ''
        const value = Number(kv[2])
        if (key !== '' && Number.isFinite(value)) values[key] = value
        continue
      }
    }

    if (section === 'boundaries' && body !== '') {
      boundaries.push(body)
      continue
    }

    if (section === 'values' && body !== '') {
      // 写了价值观但没写权重：给一个中性权重，比丢掉好
      values[body] = 0.5
    }
  }

  if (Object.keys(values).length > 0) patch.values = values
  if (boundaries.length > 0) patch.boundaries = boundaries
  const nonEmpty = Object.keys(patch).length > 0
  return { patch, nonEmpty }
}

/** 首次运行时写一份带注释的模板，让用户有个能改的东西。 */
export function writePersonaTemplate(file: string): boolean {
  try {
    if (existsSync(file)) return false
    const template = [
      '# dsh-mind 人设内核',
      '#',
      '# 这一份是「内核」——唯一只有你能直接改的东西。三个速度里的最慢一档：',
      '# 它自己也会变，但要走"年尺度"的闸门（证据 ≥8 次、跨 ≥60 天、单次幅度 ≤0.02），',
      '# 而且每次改动都留快照、可回滚。',
      '#',
      '# 下面全部可以留空：留空就是"还没有内核"，它只用性情开局。',
      '#',
      '',
      '名字:',
      '',
      '价值观:',
      '  # 权重 0..1，越接近 1 越优先',
      '  # - 诚实: 0.9',
      '',
      '边界:',
      '  # 这些行永远不会被自动改写。',
      '  # - 不做破坏性操作',
      '',
    ].join('\n')
    writeFileSync(file, template, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 给 `/mind persona` 展示时用的路径说明。 */
export function describePath(file: string): string {
  return path.relative(process.cwd(), file) === '' ? file : file
}
