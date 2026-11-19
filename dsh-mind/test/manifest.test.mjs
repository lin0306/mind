/**
 * 清单与边界的自检。
 *
 * 这一份盯的是两类**不能靠"我记住了"来保证**的东西：
 *
 * 1. **市场硬要求**——按被拒率排：没有 `dsh.bundle`、仓库根没有 `cordis.patch.yml`、
 *    图标缺失或过大、locale 缺 `meta.title/description`、手写 `npm:` 字段。
 *    这些每一条都只是"少写一行"，但代价是上架被拒。
 *
 * 2. **包边界**——`mind-core` 必须与 agent 无关（零依赖、不 import `node:` 内置、
 *    不 import `@deepseek-ai/*`）。这是"能迁移到别的 agent"的唯一保证：
 *    靠自觉迟早会破，靠测试就不会。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * 按绝对路径 import。
 *
 * Windows 上 `import('E:\…\lib\index.js')` 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME——
 * 绝对路径必须先转成 `file://` URL（这也是适配层里 `resolveModule` 要做同样转换的原因）。
 */
const importFile = (file) => import(pathToFileURL(file).href)

test('市场硬要求：dsh.bundle、根 patch、图标、双语文案、files 齐全', () => {
  const pkg = readJson(path.join(ROOT, 'package.json'))

  // ① package.json 必须声明 dsh.bundle（只声明 dsh.client 是第一大拒收原因）
  assert.ok(pkg.dsh?.bundle?.patch, 'package.json 缺 dsh.bundle.patch')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.manifestVersion, 1)

  // ② 仓库根必须有 cordis.patch.yml，且是 insert 语义
  const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/, 'patch 必须是 insert 语义（覆盖语义的新增会被静默跳过）')
  // insert 的列表项里要有 id 与 name（规范写法就是 `- id: …` 换行 `name: …`）
  assert.match(patch, /\bid:\s*\S/)
  assert.match(patch, /\bname:\s*\S/)

  // ③ 图标：要存在，且 ≤256KiB
  assert.ok(typeof pkg.icon === 'string' && pkg.icon !== '', 'package.json 缺 icon 字段')
  const icon = path.join(ROOT, pkg.icon)
  assert.ok(existsSync(icon), `图标不存在：${icon}`)
  assert.ok(statSync(icon).size <= 256 * 1024, '图标超过 256KiB')

  // ④ 双语文案：meta.title 与 meta.description
  for (const lang of ['zh', 'en']) {
    const locale = readJson(path.join(ROOT, 'locale', `${lang}.json`))
    assert.ok(typeof locale.meta?.title === 'string' && locale.meta.title !== '', `${lang}.json 缺 meta.title`)
    assert.ok(
      typeof locale.meta?.description === 'string' && locale.meta.description !== '',
      `${lang}.json 缺 meta.description`,
    )
  }

  // ⑤ files 必须带上全部运行时文件（本地目录安装不过滤，但 npm 打包会）
  for (const need of ['lib', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md']) {
    assert.ok(pkg.files.includes(need), `files 缺 ${need}`)
  }
  for (const subpath of ['./package.json', './cordis.patch.yml', './locale/*.json']) {
    assert.ok(Object.keys(pkg.exports).includes(subpath), `exports 缺 ${subpath}`)
  }

  // ⑥ 不要手写 npm: 字段（会被判无效）
  assert.ok(!JSON.stringify(pkg).includes('"npm:'), 'package.json 里出现了手写的 npm: 字段')
})

