window.__ModuleLoader__.load({ id: "dsh-speech-sherpa", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.ts
var index_exports = {};
__export(index_exports, {
  SpeechButton: () => SpeechButton,
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var React = __toESM(require("react"), 1);
var name = "speech-sherpa-client";
var inject = ["slots"];
var MAX_SECONDS = 120;
var { useState, useRef, useCallback, useEffect } = React;
function encodeWavBase64(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const v = s < 0 ? s * 32768 : s * 32767;
    view.setInt16(44 + i * 2, Math.round(v), true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}
function SpeechButton({ inputActions }) {
  const [state, setState] = useState("idle");
  const [errText, setErrText] = useState("");
  const [countdown, setCountdown] = useState(MAX_SECONDS);
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const timerRef = useRef(null);
  const pressedRef = useRef(false);
  const recordingRef = useRef(false);
  const finishRecording = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    recordingRef.current = false;
    const rec = mediaRef.current;
    mediaRef.current = null;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);
  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {
    });
    audioCtxRef.current = null;
  }, []);
  const transcribe = useCallback(async (blob) => {
    setState("transcribing");
    try {
      const arrayBuf = await blob.arrayBuffer();
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const decoded = await audioCtx.decodeAudioData(arrayBuf);
      const rate = 16e3;
      const len = Math.round(decoded.duration * rate);
      const out = new Float32Array(len);
      const src = decoded.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const pos = i / rate * decoded.sampleRate;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = src[Math.min(idx, src.length - 1)];
        const b = src[Math.min(idx + 1, src.length - 1)];
        out[i] = a + (b - a) * frac;
      }
      const dataUrl = encodeWavBase64(out, rate);
      const res = await fetch("/speech-api/sttTranscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: dataUrl })
      });
      const json = await res.json();
      if (!res.ok || json.ok !== true) {
        throw new Error(json?.error?.message ?? `\u8F6C\u5199\u5931\u8D25 HTTP ${res.status}`);
      }
      const text = String(json.text ?? "").trim();
      if (!text) {
        setState("idle");
        setErrText("\u6CA1\u6709\u8BC6\u522B\u5230\u8BED\u97F3");
        return;
      }
      inputActions.setDraft(text);
      inputActions.submit();
      setState("idle");
      setCountdown(MAX_SECONDS);
      setErrText("");
    } catch (e) {
      setState("error");
      setErrText(e instanceof Error ? e.message : String(e));
    } finally {
      audioCtxRef.current?.close().catch(() => {
      });
      audioCtxRef.current = null;
    }
  }, [inputActions]);
  const start = useCallback(async () => {
    setErrText("");
    setCountdown(MAX_SECONDS);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      mediaRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        stopTracks();
        void transcribe(blob);
      };
      rec.start();
      recordingRef.current = true;
      setState("recording");
      timerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            finishRecording();
            return 0;
          }
          return prev - 1;
        });
      }, 1e3);
    } catch (e) {
      setState("error");
      setErrText(`\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE\uFF1A${e instanceof Error ? e.message : String(e)}`);
    }
  }, [stopTracks, transcribe, finishRecording]);
  useEffect(() => () => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    stopTracks();
  }, [stopTracks]);
  const recording = state === "recording";
  const busy = state === "transcribing";
  return /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 4 } }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      disabled: busy,
      onPointerDown: (e) => {
        if (e.button !== 0 || busy) return;
        e.preventDefault();
        pressedRef.current = true;
        void start();
      },
      onPointerUp: () => {
        if (!pressedRef.current) return;
        pressedRef.current = false;
        if (recordingRef.current) finishRecording();
      },
      onPointerLeave: () => {
        if (!pressedRef.current) return;
        pressedRef.current = false;
        if (recordingRef.current) finishRecording();
      },
      onPointerCancel: () => {
        if (!pressedRef.current) return;
        pressedRef.current = false;
        if (recordingRef.current) finishRecording();
      },
      title: recording ? `\u677E\u5F00\u53D1\u9001\uFF08\u5269\u4F59 ${countdown}s\uFF09` : "\u6309\u4F4F\u8BF4\u8BDD\uFF0C\u677E\u5F00\u53D1\u9001\uFF08\u6700\u957F 120 \u79D2\uFF09",
      "aria-label": recording ? `\u5F55\u97F3\u4E2D\uFF0C\u5269\u4F59 ${countdown} \u79D2\uFF0C\u677E\u5F00\u53D1\u9001` : "\u6309\u4F4F\u8BF4\u8BDD",
      style: {
        border: "none",
        background: recording ? "#e5484d" : "transparent",
        color: recording ? "#fff" : "currentColor",
        borderRadius: 6,
        minWidth: recording ? 44 : 28,
        height: 28,
        padding: recording ? "0 6px" : 0,
        cursor: busy ? "wait" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: recording ? 12 : 15,
        lineHeight: 1,
        userSelect: "none",
        touchAction: "none"
      }
    },
    busy ? "\u2026" : recording ? `${countdown}s` : "\u{1F3A4}"
  ), errText && /* @__PURE__ */ React.createElement("span", { style: { fontSize: 11, color: "#e5484d", maxWidth: 140 } }, errText));
}
function apply(ctx) {
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
    name: "conversation.input.left",
    id: "speech-sherpa-recorder",
    order: 10
  }, SpeechButton));
}

return module.exports; } });