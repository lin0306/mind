/**
 * tsdown 构建：把**根包 + 内核**打成一个自洽的产物。
 *
 * ## 为什么必须打在一起（不是审美问题）
 *
 * 插件是被人用 `dsh plugin add <名字>` 装进 profile 的，**依赖不一定会被解析安装**
 * ——社区里已经有插件只好用 `await import('zod')` 加兜底来绕这件事。
 * 只要产物里还留着一句 `import 'dsh-mind-core'`，换个安装方式就是"插件不激活"，
 * 而且报错点看起来跟依赖毫无关系。
 *
 * 所以结构是：
 * - **开发时两个包**：`packages/core`（`dsh-mind-core`）保持独立，可单独发布、可给别的 agent 复用；
 * - **发布的是一个包**：内核内联进 `lib/index.js`，产物**零运行时依赖**。
 *
 * 类型不走 tsdown（`dts: false`）：根 `tsconfig.json` 把 `.d.ts` 单独产到 `lib/types/`，
 * 这样 `tsdown` 可以放心 `clean`，不会把上一轮的类型声明删掉。
 */

import { defineConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-mind'

export default defineConfig([
  {
    name: `${PACKAGE_ID}/host`,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    // 清理由 build 脚本负责（必须在 `tsc` 之前），否则 tsdown 会把 `lib/types` 一起删掉
    clean: false,
    outputOptions: {
      // tsdown 默认把 ESM 出成 `.mjs`；本包 `type: module`，用 `.js` 更贴合 README 与 exports
      entryFileNames: 'index.js',
    },
    /**
     * ★ 除了 node 内建，**全都内联**：`dsh-mind-core`、`zod`、`@deepseek-ai/schemastery`。
     *
     * `zod` 与 `schemastery` 是"能用宿主的就用、拿不到就降级"（`src/config.ts` 里的
     * `resolveModule` 与纯 JS 兜底），内联之后降级分支根本不会被走到——少一条不确定的路。
     * 内联也不会与宿主冲突：两者都只被当"数据形状"用（`~standard.validate` 是鸭子类型），
     * 没有 `instanceof` 之类的同源要求。
     */
    deps: {
      /**
       * 必须内联的三样（写成明处，比通配更好检查）。
       *
       * `alwaysBundle` 只认字符串/正则列表——传 `true` 会在 picomatch 里炸
       * （`Expected pattern to be a non-empty string`），这是踩过的。
       */
      alwaysBundle: ['dsh-mind-core', 'zod', '@deepseek-ai/schemastery'],
    },
  },
])
