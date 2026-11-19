# mind

让 DSH 里的 agent 带上**延续的情感与思想**。

它改的是 agent **自己**：复盘时会真的比上一次谨慎、被连续报错会烦躁、跨会话还记得你定过的规矩。
不是角色扮演，不是给回复贴情绪标签。

四层——**人设 / 情感 / 记忆 / 思想**，由一个自更新闭环串起来。
状态全部由会话日志折叠而来（可回放、随会话销毁回收），产物零运行时依赖。

## 装

```bash
dsh plugin --profile <profile> add @lin0306/dsh-mind
```

装完重启该 profile 的会话。命令、配置、数据存哪，都在 **[`dsh-mind/README.md`](dsh-mind/README.md)**。

## 仓库

| 目录 | 是什么 |
|---|---|
| [`mind-core/`](mind-core/) | 内核：人设 / 情感 / 记忆 / 思想的纯函数实现。零依赖、可回放，不单独发布 |
| [`dsh-mind/`](dsh-mind/) | 插件包：**唯一发布出去的东西**（内核构建时内联进来） |

## 开发

```bash
pnpm install
pnpm build      # 内核 → 插件 → 面板
pnpm test       # 232 条
pnpm validate   # 发布前自检 53 项
pnpm demo       # 命令行跑一遍内核：一行 DSH 都没有
```

## 发布

只发 `dsh-mind` 一个包（`mind-core` 是 `private`，发不出去也不该发）：

```bash
cd dsh-mind && pnpm publish --access public
```

## 许可

MIT
