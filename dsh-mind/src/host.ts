/**
 * 宿主（DSH / Cordis）接口的**最小声明**与容错取用。
 *
 * 为什么不直接 `import type { Context } from '@deepseek-ai/cordis'`：
 * 插件会被 pnpm 以 `file:` / `link:` 放进 profile，能不能解析到宿主的包**不保证**，
 * 而静态 import 解析不到 = **整个插件加载失败**。所以这一层只声明"我用到的形状"，
 * 运行时用 `ctx.get(name)` 取服务，取不到就降级，绝不向上抛。
 *
 * 这一层是**唯一**允许写 DSH 专有名词的地方。core 里不许出现这些名字。
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'

/** Cordis 的注册返回值：**是一个函数**，不是 `{ off() }` 对象。 */
export type Disposable = () => void

/** 宿主日志器（headless 下可能没人接，所以日志只当锦上添花）。 */
export interface LoggerLike {
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

/** 我用到的 Context 形状。 */
export interface MindContext {
  get?(name: string): unknown
  on?(event: string, listener: (...args: unknown[]) => unknown): Disposable
  inject?(names: readonly string[], register: (scope: MindContext) => unknown): Disposable
  /**
   * Cordis 的副作用注册：`ctx.effect(callback, label?)`——作用域销毁时回调返回的清理函数会被调用。
   *
   * 用法与 `on` 一样是"注册了就要能撤"：路由与设置服务都是**可撤回**的东西（宿主重载插件、
   * 关掉某个服务时，作用域会销毁），不挂在 effect 上就会留下悬空注册。
   * 声明成可选：老部署或测试里的假 ctx 未必有它，没有时调用方直接执行一次即可。
   */
  effect?(callback: () => unknown, label?: string): Disposable
  logger?: LoggerLike
  [extra: string]: unknown
}

/** 会话对象：只需要 id。 */
export interface SessionLike {
  id?: string
}

/**
 * 会话头里我们用到的最小形状。
 *
 * `cwd` 是"我在哪个工作区"的**唯一可靠来源**（平台已确认的声明）：
 * 投影 `init` 时就能拿到，而会话头是会话身份的一部分，所以由它派生的状态仍可回放。
 * 不声明它，工作区就只能靠猜（进程 cwd 会变，session.id 与目录无关）。
 */
export interface SessionHeaderLike {
  cwd?: string
  /**
   * 会话 id。
   *
   * 平台声明里是 `SessionHeader.id: SessionId`（branded string），这里只取最小形状。
   * 它也是会话身份的一部分，所以由它派生的状态仍然可回放——这正是我们要的：
   * 没选工作区的会话写下的记忆要能标出"是哪个会话说的"。
   */
  id?: string
}

/** 会话事件的最小形状（与 core 的 `SessionEventLike` 结构一致）。 */
export interface HostEvent {
  type: string
  seq?: number
  time?: number
  data?: unknown
}

/* ───────────────────────── 提示词 ───────────────────────── */

export interface PromptSectionSpec {
  name: string
  order?: number
  text: () => string
  interpolate?: boolean
}

/** 动态段拿到的渲染上下文。它有 `agent`，所以不必用闭包去抓会话。 */
export interface PromptRenderContext {
  agent?: { id?: string; session?: SessionLike }
}

export interface PromptContextSpec {
  name: string
  order?: number
  text: (context: PromptRenderContext) => string
  interpolate?: boolean
}

export interface SystemPromptService {
  section(spec: PromptSectionSpec): Disposable
  context(spec: PromptContextSpec): Disposable
}

/* ───────────────────────── 会话投影 ───────────────────────── */

export interface ProjectionWire {
  viewSchema?: unknown
  /** 同一个状态引用必须复用同一个视图引用（注册表按引用比对）。 */
  view(state: unknown): unknown
}

export interface ProjectionDefinition {
  key: string
  stateVersion: number
  stateSchema?: unknown
  /** 新会话的起点；宿主会传会话头（其中有 `cwd`）。测试与老调用方可能不带参数。 */
  init: (header?: SessionHeaderLike) => unknown
  apply: (state: unknown, event: HostEvent) => unknown
  wire?: ProjectionWire
}

/**
 * 注册投影后拿到的句柄（DSH 0.2.1-rc.2 起 `register` 返回它）。
 *
 * `stateOf(session)` 是**推荐**的状态读取入口：它自己折叠，不走注册表级读取。
 */
export interface ProjectionHandle {
  stateOf(session: unknown): unknown
  dispose(): Promise<void>
}

export interface SessionProjectionsService {
  /**
   * 注册投影。
   *
   * DSH 0.2.x 起返回的是**可调用的 thenable**：`await` 它得到 `{ stateOf, dispose }` 句柄；
   * 直接调用它仍会释放注册，但那个调用已弃用。
   * 老宿主与测试里的假宿主返回的是释放函数本身——`await` 一个非 thenable 会原样返回它，
   * 所以两种形状都能走（见 `projection.ts` 的 `stateOfVia`）。
   */
  register(definition: ProjectionDefinition): Promise<ProjectionHandle> | Disposable
  /**
   * 注册表级读取。
   *
   * @deprecated DSH 0.2.1-rc.2 起弃用：每个键的首次读取会打一次 `ctx.logger.warn` 弃用警告，
   * 且将来会移除。改用 `register` 返回的句柄的 `stateOf(session)`。
   * 这里保留成可选，是因为老宿主可能没有句柄（回落路径还要用它）。
   */
  stateOf?(session: unknown, key: string): unknown
}

/* ───────────────────────── 工具 ───────────────────────── */

export interface ToolOutputSpec {
  schema?: Record<string, unknown>
  render?: (args: unknown, value: unknown) => unknown[]
}

/**
 * 工具执行时宿主给的上下文。
 *
 * 真机会传 `{ agent, signal, deferContext }`（对照 feiyu-memory 的接收方式），
 * `agent.session` 就是"这次调用属于哪个会话"。记忆的跨工作区判定要靠它取工作区键——
 * 工具是根作用域注册的，拿不到会话就没法知道自己在哪个工作区。
 */
export interface ToolExecuteContext {
  agent?: { id?: string; session?: SessionLike }
}

export interface ToolSpec {
  name: string
  description: string
  /** 标准 JSON Schema（这里允许 `required: [...]` 数组）。 */
  parameters: Record<string, unknown>
  output?: ToolOutputSpec
  execute(args: Record<string, unknown>, context?: ToolExecuteContext): unknown | Promise<unknown>
}

export interface ToolsService {
  register(spec: ToolSpec): Disposable
}

/* ───────────────────────── 命令 ───────────────────────── */

export interface CommandInvocation {
  agent?: { id?: string; session?: SessionLike }
  rawInput?: string
  [extra: string]: unknown
}

export interface CommandSpec {
  name: string
  description: string
  input?: { hint?: string }
  handler(invocation: CommandInvocation): string | Promise<string>
}

export interface CommandsService {
  register(spec: CommandSpec): Disposable
}

/* ───────────────────────── 取用与容错 ───────────────────────── */

/** 取一个服务；拿不到返回 undefined，绝不抛。 */
export function service<T>(ctx: MindContext, name: string): T | undefined {
  try {
    const get = ctx.get
    if (typeof get !== 'function') return undefined
    const value = get.call(ctx, name)
    return value === null || value === undefined ? undefined : (value as T)
  } catch {
    return undefined
  }
}

/** 包一层 try/catch：插件永远不许挡住聊天。 */
export function safe<T>(what: string, ctx: MindContext, fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (error) {
    warn(ctx, `[dsh-mind] ${what} 出错，已降级`, error)
    return fallback
  }
}

/** 异步版的 `safe`。 */
export async function safeAsync<T>(
  what: string,
  ctx: MindContext,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    warn(ctx, `[dsh-mind] ${what} 出错，已降级`, error)
    return fallback
  }
}

