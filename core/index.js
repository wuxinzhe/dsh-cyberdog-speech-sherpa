/**
 * core/index.js — 平台无关语音核心门面（STT + TTS + 模型管理）
 *
 * 设计：本文件是**唯一实现**。两个平台适配层只做协议翻译，不重复业务逻辑：
 *   - TinkerDesk 适配层（仓库根 index.js）：注册 IPC + PluginApi → 调本门面
 *   - DeepSeek Harness 适配层（adapters/deepseek-harness/index.mjs）：
 *     Cordis 插件注册工具 → 调本门面
 *
 * 模型目录约定：
 *   - TinkerDesk：<configDir>/models/<kind>（configDir = 插件目录，应用托管）
 *   - DeepSeek Harness：<modelDir>/<kind>（modelDir 来自配置，默认 $DSH_HOME/models/sherpa）
 * 门面统一接收 { configDir } 或 { modelDir }，内部拼出 kind 子目录。
 */
const path = require('path')
const { join } = path
const models = require('./models')
const stt = require('./stt')
const tts = require('./tts')

/** TinkerDesk 配置表单 schema（JSON 方言，适配层直接转发） */
function getConfigSchema() {
  return {
    type: 'object',
    properties: {
      voiceRate: {
        type: 'number',
        title: '语速',
        min: 0.5,
        max: 2,
        step: 0.1,
        default: 1.0,
      },
      sid: {
        type: 'select',
        title: '音色',
        options: [
          { label: '女声 88', value: 88 },
          { label: '女声 90', value: 90 },
          { label: '男声 92', value: 92 },
          { label: '男声 94', value: 94 },
        ],
        default: 88,
      },
      autoSpeak: {
        type: 'boolean',
        title: '自动朗读回复',
        default: false,
        description: 'AI 回复完成后自动朗读（需聊天页接入）',
      },
    },
  }
}

/** 音色/语速的默认值与选项（供 dsh 侧 Schemastery schema 复用） */
const DEFAULTS = {
  voiceRate: 1.0,
  sid: 88,
  sidOptions: [
    { label: '女声 88', value: 88 },
    { label: '女声 90', value: 90 },
    { label: '男声 92', value: 92 },
    { label: '男声 94', value: 94 },
  ],
}

/**
 * 创建语音服务实例。
 * @param {object} opts
 * @param {string} [opts.configDir]  TinkerDesk 插件目录（模型在 <configDir>/models/<kind>）
 * @param {string} [opts.modelDir]   dsh 模型根目录（模型在 <modelDir>/<kind>）；与 configDir 二选一
 * @param {object} [opts.manifest]   tinkerdesk manifest（models:download 取下载地址用）
 * @param {(evt: object) => void} [opts.emit]  进度事件（models:progress）
 * @returns 语音服务 API
 */
function createSpeechService({ configDir, modelDir, manifest, emit = () => {} } = {}) {
  // 统一模型根目录：<root>/<kind>；TinkerDesk 的 configDir 已是插件目录，模型在 models/ 下
  const root = modelDir || join(configDir, 'models')
  const kindDir = (kind) => join(root, kind)

  return {
    /** STT：三种输入形态 */
    stt: {
      /** Float32Array（16kHz）直接转写 */
      transcribe(samples) {
        return stt.transcribe({ modelDir: kindDir('stt'), samples })
      },
      /** wav 文件路径转写 */
      transcribeFile(audioPath) {
        return stt.transcribeFile({ modelDir: kindDir('stt'), audioPath })
      },
      /** data URL 转写 */
      transcribeBase64(audioBase64) {
        return stt.transcribeBase64({ modelDir: kindDir('stt'), audioBase64 })
      },
    },

    /** TTS：两种输出形态 */
    tts: {
      /** 合成 → data URL（renderer Audio 播放） */
      synthesize({ text, speed = DEFAULTS.voiceRate, sid = DEFAULTS.sid }) {
        return tts.synthesize({ modelDir: kindDir('tts'), text, speed, sid })
      },
      /** 合成 → wav 文件（dsh 模型侧继续处理） */
      synthesizeToFile({ text, speed = DEFAULTS.voiceRate, sid = DEFAULTS.sid, outPath }) {
        return tts.synthesizeToFile({ modelDir: kindDir('tts'), text, speed, sid, outPath })
      },
    },

    /** 模型管理 */
    models: {
      isReady(kind) {
        return models.isModelReady(root, kind)
      },
      allReady() {
        return models.allReady(root)
      },
      /** 下载单个模型（带进度事件）。manifest 可选（URL 已硬编码在 models.js） */
      download(kind) {
        return models.downloadModel(root, kind, manifest, emit)
      },
      /** 下载全部缺失模型 */
      async downloadAll() {
        const results = {}
        for (const kind of Object.keys(models.MODELS)) {
          results[kind] = await this.download(kind)
        }
        return results
      },
      kinds: Object.keys(models.MODELS),
    },

    /** 状态快照（TinkerDesk models:status / dsh 工具共用） */
    status() {
      return {
        stt: models.isModelReady(root, 'stt'),
        tts: models.isModelReady(root, 'tts'),
        allReady: models.allReady(root),
      }
    },

    /** 启用前自检（TinkerDesk check() 用） */
    check() {
      const sttOk = models.isModelReady(root, 'stt')
      const ttsOk = models.isModelReady(root, 'tts')
      const checks = [
        {
          name: 'STT 模型',
          ok: sttOk,
          hint: sttOk ? undefined : '语音输入模型未下载（约 126MB）',
          action: sttOk ? undefined : 'download-models',
        },
        {
          name: 'TTS 模型',
          ok: ttsOk,
          hint: ttsOk ? undefined : '朗读模型未下载（约 30MB）',
          action: ttsOk ? undefined : 'download-models',
        },
      ]
      return { ok: sttOk && ttsOk, checks }
    },

    /** 配置常量（供适配层 schema 复用，避免两处维护） */
    defaults: DEFAULTS,
    configSchema: getConfigSchema(),
  }
}

module.exports = {
  createSpeechService,
  getConfigSchema,
  DEFAULTS,
  models,
  stt,
  tts,
  wav: require('./wav'),
}
