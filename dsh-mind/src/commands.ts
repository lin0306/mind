/**
 * `/mind` 命令：让人能看见里面到底发生了什么。
 *
 * 一条纪律：**这个命令不改变任何状态**（除了 `reset-archive` 明确要求清档案）。
 *
 * 为什么不能"重置情绪"：会话状态**只能由会话日志派生**，没有写入 API
 * （只有 register / stateOf / snapshot / checkpoint / restore / hydrate）。
 * 想让情绪归零，只能改日志——那不是命令该干的事。
 * 所以 `/mind reset` 不装作用，它如实说明为什么，并指向真正能清的东西：档案。
 */

import {
  KIND_LABEL,
  describeEntry,
  describePersona,
  renderPanel,
  renderWhy,
  type MindPersist,
  type MindState,
  type MindStats,
  type MindTunables,
} from 'dsh-mind-core'
import type { CommandInvocation, CommandSpec } from './host.js'
import { logger } from './log.js'

/** 命令依赖。 */
export interface CommandDeps {
  tunables(): MindTunables
  stateOfSession(session: unknown): MindState | undefined
  /** 当前档案（跨会话部分）。 */
  persist(): MindPersist
  /** 当前累计统计。 */
  stats(): MindStats
  /** 清空档案（连人设自我认知与统计一起归零），返回给用户看的结果。 */
  resetArchive(): string
  /**
   * 清空**记忆三层**（手边 / 本会话日记 / 跨会话库），人设与统计原样保留。
   *
   * 与 `resetArchive` 的分工：那个是"从零开始的自己"，这个是"把记得的事忘掉，我还是我"。
   * 划掉的 id 都进遗忘名单，所以正在跑的会话也写不回旧记忆。
   */
  resetMemory(): string
  /** 配置与降级自检（如实报告）。 */
  diagnose(): string
  /** 人设内核文件路径。 */
  personaFile(): string
  /** 启动以来发生了什么（自己落的日志，headless 下宿主日志看不见）。 */
  logTail(limit: number): string[]
  /**
   * 回滚内核到第 index 份快照之前。
   *
   * 注意它是**档案级**操作：会话状态由日志派生、投影没有写入 API，
   * 所以它只改档案，从下一个会话开始生效。
   */
  rollbackKernel(index: number): string
  /**
   * 看它记得什么（长期库）。
   * 这一半存在的理由：记忆最招人烦的地方就是"它凭什么记着这个"，
   * 所以每条都要能答出「什么类型 / 重要到什么程度 / 被取回几次 / 什么时候记的 / 为什么记」。
   */
  remember(query: string): string
  /**
   * 划掉一条（**宿主侧**动作，直接改档案）。
   *
   * 它和模型自己的 `forget_memory` 工具是两件不同的事：
   * 这个是"我（用户）替它决定忘掉什么"，那个是"它自己决定忘掉什么"。
   * 两者都会记进遗忘名单；区别是本会话内那一条会不会立刻消失（工具走日志，能立刻消失）。
   *
   * `layer` 指认在哪一层找（序号来自 `show <层>`）；不给层时按"片段在三层里找唯一命中的那条"。
   */
  forget(target: string, layer: MemoryLayerArg | '' | undefined, state: MindState | undefined): string
  /**
   * 清某一层（`short` / `session` / `global` / `all`）；`''` = 只列各层条数，**不真清**。
   *
   * 与 `resetArchive` 的分工：这个只清"记得的事"，那个连"自己是谁、相处了多久"一起归零。
   */
  clear(layer: MemoryLayerArg | '', state: MindState | undefined): string
  /** 当前的遗忘名单（`show forgotten` 用）：宿主侧 ＋ 档案里的，去重。 */
  forgotten(): string[]
  /** 回收站里等恢复的条目（`show trash` 用；清单已在适配层格式化成中文）。 */
  trashList(): string
  /** 恢复：`''` = 看清单；`all` = 全恢复；`<序号>`（可带层名改层）。 */
  restore(target: string, layer?: string): string
  /** 把 id 从遗忘名单里摘掉（划错了能撤回）：序号来自 `show forgotten`，也可以给 id 前缀。 */
  unforget(target: string): string
  /** **真删**（唯一不可逆）：`<序号>` 或 `trash`（清空回收站）。 */
  purge(target: string): string
  /**
   * 有哪些会话记忆、各写了些什么（v2.0）。
   *
   * 这一条是给"跨会话"用的：默认它只读**本会话 + 全局**，别的会话要说得出名字才读得到，
   * 所以得有个地方能先看看有哪些。只读，不改任何文件。
   */
  sessions(): string
}

