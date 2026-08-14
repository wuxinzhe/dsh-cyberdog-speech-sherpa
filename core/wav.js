/**
 * core/wav.js — WAV 编解码（平台无关）
 *
 * 服务两端：
 *   - TinkerDesk：应用侧已有 Float32Array（16kHz 录音），不需要解码；本模块为其
 *     保留 wavToBase64（TTS 输出）与 encodeWavFile（落盘备用）。
 *   - DeepSeek Harness：模型侧只能传 JSON（文件路径 / data URL），需要
 *     decodeWavFile / decodeWavBase64 把音频还原成 Float32Array 喂给识别器。
 *
 * 支持：16-bit PCM（最常见）与 32-bit float；多声道取第一声道。
 * 采样率：decode 不再强制 16k；STT 入口统一用 resampleTo16k 对齐识别器。
 * 已知：VITS aishell3 TTS 输出 8kHz，TTS→STT 闭环需要上采样到 16k。
 */
const { readFileSync, writeFileSync } = require('fs')

/** 从 WAV 文件读为 Float32Array（16kHz 单声道语义由调用方保证） */
function decodeWavFile(filePath) {
  return decodeWav(readFileSync(filePath))
}

/** 从 data URL（data:audio/wav;base64,...）解码为 Float32Array */
function decodeWavBase64(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.includes('base64,')) {
    throw new Error('decodeWavBase64 需要 data:audio/wav;base64,... 格式')
  }
  return decodeWav(Buffer.from(dataUrl.slice(dataUrl.indexOf('base64,') + 7), 'base64'))
}

/** 线性插值重采样到 16kHz（sherpa OnlineRecognizer 固定 16k）。
 * 支持整数倍与任意比例；8k→16k 是最常见场景（TTS 输出）。 */
function resampleTo16k(samples, sampleRate) {
  if (sampleRate === 16000 || samples.length === 0) return samples
  const ratio = sampleRate / 16000 // 输入采样率 / 目标采样率
  const outLen = Math.max(1, Math.round(samples.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = samples[Math.min(idx, samples.length - 1)]
    const b = samples[Math.min(idx + 1, samples.length - 1)]
    out[i] = a + (b - a) * frac
  }
  return out
}

/** WAV buffer → Float32Array（-1..1）。仅支持 PCM16 / Float32。不再强制 16k。 */
function decodeWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件')
  }
  // fmt 块：找到 audioFormat / channels / sampleRate / bitsPerSample
  let offset = 12
  let audioFormat = 1
  let channels = 1
  let sampleRate = 16000
  let bitsPerSample = 16
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      audioFormat = buf.readUInt16LE(offset + 8)
      channels = buf.readUInt16LE(offset + 10)
      sampleRate = buf.readUInt32LE(offset + 12)
      bitsPerSample = buf.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      dataOffset = offset + 8
      dataSize = size
      break
    }
    offset += 8 + size + (size % 2) // 块按 2 字节对齐
  }
  if (dataOffset < 0) throw new Error('WAV 缺少 data 块')

  const frameBytes = channels * (bitsPerSample / 8)
  const frames = Math.floor(dataSize / frameBytes)
  const out = new Float32Array(frames)
  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = 0; i < frames; i++) {
      const v = buf.readInt16LE(dataOffset + i * frameBytes) // 取第一声道
      out[i] = v / 0x8000
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = 0; i < frames; i++) {
      out[i] = buf.readFloatLE(dataOffset + i * frameBytes)
    }
  } else {
    throw new Error(`不支持的 WAV 格式: format=${audioFormat} bits=${bitsPerSample}`)
  }
  return resampleTo16k(out, sampleRate)
}

/** Float32 samples → WAV 文件（16bit PCM 单声道） */
function encodeWavFile(samples, sampleRate, filePath) {
  writeFileSync(filePath, encodeWav(samples, sampleRate))
  return filePath
}

/** Float32 samples → wav base64（16bit PCM，WAV 头） */
function wavToBase64(samples, sampleRate) {
  return `data:audio/wav;base64,${encodeWav(samples, sampleRate).toString('base64')}`
}

/** Float32 samples → WAV Buffer（16bit PCM 单声道） */
function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28) // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; ++i) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    const v = s < 0 ? s * 0x8000 : s * 0x7fff
    buffer.writeInt16LE(Math.round(v), 44 + i * 2)
  }
  return buffer
}

module.exports = { decodeWavFile, decodeWavBase64, encodeWavFile, wavToBase64, resampleTo16k }
