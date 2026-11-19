/**
 * 给模型用的工具。
 *
 * ## 为什么思想要靠一个工具写回，而不是再跑一个小模型
 *
 * 三条硬理由（见 core 的 thought.ts）：
 * 1. 钱与延迟——每轮再跑一次模型，成本翻倍，而"像人"的收益不随调用次数线性增长；
 * 2. 不可回放——同一份会话日志折两次会得到两套思想，本项目的立身之本（状态可重放）就没了；
 * 3. 不可审计——你没法回答"它当时到底在想什么"。
 *
 * 而工具调用**天然落在会话日志里**（`tool/call` 事件带着参数），于是思想变成日志的一部分：
 * 可回放、可审计、可解释。**不需要新增任何 session 事件类型**（官方明令禁止第三方 append）。
 *
 * ## 工具 schema 的一个坑
 *
 * `parameters` 是标准 JSON Schema（`required: [...]` 数组可用）；
 * 但 `output.schema` 是**受限的作者态 DSL**，只允许 type/oneOf/items/properties/
 * additionalProperties/enum/const/description/title/default/examples，
 * 加上**每个属性自己的 `required: true`**，**不能写 `required: [...]` 数组**。
 */

import {
  FORGET_TOOL_NAME,
  INNER_NOTE_GUIDE,
  KIND_LABEL,
  RECALL_TOOL_NAME,
  findEntries,
  recall,
  type MemoryEntry,
  type MemoryState,
  type MindTunables,
  type RecallHit,
} from 'dsh-mind-core'
import type { ToolExecuteContext, ToolSpec } from './host.js'

/** 工具名。折叠层（core/fold.ts 的 `parseNote`）按这个名字认它。 */
export const INNER_NOTE_TOOL = 'inner_note'

/** 长期记忆检索工具名（工具名只有一处真相，在 core 里）。 */
export const RECALL_TOOL = RECALL_TOOL_NAME

/**
 * `inner_note`：写一条**给自己下一轮看**的内心记录。
 *
 * 描述里必须把"什么时候该用、什么时候不该用"写清楚——否则模型会每轮都调一次，
 * 那就退化成"每句话都在深想"，比不写还假。
 */
export function innerNoteTool(): ToolSpec {
  return {
    name: INNER_NOTE_TOOL,
    description: ['写下一条你自己的内心记录：不发给用户，只给你自己下一轮用。', INNER_NOTE_GUIDE].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intent: {
          type: 'string',
          description: '我此刻在意的是什么（一句话）。没有就不填。',
        },
        workingJudgment: {
          type: 'string',
          description: '我打算怎么做——一个会改变后续动作的判断，不是复述任务。',
        },
        tension: {
          type: 'number',
          description: '悬着的张力 0..1：有没解决的矛盾（需求与代码冲突、信息不足却必须选）就 >0；0 表示没有。',
        },
        metaCheck: {
          type: 'string',
          description: '我这样想对吗——一次自查。发现自己在凑合、在猜、在绕，就写下来。',
        },
        curiosity: {
          type: 'string',
          description: '我想多看一眼的地方。',
        },
        remember: {
          type: 'string',
          description:
            '顺手把这一轮值得留下的东西记一条——**用你自己的话，别抄用户的原句**。' +
            '不写也不至于丢：这一轮你真的什么都没写时，兜底会把用户明确交代的做法摘下来。' +
            '写了它，听来的原句就让位给你这一条（只有用户明确要求记住的除外）。',
        },
        rememberKind: {
          type: 'string',
          enum: ['fact', 'agreement', 'preference', 'lesson'],
          description:
            '这条算什么：fact 事实（这个项目里就是这么做的）/ agreement 约定（用户明确要求记住的做法）/ ' +
            'preference 偏好（关于用户这个人，换个项目也成立）/ lesson 教训（踩过的坑）。不填按 fact。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // ⚠️ 这里**不能写 `required: true`**：真机注册时报
          // `unsupported JSON schema: schema.properties.ok.required is not supported on type "string"`
          // 整个工具会被拒（而且错误只落在宿主日志里，看起来像"注册成功但工具没出现"）。
          ok: { type: 'string', description: '确认信息' },
        },
      },
      render: (_args, value) => {
        const ok = (value as { ok?: unknown } | null)?.ok
        return [{ type: 'text', text: typeof ok === 'string' ? ok : '已记下' }]
      },
    },
    /**
     * 这里**故意什么都不做**。
     *
     * 状态更新发生在投影折叠这条 `tool/call` 事件的时候（core 的 `applyEvent` 会解析参数），
     * 因为状态只能由日志派生。工具本体要是也去改状态，就会出现两份真相。
     */
    execute: async () => ({ ok: '已记下（下一轮生效）' }),
  }
}