const USAGE = [
  '用法：',
  '　/mind　　　　　　　看完整状态（情感 / 思想 / 人设 / 记忆）',
  '　/mind why　　　　  最近几次情绪到底从哪来',
  '　/mind persona　　  人设，以及三档漂移各走到哪了',
  '　/mind history　　  内核变化史（年尺度那一档，可回滚）',
  '　/mind log　　　　  插件自己记的日志（宿主日志在 headless 下看不见）',
  '　/mind config　　　 配置与降级自检',
  '　/mind sessions　　  有哪些会话记忆、各写了些什么（跨会话读取前先看这个）',
  '　/mind show [short|session|global|all|forgotten|trash]　看某一层（不带层名＝三层一起看）',
  '　/mind clear <short|session|global|all>　清某一层（裸写只列各层条数，不真清；清＝假删，进回收站）',
  '　/mind restore <序号|all> [层]　从回收站捞回来（默认回原层；可指定 global 换层）',
  '　/mind unforget <序号|id>　撤销一次遗忘（划错了能撤回）',
  '　/mind purge <序号|trash>　**真删**（不可逆；别的路径一律只做假删）',
  '　/mind remember [词]  它记得什么、为什么记着（＝ show global 的别名）',
  '　/mind forget [short|session|global] <序号|片段>　划掉一条记忆（改档案，下一个会话起彻底查不到）',
  '　/mind rollback <n>　把内核回滚到第 n 份快照之前（只改档案，下一个会话生效）',
  '　/mind reset-memory　 清空记忆三层（手边 / 本会话日记 / 跨会话库），人设与统计保留',
  '　/mind reset-archive　清空跨会话档案（人设自我认知 + 长期记忆），并留下一枚标记：**重启 DSH 后**才彻底干净',
].join('\n')

/** `/mind show|clear|forget|restore` 认的层名。 */
export type MemoryLayerArg = 'short' | 'session' | 'global' | 'all' | 'forgotten' | 'trash'

/**
 * 把用户写的层名翻成内部层名；认不出返回 `''`（调用方给用法）。
 * 中文别名一并认：用户是中文用户，"清手边"比"clear short"顺口。
 */
export function parseLayer(arg: string): MemoryLayerArg | '' {
  const key = arg.trim().toLowerCase()
  if (key === 'short' || key === '手边' || key === '当前想法') return 'short'
  if (key === 'session' || key === '会话' || key === '本会话' || key === '日记') return 'session'
  if (key === 'global' || key === '跨会话' || key === '库') return 'global'
  if (key === 'all' || key === '全部') return 'all'
  if (key === 'forgotten' || key === '遗忘' || key === '名单') return 'forgotten'
  if (key === 'trash' || key === '回收站') return 'trash'
  return ''
}

/**
 * `show`：把某一层摊开给人看。**序号与 `forget <层> <序号>` 对齐**（各层各自从 1 开始）。
 *
 * 手边与本会话日记取**活状态**（那才是"此刻真的装着什么"），跨会话库取**档案**
 * （它不注入，活状态里只有接管时带进来的那批）。这就是 `/mind remember` 的原样，
 * 只是多了一个"层"的维度。
 */
