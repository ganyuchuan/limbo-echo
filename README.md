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
| [scripts/jobs.mjs](scripts/jobs.mjs) | 本地持久任务队列、豆包转写和自动摘录章节 |
| [vite.config.js](vite.config.js) | 仅开发服务启用的同源任务 API |
| [recording-transcribe/SKILL.md](recording-transcribe/SKILL.md) | 可选的转写整理子技能 |

## 网页文件夹导入

现在可以直接选择一个包含全部 `*.m4a` 和一个 `task.json` 的文件夹，无需提前生成转写或章节 JSON。

1. 在本机私下配置 `DOUBAO_API_KEY` 环境变量，或在项目 `.env.local` 中设置同名变量并将文件权限设为 `600`。变量格式见 [.env.example](.env.example)，不要在聊天、网页或命令参数中输入密钥。
2. 确保 FFmpeg、FFprobe 可用，运行 `npm run dev`，打开终端的实际本地地址。
3. 点击“导入文件夹”，选择录音目录，阅读并确认音频离开本机、第三方谈话授权与潜在费用。未勾选同意不会创建云端任务。
4. 页面显示本地传输、校验、排队、云端转写、摘录整理与播放缓存进度。关闭网页不影响后台任务；关闭开发服务会中断任务。
5. 完成后记录自动追加到选择列表，点击“打开记录”查看。原有记录与正在播放的音频不被覆盖或自动切走。

音频必须与 `task.json` 同目录，不支持递归扫描多个清单；缺件、多余音频、重复或不安全文件名、重叠时码、哈希不符会拒绝处理。未提供哈希时浏览器会在本地计算。单片上限 100 MB、2 小时，每批最多 2000 片；实际服务商限制与可用磁盘空间仍可能导致失败。

自动流程调用豆包录音识别极速版（固定官方端点，中文），逐片等待服务返回；章节按停顿与长度自动分段，说明为**原文摘录，不是语义摘要**，不额外上传转写给摘要模型。全静音或无可辨认原文会明确标记，不编造谈话。日期未独立核实时保留相对时码。

任务、输入副本及带完整 stem 的缓存保存在已忽略的 `private/jobs/<job-id>/`。失败或服务重启后可重试；有效的成功缓存不会再次提交，损坏或模型选项不符的缓存会重新识别。超时、中断或取消时，服务商可能已经接收音频并计费，重试不能保证没有重复费用，也不宣称免费。服务重启不会自行恢复上传，需再次确认。

相同清单与哈希会复用已有任务，防止重复点击；新任务使用新的记录 ID，保留之前同源录音的文档导入版本。提交索引与后台队列使用进程锁，防止两个本地服务重复消费同一队列或覆盖索引。已完成档案不自动删除。

该功能只在 `npm run dev` 的本机服务中启用；静态构建或预览不能提交云端任务。API 校验本机 Host、同源 Origin 和请求令牌，不支持公开暴露。Vite 不自动加载 `.env`，后台仅在确认的任务需要 ASR 时读取密钥：进程环境 → `.env.local` → `.env` → 兼容旧版子技能的配置文件。不要使用 `VITE_` 前缀保存密钥。

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
- 保留演示档案和历史记录，首次打开空闲演示页时选中最后导入的记录；任务完成后的增量刷新不切换当前记录。已有 ID 不覆盖，重新导入可显式传入新的 `--id`。
- 模板运行时使用 JSON，不从 Markdown 提取时码。导入不修改源码，外部标题、摘要与原文均按纯文本渲染。

## 隐私与公开发布

- 原始录音、清单和转写放在 `recordings/` 或 `private/` 等已忽略目录；不要放进源码、提交或示例数据。
- `.gitignore` 排除常见录音格式、清单、转写产物、播放缓存、构建目录、虚拟环境和密钥文件。忽略规则不能保护已提交的文件，也不能自动识别任意命名的敏感文件。
- 公开前运行 `npm run check:public` 并人工检查待提交文件；自动检查只是补充，不等于完整秘密扫描。
- 页面使用 Google Fonts，离线时回退等宽字体；演示播放不申请麦克风权限、不上传音频。
- 使用云端转写时须明确告知上传事实；“播放器在本地”不代表转写也在本地。
- 若私人文件曾被提交或推送，仅删除当前文件不足以清除 Git 历史；应清理历史，若密钥泄露还必须撤销或轮换密钥。