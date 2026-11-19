# dsh-mind

让 DSH 里的 agent 带上**延续的情感与思想**。

它改的是 agent **自己**：复盘时会真的比上一次谨慎、被连续报错会烦躁、跨会话还记得你定过的规矩。
不是角色扮演，不是给回复贴情绪标签——那些是另一类插件干的事。

> 同一时刻：**人设只有一份**，但整体在演化（说话习惯按周、自我认知按周–月、内核按年）；
> **情绪可以多种并存**；**思想**是它写给自己的东西，只在下一次对话里起作用。

---

## 它做了什么

三件事，没有第四件：

| 落点 | 内容 | 为什么放这儿 |
|---|---|---|
| `systemPrompt.section`（系统提示词） | 人设：内核 / 自我认知 / 说话习惯 / 硬边界 | 改动很少，放系统提示词不伤前缀缓存，也不每轮重复占尾巴 |
| `systemPrompt.context`（请求末尾） | 此刻：情绪、思想、相处、手边记着的事 | 每步都在变；放系统提示词会把之后所有内容缓存全毁掉 |
| 三个工具 `inner_note` / `recall_memory` / `forget_memory` | 思想写回、长期记忆**主动查**、划掉某一条 | 工具调用天然落在会话日志里 → 状态可重放、可审计（**不新增任何会话事件类型**） |

状态**只有一个载体**：会话投影（`ctx.sessionProjections`）。
所以它是会话日志的纯函数派生量——可回放、可冷读、随会话销毁而回收，没有一份"藏在插件里的第二状态"。

## 装法

```bash
# 装进某个 profile（推荐先用临时 profile 试）
dsh plugin --profile <profile> add @lin0306/dsh-mind

# 本地开发时直接指目录
dsh plugin --profile <profile> add file:E:/code/thought/dsh-mind   # 指向**插件包**这一层
```

**零运行时依赖**：内核与用到的库都在构建时内联进产物，装的时候不需要顺手解析任何包。

装完重启该 profile 的会话即可生效。卸载：`dsh plugin --profile <profile> remove @lin0306/dsh-mind`。

## 命令

```
/mind                    完整状态：情感 / 思想 / 人设 / 记忆
/mind why                最近几次情绪到底从哪来（每一条都带"因为"）
/mind persona            人设，以及三档漂移各走到哪了
/mind history            内核变化史（年尺度那一档，每次留快照）
/mind remember [词]      长期记忆里有什么；带词就只列相关的，并逐条说明"凭什么记着它"
/mind show [层]          分三层看记忆：short 手边 / session 本会话日记 / global 跨会话库
/mind show trash         回收站里有什么、原来是哪一层、为什么掉的
/mind clear <层>         只清那一层（裸写只列各层条数、不真清——不可逆动作防手滑）
/mind forget [层] <序号|词>  替它划掉一条：不带层走跨会话库，带层就只划那一层
/mind restore <序号>     从回收站捞回来（清掉的东西其实只是假删）
/mind unforget <序号>    撤销一次遗忘（要配合 restore 才算真的回来）
/mind purge <序号>       真删——唯一不可逆的地方
/mind log                插件自己记的日志（headless 下宿主日志看不见）
/mind config             配置与降级自检（如实报告哪一块降级了）
/mind reset-memory       只清记忆三层，人设与相处统计保留
/mind reset-archive      清空跨会话档案（人设自我认知 + 长期记忆）
```

读与写分开看：`/mind`、`show`、`remember`、`why`、`persona`、`history`、`log`、`config` **只读**；
`clear` / `forget` / `restore` / `unforget` / `purge` / `reset-memory` / `reset-archive` 会改档案。

**删除一律是假删**：清掉、划掉的东西先进回收站（`/mind show trash` 看得到、`restore` 捞得回），
真删只有 `purge` 一个口子。

会话内的状态不能"重置"——它由会话日志折叠而来，投影没有写入 API，这是设计而不是缺陷。
`/mind forget` 改的是**档案**，下一个会话才生效；想让它在**本会话内**立刻消失，用 `forget_memory`
工具（那条会落进会话日志，于是可重放）。

## 配置

在 profile 的 `cordis.patch.yml` 里给自己那条加 `config:`，只写想改的：

