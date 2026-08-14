/**
 * adapters/deepseek-harness/index.mjs — DeepSeek Harness 适配层（Cordis 插件）
 *
 * 形态：标准 Cordis 插件（export name + apply），业务逻辑全部复用 core/。
 * 零 @deepseek-ai/* 运行时依赖：工具用裸 JSON ToolDefinition 注册
 * （ctx.tools.register 原生支持 MCP 风格定义），Config 手写轻量校验——
 * 保证本文件脱离 dsh monorepo 的 node_modules 也能被 --patch 直接加载。
 *
 * 注册工具：
 *   - stt_transcribe          语音转文本（audioPath wav 文件 | audioBase64 data URL）
 *   - tts_speak               文本转语音（返回 wav 文件路径；inline 可选内嵌 data URL）
 *   - sherpa_models_download  模型下载（agent 自愈：模型缺失时调用）
 *
 * 配置（cordis.yml config 字段，均带默认值）：
 *   - voiceRate: number 0.5~2.0（默认 1.0）
 *   - sid: number 音色（默认 88）
 *   - modelDir: string 模型根目录（默认 $DSH_HOME/models/sherpa，DSH_HOME 默认 ~/.dsh）
 *   - outputDir: string TTS 音频输出目录（默认 $DSH_HOME/audio/sherpa）
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { registerSpeechHttpRoutes } from './remote.mjs'

// ── 加载平台无关核心（CJS interop；sherpa-onnx-node 是 CJS native 模块） ──
const require = createRequire(import.meta.url)
const core = require('./core/index.js')

export const name = 'speech-sherpa'
export const inject = ['tools', 'webServer']

const DEFAULTS = core.DEFAULTS

/** 模型根目录默认值：$DSH_HOME/models/sherpa（DSH_HOME 默认 ~/.dsh） */
function defaultModelDir() {
  const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  return join(home, 'models', 'sherpa')
}

/** TTS 输出目录默认值：$DSH_HOME/audio/sherpa */
function defaultOutputDir() {
  const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  return join(home, 'audio', 'sherpa')
}

