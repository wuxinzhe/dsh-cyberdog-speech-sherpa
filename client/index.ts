/**
 * adapters/deepseek-harness/client/index.ts — dsh WebUI 录音按钮插件（浏览器端）
 *
 * 功能：在聊天输入框工具行（conversation.input.left slot）注册麦克风按钮。
 * 点击录音 → 松开停止 → 浏览器采集音频 → 编码 wav → POST /speech-api/sttTranscribe
 * → 把识别文本填入输入框（inputActions.setDraft），用户可编辑后发送。
 *
 * 依赖 seed 词（构建时 externals，运行时从 dsh shell 拿）：
 *   react, react/jsx-runtime, @deepseek-ai/cordis, @deepseek-ai/dsh-client-ui-slots,
 *   @deepseek-ai/dsh-client-web-react
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export const name = 'speech-sherpa-client'
export const inject = ['slots']

/** conversation.input.left slot 组件 props：owner 提供 InputZone（session/input）+ 标准 kit（inputActions 等）。 */
type SpeechButtonProps = PropsRuntime<'conversation.input.left'>

/** 录音状态机 */
type RecState = 'idle' | 'recording' | 'transcribing' | 'error'

/** 最长录音时长（秒）：到点自动停止并发送 */
const MAX_SECONDS = 120

/** 从 seed 拿 React（构建 externals；运行时 shell 提供）。 */
import * as React from 'react'

const { useState, useRef, useCallback, useEffect } = React

/** 采集 Float32Array（16kHz 单声道）→ wav base64 data URL */
function encodeWavBase64(samples: Float32Array, sampleRate: number): string {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    const v = s < 0 ? s * 0x8000 : s * 0x7fff
    view.setInt16(44 + i * 2, Math.round(v), true)
  }
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:audio/wav;base64,${btoa(binary)}`
}

export function SpeechButton({ inputActions }: SpeechButtonProps) {
  const [state, setState] = useState<RecState>('idle')
  const [errText, setErrText] = useState('')
  const [countdown, setCountdown] = useState(MAX_SECONDS)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pressedRef = useRef(false)
  const recordingRef = useRef(false)

  /** 停止录音（松手 / 超时 / 组件卸载）→ 转写 → 填入并自动发送。 */
  const finishRecording = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    recordingRef.current = false
    const rec = mediaRef.current
    mediaRef.current = null
    if (rec && rec.state !== 'inactive') rec.stop() // onstop → transcribe → submit
  }, [])

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
  }, [])

  const transcribe = useCallback(async (blob: Blob) => {
    setState('transcribing')
    try {
      // 解码为 AudioBuffer → 重采样到 16k 单声道 → wav
      const arrayBuf = await blob.arrayBuffer()
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const decoded = await audioCtx.decodeAudioData(arrayBuf)
      const rate = 16000
      const len = Math.round(decoded.duration * rate)
      const out = new Float32Array(len)
      // 取第一声道 + 线性重采样（简单插值）
      const src = decoded.getChannelData(0)
      for (let i = 0; i < len; i++) {
        const pos = (i / rate) * decoded.sampleRate
        const idx = Math.floor(pos)
        const frac = pos - idx
        const a = src[Math.min(idx, src.length - 1)]
        const b = src[Math.min(idx + 1, src.length - 1)]
        out[i] = a + (b - a) * frac
      }
      const dataUrl = encodeWavBase64(out, rate)

      const res = await fetch('/speech-api/sttTranscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl }),
      })
      const json = await res.json()
      if (!res.ok || json.ok !== true) {
        throw new Error(json?.error?.message ?? `转写失败 HTTP ${res.status}`)
      }
      const text = String(json.text ?? '').trim()
      if (!text) {
        setState('idle')
        setErrText('没有识别到语音')
        return
      }
      // 填入输入框并自动发送（按住说话 → 松开直接发送）
      inputActions.setDraft(text)
      inputActions.submit()
      setState('idle')
      setCountdown(MAX_SECONDS)
      setErrText('')
    } catch (e) {
      setState('error')
      setErrText(e instanceof Error ? e.message : String(e))
    } finally {
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
    }
  }, [inputActions])

  const start = useCallback(async () => {
    setErrText('')
    setCountdown(MAX_SECONDS)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const rec = new MediaRecorder(stream)
      mediaRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        stopTracks()
        void transcribe(blob)
      }
      rec.start()
      recordingRef.current = true
      setState('recording')
      // 120 秒倒计时：到 0 自动停止并发送
      timerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            finishRecording()
            return 0
          }
          return prev - 1
        })
      }, 1000)
    } catch (e) {
      setState('error')
      setErrText(`无法访问麦克风：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [stopTracks, transcribe, finishRecording])

  // 组件卸载时清理
  useEffect(() => () => {
    if (timerRef.current !== null) clearInterval(timerRef.current)
    stopTracks()
  }, [stopTracks])

  const recording = state === 'recording'
  const busy = state === 'transcribing'

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        disabled={busy}
        onPointerDown={(e) => {
          if (e.button !== 0 || busy) return
          e.preventDefault()
          pressedRef.current = true
          void start()
        }}
        onPointerUp={() => {
          if (!pressedRef.current) return
          pressedRef.current = false
          if (recordingRef.current) finishRecording()
        }}
        onPointerLeave={() => {
          // 按住移出按钮也视为松手：停止并发送（避免无限录音）
          if (!pressedRef.current) return
          pressedRef.current = false
          if (recordingRef.current) finishRecording()
        }}
        onPointerCancel={() => {
          if (!pressedRef.current) return
          pressedRef.current = false
          if (recordingRef.current) finishRecording()
        }}
        title={recording ? `松开发送（剩余 ${countdown}s）` : '按住说话，松开发送（最长 120 秒）'}
        aria-label={recording ? `录音中，剩余 ${countdown} 秒，松开发送` : '按住说话'}
        style={{
          border: 'none',
          background: recording ? '#e5484d' : 'transparent',
          color: recording ? '#fff' : 'currentColor',
          borderRadius: 6,
          minWidth: recording ? 44 : 28,
          height: 28,
          padding: recording ? '0 6px' : 0,
          cursor: busy ? 'wait' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: recording ? 12 : 15,
          lineHeight: 1,
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        {busy ? '…' : recording ? `${countdown}s` : '🎤'}
      </button>
      {errText && <span style={{ fontSize: 11, color: '#e5484d', maxWidth: 140 }}>{errText}</span>}
    </div>
  )
}

/** 注册到 composer 工具行左侧（常驻可见的小控件座席）。 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'speech-sherpa-recorder',
    order: 10,
  }, SpeechButton))
}
