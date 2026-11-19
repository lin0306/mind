/**
 * 主动开口：在回合**正要关闭**的那一刻，判断要不要让它自己再说一句。
 *
 * ## 契约（`cordis_inspect_query` → host / Event / listEvents，逐字抄下来）
 *
 * ```
 * 'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
 * 描述：The turn is about to close: the model owes no response (no live tool calls, no fresh steering).
 * mode: serial
 * ```
 *
 * **serial 意味着宿主会 await 它。** 所以这里有一条铁律：
 * **只做判断与排程，绝不做慢活**（不调模型、不读写文件、不 await 任何东西）。
 *
 * 说话本身交给 `agent.followup(message)`（只有它才会真起一轮新对话），并且**必须带一条消息**：
 * 不带参数真机报 `Cannot read properties of undefined (reading 'id')`（它内部要读这条消息的 `source.id`）。
 * 调用就地同步做即可——契约说这一轮是"正要关闭"而**不是已经关闭**，而且判定与调用都很轻。
 * （曾经试过 `setTimeout(…, 0)` 推到回合收完之后，结果那一轮真机里一个 turn 都没起来；
 *  根因其实是不带消息，但既然同步是契约允许的、也少一个悬挂的定时器，就用同步。）
 *
 * 另外：`signal.aborted` 说明这一轮是**用户打断的**，那种时候不说话（它不是"想开口"，
 * 是被打断的）。
 */

import { proactiveDecision, type MindState, type MindTunables } from 'dsh-mind-core'
import { randomUUID } from 'node:crypto'
import { warn, type MindContext } from './host.js'
import { logger } from './log.js'

/**
 * 唤醒那条消息的正文。
 *
 * 它**不是**要说给用户听的话，只是"把 agent 叫醒"的一句话——真正说什么由模型自己决定
 * （状态已经在实况段里了）。所以这里刻意不写任何情绪词、不铺陈状态：
 * 一旦写成"你现在有点烦躁，想说说吗"，模型就会开始朗读情绪。
 */
export const PROACTIVE_WAKE_TEXT = '（你心里还搁着一件没说完的事。有话就说一句；没有就继续安静待着。）'

/** 唤醒消息的来源标记：让它在会话记录里一眼可辨，也让我自己的 fold 不把它当真用户消息。 */
export const PROACTIVE_SOURCE_KIND = 'plugin:dsh-mind'

/**
 * 造一条"唤醒用"的用户消息。
 *
 * ⚠️ 形状是**实测出来的**：`followup()` **必须带一条消息**。
 * 我第一次不带参数调用，真机报 `Cannot read properties of undefined (reading 'id')`——
 * 它内部要读这条消息的 `source.id`。真正能跑的用法见
 * `research\repos\identity\lib\onebot-channel.js:813`（`agent.followup(buildUserMessage(...))`）
 * 与它的构造器 `onebot-channel.js:54`（`{id, role:'user', content:[{type:'text',text}], source:{kind}}`）。
 */
export function wakeMessage(text: string = PROACTIVE_WAKE_TEXT): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: { kind: PROACTIVE_SOURCE_KIND },
  })
}

/** 主动开口的依赖。 */
export interface ProactiveDeps {
  tunables(): MindTunables
  stateOfSession(session: unknown): MindState | undefined
  /** 上一次开口的时间戳（跨会话，存在档案里）。 */
  lastSpokeAt(): number
  /** 记一次开口（并立刻落盘——冷却靠它算）。 */
  recordSpoken(at: number): void
}

/**
 * 注册主动开口。
 *
 * 只在配置 `proactive: true` 时才注册——关着的时候连监听都不挂，
 * 每轮连判断都不算一次。
 */
export function registerProactive(
  agentCtx: MindContext,
  /** agent 本体：只需要它身上的 `followup()`，所以按"未知 + 用前检查"处理。 */
  agent: unknown,
  session: unknown,
  deps: ProactiveDeps,
): unknown {
  return agentCtx.on?.('agent/turn-stopping', ((...args: unknown[]) => {
    try {
      const payload = args[0] as { turn?: number; signal?: { aborted?: boolean } } | undefined
      if (payload?.signal?.aborted === true) return

      const state = deps.stateOfSession(session)
      if (state === undefined) return

      const now = Date.now()
      const decision = proactiveDecision(state, deps.tunables(), now, deps.lastSpokeAt())
      if (!decision.speak) {
        logger.debug(`[proactive] 不开口：${decision.because}`)
        return
      }

      logger.info(`[proactive] 主动开口：${decision.because}`)
      deps.recordSpoken(now)

      // **就地**起回合，不要 `setTimeout` 推到后面。
      //
      // 这是真机实测改出来的：`agent/turn-stopping` 的契约是
      // "The turn is **about to close**: the model owes no response"——也就是**还没关**。
      // 我原先用 `setTimeout(…, 0)` 想"等回合收完之后再说"，结果是等回合真的关完了才去喊：
      // 档案里 `stats.proactive=1`、日志里有"主动开口"、冷却也记上了，
      // 但会话记录里**没有第二个 turn**（喊了个空）。
      // 所以就在这个钩子里同步喊，并留一行日志——下次真机跑能一眼看出到底喊没喊到。
      try {
        const followup = (agent as { followup?: (message: unknown) => unknown }).followup
        if (typeof followup !== 'function') {
          // 写进**自己的**日志：headless 下宿主日志没人接，只 warn 到宿主等于没留痕
          logger.warn(`[proactive] 这个 agent 没有 followup 方法（拿到的键：${Object.keys(agent as object).join(',')}），起不了新回合`)
          return
        }
        // 两件都必须做对：带着 agent 调（裸调丢 this），并且**带一条消息**（不带就报 reading 'id'）
        followup.call(agent, wakeMessage())
        logger.debug(`[proactive] 已请 agent 自己起一个回合（第 ${payload?.turn ?? '?'} 轮收束时）`)
      } catch (error) {
        logger.warn(`[proactive] 主动开口起回合失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } catch (error) {
      warn(agentCtx, '[dsh-mind] 主动开口判断出错（这一轮就不说话了）', error)
    }
  }) as (...args: unknown[]) => unknown)
}
