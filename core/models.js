/**
 * core/models.js — 模型管理：状态检查 + 下载（GitHub Release 直链，断点续传）
 *
 * 目录约定（configDir 参数 = 模型根，内部不再拼 models/）：
 *   <root>/stt/   STT Zipformer 中文 int8（tar.bz2 需解压）
 *   <root>/tts/   VITS 中文 AISHELL3（tar.bz2 需解压）
 *
 * 2026-08 修复（来自 dsh agent 会话日志复盘）：
 *   1. 下载地址硬编码进 MODELS（不再依赖外部 manifest 的 modelDeps）——
 *      dsh 适配层没有 tinkerdesk manifest 概念，此前 download 因缺 manifest 直接
 *      抛"缺少 manifest"，导致 agent 自愈路径完全不可用。
 *   2. tar 解压用 System32 绝对路径且探测存在性——此前仅判 platform==='win32'
 *      就硬编码，若调用方 PATH 里 Git Bash 的 GNU tar 在前（agent 的 pwsh/run_code
 *      环境），会踩 "Cannot connect to C: resolve failed"。
 *   3. 路径语义统一：configDir = 模型根（stt/tts 在其下）。此前门面把 root 传给
 *      本模块时又拼了一层 models/，导致下载写到 <root>/models/stt 而推理读
 *      <root>/stt，双端不一致（TinkerDesk 与 dsh 都受影响）。
 *   4. manifest 仍作为可选展示数据（TinkerDesk 设置页用），下载不再依赖它。
 */
const { existsSync, mkdirSync, createWriteStream, readdirSync, renameSync, rmSync, statSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')
const { pipeline } = require('stream/promises')
const https = require('https')

/** Windows 解压工具：优先 System32 自带 bsdtar（支持 bz2）；存在性探测，避免 PATH 里 GNU tar 抢跑 */
function tarBin() {
  if (process.platform === 'win32') {
    const sysTar = (process.env.SystemRoot ? process.env.SystemRoot : 'C:\\Windows') + '\\System32\\tar.exe'
    return existsSync(sysTar) ? sysTar : 'tar'
  }
  return 'tar'
}

const MODELS = {
  stt: {
    archive: 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2',
    // zipformer 流式模型是 encoder/decoder/joiner 三件套（无 model.int8.onnx）
    required: ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    // 下载地址硬编码（单一事实源；manifest.modelDeps 仅作展示，见 index.js 注释）
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2',
    sizeMB: 126,
  },
  tts: {
    archive: 'vits-icefall-zh-aishell3.tar.bz2',
    required: ['model.onnx', 'tokens.txt', 'lexicon.txt'],
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2',
    sizeMB: 30,
  },
}

/** 模型是否就绪（解压后必需文件存在） */
function isModelReady(configDir, kind) {
  const spec = MODELS[kind]
  const dir = join(configDir, kind)
  if (!existsSync(dir)) return false
  if (spec.file) return existsSync(join(dir, spec.file))
  return spec.required.every((f) => existsSync(join(dir, f)))
}

/** 全部模型就绪 */
function allReady(configDir) {
  return Object.keys(MODELS).every((k) => isModelReady(configDir, k))
}

/** 下载并解压模型（emit 进度事件）；已就绪直接返回。
 * @param {string} configDir 模型根目录（core 门面已把 configDir/modelDir 归一为根）
 * @param {string} kind 'stt' | 'tts'
 * @param {object} [manifest] 可选——仅作兼容展示；URL 已硬编码在 MODELS
 */
async function downloadModel(configDir, kind, manifest, emit) {
  const spec = MODELS[kind]
  if (isModelReady(configDir, kind)) return { ok: true, skipped: true }

  const url = spec.url
  if (!url) throw new Error(`模型 ${kind} 未配置下载地址`)

  const targetDir = join(configDir, kind)
  mkdirSync(targetDir, { recursive: true })
  emit({ kind, phase: 'download', percent: 0 })

  // 下载（断点续传 -C - 语义：用 range 头）
  const tmpFile = join(targetDir, spec.archive ? spec.archive : spec.file)
  // 多源回退：镜像1(ghfast，实测最快) → 镜像2(gh-proxy) → 主源(GitHub)；断点续传让换源后从断点继续
  const mirrors = [
    (u) => `https://ghfast.top/${u}`,
    (u) => `https://gh-proxy.com/${u}`,
    (u) => u,
  ]
  let lastErr = null
  for (let i = 0; i < mirrors.length; i++) {
    const tryUrl = mirrors[i](url)
    try {
      await downloadWithProgress(tryUrl, tmpFile, (percent) => {
        emit({ kind, phase: 'download', percent })
      })
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      if (i < mirrors.length - 1) {
        emit({ kind, phase: 'download', percent: 1, hint: `源${i + 1}失败，切换镜像…` })
      }
    }
  }
  if (lastErr) throw lastErr

  if (spec.archive) {
    emit({ kind, phase: 'extract', percent: 100 })
    // Windows 10+ 自带 tar（支持 bz2）；解压后目录为解压包内顶层目录，把内容平铺到 targetDir
    execFileSync(tarBin(), ['-xjf', tmpFile, '-C', targetDir], { stdio: 'ignore' })
    // 平铺：解压出的子目录内容移到 targetDir 根
    for (const name of readdirSync(targetDir)) {
      const sub = join(targetDir, name)
      if (name.endsWith('.tar.bz2')) continue
      const st = statSync(sub)
      if (st.isDirectory()) {
        for (const inner of readdirSync(sub)) {
          renameSync(join(sub, inner), join(targetDir, inner))
        }
        rmSync(sub, { recursive: true, force: true })
      }
    }
    rmSync(tmpFile, { force: true })
  }

  if (!isModelReady(configDir, kind)) {
    throw new Error(`模型 ${kind} 解压后缺少必需文件（期望 ${spec.required.join(', ')}）`)
  }
  emit({ kind, phase: 'done', percent: 100 })
  return { ok: true }
}

/** 带进度的 HTTP 下载（Range 断点续传 + 重定向跟随） */
function downloadWithProgress(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let downloaded = 0
    const fileSize = 0

    const request = (targetUrl, start) => {
      const headers = start > 0 ? { Range: `bytes=${start}-` } : {}
      const req = https.get(targetUrl, { headers }, (res) => {
          const status = res.statusCode
          if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
            res.resume()
            const next = res.headers.location
            if (!next) {
              reject(new Error(`重定向缺少 Location: ${targetUrl}`))
              return
            }
            // 跟随重定向（用新 URL，继续断点语义）
            request(new URL(next, targetUrl).toString(), start)
            return
          }
          if (status !== 200 && status !== 206) {
            reject(new Error(`下载失败 HTTP ${status}: ${targetUrl}`))
            return
          }
          const size = parseInt(res.headers['content-length'] || '0', 10) + (status === 206 ? start : 0)
          const ws = createWriteStream(dest, { flags: start > 0 ? 'a' : 'w' })
          ws.on('error', reject)
          res.on('data', (chunk) => {
            downloaded += chunk.length
            if (size > 0) onProgress(Math.min(99, Math.round((downloaded / size) * 100)))
          })
          pipeline(res, ws).then(resolve).catch(reject)
        })
        .on('error', reject)
      // 30s 无进展 → 销毁连接，切下一个源（防卡死在慢源）
      req.setTimeout(30000, () => req.destroy(new Error(`下载超时（30s 无响应）: ${targetUrl}`)))
    }
    request(url, existsSync(dest) ? statSync(dest).size : 0)
  })
}

module.exports = { isModelReady, allReady, downloadModel, MODELS }