/** 写日志；日志器本身也可能没有。 */
export function warn(ctx: MindContext, ...args: unknown[]): void {
  try {
    ctx.logger?.warn?.(...args)
  } catch {
    /* 连日志都失败就什么都别做 */
  }
}

export function debug(ctx: MindContext, ...args: unknown[]): void {
  try {
    ctx.logger?.debug?.(...args)
  } catch {
    /* 同上 */
  }
}

/* ───────────────────────── 模块解析 ───────────────────────── */

/**
 * DSH 主目录：`$DSH_HOME` 优先，否则 `~/.dsh`（与 dsh-home-paths 行为一致）。
 * 不 import `@deepseek-ai/dsh-home-paths`：为一个取值多担一次加载风险不值得。
 */
export function dshHome(): string {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return path.join(homedir(), '.dsh')
}

/**
 * 拆 CJS 互操作包装。
 *
 * `require()` 拿到的若是 esbuild/tsup 打出来的 CJS 壳，整个模块会被挂在 `default` 上。
 * 实测：`@deepseek-ai/schemastery` 解析到 `lib/index.cjs` 就是这种形状，
 * 于是 `typeof schemastery.object !== 'function'`，插件会**误报"宿主没有 schemastery"**
 * 并静默降级（真实启动日志里就是这句："两处降级：schemastery 缺失…"）。
 *
 * 只在**确实是纯壳**（除 `__esModule` 外只有一个 `default`）时才拆，
 * 避免误伤 zod 这类真模块。
 */