/** 跨会话检索一次调用的选项：适配层只需要知道"这次从哪儿来"与第一段选几个。 */
export interface CrossSessionOptions {
  /** 这次工具调用来自哪个宿主上下文（适配层靠它认出当前会话 id）。 */
  context?: ToolExecuteContext
  /** 第一段最多进几个会话（默认 5）。 */
  sessionLimit?: number
}

/**
 * 两段式跨会话检索的结果。
 *
 * `entries` 是**选中会话的全部条目**（不是分页后的命中）：分页发生在 `recall` 打分之后，
 * 因为"共 N 条命中"只有打过总分才知道；适配层不去猜这件事。
 */
export interface CrossSessionResult {
  entries: readonly MemoryEntry[]
  /** 看了几个会话的简介（不含当前会话）。 */
  lookedAt: number
  /** 第一段选中、真正进去翻了的会话 id（按简介相关度降序）。 */
  entered: readonly string[]
  /** 这次要的是第几页（工具回显，便于排查）。 */
  page: number
  /** 进会话读到的候选条目数；命中数与分页数在工具里算。 */
  total: number
  /** 拿不到当前会话 id 时给 'no-session'：工具据此如实回答，而不是抛错。 */
  reason?: 'no-session'
}

/** 适配层接进来的跨会话检索（两段式 + 分页参数）。 */
export type CrossSessionRecall = (
  query: string,
  page: number,
  pageSize: number,
  options?: CrossSessionOptions,
) => CrossSessionResult

/** `recall_memory` 与 `forget_memory` 的依赖：三层记忆与参数都由适配层注入，core 不认识宿主。 */
export interface RecallToolDeps {
  /** 当前三层记忆（全局库 + 本会话日记 + 手边那几条）。 */
  memory: () => MemoryState
  tunables: () => MindTunables
  /**
   * 当前会话的工作区键（适配层从这次调用的 agent 会话上取）。
   *
   * 可选：拿不到就返回空串（未知）——这时**不做跨工作区降权**。
   * 宁可当全局，也不要在不知道自己在哪的时候误伤记忆。
   */
  workspace?: (context?: ToolExecuteContext) => string
  /**
   * 别的会话的日记（`scope: 'all'` 才用）：**先读简介选会话，再进会话读条目**。
   *
   * core 不碰磁盘，所以两段式由适配层实现；分页留在工具里，因为要先拿到全部命中。
   * 不接这个依赖时，`scope: 'all'` 会如实说跨会话查不了。
   */
  crossSession?: CrossSessionRecall
}

/** 遗忘工具名（唯一真相在 core，两边共用一处，免得拼错）。 */
export const FORGET_TOOL = FORGET_TOOL_NAME

/** 文本指认时"算对得上"的最低重合度——**必须与 core 折叠时的阈值一致**（0.3）。 */
const FORGET_MATCH_FLOOR = 0.3

/** 第一段默认进几个会话。 */
const DEFAULT_SESSION_LIMIT = 5

/** 第一段最多进几个会话：简介也不能无限看，否则一样撑爆上下文。 */
const MAX_SESSION_LIMIT = 50

/** 分页默认值：一页 20 条，最多 50 条。 */
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

/**
 * `scope: 'all'` 时 core 默认只留 `recallLimit`（5）条，那样分页就没意义了；
 * 先要全部命中，再由这里切片。池子只来自第一段选中的几个会话，不会无限大。
 */
const ALL_RECALL_LIMIT = Number.MAX_SAFE_INTEGER

/** 取一个整数参数；没给、给了非数就退回默认值。 */
function intArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

/** 会话 id 形如 `session-4a9596a3-…`：去掉固定前缀后只露 8 位，够指认又不会把一行撑开。 */
function shortSessionId(id: string): string {
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : id
  return bare.slice(0, 8)
}

