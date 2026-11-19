#!/usr/bin/env node
/**
 * 发布前自检：把"被市场拒过"的坑逐条变成断言。
 *
 * 这些检查不是凭想象列的，每一条都对应一份真实的拒绝记录或一次真实的加载失败
 * （见 `research/DSH-API-NOTES.md` 与 `research/repos/emotion-feedback/docs/publishing.md`）：
 *
 * | 检查 | 对应的坑 |
 * |---|---|
 * | 声明 `dsh.bundle.patch` | 只声明 `dsh.client` 是**第一大拒收原因** |
 * | 根目录有 `cordis.patch.yml` 且是 `- insert:` | 用覆盖语义会被**静默跳过**，插件根本不加载 |
 * | `files[]` 覆盖全部运行时文件 | 仓库能跑、装完却缺文件（尤其 `locale/` 与 `client/`） |
 * | `client/index.js` 是 CJS factory | 普通 ESM 会报 `loaded without registering ... __ModuleLoader__.load` |
 * | `dsh.client.inject` 不写会阻塞的服务 | 一个从不出现的服务会让整个 entry **永久 pending、不激活** |
 * | icon ≤ 256 KiB、locale 有 meta | 市场显示与校验 |
 * | 两包版本一致、core 零依赖 | 发布顺序与"core 真的干净" |
 *
 * 用法：`node scripts/validate.mjs`（退出码非 0 表示不能发布）
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const warnings = []
const passed = []

function check(ok, label, detail = '') {
  if (ok) passed.push(label)
  else problems.push(detail === '' ? label : `${label}｜${detail}`)
}
function warn(ok, label, detail = '') {
  if (ok) passed.push(label)
  else warnings.push(detail === '' ? label : `${label}｜${detail}`)
}
function readJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'))
}
function exists(rel) {
  return existsSync(path.join(ROOT, rel))
}
/** `files[]` 里的目录写法（`lib`）要能覆盖 `lib/index.js`。 */
function covered(files, rel) {
  return (files ?? []).some((entry) => {
    const clean = String(entry).replace(/\/+$/, '')
    return rel === clean || rel.startsWith(`${clean}/`)
  })
}

// 注意：这个脚本住在插件包里（`dsh-mind/scripts/`），所以 ROOT 是**包根**；
// 内核与 docs 是它的兄弟目录，一律用 `../` 指过去。
const pkg = readJson('package.json')
const core = readJson('../mind-core/package.json')

// ── 1. 市场硬要求 ───────────────────────────────────────────
check(
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  'package.json 声明了 dsh.bundle.patch',
  '只声明 dsh.client 是市场第一大拒收原因',
)
check(exists('cordis.patch.yml'), '包根有 cordis.patch.yml', '市场硬要求它在**包根**（本仓库的包根是 dsh-mind/）')
if (exists('cordis.patch.yml')) {
  const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  check(/-\s*insert:/.test(patch), 'cordis.patch.yml 用的是 `- insert:`', '覆盖语义会被静默跳过')
  check(
    /-\s*id:\s*\S+/.test(patch) && /name:\s*\S+/.test(patch),
    'patch 条目有 id 与 name',
    'loader 需要 id/name 才能把插件挂进组合',
  )
}

// ── 2. 运行时文件既存在、也在 files[] 里 ────────────────────
const RUNTIME = [
  'lib/index.js',
  '../mind-core/lib/index.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'client/index.js',
  'README.md',
]
for (const rel of RUNTIME) {
  check(exists(rel), `运行时文件在：${rel}`, '先跑 `pnpm build`（client 还要 `scripts/build-client.mjs`）')
  if (rel.startsWith('..')) continue // 内核是兄弟目录：它不进本包的 files[]（内容已内联进产物）
  check(covered(pkg.files, rel), `files[] 覆盖了 ${rel}`, 'npm 包里会缺这个文件')
}