```yaml
- insert:
    - id: mind
      name: dsh-mind
      config:
        halfLifeMin: 45        # 情绪来得快去得也快（默认 90 分钟）
        baselineValence: 0.1   # 性情底色更偏正
        debugLog: true
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（关掉后不再注入，但状态仍在折叠） |
| `injectPersona` / `injectRealtime` | `true` | 两段注入分别开关；全关即零提示词开销 |
| `baselineValence` / `baselineArousal` / `baselineDominance` | `0.05` / `0.25` / `0.5` | 静息性情（效价 / 唤醒 / 支配感） |
| `halfLifeMin` / `moodHalfLifeHours` | `90` / `12` | 即时情绪与心境的半衰期 |
| `gain` | `1` | 情绪有多容易被推起来 |
| `voiceDrift` / `traitDrift` / `kernelDrift` | `0.2` / `0.1` / `0.02` | 三档演化的漂移上限（周 / 周–月 / 年） |
| `memoryShortMax` / `memoryLongMax` / `recallLimit` | `6` / `400` / `5` | 记忆额度 |
| `heavyTokens` / `longUserChars` | `8000` / `1200` | 什么算"这一轮很重""一次给了很多" |
| `personaPath` / `stateDir` | 空 | 人设内核文件 / 档案目录（默认都在 `$DSH_HOME/dsh-mind/`） |
| `allowExpose` / `proactive` | `true` / `false` | 偶尔外露 / 主动开口（默认关：关就是连监听都不挂） |
| `debugLog` | `false` | 调试日志（同时进内存环形缓冲，`/mind log` 能看） |

## 数据在哪

全部在本地，**不发任何网络请求**：

- `$DSH_HOME/dsh-mind/state.json` —— 人设 / 长期记忆 / 累计统计（原子写，坏了只当"这次想不起来"）
- `$DSH_HOME/dsh-mind/persona.md` —— 人设内核，**你可以直接改**（首次运行会给一份带注释的模板）

内核是唯一"只有你能直接改"的东西；硬边界永远不参与自动演化。

## 架构

```
mind/（仓库）
├── mind-core/       内核内容（包名 dsh-mind-core）：人设 / 情感 / 记忆 / 思想的纯逻辑
│                    纯函数、零 DSH 依赖、可回放；单拿出来接别的 agent 还得写一层 adapter
└── dsh-mind/        插件包（就是本目录，仓库里唯一发布的包）
    ├── src/         DSH 适配层：只做接线 / 翻译 / 容错
    ├── client/      左侧栏面板（Web UI）
    └── adapters/cli/  第二个 adapter：一行 DSH 都没有，跑的是同一份 core