/**
 * 每条命中一行：内容与原因在前，再标层、来源会话、跨工作区。
 *
 * `otherSessions` 是这次第一段选中的会话 id：命中来自它们时不再说"本会话日记"
 * （那会自相矛盾），只留更准确的"来自会话 xxx"。
 */
function hitLine(hit: RecallHit, otherSessions?: ReadonlySet<string>): string {
  const sessionId = typeof hit.entry.sessionId === 'string' ? hit.entry.sessionId : ''
  const fromOther = hit.layer === 'session' && otherSessions?.has(sessionId) === true
  const layer = fromOther
    ? ''
    : hit.layer === 'session'
      ? ' · 本会话日记'
      : hit.layer === 'short'
        ? ' · 手边'
        : ''
  const origin = hit.layer === 'session' && sessionId !== '' ? ` · 来自会话 ${shortSessionId(sessionId)}` : ''
  return (
    `　· [${KIND_LABEL[hit.entry.kind]}] ${hit.entry.text}（因为：${hit.entry.because || '当时觉得值得记'}）` +
    layer +
    origin +
    (hit.foreign === true ? ' · 跨工作区' : '')
  )
}

/**
 * `recall_memory`：**想不起来的时候先去翻。**
 *
 * 这正是用户要的分工："短期记忆注入上下文（不用想就知道），长期记忆需要大模型主动去查"——
 * 就像人有时候忘记了会说"我想想"。
 *
 * 查不到就老实说查不到。工具结果里那句"不要凭印象编"是**给模型看的**：
 * 记忆类功能最大的失败不是想不起来，而是想不起来还硬答。
 *
 * 跨会话（`scope: 'all'`）走两段式：先看简介挑会话，再进会话翻日记；数据多时分页。
 */