// ── 3. 客户端声明与产物形态 ─────────────────────────────────
if (pkg.dsh?.client !== undefined) {
  check(
    typeof pkg.exports?.['./client'] === 'string',
    'package.json 里 exports["./client"] 指向产物',
    '没这个出口，DSH 找不到客户端半边',
  )
  if (exists('client/index.js')) {
    const bundle = readFileSync(path.join(ROOT, 'client/index.js'), 'utf8')
    check(
      bundle.includes('__ModuleLoader__.load'),
      'client 产物是 CJS factory 信封',
      '普通 ESM 会报 `loaded without registering ... via __ModuleLoader__.load`',
    )
    check(bundle.includes('exports.apply'), 'client 产物导出了 apply')
    check(!/^\s*(import|export)\s/m.test(bundle), 'client 产物里没有裸 ESM 语法')
  }
  const inject = pkg.dsh.client.inject ?? []
  check(Array.isArray(inject), 'dsh.client.inject 是数组')
  // mneme issue #88：把这种"后注册/可能不出现"的服务写进模块级 inject，loader 会硬等它
  const POISON = ['bettersidebar', 'remote.', 'dsh-market']
  for (const name of inject) {
    const bad = POISON.find((word) => String(name).toLowerCase().includes(word))
    check(bad === undefined, `inject 里没有会阻塞的服务：${name}`, `「${bad}」这类服务一写进 inject，整个 entry 会永久 pending`)
  }
}
if (pkg.dsh?.manifestVersion !== undefined) {
  check(typeof pkg.dsh.manifestVersion === 'number', 'dsh.manifestVersion 是数字')
}

// ── 4. 显示元数据 ───────────────────────────────────────────
if (exists('icon.svg')) {
  const size = statSync(path.join(ROOT, 'icon.svg')).size
  check(size <= 256 * 1024, 'icon 不超过 256 KiB', `当前 ${size} 字节`)
}
for (const lang of ['zh', 'en']) {
  const rel = `locale/${lang}.json`
  if (!exists(rel)) continue
  const locale = readJson(rel)
  check(typeof locale.meta?.title === 'string' && locale.meta.title !== '', `${rel} 有 meta.title`)
  check(
    typeof locale.meta?.description === 'string' && locale.meta.description !== '',
    `${rel} 有 meta.description`,
  )
}

// ── 5. 两包一致性与 core 的干净 ─────────────────────────────
check(pkg.version === core.version, '根包与 core 版本一致', `${pkg.version} vs ${core.version}`)
check(pkg.name === 'dsh-mind' && core.name === 'dsh-mind-core', '两个包名是约定好的名字')
check(
  core.private === true,
  'core 是 private：它不是一个独立产品，只是内核内容',
  'core 单独拿出去并不能直接用——要接到某个 agent 还得写一层兼容逻辑（本仓库 src/ 与 adapters/cli/ 是两个例子）；不设 private 就会被误发成一个独立包',
)
check(
  Object.keys(core.dependencies ?? {}).length === 0,
  'core 零运行时依赖',
  `实际：${JSON.stringify(core.dependencies ?? {})}`,
)
check(
  Object.keys(core.peerDependencies ?? {}).length === 0,
  'core 零 peerDependencies',
  'core 一旦依赖宿主包，"换个 agent 只写 adapter"就不成立了',
)
check(
  Object.keys(pkg.dependencies ?? {}).length === 0,
  '根包零运行时依赖（内核与 zod / schemastery 都内联进产物）',
  `实际：${JSON.stringify(pkg.dependencies ?? {})}——插件是被 dsh plugin add 装进 profile 的，依赖不一定会被解析`,
)
check(
  String(pkg.devDependencies?.['dsh-mind-core'] ?? '').startsWith('workspace:'),
  'core 在 devDependencies 里用 workspace 协议（只用于构建）',
  'core 必须内联进产物，不能留在 dependencies 里',
)

