# Limbo Echo

把一天的声音，整理成记忆。

Limbo 产品家族中的本地录音时间轴，采用黑白 ASCII × Pixels 风格，使用 Vite、SiriWave、Lucide 和 Web Audio API。

**公开版本不包含真实录音、个人转写或历史摘要。** 默认提供三个虚构章节和一分钟程序合成音频。文字为演示内容，并非语音识别结果。

## 快速运行

运行环境：Node.js 22.12+。演示音频由 Node.js 直接生成，无需 FFmpeg、Python、转写模型或 API Key。

```sh
npm install
npm run dev
```

打开终端显示的本地地址。音频按章节播放，支持原文/示例文本高亮、书签、倍速、音量、跨切片续播和真实音量驱动的像素声纹。

```sh
npm test
npm run build
npm run check:public
```

构建会将 `public/` 下的资源复制到 `dist/`。默认只有合成演示资源；导入私人数据后，不能直接公开构建产物。

## 项目结构

| 路径 | 用途 |
|---|---|
| [SKILL.md](SKILL.md) | 复用现成模板的端到端操作技能 |
| [src/demo.js](src/demo.js) | 虚构章节、文本与标记 |
| [scripts/prepare-audio.mjs](scripts/prepare-audio.mjs) | 生成本地合成演示音频 |
| [scripts/import-recording.mjs](scripts/import-recording.mjs) | 固定的数据校验、音频转码与记录导入命令 |
| [src/recording.js](src/recording.js) | 网页与导入命令共享的录音契约校验 |
| [recording-transcribe/SKILL.md](recording-transcribe/SKILL.md) | 可选的转写整理子技能 |

## 一句话生成录音网页

先安装完整 Limbo Echo 项目，再给具备本地文件、终端和浏览器操作能力的 agent 发送以下三类附件，输入 **“转写”**：

1. 根目录 [SKILL.md](SKILL.md)。
2. 本批次所有 `*.m4a` 录音切片。
3. 对应的 `task.json`。

技能指导 agent 完成校验、转写、章节摘要数据、固定命令导入、启动与浏览器展示。agent 只生成数据，不再逐批编写 JavaScript 或重建界面。单独一份技能不包含模板，项目缺失时应先安装完整项目。根目录技能不保证被工具自动发现，应明确附上，或按所用 agent 的技能安装方式注册。

处理真实录音通常需要 Python、faster-whisper 和 FFmpeg，首次可能下载模型与依赖。默认本地转写，云端 ASR 必须另行授权；缺件或环境受限时如实报告，不生成虚假转写。

## 导入转写产物

网页与转写服务解耦：豆包 API 或本地模型产生逐句 JSON，agent 仅整理 `chapters.json`，固定工具完成导入。要求 FFmpeg、FFprobe 可用。

```sh
npm run import:recording -- --task-json private/batch/task.json --audio-dir private/batch --transcripts private/batch/transcripts --chapters private/batch/chapters.json --mode local --model faster-whisper/medium
```

确实经授权使用豆包时，改为 `--mode cloud --model doubao/seed-asr`。本命令不联网、不调用豆包、不读取密钥。

章节数据示例，内容与时码须根据实际转写填写：

```json
{
	"title": "录音 01",
	"chapters": [
		{
			"id": "chapter-01", "start": 0, "end": 20,
			"title": "片段主题", "tag": "RECORDING", "icon": "audio-lines",
			"location": "", "description": "根据原文整理的简述。",
			"bullets": ["根据原文整理的要点。"]
		}
	]
}
```

可附加经过核实的 `recordingDate`、带时区的 `startedAt` 与 IANA `timezone`，未知时省略；默认使用相对时码。章节不能重叠，不要求填满静音区间。

- 转写缓存优先为 `transcripts/<full-stem>.json`，包含 `utterances: [{start, end, text}]`（秒）；也支持豆包原始 `result.utterances` 中的 `start_time/end_time`（毫秒）。旧短 UID 仅在本批次唯一时兼容，碰撞则拒绝导入。
- 缺失音频、哈希不符、重叠清单、非法路径会拒绝导入；部分转写失败会展示警告，全部失败则拒绝生成占位记录。
- 五类交付文件保存在 `recordings/<id>/`，播放缓存位于 `public/audio/<id>/`，网页数据位于 `public/private/`。音频按原始哈希与转码参数命名，原音频不改动。
- 保留演示档案和历史记录，刷新页面自动选中最后导入的记录。已有 ID 不覆盖，重新导入可显式传入新的 `--id`。
- 模板运行时使用 JSON，不从 Markdown 提取时码。导入不修改源码，外部标题、摘要与原文均按纯文本渲染。

## 隐私与公开发布

- 原始录音、清单和转写放在 `recordings/` 或 `private/` 等已忽略目录；不要放进源码、提交或示例数据。
- `.gitignore` 排除常见录音格式、清单、转写产物、播放缓存、构建目录、虚拟环境和密钥文件。忽略规则不能保护已提交的文件，也不能自动识别任意命名的敏感文件。
- 公开前运行 `npm run check:public` 并人工检查待提交文件；自动检查只是补充，不等于完整秘密扫描。
- 页面使用 Google Fonts，离线时回退等宽字体；演示播放不申请麦克风权限、不上传音频。
- 使用云端转写时须明确告知上传事实；“播放器在本地”不代表转写也在本地。
- 若私人文件曾被提交或推送，仅删除当前文件不足以清除 Git 历史；应清理历史，若密钥泄露还必须撤销或轮换密钥。