export function recallTool(deps: RecallToolDeps): ToolSpec {
  return {
    name: RECALL_TOOL,
    description: [
      '在你**想不起来**的时候，去查记忆：用户以前定过的规矩、说过的偏好、项目的既定事实。',
      '默认查**本会话的日记 + 跨会话库**。跨会话库是"关于这个人"的规矩与偏好，本会话日记是这段对话里攒下来的。',
      'scope="global" 只查跨会话库；scope="all" 连**别的会话**的日记一起查——那是别人的对话，只有当你明确需要'
        + '（用户说"上次那个会话里…"）才用。',
      'scope="all" 是两段式：先读各会话的简介，挑最像的几个（默认 5 个，sessionLimit 可调），再进这几个会话翻日记；'
        + '结果会说明看了几个简介、进了哪几个会话，每条命中标出来源会话。',
      '数据多就分页：page 从 1 开始（默认 1），pageSize 默认 20、最多 50；结果里会写"第几页、共几条、有没有下一页"。',
      '该用的时候：用户提到"上次 / 之前 / 我们说好的 / 按老规矩"，或者你要依赖一件旧事但没把握。',
      '不该用的时候：这一轮刚发生的事，或者已经写在【手边记着的事】里的——那些不用查。',
      '每次只传一个 query，**写关键词，不要写问句**（例："中文"、"pnpm"、"注释"、"路径"）。',
      '检索是字面重合：问句里那些"我们之前说好"之类的词对不上原话，会白白想不起来。',
      '重合太低时会直接返回"没想起来"；那种情况**如实说你记不清，不要凭印象编**。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: '想找什么，用自然语言写（例："中文语言约定""项目用哪个包管理器"）',
        },
        scope: {
          type: 'string',
          enum: ['this', 'global', 'all'],
          description:
            '查哪一层。this（默认）= 本会话日记 + 跨会话库；global = 只查跨会话库；'
            + 'all = 先看别的会话的简介、再进选中的会话查（只在用户明确提到别的会话时用）。',
        },
        page: {
          type: 'number',
          description: 'scope="all" 时看第几页（从 1 开始，默认 1）。',
        },
        pageSize: {
          type: 'number',
          description: 'scope="all" 时每页几条（默认 20，最多 50）。',
        },
        sessionLimit: {
          type: 'number',
          description: 'scope="all" 时第一段最多进几个会话（默认 5，最多 50）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'string', description: '想起的内容；想不起来就如实说' },
        },
      },
      render: (_args, value) => {
        const ok = (value as { ok?: unknown } | null)?.ok
        return [{ type: 'text', text: typeof ok === 'string' ? ok : '（没有结果）' }]
      },
    },
    execute: async (args, context) => {
      const raw = (args as { query?: unknown } | null | undefined)?.query
      const query = typeof raw === 'string' ? raw.trim() : ''
      if (query === '') return { ok: '没有给查询词，什么都没查到。' }

      // 跨工作区的条目**仍然查得到**（硬切两半一定丢东西），但降权，并按来源标出来。
      const ws = deps.workspace?.(context) ?? ''
      const asked = (args as { scope?: unknown } | null | undefined)?.scope
      const scope: 'this' | 'global' | 'all' = asked === 'global' || asked === 'all' ? asked : 'this'

      // 默认两层与 global 的行为原样保留：不读简介、不进别的会话、也不分页。
      if (scope !== 'all') {
        const hits = recall(deps.memory(), query, Date.now(), deps.tunables(), ws, scope)
        if (hits.length === 0) {
          const where = scope === 'global' ? '跨会话库' : '本会话与跨会话库'
          return { ok: `没想起来：${where}没有和「${query}」相关的东西。不要凭印象编，直接说你记不清。` }
        }
        return { ok: `想起来 ${hits.length} 条：\n${hits.map((hit) => hitLine(hit)).join('\n')}` }
      }

      // ── 跨会话：分页参数先夹到合法范围，再交给适配层做第一段 ──
      const page = Math.max(1, intArg((args as { page?: unknown }).page, 1))
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, intArg((args as { pageSize?: unknown }).pageSize, DEFAULT_PAGE_SIZE)))
      const sessionLimit = Math.min(
        MAX_SESSION_LIMIT,
        Math.max(1, intArg((args as { sessionLimit?: unknown }).sessionLimit, DEFAULT_SESSION_LIMIT)),
      )

      const cross = deps.crossSession?.(query, page, pageSize, { context, sessionLimit })
      if (cross === undefined) {
        return { ok: '这个宿主没有接上跨会话检索：别的会话的日记查不了（本会话和跨会话库还是能查的）。' }
      }
      if (cross.reason === 'no-session') {
        return { ok: '这个会话没有记下自己的 id，跨会话查不了（本会话和跨会话库还是能查的）。' }
      }

      const looked = `看了 ${cross.lookedAt} 个会话的简介`
      const header =
        cross.entered.length === 0
          ? `${looked}，没有一个像在说这件事`
          : `${looked}，进了 ${cross.entered.length} 个（${cross.entered.map(shortSessionId).join('、')}）`

      // 第一段只有选中会话的条目；core 仍按 scope='all' 打分并给它们"别的会话"的权重。
      const hits = recall(
        deps.memory(),
        query,
        Date.now(),
        { ...deps.tunables(), recallLimit: ALL_RECALL_LIMIT },
        ws,
        'all',
        cross.entries,
      )
      if (hits.length === 0) {
        const where =
          cross.entered.length === 0
            ? '本会话、跨会话库'
            : `本会话、跨会话库、别的会话（${cross.entered.map(shortSessionId).join('、')}）的日记`
        return { ok: `${header}。\n没想起来：${where}里没有和「${query}」相关的东西。不要凭印象编，直接说你记不清。` }
      }

      const start = (page - 1) * pageSize
      const pageHits = hits.slice(start, start + pageSize)
      if (pageHits.length === 0) {
        const lastPage = Math.max(1, Math.ceil(hits.length / pageSize))
        return {
          ok:
            `${header}\n第 ${page} 页没有内容：共 ${hits.length} 条命中，每页 ${pageSize} 条，只有 ${lastPage} 页。` +
            `想看就再问一次，带上 page=${lastPage}。`,
        }
      }

      const hasNext = start + pageHits.length < hits.length
      const footer = hasNext
        ? `第 ${page} 页，共 ${hits.length} 条命中，还有下一页：想看更多就再问一次，带上 page=${page + 1}。`
        : `第 ${page} 页，共 ${hits.length} 条命中，没有下一页了。`
      const entered = new Set(cross.entered)
      return {
        ok:
          `${header}\n想起来 ${pageHits.length} 条（第 ${page} 页）：\n` +
          `${pageHits.map((hit) => hitLine(hit, entered)).join('\n')}\n${footer}`,
      }
    },
  }
}