// ── 5b. 产物真的是自洽的（这一条是"能不能装上"的关键）──
if (exists('lib/index.js')) {
  const bundle = readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  for (const dep of ['dsh-mind-core', 'zod', '@deepseek-ai/schemastery']) {
    check(
      !new RegExp(`(from|require\\()\\s*['"]${dep.replace(/[/@]/g, '\\$&')}['"]`).test(bundle),
      `产物里没有对 ${dep} 的 import（已内联）`,
      '留着的话换个安装方式就是"插件不激活"',
    )
  }
  check(
    bundle.includes('内部状态·给你自己看的'),
    '产物里确实有内核（内联成功）',
    '这是 core 的 render.ts 里才有的字符串',
  )
  check(exists('lib/types/index.d.ts'), '类型声明产在 lib/types/index.d.ts', '根 tsconfig 现在只出类型')
}

// ── 6. 上架材料 ─────────────────────────────────────────────
// 上架材料在仓库内部的 `plan/`（不入库）：别人 clone 下来跑这个脚本时它不存在，
// 就会落到下面的 else 分支给一条提醒——那是正确行为，不是缺检。
if (exists('../plan/registry-entry.yml')) {
  const entry = readFileSync(path.join(ROOT, '../plan/registry-entry.yml'), 'utf8')
  check(/^url:\s*https:\/\/github\.com\/\S+\/\S+/m.test(entry), 'registry 条目有 url')
  check(
    !/^url:.*(<owner>|TODO|example\.com|your-)/m.test(entry),
    'registry 条目的 url 不是占位符',
    'url 必须与仓库完全一致（市场会核对）',
  )
  check(/^name:\s*\S+\/\S+/m.test(entry), 'registry 条目有 name（owner/repo）')
  check(/^\s+en:\s*\S/m.test(entry), 'registry 条目有 description.en', '这是 registry 唯一的必填描述字段')
  check(!/^npm:/m.test(entry), 'registry 条目没有手写 npm: 字段', '手写的会被判无效')
  check(/^category:\s*\S+/m.test(entry), 'registry 条目有 category')
  // 只看真正的字段行，别把"怎么提交"的说明注释也当成占位符
  // （注释里本来就写着 `data/plugins/<owner>__<repo>.yml`）
  const fieldLines = entry
    .split('\n')
    .filter((line) => /^(url|name|category|description|npm):/.test(line))
    .join('\n')
  check(
    !/⚠️|TODO|待填|<owner>/.test(fieldLines),
    'registry 条目的字段里没有留下待办占位说明',
    '占位说明是给自己看的，提 PR 前要清掉',
  )
  const category = String(entry.match(/^category:\s*(\S+)/m)?.[1] ?? '')
  // 注意 warn 的方向与 check 相反：**第一个参数是"好"的那一侧**（见 `warn(exists('LICENSE'))`）
  warn(
    ['ui', 'identity', 'memory', 'fun', 'tools', 'theme'].includes(category),
    `registry 的 category 是「${category}」，不在已确认的取值里`,
    '已确认的取值来自 registry 真实条目的观察（ui / identity），不是官方枚举——提 PR 前再对一眼',
  )
} else {
  warnings.push('还没有 plan/registry-entry.yml（上架前补）')
}
warn(exists('LICENSE'), '有 LICENSE 文件')
warn(pkg.private !== true, 'package.json 不是 private', 'private:true 时 npm publish 会直接拒')

// ── 输出 ───────────────────────────────────────────────────
console.log(`发布前自检：通过 ${passed.length} 项，问题 ${problems.length} 项，提醒 ${warnings.length} 项`)
if (problems.length > 0) {
  console.log('\n必须先解决：')
  for (const item of problems) console.log(`  ✖ ${item}`)
}
if (warnings.length > 0) {
  console.log('\n提醒（不阻塞，但上架前要处理）：')
  for (const item of warnings) console.log(`  · ${item}`)
}
if (problems.length === 0) {
  console.log('\n结论：可以发布。**只发一个包**——内核已内联进产物，装插件的人不必再解析任何依赖。')
  console.log('  pnpm publish --access public')
  console.log('  mind-core 是 private，发不出去也不该发：它是内核内容，不是一个能独立使用的产品。')
}
process.exit(problems.length > 0 ? 1 : 0)
