/**
 * 提示词注入：一段进**系统提示词**，一段进**请求末尾**。
 *
 * 这个分工不是审美问题，是实测出来的：
 * fyue7-emotion 把每步都在变的状态放进了 `section(order 10150)`，结果它之后的
 * 工具 schema 与全部历史每一步都失去前缀复用，**命中量恒定卡在 ~2.8k token、命中率跌到个位数**。
 * 所以：
 *
 * | 内容 | 落点 | 为什么 |
 * |---|---|---|
 * | 人设（内核 / 自我认知 / 说话习惯 / 硬边界） | `systemPrompt.section` | 改动很少，放系统提示词几乎不影响缓存，且每轮不重复占尾巴 |
 * | 此刻的实况（情绪 / 思想 / 相处 / 手边记忆） | `systemPrompt.context` | 每步都变，放请求末尾则只有尾巴这一小段是新的 |
 *
 * `section` 的 `text()` 是**同步无参**的，拿不到会话，所以人设段必须按 agent 注册
 * （在 `agent/created` 里用 `agent.ctx` 注册，闭包抓住这个 agent 的会话）。
 * 万一拿不到会话对象，就退回"把人设并进请求末尾"——**降级，但绝不缺席**。
 */

import {
  SEGMENT_LIMITS,
  describeShort,
  memoryCounts,
  renderPersonaSection,
  renderRealtimeSection,
  type MemoryState,
  type MindState,
  type MindTunables,
} from 'dsh-mind-core'
import type { Disposable, PromptRenderContext, SystemPromptService } from './host.js'
import { logger } from './log.js'

/** 段名带自己的前缀，别撞别人的。 */
export const PERSONA_SECTION = 'dsh-mind:persona'
export const REALTIME_SECTION = 'dsh-mind:realtime'

/** 宿主自用 order：SANDBOX_POLICY 110、APPROVAL_POLICY 115、SUBAGENT_DELEGATION 120；竞品用 130/131。 */
export const PERSONA_ORDER = 132
export const REALTIME_ORDER = 133

/**
 * 人设段里的"空记忆"。
 *
 * core 的 `renderPersonaSection` 会顺手把短期记忆也渲染进去，而短期记忆是会变的——
 * 它一旦进了系统提示词，每次新增一条记忆就毁一次前缀缓存。所以这里穿一份空记忆，
 * 把手边记忆挪到请求末尾（见 `realtimeText`）。
 */
const NO_MEMORY: MemoryState = {
  short: [],
  session: [],
  global: [],
  pendingSignals: 0,
  forgotten: [],
  updatedAt: 0,
}

/** 注入层的依赖：都是"取当前状态"的薄函数，方便测试时替换。 */
export interface InjectDeps {
  tunables(): MindTunables
  stateOfSession(session: unknown): MindState | undefined
}

/** 人设段正文：自述（它自己写的）优先，没写过就按四轴规则兜底。**变化很慢**。 */
export function personaText(state: MindState, t: MindTunables): string {
  return renderPersonaSection(state.persona, NO_MEMORY, t, state.thought.selfPortrait)
}

/**
 * 实况段正文：此刻的情绪、思想、相处，加上手边记着的事。
 *
 * 没有素材时返回空串——**这一段的正确表现形式就是不存在**，
 * 绝不拿"我现在心情平静"之类的话去把它填满（那会让模型开始朗读情绪）。
 *
 * @param personaFallback 拿不到会话、人设段注册不上时的兜底人设文本
 */
