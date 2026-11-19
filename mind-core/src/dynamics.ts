/**
 * 动力学：情感怎么衰减、怎么被推离基线、怎么回来。
 *
 * 只有一个公式，全篇复用：
 *
 *     regress(value, base, dt, halfLife) = base + (value - base) * 0.5 ^ (dt / halfLife)
 *
 * 为什么是它：半衰期是**可解释的常数**（"90 分钟后还剩一半"），
 * 比"每轮乘 0.9"这种按轮次衰减好得多——后者在密集对话和隔天回来的情况下行为完全不同，
 * 而人的情绪是按**时间**退的，不是按轮次退的。
 */

import type { Vector3 } from './types.js'

/**
 * **单位约定：本文件里的时间一律是毫秒。**
 * `dt` 与 `halfLife` 必须是同一个单位，而内核的时间戳就是毫秒——
 * 如果一边传毫秒、一边传"分钟"的参数，衰减会快 6 万倍，情绪会瞬间归位，
 * 而且先后顺序的 bug 会被掩盖成"看起来也能跑"。
 */
export const MIN = 60_000
/** 毫秒转小时。 */
export const HOUR = 60 * MIN
/** 毫秒转天。 */
export const DAY = 24 * HOUR

/** 单点回归。`halfLife <= 0` 视为立即归位。 */
export function regress(value: number, base: number, dt: number, halfLife: number): number {
  if (dt <= 0) return value
  if (halfLife <= 0) return base
  return base + (value - base) * Math.pow(0.5, dt / halfLife)
}

/** 三维一起回归。 */
export function regressVector(v: Vector3, base: Vector3, dt: number, halfLife: number): Vector3 {
  return {
    valence: regress(v.valence, base.valence, dt, halfLife),
    arousal: regress(v.arousal, base.arousal, dt, halfLife),
    dominance: regress(v.dominance, base.dominance, dt, halfLife),
  }
}

/** 把数值夹到区间内。 */
export function clamp(v: number, lo = -1, hi = 1): number {
  if (Number.isNaN(v)) return 0
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 按方向推动一个三维向量（用于一次脉冲）。
 *
 * v2.4 **饱和阻尼**：每次最多推 `strength`，而且**离那边的边界越近推得越少**——
 * `delta = toward × k × room`，`room` 是朝这个方向还剩多少余地（封顶 1）。
 * 老写法 `v + toward × k` 是线性的：同一种情绪反复出现，几次就把分量顶到边界，
 * 之后再怎么推都没区别（面板上看着像"情绪卡死了"）。
 * 用户定的口径：「单次推动改成 强度 × (1 − 当前值)」；对双向的效价做对称推广
 * （朝正看 `1 − v`，朝负看 `1 + v`，都封顶 1），效果一致：**渐近，永不贴死**。
 * 从接近 0 处推第一次的值不变（`room = 1`）——日常单次脉冲的手感就是原来那个。
 */
export function push(v: Vector3, toward: Vector3, strength: number): Vector3 {
  const k = clamp(strength, 0, 1)
  /** 朝 `towardPart` 那个方向还剩多少余地（0..1）。 */
  const room = (current: number, towardPart: number): number => {
    const used = towardPart >= 0 ? current : -current
    return clamp(1 - used, 0, 1)
  }
  return {
    valence: clamp(v.valence + toward.valence * k * room(v.valence, toward.valence), -1, 1),
    arousal: clamp(v.arousal + toward.arousal * k * room(v.arousal, toward.arousal), 0, 1),
    dominance: clamp(v.dominance + toward.dominance * k * room(v.dominance, toward.dominance), 0, 1),
  }
}

/** 逐分量线性跟随（心境跟即时情感用它）。 */
export function follow(from: Vector3, to: Vector3, rate: number): Vector3 {
  const k = clamp(rate, 0, 1)
  return {
    valence: from.valence + (to.valence - from.valence) * k,
    arousal: from.arousal + (to.arousal - from.arousal) * k,
    dominance: from.dominance + (to.dominance - from.dominance) * k,
  }
}

/**
 * 给定一段时间，算出"跟到目标的比例"。
 * 用半衰期表达：dt == halfLife 时跟到一半。
 */
export function followRate(dt: number, halfLife: number): number {
  if (dt <= 0) return 0
  if (halfLife <= 0) return 1
  return 1 - Math.pow(0.5, dt / halfLife)
}

/** 三维向量转成一句人话（面板与 /mind 用）。 */
export function describeVector(v: Vector3): string {
  const valence = v.valence > 0.25 ? '偏正' : v.valence < -0.25 ? '偏负' : '中性'
  const arousal = v.arousal > 0.6 ? '紧' : v.arousal < 0.3 ? '松' : '中间'
  const dominance = v.dominance > 0.6 ? '有掌控' : v.dominance < 0.3 ? '使不上劲' : '一般'
  return `${valence}（${v.valence.toFixed(2)}）、${arousal}（${v.arousal.toFixed(2)}）、${dominance}（${v.dominance.toFixed(2)}）`
}

/** 按半衰期把一批带时间的强度算成"现在的残留"（时间一律毫秒）。 */
export function decayed(strength: number, at: number, now: number, halfLife: number): number {
  return regress(strength, 0, now - at, halfLife)
}
