/**
 * dsh-mind-core 的公共出口。
 *
 * 这个包**与任何 agent 无关**：它不认识 DSH，不认识 Cordis，不认识会话日志对象的形状
 * （只认 `{ type, time, data }` 这样一个最小结构，见 fold.ts 的 `SessionEventLike`）。
 * 换一个 agent，只要把事件翻译成这个最小结构，内核可以原样复用。
 */

export * from './types.js'
export * from './config.js'
export * from './dynamics.js'
export * from './lexicon.js'
export * from './state.js'
export * from './appraise.js'
export * from './affect.js'
export * from './thought.js'
export * from './persona.js'
export * from './memory.js'
export * from './render.js'
export * from './fold.js'
export * from './events.js'
export * from './mind.js'
export * from './decide.js'
export * from './proactive.js'
