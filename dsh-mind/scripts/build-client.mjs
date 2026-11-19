/**
 * 把 `client/out/index.js`（tsc 出的 CommonJS）包成 DSH 客户端要求的 **CJS factory**。
 *
 * 为什么不用打包器做这一步：客户端 bundle 的形状是**硬契约**
 * （`window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })`，
 * 且 `id` 必须等于包名），而我们需要的只是"加一个信封"。
 * tsc 已经能出 CommonJS，少引一个打包依赖就少一处版本漂移——打包这一步越笨越好。
 *
 * 用法：`pnpm run build`（root 脚本里已经串上：tsc -b → tsc -p client → 这个脚本）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const compiled = path.join(root, 'client', 'out', 'index.js')
const target = path.join(root, 'client', 'index.js')

if (!existsSync(compiled)) {
  console.error('[build-client] 没找到 client/out/index.js —— 先跑 `tsc -p client/tsconfig.json`')
  process.exit(1)
}

// 包里读出来的包名就是 loader 的 id（两个来源解析到同一包名会让组合直接失败，所以只能有一个来源：package.json）。
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const body = readFileSync(compiled, 'utf8')

const envelope = [
  '// ⚠️ 这个文件由 scripts/build-client.mjs 生成，不要手改。改 client/src/*.ts 后重新构建。',
  '// DSH 客户端的加载形状：id 必须等于包名，factory 收到 require 并交回 module.exports。',
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(pkg.name)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  body,
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')

mkdirSync(path.dirname(target), { recursive: true })
writeFileSync(target, envelope, 'utf8')
console.log(`[build-client] 已生成 ${path.relative(root, target)}（${envelope.length} 字节）`)