function unwrapInterop(loaded: unknown): unknown {
  if (loaded === null || typeof loaded !== 'object') return loaded
  const holder = loaded as Record<string, unknown>
  const keys = Object.keys(holder).filter((key) => key !== '__esModule')
  if (keys.length === 1 && keys[0] === 'default') return holder['default']
  return loaded
}

/**
 * 试着 require 一个宿主自带的包，**多试几个基准**。
 *
 * 只认 `import.meta.url` 是不够的（feiyu-memory 实测）：pnpm 把包装进
 * `.pnpm/<pkg>@<ver>/node_modules/<pkg>/`，而它外面的 node_modules 里没有
 * `@deepseek-ai/schemastery`；用 `link:` 安装时插件在别的盘、包在 profile 里，
 * 隔了十万八千里。所以还要试 profile 目录、DSH 安装目录、DSH_HOME 下的各 profile。
 */
export function resolveModule(
  name: string,
  specifier: string,
  trace?: (base: string, error: unknown) => void,
  /**
   * 判定"这个结果能不能用"。
   *
   * 必须逐个基准判形状，不能拿到就返回：DSH 的安装目录里可能装着**另一个版本的同一个包**
   * （实测：从 `app.asar` 里 require 到的 schemastery 形状与插件自己 node_modules 里的不一样，
   * 于是"require 成功了、但 `object` 不是构造器"，插件照样降级，而且**连失败记录都没有**）。
   */
  usable?: (loaded: unknown) => boolean,
): unknown {
  const bases = new Set<string>()

  const push = (file: string | undefined): void => {
    if (typeof file === 'string' && file !== '') bases.add(file)
  }

  /**
   * 连**真实路径**一起试。
   *
   * 用 `link:` 装插件时，Node 可能带着 `--preserve-symlinks` 语义把 `import.meta.url`
   * 报成 `<profile>/node_modules/dsh-mind/lib/config.js`——从那儿往上找只能找到 profile 的
   * node_modules，而 profile 里**没有** `@deepseek-ai/*`（那些来自 DSH 自己的安装目录）。
   * 于是插件会误以为"宿主没有 schemastery"并降级。realpath 一下就回到插件真正的家。
   */
  const pushWithReal = (file: string | undefined): void => {
    push(file)
    if (typeof file !== 'string' || file === '') return
    try {
      if (existsSync(file)) push(realpathSync(file))
    } catch {
      /* asar 里的路径 realpath 可能失败，忽略 */
    }
  }

  try {
    pushWithReal(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  } catch {
    /* 忽略 */
  }
  push(path.join(process.cwd(), 'package.json'))

  // DSH 自己的安装目录：从 CLI 入口往上找
  try {
    const argv1 = process.argv[1]
    if (typeof argv1 === 'string' && argv1 !== '') {
      push(argv1)
      let dir = path.dirname(argv1)
      for (let i = 0; i < 8; i += 1) {
        push(path.join(dir, 'package.json'))
        const next = path.dirname(dir)
        if (next === dir) break
        dir = next
      }
    }
  } catch {
    /* 忽略 */
  }

  // DSH_HOME 下的各 profile
  try {
    const home = dshHome()
    const profiles = path.join(home, 'profiles')
    if (existsSync(profiles)) {
      for (const entry of readdirSync(profiles)) {
        push(path.join(profiles, entry, 'package.json'))
      }
    }
    push(path.join(home, 'package.json'))
  } catch {
    /* 忽略 */
  }

  for (const base of bases) {
    try {
      const loaded = unwrapInterop(createRequire(base)(name))
      if (usable !== undefined && !usable(loaded)) {
        // 找到了但形状不对：继续找下一个基准，并留下线索
        try {
          trace?.(base, new Error(`形状不可用（键：${Object.keys((loaded as object) ?? {}).slice(0, 6).join(',')}）`))
        } catch {
          /* 忽略 */
        }
        continue
      }
      return loaded
    } catch (error) {
      // 留下失败记录：降级时这是唯一能说清"为什么拿不到"的线索
      try {
        trace?.(base, error)
      } catch {
        /* 忽略 */
      }
    }
  }

  void specifier
  return undefined
}
