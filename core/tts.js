/**
 * core/tts.js — 语音合成（TTS）：VITS 中文 → wav（平台无关）
 *
 * 输出两种形态：
 *   - data URL / base64：TinkerDesk renderer Audio 直接播放
 *   - wav 文件：DeepSeek Harness 模型侧需要落盘路径继续处理
 */
const sherpa_onnx = require('sherpa-onnx-node')
const { join } = require('path')
const { mkdirSync } = require('fs')
const { wavToBase64, encodeWavFile } = require('./wav')

function createTts(modelDir) {
  const config = {
    model: {
      vits: {
        model: join(modelDir, 'model.onnx'),
        tokens: join(modelDir, 'tokens.txt'),
        lexicon: join(modelDir, 'lexicon.txt'),
      },
      debug: false,
      numThreads: 1,
      provider: 'cpu',
    },
    maxNumSentences: 1,
    ruleFsts: [
      join(modelDir, 'date.fst'),
      join(modelDir, 'phone.fst'),
      join(modelDir, 'number.fst'),
      join(modelDir, 'new_heteronym.fst'),
    ].join(','),
    ruleFars: join(modelDir, 'rule.far'),
  }
  // sherpa-onnx-node 1.13.x：OfflineTts 是 ES class，构造器直接创建 handle。
  // 不要用 OfflineTts.createSync（该静态方法在此版本不存在）。
  return new sherpa_onnx.OfflineTts(config)
}

/**
 * 合成语音 → wav base64 data URL
 * @param {object} opts { modelDir, text, speed?, sid? }
 */
async function synthesize({ modelDir, text, speed = 1.0, sid = 88 }) {
  const tts = createTts(modelDir)
  const generationConfig = new sherpa_onnx.GenerationConfig({ sid, speed, silenceScale: 0.2 })
  const audio = await tts.generateAsync({ text, generationConfig })
  return wavToBase64(audio.samples, audio.sampleRate)
}

/**
 * 合成语音 → 落盘 wav 文件（返回 { path, dataUrl, sampleRate, samples }）
 * @param {object} opts { modelDir, text, speed?, sid?, outPath }
 */
async function synthesizeToFile({ modelDir, text, speed = 1.0, sid = 88, outPath }) {
  const tts = createTts(modelDir)
  const generationConfig = new sherpa_onnx.GenerationConfig({ sid, speed, silenceScale: 0.2 })
  const audio = await tts.generateAsync({ text, generationConfig })
  mkdirSync(require('path').dirname(outPath), { recursive: true })
  encodeWavFile(audio.samples, audio.sampleRate, outPath)
  return {
    path: outPath,
    dataUrl: wavToBase64(audio.samples, audio.sampleRate),
    sampleRate: audio.sampleRate,
    samples: audio.samples.length,
  }
}

module.exports = { synthesize, synthesizeToFile }
