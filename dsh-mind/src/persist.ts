/**
 * 跨会话持久层：人设 / 长期记忆 / 累计统计。
 *
 * ## 为什么这里可以自己写文件，而会话状态不行
 *
 * 会话内状态（此刻的情绪、张力、脉冲）**必须**由会话投影承载：它是日志的派生量，
 * 才能重放、才能随会话销毁而回收。被查的 5 家竞品全部拿自持 JSON 当会话状态，
 * 于是状态不是日志派生、无法重放、注册挂在 root ctx 上不回收——那是最大的架构缺口。
 *
 * 但"人设跨会话保留同一份""长期记忆库"在定义上就**不在**任何单个会话日志里，
 * 投影的 `apply` 是纯函数、装不下跨会话写入。宿主确实有 `storageDomain`，
 * 但它需要 zod record schema + 与 `@deepseek-ai/dsh-*` 的依赖关系（会触发安装期硬校验），
 * 代价与收益不匹配（feiyu-memory 也是同样的结论）。
 *
 * 所以：**自己的档案文件 + 原子写 + 规范化读**。文件坏了只是"这次想不起来"，不影响聊天。
 *
 * ## v3 起：这里不再有"一个 state.json 装完"
 *
 * v2 的权威是根目录那个 `state.json`（`{format:1, mind}`），`global/`、`short/` 只是它的落地副本；
 * v3 把 `global/persona.jsonl.zst`（人设快照 + 性情基线 + 统计 + 遗忘名单）和三层记忆的快照文件
 * 变成**唯一真相**，`state.json` 只活在迁移那一次（改名进 `archive/state.v1.json`）。
 * 所以本文件现在只做三件事：算路径、给"值得写盘吗"的签名、把散在各文件里的东西**拼回一份 `MindPersist`**。
 */

import path from 'node:path'
import {
  normalizePersist,
  toPersist,
  type MindPersist,
  type MindState,
  type MindStats,
} from 'dsh-mind-core'
import { dshHome } from './host.js'
import { loadGlobal, loadPersonaState } from './store.js'

/**
 * 档案目录：`$DSH_HOME/dsh-mind/`。
 *
 * 返回**规范化**过的路径（斜杠风格统一、去掉结尾分隔符、去掉两头的空白）：
 * 它是"根在哪里"的唯一答案，而调用方经常拿它做包含判断
 * （`file.startsWith(rootDir(raw) + path.sep)`）。原样回传用户配置的字符串时，
 * `E:/tmp/mind` 与 `E:\tmp\mind` 会被当成两个根，包含判断就会漏。
 */
export function stateDir(raw: string): string {
  const trimmed = raw.trim()
  const base = trimmed !== '' ? trimmed : path.join(dshHome(), 'dsh-mind')
  // 统一成**平台无关**的写法：反斜杠一律转成正斜杠。
  //
  // `path.normalize` 只管当前平台的风格——Windows 上它把 `/` 改成 `\`，Linux 上它把 `\`
  // 当普通字符原样保留。所以光靠它，同一个工作区在开发机（Windows）和 CI（Linux）上会算出
  // 两个不同的根，档案分桶和 `startsWith(root + sep)` 的包含判断都会错。
  // 这段的注释一直写着"斜杠风格统一"，实现却依赖了平台——2026-11-19 被 CI 抓到（layout.test.mjs）。
  return path.normalize(base).replace(/\\/g, '/')
}

/** 人设内核文件路径（用户可编辑）。 */
export function personaFile(raw: string): string {
  return raw.trim() !== '' ? raw : path.join(stateDir(''), 'persona.md')
}

/**
 * 把 v3 的几份文件拼回一份档案。任何异常都当成"全新的"处理——
 * **不许因为某份文件坏了挡住聊天**。
 *
 * 拼的时候只带回**跨会话要带走的**：全局层 + 人设/基线/统计/遗忘名单。
 * - 短期层不在这里汇总：它按工作区一份，由 `adoptShort` 按当前工作区去读（汇总反而会串味）；
 * - 会话日记更不汇总：那是某一段对话自己的流水账，读它要看会话 id。
 */
export function loadArchive(raw: string, now: number): { persist: MindPersist; note: string } {
  const state = loadPersonaState(raw)
  const base = normalizePersist(
    state === undefined
      ? undefined
      : {
          persona: state.persona,
          baseline: state.baseline,
          stats: state.stats,
          memory: { forgotten: state.forgotten },
        },
    now,
  )
  const global = loadGlobal(raw)
  const persist: MindPersist = {
    ...base,
    // 全局层直接用手里的条目，不再过一遍 `normalizeMemory`：`where` / `legacy` 这类
    // "只对磁盘有意义"的字段要原样活着穿过这一层——摘要里那行"当年没记归属"就是靠它写的。
    memory: { ...base.memory, global: global.entries, short: [], session: [] },
    savedAt: now,
  }
  const bits = [state === undefined ? '首次运行，还没有存档' : '已读存档', `跨会话库 ${global.entries.length} 条`]
  if (global.dropped > 0) bits.push(`另有 ${global.dropped} 条读不懂被丢掉`)
  return { persist, note: bits.join('｜') }
}

/** 从会话状态里抽出要跨会话带走的部分。 */
export function extract(state: MindState, stats: MindStats, now: number): MindPersist {
  return toPersist(state, stats, now)
}

/**
 * 判断"值得写盘吗"。
 *
 * 每次会话事件都写盘是不可接受的（一个回合几十个事件）。所以只比一个**签名**：
 * 人设/记忆/统计变了才写。签名本身很便宜（都是小对象）。
 */
export function signature(persist: MindPersist): string {
  return JSON.stringify({
    persona: persist.persona,
    // 三层都要算：少了哪一层，那一层的变化就写不进盘（会话日记那一层最容易漏）。
    memory: {
      short: persist.memory.short,
      session: persist.memory.session,
      global: persist.memory.global,
    },
    stats: persist.stats,
  })
}
