/**
 * 人设层：只有一份，但整体会演化。
 *
 * 三档速度，**每档有自己的闸门**：
 *
 * | 档 | 变化幅度 | 时间尺度 | 闸门 |
 * |---|---|---|---|
 * | 说话习惯 voice | ±0.2 | 周 | 单次 ±0.01 |
 * | 自我认知 traits | 证据制 | 周–月 | hits≥3 且跨≥2 天 |
 * | 内核 kernel | ±0.02 | **年** | 证据≥8 且跨≥60 天，且留快照可回滚 |
 *
 * 内核**不是不许变**——人三年后性格确实不同。它是**变得慢、变得小、变得有据可查**。
 * 唯一真正锁死的是硬边界 boundaries：任何演化路径都不碰它。
 */

import type { MindTunables } from './config.js'
import { DAY } from './dynamics.js'
import type { KernelSnapshot, PersonaState, Trait, VoiceState } from './types.js'

/** 说话习惯的允许区间（相对初始 0.5 的 ±limit）。 */
function voiceBounds(limit: number): { lo: number; hi: number } {
  return { lo: 0.5 - limit, hi: 0.5 + limit }
}

function clampVoice(v: number, limit: number): number {
  const { lo, hi } = voiceBounds(limit)
  return v < lo ? lo : v > hi ? hi : v
}

