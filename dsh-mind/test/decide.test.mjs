/**
 * 决策通道的适配层一半：`applyDecision`。
 *
 * 这一层是纯函数，所以必须在这里把边界测死——真机上只有"这一轮的参数变了/没变"这一个现象，
 * 出错时极难定向（既没有报错，也没有可对比的基线）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDecision } from '../lib/index.js'

const CONFIG = { provider: 'p', model: 'm', temperature: 0.5, reasoningEffort: 'medium' }

/** 造一个决策倾向。 */
function signal(openness, needMoreThought) {
  return {
    openness,
    urgency: needMoreThought ? 0.9 : 0,
    needMoreThought,
    because: '测试',
    active: Math.abs(openness) >= 0.05 || needMoreThought,
  }
}

test('不干预时返回同一个引用（调用方据此不写日志）', () => {
  assert.equal(applyDecision(CONFIG, signal(0, false), 0.15), CONFIG)
})

test('收紧：温度往下走，幅度不超过给定的上限', () => {
  const out = applyDecision(CONFIG, signal(-1, false), 0.15)
  assert.equal(out.temperature, 0.35)
  // 浮点：0.5 - 0.15 在二进制里是 0.34999999999999998，所以这里留一点容差
  assert.ok(Math.abs(out.temperature - CONFIG.temperature) <= 0.15 + 1e-9)
})

test('打开：温度往上走，且永远夹在 0.05..0.95', () => {
  const hot = { ...CONFIG, temperature: 0.9 }
  assert.equal(applyDecision(hot, signal(1, false), 0.15).temperature, 0.95)
  const cold = { ...CONFIG, temperature: 0.1 }
  assert.equal(applyDecision(cold, signal(-1, false), 0.15).temperature, 0.05)
})

test('有没解决的矛盾 → 推理强度上调到 high；本来就是 high 就不动', () => {
  assert.equal(applyDecision(CONFIG, signal(0, true), 0.15).reasoningEffort, 'high')
  const already = { ...CONFIG, reasoningEffort: 'high' }
  assert.equal(applyDecision(already, signal(0, true), 0.15), already, '已经是 high 就该原样返回')
})

test('只碰温度与推理强度：模型、provider、maxTokens、stop 一律不动', () => {
  const full = { ...CONFIG, maxTokens: 4096, stop: ['END'] }
  const out = applyDecision(full, signal(-1, true), 0.15)
  assert.equal(out.provider, full.provider)
  assert.equal(out.model, full.model)
  assert.equal(out.maxTokens, full.maxTokens)
  assert.deepEqual(out.stop, full.stop)
  // 键集合不许变多（免得把宿主的字段悄悄吃掉）
  assert.deepEqual(Object.keys(out).sort(), Object.keys(full).sort())
})

test('配置里没有 temperature 时不硬塞一个（宿主没给就别自作主张）', () => {
  const noTemp = { provider: 'p', model: 'm' }
  const out = applyDecision(noTemp, signal(1, false), 0.15)
  assert.equal(out.temperature, undefined)
  assert.equal(out, noTemp)
})

test('上限为 0 时等于关掉温度通道（但推理强度仍按张力走）', () => {
  const out = applyDecision(CONFIG, signal(-1, true), 0)
  assert.equal(out.reasoningEffort, 'high')
  // 温度偏移不足 0.01，视为没改 → 仍然是原值
  assert.equal(out.temperature, 0.5)
})
