/**
 * scripts/verify-dsh.mjs — DeepSeek Harness 适配层验证（不依赖 dsh 运行时）
 *
 * 模拟 cordis Context（tools.register / logger），动态加载
 * adapters/deepseek-harness/index.mjs 并执行 apply()，验证：
 *   1. sherpa-onnx-node native 模块可加载（CJS interop）
 *   2. 插件导出 name / inject / apply 契约
 *   3. 三个工具注册（stt_transcribe / tts_speak / sherpa_models_download）
 *   4. 工具 schema 符合 dsh JSON Schema 子集（防 mock 盲区——真实
 *      ToolRegistry.register 会校验，schema 违规在真实环境才暴露）
 *   5. 配置校验（非法 voiceRate 拒绝加载）
 *   6. 工具 execute 错误路径（模型未就绪时给出可操作提示）
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// ── dsh JSON Schema 子集校验器（复刻 packages/core/tools/src/json-schema.ts 核心规则） ──
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const SUPPORTED_KEYS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', ...ANNOTATIONS]

function checkDshSchema(node, path = 'schema', violations = [], seen = new Set()) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} 必须是 schema 对象`)
    return violations
  }
  if (seen.has(node)) { violations.push(`${path} 循环引用`); return violations }
  seen.add(node)

  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYS.includes(key)) violations.push(`${path}.${key} 不是受支持的关键字`)
  }
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
    violations.push(`${path}.description 必须是字符串`)
  }

  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) { violations.push(`${path} 不能同时声明 type 和 oneOf`); return violations }
  if (!hasType && !hasOneOf) { violations.push(`${path} 缺少 type/oneOf`); return violations }

  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${path}.oneOf 必须是至少两个 schema 的数组`)
    } else {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} 不能与 oneOf 同时使用`)
      }
      for (let i = 0; i < node.oneOf.length; i++) checkDshSchema(node.oneOf[i], `${path}.oneOf[${i}]`, violations, seen)
    }
    return violations
  }

  const type = node.type
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(Array.isArray(type)
      ? `${path}.type 必须是单个类型字符串（不支持 type 数组）`
      : `${path}.type 必须是 ${SCHEMA_TYPES.join('/')} 之一`)
    return violations
  }

  const scalar = ['string', 'number', 'integer', 'boolean', 'null'].includes(type)
  if (Object.hasOwn(node, 'additionalProperties')) {
    if (type !== 'object') violations.push(`${path}.additionalProperties 仅支持 object 类型`)
    else if (typeof node.additionalProperties !== 'boolean') violations.push(`${path}.additionalProperties 必须是 boolean`)
  }
  if (Object.hasOwn(node, 'properties')) {
    if (type !== 'object') violations.push(`${path}.properties 仅支持 object 类型`)
    else if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      violations.push(`${path}.properties 必须是 schema 对象`)
    } else {
      for (const [k, v] of Object.entries(node.properties)) checkDshSchema(v, `${path}.properties.${k}`, violations, seen)
    }
  }
  if (Object.hasOwn(node, 'required')) {
    if (type !== 'object') violations.push(`${path}.required 仅支持 object 类型`)
    else if (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string')) {
      violations.push(`${path}.required 必须是字符串数组`)
    }
  }
  if (Object.hasOwn(node, 'items')) {
    if (type !== 'array') violations.push(`${path}.items 仅支持 array 类型`)
    else checkDshSchema(node.items, `${path}.items`, violations, seen)
  }
  if (Object.hasOwn(node, 'enum')) {
    if (!scalar) violations.push(`${path}.enum 仅支持 scalar 类型`)
    else if (!Array.isArray(node.enum) || node.enum.length === 0) violations.push(`${path}.enum 必须是非空数组`)
  }
  if (Object.hasOwn(node, 'const') && !scalar) violations.push(`${path}.const 仅支持 scalar 类型`)
  return violations
}

// ── 验证主体 ──
const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const ok = (name) => { results.push(`✅ ${name}`); console.log(`  ✅ ${name}`) }
const fail = (name, err) => { results.push(`❌ ${name}: ${err?.message ?? err}`); console.error(`  ❌ ${name}: ${err?.message ?? err}`) }

// 1. native 模块加载（sherpa-onnx-node → sherpa-onnx-win-x64 .node）
try {
  const sherpa = require(join(root, 'node_modules', 'sherpa-onnx-node'))
  ok(`sherpa-onnx-node 加载成功（${typeof sherpa.OnlineRecognizer}/${typeof sherpa.OfflineTts}）`)
} catch (e) {
  fail('sherpa-onnx-node 加载', e)
}

// 2~4. 加载 dsh 适配层
const plugin = await import(pathToFileURL(join(root, 'index.mjs')).href)
if (plugin.name === 'speech-sherpa' && Array.isArray(plugin.inject) && plugin.inject.includes('tools')) {
  ok(`插件导出契约 name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`)
} else {
  fail('插件导出契约', new Error(`name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`))
}

const defs = []
const provides = {}
const mockCtx = {
  tools: { register: (def) => defs.push(def) },
  provide: (key, value) => { provides[key] = value },
  logger: { info: (...a) => console.log('   [logger]', ...a) },
}

try {
  await plugin.apply(mockCtx, { voiceRate: 1.2, sid: 90 })
  const names = defs.map((d) => d.name)
  const expect = ['stt_transcribe', 'tts_speak', 'sherpa_models_download']
  if (names.length === 3 && expect.every((n) => names.includes(n))) {
    ok(`apply() 注册 3 个工具：${names.join(', ')}`)
  } else {
    fail('工具注册', new Error(`期望 ${expect.join(', ')}，得到 ${names.join(', ')}`))
  }
  // 每个工具定义的关键字段 + schema 子集校验
  for (const d of defs) {
    if (d.name && d.description && d.parameters && d.output && typeof d.execute === 'function') {
      ok(`工具 ${d.name} 定义完整（parameters/output/execute）`)
    } else {
      fail(`工具 ${d.name} 定义不完整`, new Error(JSON.stringify(Object.keys(d))))
    }
    for (const [slot, schema] of [['parameters', d.parameters], ['output.schema', d.output?.schema]]) {
      const violations = checkDshSchema(schema)
      if (violations.length === 0) {
        ok(`工具 ${d.name} ${slot} 符合 dsh JSON Schema 子集`)
      } else {
        fail(`工具 ${d.name} ${slot} 违反 dsh JSON Schema 子集`, new Error(violations.join('; ')))
      }
    }
  }
} catch (e) {
  fail('apply() 执行', e)
}

// 非法配置应拒绝加载（apply 是 async，需 await）
try {
  await plugin.apply({ ...mockCtx, tools: { register: () => {} } }, { voiceRate: 99 })
  fail('配置校验', new Error('voiceRate=99 应被拒绝'))
} catch (e) {
  ok(`配置校验：非法 voiceRate 被拒绝（${e.message}）`)
}

// 5. 工具 execute 守卫（模型已就绪时放行到文件检查；模型缺失时才报"未就绪"）
const errCtx = {
  tools: { register: (d) => defs.push(d) },
  provide: (key, value) => { provides[key] = value },
  logger: { info: () => {} },
}
await plugin.apply(errCtx, { voiceRate: 1.0, sid: 88 })
const sttDef = defs.find((d) => d.name === 'stt_transcribe')
try {
  await sttDef.execute({ audioPath: 'C:/nope/nonexistent.wav' })
  fail('stt_transcribe 守卫', new Error('文件不存在时应抛错'))
} catch (e) {
  if (e.message.includes('文件不存在')) {
    ok(`stt_transcribe 守卫：模型就绪时放行到文件检查（${e.message.slice(0, 50)}…）`)
  } else if (e.message.includes('未就绪')) {
    ok(`stt_transcribe 守卫：模型未就绪提示可操作（${e.message.slice(0, 60)}…）`)
  } else {
    fail('stt_transcribe 守卫', e)
  }
}

console.log(`\n${results.filter((r) => r.startsWith('✅')).length}/${results.length} 项通过`)
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