```

**开发时是两个包，发布出去的是一个包。** 构建时 `tsdown` 把 `dsh-mind-core`（连同 zod、schemastery）
内联进 `lib/index.js`，所以 `dependencies` 是空的、**零运行时依赖**——插件是被
`dsh plugin add <名字>` 装进 profile 的，依赖不一定被解析，产物里留着外部 import 就是"装上了但不激活"。

装 `dsh-mind` **不需要**（也不应该）再装 `dsh-mind-core`：它是内核内容，已经在这个包里了，
`mind-core` 也标了 `private: true`，发不出去。

两道边界是**靠包边界强制**的，不是靠自觉：`mind-core` 的 `dependencies` 是空的，
不依赖任何 `@deepseek-ai/*`，连 `tsconfig` 的 `types` 都是空的——想在 core 里 import 宿主的东西，
构建就会失败。`test/cli-adapter.test.mjs` 把这句话变成了断言：core 的每一条 import 要么是相对的、要么是 `node:` 内建。

换 agent 的姿势：`createMind()` 拿门面，`observe(事件)` 喂折叠，`assemble()` 取两段文本
（`stable` 进系统提示词、`dynamic` 进请求末尾），`recall()` / `panel()` / `persist()` 按需用。
**core 一行不用改。**

先看它跑起来：

```bash
node adapters/cli/mind-cli.mjs --demo
```

## 已知范围（v1.0–v1.5）

做完了：情感（三维 affect + 心境 + appraisal 推导的具名情绪）、思想（`inner_note` + 折叠）、人设三档演化、记忆（短期注入 + 长期主动查 + **能看能忘**）、**自更新闭环**（性情基线按天漂移、有界、可回滚）、`/mind`。

**记忆的分工**（这是它像人的地方）：

- **短期**（默认 6 条）在每轮末尾的 `【手边记着的事】` 里，不用想就知道；
- **长期**（默认 400 条）只能**主动查**：`recall_memory`，也就是"我想想……"。查不到就老实说想不起来，并被告知不要凭印象编。
- **按工作区弱绑定、按种类分级**：`preference`（关于你这个人）不带工作区、到哪都看得见；`fact` / `agreement` / `lesson`（关于某个项目）记在写下它的那个工作区。**注入**只给「本工作区 + 全局」，所以别的项目的细节不会串过来；**主动查**时仍能查到其他工作区的，只是降权、并在结果里标「· 跨工作区」。
- 长期库不为空时，每轮注入末尾多一行**数量索引**（这个工作区 N 条、全局 M 条）——只报数量，不列内容：让它知道自己有地方可查。

一条记忆要走完这条链才算"存下来了"：这一轮说的事值得记 → 进短期 → 一轮结束时够重要（被反复取用或重要度高）→ 固化进长期 → 下次被查到时加固。

> **已知限制**：检索按**字面重合**算分，所以工具描述里要求模型写关键词而不是整句问句。
> 问法差太远就会真的想不起来——这是刻意的：宁可说"记不清"，也不要硬凑一条答非所问的。
> 只共享一两个常用字不算命中（所以「包管理器用哪个」这种问法会落空，写 `pnpm` 就能中）。

**忘掉一条**有两条路，走的是同一份**遗忘名单**：人从外面替它划（`/mind forget`），或它自己调 `forget_memory`。
名单存在档案里，**接管档案与写档案两边都按名单过滤**——不然下一次落盘时那条又会长回来。
遗忘**不可逆**，所以指认不明（片段对不上、或同时对上好几条）时**什么都不删**：宁可没删掉，不可删错。
划掉过几条也如实写在 `/mind` 里——遗忘是它的一部分，不该看不见。

- **v1.3 决策通道**：情绪参与「这一轮该怎么想」——偏离静息状态就调 `temperature`（幅度有上限、结果夹在 0.05..0.95），有没解决的矛盾就把 `reasoningEffort` 上调一档。**只碰这两个参数**，模型 / provider / 工具 / `maxTokens` 一律不动；provider 没配 `temperature` 时这一半自然不生效（不凭空造参数）。
- **v1.4 主动开口**（默认关）：只有「心里搁着事 + 情绪上真的在 + 冷却已过（45 分钟）」三条同时成立，
  回合结束后才会自己起一个回合说一句；**默认关就是连监听都不挂**，不说时零开销、零模型调用。
  被用户打断（`signal.aborted`）的那一轮绝不开口。
- **面板**：左侧栏多一个「心念」图标；页面按**用途**分三个 tab——
  此刻（情绪环 + 心境 + 人设雷达）/ 想法（当前想法 + 内心记录 + 本会话日记，后两块可折叠）/
  记忆（跨会话库，按来源分组折叠）。
  面板**不做格式化**——中枢把每区的文本通过会话投影的 `wire` 准备好的，客户端只负责画，
  所以「面板上的说法」和「`/mind` 的说法」永远是同一份。

**第二个 adapter 已经落地**（v1.5 的硬要求）：`adapters/cli/` 是一个命令行适配层，
一行 DSH 都不认识，跑的是同一份 core——折叠、两段文本、长期记忆召回、面板、跨会话档案全通。
它同时也是个调试工具：把事件按 JSONL 喂进去，就能看见状态一轮一轮怎么变。

**已知限制**：英文文案只覆盖了插件注册那一层，面板标签仍是中文。

## 开发

在**仓库根**跑（根 `package.json` 只是 workspace 根，脚本转发到这里）：

```bash
pnpm install
pnpm build      # 内核 → tsdown（把内核与依赖内联进 lib/index.js）→ 客户端信封
pnpm test       # 全量测试（232 项：内核 + 适配层接线 + 客户端产物 + 清单）
pnpm validate   # 发布前自检
pnpm demo       # 第二个 adapter（不碰 DSH）
```

测试分三层：

| 层 | 文件 | 管什么 |
|---|---|---|
| 机制 | `mind-core/test/` | 半衰期、证据制、漂移上限、一次事件封顶、记忆召回、主动开口的三道闸 |
| 接线 | `test/adapter.test.mjs` | 用**假宿主**：事件进得来、状态出得去、提示词真有那一段、档案真落盘、工具真注册上 |
| 迁移 | `test/cli-adapter.test.mjs` | 第二个 adapter 跑通同一条链路；core 的 import 只有相对路径与 `node:` 内建 |

接线的必须性来自真机教训：**测试全绿不等于插件能用**。`Config` 缺 `~standard`、登记工具时丢了
`this`、`followup` 不带消息——这三个都是全绿状态下真机完全不工作，只有真跑一次才会露出来。

## 发布

两件事互相独立：发到 npm（能被安装）与进社区 registry（能被市场搜到）。

最短路径（在仓库根执行）：

```bash
pnpm build && pnpm test && pnpm validate   # 在仓库根
cd dsh-mind && pnpm publish --access public
```

**只发一个包**：内核已经内联进产物，`dependencies` 是空的；`mind-core` 是 `private: true`，发不出去。
（仓库根是 workspace 根、`private: true`，所以必须进到插件包里发。）

`lib/` 与 `client/index.js` 不进 git，产物由 `prepublishOnly` 现场构建。

## 许可

MIT