/** 轻量配置归一化 + 校验（替代 Schemastery，避免运行时依赖） */
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const voiceRate = Number(cfg.voiceRate ?? DEFAULTS.voiceRate)
  if (!Number.isFinite(voiceRate) || voiceRate < 0.5 || voiceRate > 2.0) {
    throw new Error(`speech-sherpa: voiceRate 必须是 0.5~2.0 的数字（收到 ${cfg.voiceRate}）`)
  }
  const sid = Number(cfg.sid ?? DEFAULTS.sid)
  if (!Number.isInteger(sid) || !DEFAULTS.sidOptions.some((o) => o.value === sid)) {
    throw new Error(`speech-sherpa: sid 必须是 ${DEFAULTS.sidOptions.map((o) => o.value).join('/')}（收到 ${cfg.sid}）`)
  }
  const modelDir = cfg.modelDir && String(cfg.modelDir).trim() ? resolve(String(cfg.modelDir).trim()) : defaultModelDir()
  const outputDir = cfg.outputDir && String(cfg.outputDir).trim() ? resolve(String(cfg.outputDir).trim()) : defaultOutputDir()
  return { voiceRate, sid, modelDir, outputDir }
}

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const speech = core.createSpeechService({
    modelDir: config.modelDir,
    emit: (evt) => ctx.logger?.info('[speech-sherpa]', evt.kind, evt.phase, evt.percent != null ? `${evt.percent}%` : ''),
  })
  const log = (...args) => (ctx.logger ? ctx.logger.info('[speech-sherpa]', ...args) : console.log('[speech-sherpa]', ...args))

  const requireModel = (kind) => {
    if (!speech.models.isReady(kind)) {
      const name = kind === 'stt' ? 'STT' : 'TTS'
      const spec = speech.models.kinds.includes(kind)
        ? (kind === 'stt' ? '126MB' : '30MB')
        : '?'
      throw new Error(
        `speech-sherpa: ${name} 模型未就绪（${config.modelDir}/${kind}）。`
        + `请调用 sherpa_models_download 工具下载（${name} 约 ${spec}，走国内镜像+断点续传，`
        + `需联网；下载完成后本工具自动可用）。`
      )
    }
  }

  // ── 工具 1：语音转文本 ──
  ctx.tools.register({
    name: 'stt_transcribe',
    description:
      '将本地 wav 音频文件（或内嵌 base64 data URL）转写为中文文本。'
      + '输入音频必须为 16kHz 单声道 wav（PCM16 或 Float32）。'
      + '适合处理模型自己生成/获得的音频文件（如录音、其他工具产生的 wav）。'
      + 'audioPath 与 audioBase64 二选一，优先 audioPath。',
    parameters: {
      type: 'object',
      properties: {
        audioPath: { type: 'string', description: '本地 wav 文件绝对路径（16kHz 单声道）' },
        audioBase64: { type: 'string', description: 'data:audio/wav;base64,... data URL' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string', description: '识别出的文本' } },
        additionalProperties: false,
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: `识别结果：${value.text}` }],
    },
    async execute(args) {
      requireModel('stt')
      if (args.audioPath) {
        if (!existsSync(args.audioPath)) throw new Error(`stt_transcribe: 文件不存在 ${args.audioPath}`)
        return { text: speech.stt.transcribeFile(args.audioPath) }
      }
      if (args.audioBase64) {
        return { text: speech.stt.transcribeBase64(args.audioBase64) }
      }
      throw new Error('stt_transcribe: 需要 audioPath 或 audioBase64')
    },
  })

  // ── 工具 2：文本转语音 ──
  ctx.tools.register({
    name: 'tts_speak',
    description:
      '将文本合成为中文语音，写入 wav 文件并返回文件路径。'
      + '模型可继续用 fs 等工具读取/移动该文件，或交给用户播放。'
      + '默认不返回内嵌音频（避免大 base64 污染上下文）；需要内嵌时设 inline=true。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要合成的文本（中文）' },
        speed: { type: 'number', description: `语速 0.5~2.0（默认 ${DEFAULTS.voiceRate}）` },
        sid: { type: 'number', description: `音色 ${DEFAULTS.sidOptions.map((o) => `${o.label} ${o.value}`).join(' / ')}（默认 ${DEFAULTS.sid}）` },
        inline: { type: 'boolean', description: 'true 时结果额外返回 data URL（默认 false）' },
      },
      additionalProperties: false,
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          audioPath: { type: 'string', description: '生成的 wav 文件绝对路径' },
          text: { type: 'string', description: '已合成的文本' },
          dataUrl: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'inline=true 时的 audio data URL，否则为 null',
          },
        },
        additionalProperties: false,
        required: ['audioPath', 'text'],
      },
      render: (args, value) => [
        { type: 'text', text: `已合成语音（${value.text.length} 字）：${value.audioPath}` },
      ],
    },
    async execute(args) {
      requireModel('tts')
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (!text) throw new Error('tts_speak: text 不能为空')
      const speed = args.speed == null ? config.voiceRate : Number(args.speed)
      const sid = args.sid == null ? config.sid : Number(args.sid)
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) throw new Error(`tts_speak: speed 必须在 0.5~2.0（收到 ${args.speed}）`)
      if (!DEFAULTS.sidOptions.some((o) => o.value === sid)) throw new Error(`tts_speak: sid 无效（${args.sid}）`)
      mkdirSync(config.outputDir, { recursive: true })
      const outPath = join(config.outputDir, `tts-${Date.now()}.wav`)
      const result = await speech.tts.synthesizeToFile({ text, speed, sid, outPath })
      return args.inline
        ? { audioPath: result.path, text, dataUrl: result.dataUrl }
        : { audioPath: result.path, text, dataUrl: null }
    },
  })

  // ── 工具 3：模型下载（agent 自愈） ──
  ctx.tools.register({
    name: 'sherpa_models_download',
    description:
      `下载 Sherpa-ONNX 离线语音模型（STT 约 126MB / TTS 约 30MB，支持断点续传+镜像回退）。`
      + `模型存放于 ${config.modelDir}。stt_transcribe / tts_speak 报"模型未就绪"时调用本工具。`
      + `kinds 省略则下载全部缺失模型。`,
    parameters: {
      type: 'object',
      properties: {
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['stt', 'tts'] },
          description: '要下载的模型（默认全部缺失项）',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'object',
            description: '每个 kind 的下载结果 { kind: { ok, skipped? } }',
            properties: {
              stt: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, skipped: { type: 'boolean' } },
                additionalProperties: false,
              },
              tts: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, skipped: { type: 'boolean' } },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          modelDir: { type: 'string' },
        },
        additionalProperties: false,
        required: ['results', 'modelDir'],
      },
      render: (_args, value) => [
        { type: 'text', text: `模型下载完成：${Object.entries(value.results).map(([k, v]) => `${k}=${v.ok ? (v.skipped ? '已就绪' : '完成') : '失败'}`).join('，')}（目录 ${value.modelDir}）` },
      ],
    },
    async execute(args) {
      const kinds = Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds : speech.models.kinds
      const results = {}
      for (const kind of kinds) {
        if (!speech.models.kinds.includes(kind)) throw new Error(`sherpa_models_download: 未知模型 kind=${kind}（可用 ${speech.models.kinds.join('/')}）`)
        results[kind] = await speech.models.download(kind)
      }
      return { results, modelDir: config.modelDir }
    },
  })

  // ── UI HTTP 路由（浏览器录音按钮 fetch 调用） ──
  // 独立路径 /speech-api/*（避开 connection 的 /api 前缀与浏览器信任围栏）；
  // 由 webserver 运行时注册，随插件 fiber 自动清理。
  try {
    registerSpeechHttpRoutes(ctx, speech)
    // eslint-disable-next-line no-console
    console.log('[speech-sherpa] http routes registered: /speech-api/status, /speech-api/sttTranscribe, /speech-api/ttsSynthesize')
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[speech-sherpa] http routes FAILED: ${e?.message ?? e}`)
  }

  log(`loaded (modelDir=${config.modelDir}, voiceRate=${config.voiceRate}, sid=${config.sid})`)
  log(`models: ${speech.status().allReady ? 'all ready' : 'missing → call sherpa_models_download'}`)
}