/** 按 id 或一段文本，在这份跨会话库里认出唯一一条最像的。 */
function pickForgetTarget(
  all: MemoryEntry[],
  args: { id: string; text: string },
): { entry: MemoryEntry } | { ambiguous: MemoryEntry[] } | null {
  if (args.id !== '') {
    const hit = all.find((entry) => entry.id === args.id)
    return hit === undefined ? null : { entry: hit }
  }
  if (args.text === '') return null
  const hits = findEntries({ short: [], session: [], global: all, pendingSignals: 0, forgotten: [], updatedAt: 0 }, args.text, 5)
    .filter((hit) => hit.score >= FORGET_MATCH_FLOOR)
  const first = hits[0]
  if (first === undefined) return null
  const second = hits[1]
  // 对上多条就别自己猜（遗忘不可逆）
  if (second !== undefined && second.score >= first.score - 0.02) {
    return { ambiguous: hits.map((hit) => hit.entry) }
  }
  return { entry: first.entry }
}

/**
 * `forget_memory`：**用户明确要求忘掉某一条时**才用。
 *
 * 为什么它必须存在（而不是只留一条 `/mind forget`）：人是会忘的，而且**忘什么由它自己判断**
 * 才算"像人"。`/mind forget` 是"我（用户）替它决定忘掉什么"，工具是"它自己决定"。
 *
 * 两条不可破的规矩：
 * 1. **只删得掉能唯一指认的**（id 或足够像的一段原文）。对上多条就如实列出来让人选，
 *    绝不"全部删掉"——遗忘不可逆；
 * 2. 这里**只负责回答"能不能删"**，真正的删除发生在折叠那一步（`tool/call` 事件进来时），
 *    所以"忘掉"这件事一样落在会话日志里，可重放、可审计。
 */
export function forgetTool(deps: RecallToolDeps): ToolSpec {
  return {
    name: FORGET_TOOL,
    description: [
      '忘掉一条长期记忆。**只在用户明确要求你忘掉某件事时使用**（"忘掉这个""别记着它"）。',
      '不要因为"这条看起来没用了"就自己删——记忆要能被追问，不能悄悄蒸发。',
      '指认方式二选一：传 id（精确），或传一段原文（会挑最像的一条；对上多条时不会猜，会列给你看）。',
      '忘掉之后就查不到了，而且这条划掉的记录会一直留着（避免它下次又被记回来）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '要忘掉的那一记忆条目的 id（从 recall_memory 的结果里可以看到）' },
        text: { type: 'string', description: '或者给出那条记忆的原文片段（越完整越准）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'string', description: '结果；删不掉就如实说为什么' },
        },
      },
      render: (_args, value) => {
        const ok = (value as { ok?: unknown } | null)?.ok
        return [{ type: 'text', text: typeof ok === 'string' ? ok : '（没有结果）' }]
      },
    },
    execute: async (args) => {
      const raw = (args ?? {}) as { id?: unknown; text?: unknown }
      const id = typeof raw.id === 'string' ? raw.id.trim() : ''
      const text = typeof raw.text === 'string' ? raw.text.trim() : ''
      if (id === '' && text === '') {
        return { ok: '没说要忘掉哪一条。给我 id，或者一条足够完整的原文。' }
      }

      const memory = deps.memory()
      const picked = pickForgetTarget(memory.global, { id, text })
      if (picked === null) {
        return {
          ok: `没找到能唯一对上的条目（跨会话库 ${memory.global.length} 条）。什么都没删——遗忘了就找不回来，宁可不动。`,
        }
      }
      if ('ambiguous' in picked) {
        const lines = picked.ambiguous.map(
          (entry) => `　· [${KIND_LABEL[entry.kind]}] ${entry.text}（id ${entry.id}）`,
        )
        return { ok: `「${text}」对上了 ${picked.ambiguous.length} 条，我不替你猜是哪一条：\n${lines.join('\n')}\n把 id 给我，我删那一条。` }
      }

      const entry = picked.entry
      return {
        ok: [
          `已忘掉：[${KIND_LABEL[entry.kind]}] ${entry.text}`,
          '（这一轮折叠时它会从记忆里清掉；长期库里也划掉了，之后查不到——这条"忘掉"的痕迹会留着，免得它被重新记回来。）',
        ].join('\n'),
      }
    },
  }
}