/** 自我陈述 -> 主题键。 */
export function traitKeyOf(text: string): string {
  // 去掉标点与空白，取前 12 个字作为"同一件事"的判定依据。
  // 这是个刻意的粗粒度做法：宁可把两件相近的事算成一件，也不要把同一件事算成十件。
  const cleaned = text.replace(/[\s，。；：、！？"'（）()【】\[\]—…·]/g, '')
  return cleaned.slice(0, 12)
}

/**
 * 从一条自我陈述里积累证据。
 * 同一个主题反复出现，并且**跨越了时间**，才会被提升为自我认知。
 */
export function observeSelfStatement(
  persona: PersonaState,
  text: string,
  at: number,
  t: MindTunables,
): PersonaState {
  const label = text.replace(/\s+/g, ' ').trim()
  const key = traitKeyOf(label)
  if (!key) return persona

  const traits = persona.traits.map((x) => ({ ...x }))
  const existing = traits.find((x) => x.key === key)
  if (existing) {
    existing.hits += 1
    existing.lastAt = at
    existing.label = label
    existing.spanDays = (existing.lastAt - existing.firstAt) / DAY
    // 反复被印证 -> 权重涨，但涨得很慢。
    existing.weight = Math.min(existing.weight + t.traitDrift / 4, 1)
    if (existing.hits < t.traitMinHits || existing.spanDays < t.traitMinSpanDays) {
      // 证据还不够：留在候选区（traits 里 weight 低的那批），不参与提示词。
      return { ...persona, traits, updatedAt: at }
    }
  } else {
    traits.push({
      key,
      label,
      weight: 0.2,
      hits: 1,
      firstAt: at,
      lastAt: at,
      spanDays: 0,
      settledAt: null,
    })
    return { ...persona, traits, updatedAt: at }
  }

  // 到达阈值 -> 正式提升（这里只标记，权重已经在上面涨过了）。
  const promoted = traits.find((x) => x.key === key)
  if (promoted && promoted.weight < 0.5) promoted.weight = 0.5
  return { ...persona, traits, driftCount: persona.driftCount, updatedAt: at }
}

/** 已经立住的自我认知（进提示词的就是这些）。 */
export function settledTraits(persona: PersonaState, t: MindTunables): Trait[] {
  return persona.traits
    .filter((x) => x.hits >= t.traitMinHits && x.spanDays >= t.traitMinSpanDays && x.weight >= 0.5)
    .sort((a, b) => b.weight - a.weight)
}

/**
 * 内核沉淀：反复出现的自我认知，久了会变成"我就是这样的人"。
 * 这是那人设按年变化的唯一入口，四条限制都在这里。
 */
export function settleKernel(persona: PersonaState, at: number, t: MindTunables): PersonaState {
  const candidates = persona.traits.filter(
    (x) =>
      x.settledAt === null && x.hits >= t.kernelMinEvidence && x.spanDays >= t.kernelMinSpanDays,
  )
  if (candidates.length === 0) return persona

  let values = { ...persona.kernel.values }
  const history: KernelSnapshot[] = [...persona.kernelHistory]
  let changed = 0

  for (const trait of candidates) {
    const before = values[trait.key] ?? 0
    // 单次改动幅度天花板（kernelDrift），方向永远朝"更像那件事"。
    const after = before + Math.sign(1 - before || 1) * t.kernelDrift
    const bounded = Math.abs(after - before) > t.kernelDrift ? before + t.kernelDrift : after
    history.push({
      at,
      reason: `「${trait.label}」被反复印证 ${trait.hits} 次、跨 ${trait.spanDays.toFixed(0)} 天，沉淀成内核的一部分`,
      evidence: [`hits=${trait.hits}`, `spanDays=${trait.spanDays.toFixed(1)}`],
      values: { ...values },
    })
    values[trait.key] = Number(bounded.toFixed(4))
    changed += 1
  }

  const traits = persona.traits.map((x) =>
    candidates.some((c) => c.key === x.key) ? { ...x, settledAt: at } : x,
  )

  return {
    ...persona,
    kernel: { ...persona.kernel, values },
    kernelHistory: history.slice(-t.kernelHistoryKeep),
    traits,
    driftCount: persona.driftCount + changed,
    updatedAt: at,
  }
}

/** 回滚到某一次内核快照之前。 */
export function rollbackKernel(persona: PersonaState, index: number, at: number): PersonaState {
  const snapshot = persona.kernelHistory[index]
  if (!snapshot) return persona
  return {
    ...persona,
    kernel: { ...persona.kernel, values: { ...snapshot.values } },
    kernelHistory: [
      ...persona.kernelHistory,
      {
        at,
        reason: `回滚到 ${new Date(snapshot.at).toISOString()} 的那份内核`,
        evidence: ['手动回滚'],
        values: { ...persona.kernel.values },
      },
    ],
    updatedAt: at,
  }
}

/** 说话习惯漂移：单次幅度极小，且有硬上限。 */
export function driftVoice(
  persona: PersonaState,
  delta: Partial<VoiceState>,
  at: number,
  t: MindTunables,
): PersonaState {
  const step = 0.01
  const voice: VoiceState = {
    brevity: clampVoice(persona.voice.brevity + Math.sign(delta.brevity ?? 0) * step, t.voiceDrift),
    warmth: clampVoice(persona.voice.warmth + Math.sign(delta.warmth ?? 0) * step, t.voiceDrift),
    directness: clampVoice(
      persona.voice.directness + Math.sign(delta.directness ?? 0) * step,
      t.voiceDrift,
    ),
    initiative: clampVoice(
      persona.voice.initiative + Math.sign(delta.initiative ?? 0) * step,
      t.voiceDrift,
    ),
  }
  if (
    voice.brevity === persona.voice.brevity &&
    voice.warmth === persona.voice.warmth &&
    voice.directness === persona.voice.directness &&
    voice.initiative === persona.voice.initiative
  ) {
    return persona
  }
  return { ...persona, voice, updatedAt: at }
}

/**
 * 记一次互动（关系在变，同时推动说话习惯）。
 *
 * 四根轴**每根都有双向的驱动源**（v2.4.x 修）：原来只有两条单向的
 * ——"被谢 → 温度 +1"、"被驳回 → 直给 +1"——于是那两根只会一路爬到硬上限、
 * 再也下不来（真机证据：`directness` 停在 0.50+0.20 的上限上）。
 */
export function noteInteraction(
  persona: PersonaState,
  ev: {
    thanks?: boolean
    pushback?: boolean
    interrupt?: boolean
    question?: boolean
    repeat?: boolean
    turn?: boolean
  },
  at: number,
  t: MindTunables,
): PersonaState {
  const relation = { ...persona.relation, lastSeenAt: at }
  if (ev.turn) relation.turns += 1
  if (ev.thanks) relation.thanks += 1
  if (ev.pushback) relation.pushbacks += 1
  const next: PersonaState = { ...persona, relation, updatedAt: at }

  const delta: Partial<VoiceState> = {}
  // 温度：被谢/被夸 → 暖；被驳回/被打断 → 收着点
  if (ev.thanks) delta.warmth = 1
  if (ev.pushback || ev.interrupt) delta.warmth = -1
  // 直给：被驳回 → 少绕弯、直接改；同一件事被重复说 → 上一遍没讲清，得铺垫
  if (ev.pushback) delta.directness = 1
  if (ev.repeat) delta.directness = -1
  // 主动：被追问 → 多给一层；被打断 → 说明多嘴了
  if (ev.question) delta.initiative = 1
  if (ev.interrupt) delta.initiative = -1
  // 同时被谢又被打断这种矛盾输入：让"收着"压过"暖"，宁可少说一句
  if (ev.interrupt && delta.warmth !== undefined && delta.warmth > 0) delta.warmth = -1

  if (Object.keys(delta).length === 0) return next
  return driftVoice(next, delta, at, t)
}

/** 用户给的 persona.md 直接接管内核（这不算演化，不写快照）。 */
export function adoptKernel(
  persona: PersonaState,
  kernel: { name?: string; values?: Record<string, number>; boundaries?: string[] },
  at: number,
): PersonaState {
  return {
    ...persona,
    kernel: {
      name: kernel.name ?? persona.kernel.name,
      values: { ...persona.kernel.values, ...(kernel.values ?? {}) },
      boundaries: kernel.boundaries ?? persona.kernel.boundaries,
    },
    updatedAt: at,
  }
}

/** 把硬边界拿出来单独展示（它们是唯一不许自动变的东西）。 */
export function boundariesOf(persona: PersonaState): string[] {
  return persona.kernel.boundaries
}

/** 给面板/命令看的几行中文。 */
export function describePersona(persona: PersonaState, t: MindTunables): string[] {
  const lines: string[] = []
  const v = persona.voice
  lines.push(
    `语气：简洁 ${v.brevity.toFixed(2)} / 温度 ${v.warmth.toFixed(2)} / 直给 ${v.directness.toFixed(2)}（区间 ±${t.voiceDrift}）`,
  )
  const settled = settledTraits(persona, t)
  const pending = persona.traits.length - settled.length
  if (settled.length > 0) {
    lines.push('自我认知（已立住）：')
    for (const trait of settled.slice(0, 5)) {
      lines.push(`　· ${trait.label}（见过 ${trait.hits} 次，前后跨 ${trait.spanDays.toFixed(1)} 天）`)
    }
  }
  // 这些话是给人看的：不用"沉淀""年尺度"这类内部说法
  if (pending > 0) lines.push(`候选自我认知：${pending} 条（还不足以写进"我是谁"，先记着）`)
  const kernelKeys = Object.keys(persona.kernel.values)
  lines.push(
    kernelKeys.length === 0
      ? '内核：还没定下来（这类东西一年才可能动一次）'
      : `内核：${kernelKeys.map((k) => `${k}=${persona.kernel.values[k]}`).join('、')}`,
  )
  if (persona.kernelHistory.length > 0) {
    lines.push(`内核变化历史：${persona.kernelHistory.length} 条（可回滚）`)
  }
  if (persona.kernel.boundaries.length > 0) {
    lines.push(`硬边界（永不自动变）：${persona.kernel.boundaries.join('；')}`)
  }
  return lines
}
