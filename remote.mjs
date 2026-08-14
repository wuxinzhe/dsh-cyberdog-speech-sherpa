/**
 * adapters/deepseek-harness/remote.mjs — host 端 UI 直调 HTTP 端点
 *
 * 供浏览器 client 插件（录音按钮）通过 fetch 调用：
 *   POST /speech-api/status          → { stt, tts, allReady }         模型状态（按钮可用性）
 *   POST /speech-api/sttTranscribe   { audioBase64 } → { text }       语音转文本（录音入口）
 *   POST /speech-api/ttsSynthesize   { text, speed?, sid? } → { audioBase64 }  文本转语音
 *
 * 为什么用 HTTP 而非 typert Remote：
 *   dsh 浏览器端的 ctx.remote.* 是编译期生成的（api-remotes 包静态 import 各包的
 *   /remote 描述符），独立插件无法让运行中的 dsh 收录新 remote。而 webserver 的
 *   register() 是运行时 API——host 插件可注册任意路径，浏览器同源 fetch 即可。
 *   信任：路径独立于 /api 前缀，不经过 connection 的浏览器信任围栏；本地服务默认
 *   只绑 127.0.0.1（dsh web 默认），同源浏览器才能访问。
 *
 * @param {object} deps { speech } 平台无关语音核心（createSpeechService 实例）
 */
import { readBody } from './http-body.mjs'

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function methodGuard(req, res, expected) {
  if (req.method !== expected) {
    json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `use ${expected}` } })
    return false
  }
  return true
}

/** 注册语音 HTTP 路由到 ctx.webServer（在 apply 内调用，随插件 fiber 生命周期自动清理）。 */
export function registerSpeechHttpRoutes(ctx, speech) {
  const register = (path, handler) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler,
    }), `speech-sherpa: ${path}`)
  }

  // ── 模型状态（按钮可用性） ──
  register('/speech-api/status', (req, res) => {
    if (!methodGuard(req, res, 'GET')) return
    json(res, 200, { ok: true, ...speech.status() })
  })

  // ── 语音转文本（录音入口） ──
  register('/speech-api/sttTranscribe', async (req, res) => {
    if (!methodGuard(req, res, 'POST')) return
    try {
      const body = await readBody(req)
      const audioBase64 = body?.audioBase64
      if (typeof audioBase64 !== 'string' || !audioBase64.includes('base64,')) {
        json(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 audioBase64（data:audio/wav;base64,...）' } })
        return
      }
      if (!speech.models.isReady('stt')) {
        json(res, 503, { ok: false, error: { code: 'model-not-ready', message: 'STT 模型未就绪，请先下载模型' } })
        return
      }
      const text = speech.stt.transcribeBase64(audioBase64)
      json(res, 200, { ok: true, text })
    } catch (e) {
      json(res, 500, { ok: false, error: { code: 'internal', message: String(e?.message ?? e) } })
    }
  })

  // ── 文本转语音（返回内嵌 data URL） ──
  register('/speech-api/ttsSynthesize', async (req, res) => {
    if (!methodGuard(req, res, 'POST')) return
    try {
      const body = await readBody(req)
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (!text) {
        json(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 text' } })
        return
      }
      if (!speech.models.isReady('tts')) {
        json(res, 503, { ok: false, error: { code: 'model-not-ready', message: 'TTS 模型未就绪，请先下载模型' } })
        return
      }
      const dataUrl = await speech.tts.synthesize({
        text,
        speed: body?.speed ?? speech.defaults.voiceRate,
        sid: body?.sid ?? speech.defaults.sid,
      })
      json(res, 200, { ok: true, audioBase64: dataUrl, text })
    } catch (e) {
      json(res, 500, { ok: false, error: { code: 'internal', message: String(e?.message ?? e) } })
    }
  })
}
