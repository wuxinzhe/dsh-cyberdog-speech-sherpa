/**
 * scripts/build-client.mjs — 构建 dsh WebUI client bundle（录音按钮）
 *
 * 产物：adapters/deepseek-harness/client/dist/client.js
 * 格式：dsh client module 的 factory bundle——
 *   window.__ModuleLoader__.load({ id: 'tinkerdesk-plugin-speech-sherpa', factory: (require) => { ... } })
 * externals（seed 词）：react、react/jsx-runtime、@deepseek-ai/cordis、@deepseek-ai/dsh-client-ui-slots 等，
 * 运行时从 dsh shell 的 module table 解析。
 *
 * 用法：node scripts/build-client.mjs （需 dsh 仓库的 esbuild；DSH_HARNESS_PATH 环境变量指定仓库）
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 定位 esbuild：优先本地 node_modules（npm 安装，CI 可用），再退回 dsh 仓库
function findEsbuild() {
  const candidates = [
    join(root, 'node_modules/esbuild'),
    join(root, 'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild'),
  ]
  for (const c of candidates) {
    try {
      require(c)
      return c
    } catch { /* try next */ }
  }
  // 兼容旧环境：dsh 仓库的 .pnpm
  const dshPath = process.env.DSH_HARNESS_PATH || 'C:/Users/Administrator/Documents/deepseek-harness'
  const dshCandidates = [
    join(dshPath, 'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild'),
    join(dshPath, 'node_modules/esbuild'),
  ]
  for (const c of dshCandidates) {
    try {
      require(c)
      return c
    } catch { /* try next */ }
  }
  throw new Error('无法定位 esbuild——请先在项目内 npm i -D esbuild')
}

const esbuild = require(findEsbuild())
const ID = 'dsh-cyberdog-speech-sherpa'

// seed 词 externals（与 dsh PLATFORM_MODULES 一致）
const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const entry = join(root, 'client/index.ts')
const outfile = join(root, 'client/dist/client.js')

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  loader: { '.ts': 'tsx', '.tsx': 'tsx' },
  outfile,
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // 注意：不设 esbuild 的 banner/footer —— 否则输出里已含一次 load 调用，
  // 再手动包裹会形成嵌套的双重注册（duplicate factory registration）。
  write: false,
})

// 组装：唯一一次 __ModuleLoader__.load 调用（factory 体内提供 module/exports）
const intro = 'var module = { exports: {} }; var exports = module.exports;'
const code = `${result.outputFiles[0].text}`
const final = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\n${intro}\n${code}\nreturn module.exports; } });`

mkdirSync(dirname(outfile), { recursive: true })
writeFileSync(outfile, final)
console.log(`✅ client bundle: ${outfile} (${(final.length / 1024).toFixed(1)} KB)`)