test('包边界：core 零依赖、不 import node: 内置、不 import 宿主包', () => {
  const core = readJson(path.join(ROOT, '..', 'mind-core', 'package.json'))
  assert.deepEqual(core.dependencies ?? {}, {}, 'core 的 dependencies 必须是空的（包边界即硬约束）')
  assert.deepEqual(core.peerDependencies ?? {}, {}, 'core 不许有 peerDependencies')
  assert.ok(!JSON.stringify(core).includes('@deepseek-ai/'), 'core 的清单里出现了 @deepseek-ai/*')

  const srcDir = path.join(ROOT, '..', 'mind-core/src')
  const offenders = []
  for (const relative of readdirSync(srcDir, { recursive: true })) {
    if (typeof relative !== 'string' || !relative.endsWith('.ts')) continue
    const text = readFileSync(path.join(srcDir, relative), 'utf8')
    if (/from\s+'node:/.test(text)) offenders.push(`${relative}（node: 内置）`)
    if (/from\s+'@deepseek-ai\//.test(text)) offenders.push(`${relative}（宿主包）`)
    if (/\brequire\s*\(/.test(text)) offenders.push(`${relative}（require）`)
  }
  assert.deepEqual(offenders, [], `core 必须是纯逻辑，不能出现：${offenders.join('、')}`)
})

test('入口：四个导出都在，且 apply 是可调用的函数', async () => {
  const entry = await importFile(path.join(ROOT, 'lib/index.js'))
  assert.equal(entry.name, 'dsh-mind')
  assert.ok(Array.isArray(entry.inject) && entry.inject.length > 0)
  assert.ok(entry.Config, 'Config 不能是 undefined（DSH 会传空模板，用户配置全部失效）')
  assert.equal(typeof entry.apply, 'function')
})

/**
 * 这条是**真实加载失败换来的**：
 *
 * ```
 * mind (dsh-mind): TypeError: Cannot read properties of undefined (reading 'validate')
 * ```
 *
 * `cordis/lib/index.js:956-962` 的 `resolveConfig` 只认 `Config["~standard"].validate`。
 * 缺了它，插件**完全不激活**，而且报错点看起来跟配置毫无关系。
 */
test('Config 必须是 Standard Schema：~standard.validate 可用且会补默认值', async () => {
  const entry = await importFile(path.join(ROOT, 'lib/index.js'))
  const standard = entry.Config['~standard']
  assert.ok(standard, 'Config 缺 ~standard，loader 会在 resolveConfig 里直接抛错')
  assert.equal(typeof standard.validate, 'function')

  const result = standard.validate({ halfLifeMin: 30 })
  assert.ok(!('then' in result), '校验必须是同步的（异步会抛 Async config validation is not supported）')
  assert.equal(result.issues, undefined)
  assert.equal(result.value.halfLifeMin, 30, '用户传的值必须原样保留')
  assert.equal(result.value.moodHalfLifeHours, 12, '没传的必须补上默认值')
  assert.equal(result.value.enabled, true)

  // 空模板（DSH 在没有 Config 时会传这个）也要能补全——**每一项**都要在，
  // 否则用户配置里没写到的项就取不到默认值（这条正是真实加载失败换来的教训）。
  const { CONFIG_FIELDS } = entry
  const empty = standard.validate({})
  assert.deepEqual(
    Object.keys(empty.value).sort(),
    CONFIG_FIELDS.map((field) => field.key).sort(),
    '空模板进来也要拿到全部配置项',
  )
})

test('人设内核解析器：三种写法都能认，空文件等于没有内核', async () => {
  const { parsePersonaText } = await importFile(path.join(ROOT, 'lib/index.js'))

  const full = parsePersonaText(['名字: 小和', '价值观:', '  - 诚实: 0.9', '  - 不图快', '边界:', '  - 不做破坏性操作'].join('\n'))
  assert.equal(full.nonEmpty, true)
  assert.equal(full.patch.name, '小和')
  assert.equal(full.patch.values['诚实'], 0.9)
  assert.equal(full.patch.values['不图快'], 0.5, '写了价值观没写权重时给中性权重，不能丢')
  assert.deepEqual(full.patch.boundaries, ['不做破坏性操作'])

  const empty = parsePersonaText('# 只有注释\n')
  assert.equal(empty.nonEmpty, false)
  assert.deepEqual(empty.patch, {})
})