function showMemory(
  arg: string,
  state: MindState | undefined,
  persist: MindPersist,
  forgotten: readonly string[],
  now: number,
): string {
  const layer = parseLayer(arg)
  if (arg !== '' && layer === '') {
    return [
      '用法：/mind show [short|session|global|all|forgotten]',
      '',
      '　· short　　手边（当前想法：每次说话都带上来的那几条）',
      '　· session　本会话日记（这一段写过什么，只增不改）',
      '　· global　　跨会话库（不注入，只有主动查才看得见）',
      '　· forgotten　遗忘名单（划过什么、凭据）',
      '　不带层名 = 三层一起看。',
    ].join('\n')
  }
  const short = state?.memory.short ?? persist.memory.short
  const session = state?.memory.session ?? persist.memory.session
  const global = persist.memory.global
  const hint = '划掉某一条：`/mind forget <层> <序号>`（例：`/mind forget short 2`）。'

  if (layer === 'forgotten') {
    const ids = [...new Set([...forgotten, ...persist.memory.forgotten])]
    if (ids.length === 0) {
      return ['# 遗忘名单是空的', '', '划过的东西会记在这儿——不再被查出来，也不会被重新接管回来。'].join('\n')
    }
    const rows = ids.map((id) => {
      const found = [...short, ...session, ...global].find((entry) => entry.id === id)
      return found === undefined
        ? `　· ${id}（原件已经不在三层里）`
        : `　· [${KIND_LABEL[found.kind]}] ${found.text}　${id}`
    })
    return [
      `# 遗忘名单（${ids.length} 条）`,
      '',
      ...rows,
      '',
      '为什么名单要留着：不留的话，被划掉的条目会在别的会话接管档案时长回来。',
    ].join('\n')
  }

  const list = (title: string, entries: MindState['memory']['short'], extra?: string): string[] => {
    if (entries.length === 0) return [`# ${title}`, '', '空的。']
    return [
      `# ${title}（${entries.length} 条，序号用于 /mind forget）`,
      '',
      ...entries.map((entry, index) => describeEntry(entry, index + 1, now)),
      '',
      ...(extra === undefined ? [] : [extra, '']),
      hint,
    ]
  }

  const all = arg === '' || layer === 'all'
  const parts: string[] = []
  if (all || layer === 'short') {
    parts.push(...list('手边（当前想法：每次说话都带上来的那几条）', short))
  }
  if (all || layer === 'session') {
    parts.push(
      ...list(
        '本会话日记（这一段写过什么；只增不改）',
        session,
        '别的会话的日记：先 `/mind sessions` 看有哪些，再让模型用 `recall_memory`（scope="all"）去查。',
      ),
    )
  }
  if (all || layer === 'global') {
    parts.push(...list('跨会话库（不注入，只有主动查才看得见）', global))
  }
  if (all) {
    parts.push('', '只看某一层：`/mind show short|session|global`；清某一层：`/mind clear <层>`。')
  }
  return parts.join('\n')
}

