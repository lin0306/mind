/**
 * 把内核的"决策倾向"翻译成**这一轮真实的 LLM 参数**。
 *
 * ## 契约（用 `cordis_inspect_query(host, Event, listEvents, {event:'agent/request'})` 取到的原文）
 *
 * ```
 * 'agent/request'(this: Scoped<Agent>, payload: { agent, turn, step, signal },
 *                 next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
 * mode: waterfall
 * ```
 *
 * 官方描述里有一句是决定性的：**"Model-visible content must use logged channels;
 * this waterfall cannot mutate messages."** —— 所以这里**只改参数、绝不塞消息**
 * （注入走 `systemPrompt` 与工具，那两条才是"记录在案"的通道）。
 *
 * ## 三条纪律
 *
 * 1. **只碰 `temperature` 与 `reasoningEffort`**：`provider` / `model` / `maxTokens` / `stop`
 *    不是这一层的事，改了就是越权；
 * 2. **永远有界**：温度偏移不超过 `temperatureTilt`，结果夹在 0.05..0.95；
 * 3. **绝不吞掉上游异常、也绝不让自己的错毁掉回合**：
 *    这条路径在每一步的准入上被 `await`。`next()` 的错照旧抛出；我自己算错了就原样返回配置。
 */

import { decisionSignal, type MindState, type MindTunables } from 'dsh-mind-core'
import { warn, type Disposable, type MindContext } from './host.js'
import { logger } from './log.js'

/** `LlmCallConfig`（只声明我用到的那几个字段；这是宿主给的对象，我不构造它）。 */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** 这一档推理强度是宿主自己的取值（实测请求头里就是 `high`）。 */
const EFFORT_HIGH = 'high'

/** 温度的物理边界：再怎么放开/收紧，也不许跑到极端（那会变成随机输出或复读机）。 */
const TEMP_FLOOR = 0.05
const TEMP_CEIL = 0.95

/**
 * 纯函数：把倾向落到参数上。抽出来是为了能单测——**这一层错了很难在真机上定向**。
 *
 * 返回**同一个引用**表示"不干预"（调用方据此不写日志）。
 */
export function applyDecision(
  config: LlmCallConfig,
  signal: ReturnType<typeof decisionSignal>,
  temperatureTilt: number,
): LlmCallConfig {
  if (!signal.active) return config

  let next: LlmCallConfig | null = null
  const touch = (): LlmCallConfig => {
    if (next === null) next = { ...config }
    return next
  }

  // 1) 温度：正效价放开、负效价收紧，幅度由配置给上限
  if (typeof config.temperature === 'number' && Math.abs(signal.openness) >= 0.05) {
    const tilt = signal.openness * temperatureTilt
    const warmed = Math.min(TEMP_CEIL, Math.max(TEMP_FLOOR, config.temperature + tilt))
    if (Math.abs(warmed - config.temperature) >= 0.01) touch().temperature = Number(warmed.toFixed(3))
  }

  // 2) 推理强度：有没解决的矛盾就多推一步。
  //    只往上调，**不往下砍**——省脑子这件事不该由情绪来决定。
  if (signal.needMoreThought && config.reasoningEffort !== EFFORT_HIGH) {
    touch().reasoningEffort = EFFORT_HIGH
  }

  return next ?? config
}

/** 决策通道的依赖。 */
export interface DecideDeps {
  tunables(): MindTunables
  stateOfSession(session: unknown): MindState | undefined
  /** 关掉之后完全不动参数（默认开）。 */
  enabled(): boolean
  /** 情绪最多能把温度推多远（温度单位）——这一层唯一允许的幅度。 */
  temperatureTilt(): number
}

/**
 * 注册决策通道（**按 agent**：这个事件是 scope-filtered，agent 作用域的监听只收自己的请求）。
 *
 * 为什么按 agent 注册而不是挂在根上：`payload.agent` 声明的只有 `{id}`，
 * 拿不到会话对象；而我在 `agent/created` 里能拿到真 agent，闭包抓住它的会话最稳。
 */
export function registerDecision(agentCtx: MindContext, session: unknown, deps: DecideDeps): Disposable {
  const handler = async (...args: unknown[]): Promise<LlmCallConfig> => {
    const next = args[args.length - 1] as () => Promise<LlmCallConfig>
    // 上游的错照旧抛出：那是它的问题，我不替它兜底
    const config = await next()
    try {
      if (!deps.enabled()) {
        logger.debug('[decide] 总开关关着：不动参数')
        return config
      }
      const state = deps.stateOfSession(session)
      if (state === undefined) {
        logger.debug('[decide] 拿不到这个会话的状态：不动参数')
        return config
      }
      const t = deps.tunables()
      if (t.decisionGain <= 0) {
        logger.debug('[decide] decisionGain=0：情绪不参与决策')
        return config
      }

      const signal = decisionSignal(state.affect, state.thought, t)
      const decided = applyDecision(config, signal, deps.temperatureTilt())
      // **每一次调用都留痕**：这一层在真机上只有"参数变了/没变"这一个现象，
      // 不留痕就完全没法定向（这条日志是排查它到底有没有被调用的唯一手段）。
      logger.debug(
        `[decide] 效价 ${state.affect.current.valence.toFixed(3)}（静息 ${state.affect.baseline.valence.toFixed(3)}）` +
          `｜openness ${signal.openness.toFixed(3)} urgency ${signal.urgency.toFixed(3)}` +
          `｜${signal.because}｜温度 ${String(config.temperature ?? '—')}→${String(decided.temperature ?? '—')}` +
          `｜推理强度 ${String(config.reasoningEffort ?? '—')}→${String(decided.reasoningEffort ?? '—')}` +
          `${decided === config ? '（没改）' : ''}`,
      )
      return decided
    } catch (error) {
      warn(agentCtx, '[dsh-mind] 决策通道算错了（这一轮按原参数走）', error)
      return config
    }
  }

  return (agentCtx.on?.('agent/request', handler as (...a: unknown[]) => unknown) ?? (() => {})) as Disposable
}