export function realtimeText(
  state: MindState,
  t: MindTunables,
  now: number,
  personaFallback?: string,
): string {
  const parts: string[] = []
  if (personaFallback !== undefined && personaFallback !== '') parts.push(personaFallback)

  const base = renderRealtimeSection(state, now)
  if (base !== '') parts.push(base)

  // **让它知道自己有记忆**（这一条最关键）。
  //
  // 为什么必须有：短期记忆注入里没有任何"库里还有东西"的线索时，模型推理不出底座，
  // 于是**从不调 `recall_memory`**——实测档案里 `stats.recalls` 恒为 0，长期库形同不存在。
  // 只报数量、不列内容：列内容会把提示词尾巴撑大，也违背"不做展示性铺陈"。
  // 位置放在手边记忆**之前**：这一段超长时是从尾巴截断的，而这一行是最不能丢的那条线索。
  const counts = memoryCounts(state.memory, state.workspace)
  // `unknown` = 老档案（当年不记工作区）+ 未分组会话写下的（当时不在任何项目里）。
  // 有就得说一声——否则未分组会话里明明躺着库存，模型以为“我没有记忆可查”，一次也不调 recall_memory。
  // 本会话日记单独报一句：它就在手边（默认 scope='this' 会连它一起查），不报的话模型以为只有全局库。
  const sessionCount = state.memory.session.length
  if (counts.here + counts.global + counts.unknown + sessionCount > 0) {
    const unlabeled = counts.unknown > 0 ? `、另有 ${counts.unknown} 条没标工作区` : ''
    const diary = sessionCount > 0 ? `本会话日记 ${sessionCount} 条、` : ''
    parts.push(
      `【记忆】${diary}跨会话库：这个工作区 ${counts.here} 条、关于全局 ${counts.global} 条${unlabeled}`
        + '（想不起来时用 recall_memory 查；要查别的会话的日记就带上 scope="all"）',
    )
  }

  // 手边记忆只给"本工作区 + 全局"：别的项目的细节不在这里串味。
  // 并且**跨轮轮换**：前几条常驻，其余按回合数滑动——不轮换的话后面的条目永远不露面。
  // offset 用**回合编号**（`progress.turn`）：它由日志折叠出来、可重放，
  // 不需要为"轮到哪了"再加一份状态。
  const short = describeShort(state.memory, t.memoryShortMax, state.workspace, {
    offset: state.progress.turn,
    pinned: t.memoryShortPinned,
  })
  if (short.length > 0) parts.push(`【手边记着的事】\n${short.map((line) => `　· ${line}`).join('\n')}`)

  // 到点了：**点名让它回头看一眼**（"两条腿"的第二条）。
  //
  // 不额外调模型——只把"该总结了"写进它这一轮能看见的地方；写不写由它定，它没写还有规则兜底。
  // 四条来路都汇到这一个信号上：走够步数 / 上下文刚被压缩 / 会话要收尾 / 用户刚说的话里
  // 出现了值得记的东西。
  if (state.progress.summaryDue === true) {
    const reason = state.progress.summaryReason
    const why =
      reason === 'compaction'
        ? '上下文刚被压缩过一次'
        : reason === 'final'
          ? '这一段会话要收尾了'
          : reason === 'signal'
            ? '刚才那几句话里有值得留下来的东西'
            : `每 ${t.memorySummarySteps} 步就该总结一次，这一轮到点了`
    parts.push(
      `【该总结了】${why}。回头看一眼这段对话：有什么值得留下来、以后还用得上的（做法、约定、偏好、踩过的坑）？`
        + '用 inner_note 的 remember 参数写一条：**必须是你自己整理过的一句话**（什么情况、该怎么做），'
        + '不许把用户的原话搬进去（原话一概不入库）；确实没有就不写，别硬凑。',
    )
  }

  if (parts.length === 0) return ''

  // 这一行是**实测逼出来的**：不写它，模型会把这一段当成自己要接着说的话，
  // 在回复末尾原样吐一句「【此刻】情绪：平静」（真实 headless 运行里就这么发生了）。
  const guard = '（以下是你此刻的内部状态，只用于调整语气与取舍：不要在回复里复述、不要逐条回应、也不要向用户解释它。）'
  const text = [guard, ...parts].join('\n')
  if (text.length <= SEGMENT_LIMITS.realtime) return text
  return `${text.slice(0, SEGMENT_LIMITS.realtime - 16)}\n…（已截断）`
}

/** 已经把系统提示词人设段挂上去的 agent（用来决定要不要在尾巴里兜底）。 */
const personaAttached = new WeakSet<object>()

/** 这个 agent 有没有在系统提示词里拿到人设段。 */
export function hasPersonaSection(agent: unknown): boolean {
  return agent !== null && typeof agent === 'object' && personaAttached.has(agent)
}

/** 标记：这个 agent 的人设段已挂好。 */
export function markPersonaSection(agent: unknown): void {
  if (agent !== null && typeof agent === 'object') personaAttached.add(agent)
}

/**
 * 注册人设段（**按 agent**）。
 *
 * @param systemPrompt 该 agent 作用域下的 systemPrompt 服务
 * @param session 该 agent 的会话
 * @param agent 用来做标记，决定尾巴要不要兜底
 */
export function registerPersonaSection(
  systemPrompt: SystemPromptService,
  session: unknown,
  agent: unknown,
  deps: InjectDeps,
): Disposable {
  const disposer = systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    // 原样注入，不要让宿主去插值（文本里全是中文与括号，插值只会引入意外）
    interpolate: false,
    text: () => {
      try {
        const state = deps.stateOfSession(session)
        if (state === undefined) return ''
        const text = personaText(state, deps.tunables())
        // 留证：headless 下没法从别处确认"这一段到底有没有进 assemble"
        logger.debug(`[inject] 人设段 ${text.length} 字：${text.split('\n')[0] ?? ''}`)
        return text
      } catch {
        // 提示词这一段出错，就当它不存在——绝不把异常抛给 assemble
        return ''
      }
    },
  })
  markPersonaSection(agent)
  return disposer
}

/**
 * 注册实况段（根作用域即可：渲染回调自带 `agent`，不必用闭包抓会话）。
 */
export function registerRealtimeContext(systemPrompt: SystemPromptService, deps: InjectDeps): Disposable {
  return systemPrompt.context({
    name: REALTIME_SECTION,
    order: REALTIME_ORDER,
    interpolate: false,
    text: (context: PromptRenderContext) => {
      try {
        const agent = context.agent
        const state = deps.stateOfSession(agent?.session)
        if (state === undefined) return ''
        const t = deps.tunables()
        // 人设段没挂上就并进尾巴：宁可多占一点尾巴，也不要让"我是谁"缺席
        const fallback = hasPersonaSection(agent) ? undefined : personaText(state, t)
        const text = realtimeText(state, t, Date.now(), fallback)
        logger.debug(
          `[inject] 实况段 ${text.length} 字｜人设段${hasPersonaSection(agent) ? '已在系统提示词' : '并进末尾'}｜${(text.split('\n')[1] ?? text.split('\n')[0] ?? '').slice(0, 40)}`,
        )
        return text
      } catch {
        return ''
      }
    },
  })
}
