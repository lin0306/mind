# dsh-mind-core

`dsh-mind` 的内核。**与 agent 无关**：它不知道 DSH、不知道会话、不知道投影，只认「事件进、产物出」。

**它不是拿来即用的。** core 是"内容"：想给别的 agent（另一个 harness、自研 agent）接上情感与思想，
光有它不够，还得写一层兼容逻辑——把那个 agent 的事件翻成 `MindEvent`，再把回来的两段文本放到它该放的地方。
本仓库有两个现成的例子（根包的 `src/` 走 DSH、`adapters/cli/` 走命令行），但**换一个 agent 仍然要再写一层**。
好处是：要写的只是那一层，**core 自己一行不用改**。

**它也不单独发布**（`package.json` 里 `private: true`）：装 `dsh-mind` 时内核已经内联在产物里了，
不需要、也不应该再装一个 `dsh-mind-core`。

## 为什么单独成包

1. **迁移性**：适配层与逻辑分开，换宿主只换适配层。
2. **可测**：纯函数 + 注入的 `now`，`node --test` 直接跑，不用起 harness。
3. **硬约束**：`dependencies` 为空、`tsconfig` 里 `types: []`（连 Node 的 `process` / `Buffer` 都用不了）、
   源码只允许相对路径与 `node:` 内建的 import。**包边界本身就是纪律**，`test/cli-adapter.test.mjs` 里有断言在守。

## 边界

| 可以做 | 不可以做 |
|---|---|
| 纯计算：评价、演化、漂移、召回打分、渲染文本 | import 任何 agent API |
| 用传进来的 `now` 推进时间 | 直接读 `Date.now()` |
| 把状态用返回值交回给调用方 | 直接碰磁盘、网络、环境变量 |

## 用法

```ts
import { createMind, createEventStream } from 'dsh-mind-core'

// 1) 造门面。传 persist 就是「接着上一次的自己继续」
const mind = createMind({ now: Date.now() })

// 2) 事件进：`createEventStream` 负责维护单调递增的 seq，并把真机实测过的形状固定下来
const ev = createEventStream()
const t = Date.now()
mind.observe(ev.turnStart(1, t))
mind.observe(ev.userMessage('这个项目用 pnpm，别用 npm', t + 1))
mind.observe(ev.toolCall('read', { path: 'README.md' }, t + 2))
mind.observe(ev.toolResult('read', t + 3, { isError: true, error: 'ENOENT' }))
mind.observe(ev.turnEnd(1, t + 4, 'completed'))

// 3) 产物出：两段文本。stable 放系统提示词，dynamic 放请求末尾
const { stable, dynamic } = mind.assemble()
//   stable  → 【我的人设】…（改动很少）
//   dynamic → 【内部状态·给你自己看的，不要出现在回复里】…（每步都在变）
//             —— 这两段**不能放反**：dynamic 进系统提示词会让它之后的全部内容每轮失去前缀复用

// 4) 长期记忆只能靠主动查（这就是人说的「我想想」）
mind.recall('包管理器')

// 5) 跨会话延续：存这三样（人设 / 长期记忆 / 统计），下次 createMind({ persist })
const saved = mind.persist()
```

`MindEvent` 的形状与真机一致，这几处是实测踩出来的：

- `tool/call` 的 `arguments` 是**字符串**，不是对象
- 助手文本在 `assistant/message.stream[].texts` 里
- `user/message.source.kind` 决定这条算不算**用户亲口说的**——插件自己造的消息（比如主动开口的唤醒语）
  要传自己的 kind，否则会被当成用户说过的话记进记忆

## 参考实现

- `adapters/cli/mind-cli.mjs`：一行 DSH 都没有的第二个 adapter。`node adapters/cli/mind-cli.mjs --demo` 直接看效果，
  也可以 `--events 事件.jsonl` 喂自己的日志、`--json` 拿结构化输出
- 仓库根包的 `src/`：DSH 的 adapter（会话投影承载状态、提示词两段落点、`inner_note` / `recall_memory` 工具、`/mind` 命令）

## 状态是可回放的

状态是**事件的纯函数**（`applyEvent`），同一份日志折两次一定得到同一结果——所以能重放、能审计、能冷读历史会话。
跨会话落盘的只有三样：**人设**、**长期记忆**、**统计**；情绪与思想是会话内的，随会话结束而消失。

## 许可

MIT
