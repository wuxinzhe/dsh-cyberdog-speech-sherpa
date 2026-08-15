# dsh-cyberdog-speech-sherpa

DeepSeek Harness（dsh）本地离线语音插件，基于 [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx)。

- **全本地离线**，不联网、不收费、CPU 可运行
- **STT**：Zipformer 中文流式识别（`stt_transcribe`）
- **TTS**：VITS 中文多音色（`tts_speak`）
- **WebUI 按住说话**：聊天输入框工具行 🎤 按钮——按住录音、松开发送（最长 120 秒，带倒计时）

## 架构

```
dsh-speech-sherpa/
├── index.mjs            # host 插件（Cordis）：注册 3 个工具 + HTTP 路由
├── remote.mjs           # HTTP 路由（/speech-api/*，浏览器录音按钮直调）
├── http-body.mjs        # HTTP 请求体读取
├── core/                # 平台无关核心（STT/TTS/模型管理/WAV 编解码）
│   ├── index.js         #   createSpeechService() 门面
│   ├── models.js        #   模型管理（状态/下载/断点续传/镜像回退）
│   ├── stt.js           #   语音识别（wav 文件 / data URL）
│   ├── tts.js           #   语音合成（data URL / wav 文件）
│   └── wav.js           #   WAV 编解码 + 8kHz→16kHz 重采样
├── client/              # 浏览器端插件（录音按钮）
│   ├── index.ts         #   源码（TSX）
│   └── dist/client.js   #   构建产物（CJS factory bundle）
├── cordis.bundle.yml    # dsh bundle patch（dsh plugin add 安装）
├── cordis.patch.yml     # --patch 开发加载示例
└── scripts/
    ├── build-client.mjs # 构建 client bundle（esbuild）
    └── verify-dsh.mjs   # 插件契约验证（mock cordis ctx）
```

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-speech-sherpa
# 或从 git：dsh plugin --profile <name> add github:you/dsh-speech-sherpa
```

开发期用 `--patch`：
```sh
cd <deepseek-harness 仓库>
pnpm dsh --profile web --patch C:\Users\Administrator\Documents\dsh-speech-sherpa\cordis.patch.yml --port 3099
```

## 工具

| 工具 | 输入 | 输出 |
|:--|:--|:--|
| `stt_transcribe` | `audioPath`（wav 文件）或 `audioBase64`（data URL） | `{text}` |
| `tts_speak` | `text`、`speed?`、`sid?`、`inline?` | `{audioPath, text, dataUrl?}` |
| `sherpa_models_download` | `kinds?`（`['stt','tts']`） | `{results, modelDir}` |

模型自愈：`stt_transcribe`/`tts_speak` 发现模型缺失会报错并提示调用 `sherpa_models_download`，agent 可自行下载。

## 配置（cordis.yml `config` 字段）

| 字段 | 默认值 | 说明 |
|:--|:--|:--|
| `voiceRate` | `1.0` | 语速 0.5~2.0 |
| `sid` | `88` | 音色 88/90/92/94 |
| `modelDir` | `$DSH_HOME/models/sherpa` | 模型目录（DSH_HOME 默认 `~/.dsh`）|
| `outputDir` | `$DSH_HOME/audio/sherpa` | TTS 输出目录 |

## WebUI 录音按钮

聊天输入框工具行左侧的 🎤 按钮（`conversation.input.left` slot）：

1. **按住**开始录音（`getUserMedia` + MediaRecorder），按钮变红显示倒计时 `120s → ...`
2. **松开**自动停止 → 浏览器编码 wav → POST host `/speech-api/sttTranscribe`
3. 转写文本**自动填入输入框并发送**（`inputActions.setDraft` + `submit`）
4. 按住超过 120 秒自动停止发送；按住移出按钮也视为松手

重建 client bundle（改源码后）：
```sh
node scripts/build-client.mjs   # 产物 client/dist/client.js
```

## 模型

| 模型 | 用途 | 体积 |
|:--|:--|:--|
| streaming-zipformer-zh-int8-2025-06-30 | 中文语音识别 | 126MB |
| vits-icefall-zh-aishell3 | 中文语音合成 | 30MB |

下载后存放于 `<modelDir>/stt`、`<modelDir>/tts`。下载走国内镜像（ghfast.top → gh-proxy → GitHub）+ 断点续传。

## 开发

```bash
npm install                # sherpa-onnx-node（版本已精确锁定 1.13.4）
node scripts/verify-dsh.mjs   # 插件契约验证（14 项）
node scripts/build-client.mjs # 重建 client bundle
```

## 音频规格

- STT 输入 wav 支持 16kHz/8kHz（8kHz 自动上采样到 16k；VITS TTS 输出 8kHz，`tts_speak` → `stt_transcribe` 闭环可用）
- TTS 输出 wav 为 8kHz 16bit PCM 单声道

## 发布

- 遵循 dsh 插件命名惯例：npm 包名 `dsh-` 前缀（本包 `dsh-speech-sherpa`）
- GitHub 仓库加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题便于被发现
- 依赖 `@deepseek-ai/*` 时注意：`@deepseek-ai/dsh-tools` 的 npm `latest` tag 是过期线，用 `next` tag；本插件零 `@deepseek-ai` 运行时依赖（裸 JSON ToolDefinition）已避开