/** 造一个 `/mind` 命令。 */
export function mindCommand(deps: CommandDeps): CommandSpec {
  return {
    name: 'mind',
    description: '查看 dsh-mind 的状态：情绪 / 思想 / 人设 / 记忆（只读，不改变状态）',
    input: {
      hint: '[show | clear | restore | unforget | purge | forget | why | persona | history | log | config | reset-memory | reset-archive]',
    },
    handler: (invocation: CommandInvocation): string => {
      const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const session = invocation.agent?.session
      const state = deps.stateOfSession(session)
      const t = deps.tunables()

      if (raw === '' || raw === 'all') {
        if (state === undefined) {
          return [
            '这个会话还没有 dsh-mind 状态。',
            '可能的原因：插件刚装上、这一轮还没走到折叠、或者 `sessionProjections` 没拿到（看 `/mind log`）。',
          ].join('\n')
        }
        return renderPanel(state, deps.persist(), deps.stats(), Date.now(), t)
      }

      if (raw === 'why') {
        if (state === undefined) return '还没有状态可解释。'
        return renderWhy(state)
      }

      if (raw === 'persona') {
        if (state === undefined) return '还没有状态。'
        const lines = ['# 人设（同一时刻只有一份，但整体会演化）', '']
        for (const line of describePersona(state.persona, t)) lines.push(line)
        lines.push('')
        lines.push(`内核文件：${deps.personaFile()}`)
        lines.push('　内核也能变，只是按年尺度：证据 ≥8 次、跨 ≥60 天、单次幅度 ≤0.02，且每次留快照。')
        lines.push(`　内核快照 ${state.persona.kernelHistory.length} 份（/mind history 看细节）`)
        return lines.join('\n')
      }

      if (raw === 'history') {
        if (state === undefined) return '还没有状态。'
        const history = state.persona.kernelHistory
        if (history.length === 0) {
          return [
            '内核还没有变过。',
            '',
            '这是正常的：内核走的是年尺度闸门（证据 ≥8 次、跨 ≥60 天），',
            '刚认识的这段时间里，动的应该是说话习惯（最快）和自我认知（次快）。',
          ].join('\n')
        }
        const lines: string[] = ['# 内核变化史（越靠后越近）']
        history.forEach((snapshot, index) => {
          lines.push('')
          lines.push(`${index + 1}. ${new Date(snapshot.at).toLocaleString('zh-CN')}`)
          lines.push(`　为什么：${snapshot.reason}`)
          if (snapshot.evidence.length > 0) lines.push(`　证据：${snapshot.evidence.join('；')}`)
        })
        lines.push('')
        lines.push('要回滚就敲 `/mind rollback <n>`（n 是上面的序号）。')
        lines.push('　它只改档案，**从下一个会话开始生效**——当前会话的状态由日志派生，改不了。')
        return lines.join('\n')
      }

      if (raw === 'sessions') {
        return deps.sessions()
      }

      if (raw === 'log') {
        const lines = deps.logTail(30)
        return lines.length === 0 ? '插件还没有记任何日志。' : ['# dsh-mind 自己的日志', '', ...lines].join('\n')
      }

      if (raw === 'config') {
        return ['# 配置自检', '', deps.diagnose(), '', `日志缓冲：${logger.verbose ? '在写' : '只留 warn 以上'}`].join('\n')
      }

      if (raw === 'show' || raw.startsWith('show ')) {
        const arg = raw.slice('show'.length).trim()
        if (parseLayer(arg) === 'trash') return deps.trashList()
        return showMemory(arg, state, deps.persist(), deps.forgotten(), Date.now())
      }

      if (raw === 'restore' || raw.startsWith('restore ')) {
        const [head, ...rest] = raw.slice('restore'.length).trim().split(/\s+/)
        const layer = parseLayer(rest.join(' ').trim())
        return deps.restore((head ?? '').trim(), layer === '' ? undefined : layer)
      }

      if (raw === 'unforget' || raw.startsWith('unforget ')) {
        return deps.unforget(raw.slice('unforget'.length).trim())
      }

      if (raw === 'purge' || raw.startsWith('purge ')) {
        return deps.purge(raw.slice('purge'.length).trim())
      }

      if (raw === 'clear' || raw.startsWith('clear ')) {
        const layer = parseLayer(raw.slice('clear'.length).trim())
        // `clear all` 与 `reset-memory` 是同一件事：复用同一段实现，别写两遍
        // （两遍就有第二个真相，迟早一处改了另一处没改）。
        if (layer === 'all') return deps.resetMemory()
        return deps.clear(layer, state)
      }

      if (raw === 'reset-memory') {
        return deps.resetMemory()
      }
      if (raw === 'reset-archive') {
        return deps.resetArchive()
      }

      if (raw === 'remember' || raw.startsWith('remember')) {
        return deps.remember(raw.slice('remember'.length).trim())
      }

      if (raw.startsWith('forget')) {
        const arg = raw.slice('forget'.length).trim()
        // `forget short 3` / `forget global 三` —— 层名可选；不带层时
        // 纯数字按跨会话库（兼容老习惯），片段则三层里找唯一命中的那条。
        const [head, ...rest] = arg.split(/\s+/)
        const layer = parseLayer(head ?? '')
        if (layer === 'short' || layer === 'session' || layer === 'global') {
          return deps.forget(rest.join(' ').trim(), layer, state)
        }
        return deps.forget(arg, undefined, state)
      }

      if (raw.startsWith('rollback')) {
        const arg = raw.slice('rollback'.length).trim()
        const index = Number.parseInt(arg, 10)
        if (!Number.isFinite(index) || index <= 0) {
          return [
            '用法：/mind rollback <n>',
            '　n 是 /mind history 里的序号；回滚到第 n 份快照**之前**那一版内核。',
            '',
            '为什么要留这一步：内核按年尺度漂移，谁也保不齐它漂歪了，所以每次变化都留了快照。',
          ].join('\n')
        }
        return deps.rollbackKernel(index)
      }

      if (raw === 'reset') {
        return [
          '会话内的状态**不能重置**，这不是没做，是设计如此：',
          '',
          '它完全由会话日志折叠而来（也正因如此才可以重放、才随会话销毁而回收）。',
          '投影只有 register / stateOf / snapshot / checkpoint / restore / hydrate，**没有写入 API**。',
          '想让情绪归零，只能改日志——那不该由一条命令来干。',
          '',
          '要清"记得的事"：`/mind reset-memory`（手边 + 本会话日记 + 跨会话库，人设与统计保留）。',
          '要连"自己是谁、相处了多久"一起归零：`/mind reset-archive`。',
          '',
          '只想划掉某一条记忆，用 `/mind forget <序号>`（那条会进遗忘名单，不再被查出来）。',
        ].join('\n')
      }

      if (raw === 'memory') {
        return [deps.remember(''), '', '（这是 `/mind remember` 的旧写法，现在两个名字都能用。）'].join('\n')
      }

      return `${USAGE}\n\n（没认出来的是：${raw}）`
    },
  }
}
