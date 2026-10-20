import { readFile, writeFile, mkdir, lstat, realpath, access, rename, rm, statfs } from 'node:fs/promises';
import { resolve, basename, dirname, extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateRecording, safeId } from '../src/recording.js';
import { formatTime } from '../src/timeline.js';
import { acquireFileLock } from './file-lock.mjs';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function confinedFile(directory, file) {
  if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(file)) throw new Error('Unsafe filename');
  const path = join(directory, file);
  if (!(await lstat(path)).isFile() || dirname(await realpath(path)) !== await realpath(directory)) throw new Error(`Not a regular local file: ${file}`);
  return path;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}

export function normalizeUtterances(data) {
  const source = data.utterances || data.result?.utterances;
  const rawContainer = !Array.isArray(data.utterances) && Array.isArray(data.result?.utterances);
  if (!Array.isArray(source)) throw new Error('Missing utterances array');
  return source.map((cue) => {
    const raw = rawContainer || !Object.hasOwn(cue, 'start');
    const start = raw ? (cue.start_time ?? cue.start) / 1000 : cue.start;
    const end = raw ? (cue.end_time ?? cue.end) / 1000 : cue.end;
    if (![start, end].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) || end < start || typeof cue.text !== 'string') throw new Error('Invalid ASR timestamp or text');
    return { start, end, text: cue.text };
  });
}

export async function importRecording(options, root = resolve(import.meta.dirname, '..')) {
  for (const key of ['task-json', 'transcripts', 'chapters', 'mode', 'model']) if (!options[key]) throw new Error(`Missing --${key}`);
  if (!['local', 'cloud'].includes(options.mode)) throw new Error('--mode must be local or cloud');
  const taskPath = resolve(options['task-json']);
  const audioDirectory = resolve(options['audio-dir'] || dirname(taskPath));
  const transcriptDirectory = resolve(options.transcripts);
  const task = await readJson(taskPath);
  const prepared = await readJson(resolve(options.chapters));
  if (!Array.isArray(task.segments) || !task.segments.length) throw new Error('Empty manifest');
  const id = options.id || (safeId(task.recordingID) ? task.recordingID : `recording-${randomUUID()}`);
  if (!safeId(id) || id === 'synthetic-demo') throw new Error('Unsafe or reserved recording id');
  const output = join(root, 'recordings', id);
  const web = join(root, 'public', 'private', id);
  const audioOutput = join(root, 'public', 'audio', id);
  for (const path of [output, web, audioOutput]) if (await exists(path)) throw new Error(`Recording already exists: ${id}; choose a new --id to preserve history`);
  const segments = task.segments.map((entry) => ({ ...entry })).sort((first, second) => first.offset - second.offset);
  const names = new Set();
  const prefixCounts = new Map();
  let previousEnd = 0;
  for (const segment of segments) {
    if (typeof segment.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment.file) || names.has(segment.file)) throw new Error('Unsafe or duplicate segment filename');
    names.add(segment.file);
    if (![segment.offset, segment.duration].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) || segment.offset < previousEnd) throw new Error('Invalid or overlapping segment timing');
    previousEnd = segment.offset + segment.duration;
    const prefix = segment.file.split('-')[0];
    prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
  }
  const duration = Math.max(...segments.map((entry) => entry.offset + entry.duration));
  const warnings = [];
  if (!prepared.recordingDate) warnings.push('未从录制元数据确认日期，使用相对时码。');
  const utterances = [];
  const media = [];
  const statuses = [];
  for (const segment of segments) {
    const source = await confinedFile(audioDirectory, segment.file);
    const sha256 = hash(await readFile(source));
    if (segment.sha256 !== undefined && segment.sha256 !== sha256) throw new Error(`SHA256 mismatch: ${segment.file}`);
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', source]));
    const actualDuration = Number(probe.format?.duration);
    if (!Number.isFinite(actualDuration) || actualDuration < 0 || !probe.streams?.some((stream) => stream.codec_type === 'audio')) throw new Error(`Undecodable audio: ${segment.file}`);
    if (Math.abs(actualDuration - segment.duration) > 0.1) warnings.push(`${segment.file} 实际时长 ${actualDuration.toFixed(3)}s，清单 ${segment.duration}s。`);
    segment.sha256 = sha256;
    segment.actualDuration = actualDuration;
    segment.playable = segment.duration >= 1 && actualDuration >= 1;
    if (!segment.playable) {
      segment.skipReason = '时长不足 1 秒';
      statuses.push({ file: segment.file, status: 'skipped', reason: segment.skipReason });
      warnings.push(`${segment.file}：${segment.skipReason}，跳过转写和播放。`);
      continue;
    }
    const cacheName = `${sha256}-pcm16k-v1.wav`;
    segment.audioUrl = `audio/${id}/${cacheName}`;
    media.push({ source, cacheName });
    const stem = basename(segment.file, extname(segment.file));
    let cacheId = stem;
    if (!(await exists(join(transcriptDirectory, `${stem}.json`)))) {
      const legacy = stem.split('-')[0];
      if (await exists(join(transcriptDirectory, `${legacy}.json`))) {
        if (prefixCounts.get(legacy) !== 1) throw new Error(`Ambiguous legacy cache: ${legacy}; regenerate with full stems`);
        cacheId = legacy;
        warnings.push(`${segment.file} 使用旧版短 UID 缓存，已显式适配。`);
      }
    }
    try {
      if (await exists(join(transcriptDirectory, `${cacheId}.ERROR.txt`))) throw new Error('存在转写失败日志');
      const data = await readJson(await confinedFile(transcriptDirectory, `${cacheId}.json`));
      if (data.sha256 && data.sha256 !== sha256) throw new Error('缓存哈希不匹配');
      if (data.file && basename(data.file) !== segment.file) throw new Error('缓存音频文件不匹配');
      const cues = normalizeUtterances(data);
      if (cues.some((cue) => cue.end > segment.duration || cue.end > actualDuration + 0.1)) throw new Error('句级时码超出切片范围');
      utterances.push(...cues.map((cue) => ({ ...cue, start: segment.offset + cue.start, end: segment.offset + cue.end })));
      statuses.push({ file: segment.file, status: 'success', utterances: cues.length });
      if (!cues.length) warnings.push(`${segment.file} 转写为零句，需区分静音与漏识。`);
    } catch (error) {
      statuses.push({ file: segment.file, status: 'failed', reason: error.message });
      warnings.push(`${segment.file} 转写不可用：${error.message}`);
    }
  }
  utterances.sort((first, second) => first.start - second.start);
  if (!statuses.some((entry) => entry.status === 'success')) throw new Error('No successful transcripts; refusing placeholder recording');
  const recording = validateRecording({
    version: 1, id, recordingDate: prepared.recordingDate ?? null, startedAt: prepared.startedAt ?? null, timezone: prepared.timezone ?? null,
    title: options.title || prepared.title || '录音 01', duration,
    processing: { mode: options.mode, model: options.model },
    segments, chapters: prepared.chapters, utterances, markers: task.markers || [],
    warnings: [...warnings, ...(prepared.warnings || [])],
  });
  const stats = { segments_total: segments.length, success: statuses.filter((entry) => entry.status === 'success').length, failed: statuses.filter((entry) => entry.status === 'failed').length, skipped: statuses.filter((entry) => entry.status === 'skipped').length, effective_duration: segments.filter((entry) => entry.playable).reduce((sum, entry) => sum + entry.actualDuration, 0), missing: statuses.filter((entry) => entry.status === 'failed'), statuses, processing: recording.processing };
  const transcript = ['# 完整逐字稿', '', ...utterances.map((cue) => `[${cue.start.toFixed(3)}s → ${cue.end.toFixed(3)}s] ${cue.text}`)].join('\n');
  const segmentText = ['# 按切片整理稿', '', ...segments.flatMap((segment) => [`## ${formatTime(segment.offset)} / ${segment.file}`, '', ...utterances.filter((cue) => cue.start >= segment.offset && cue.start < segment.offset + segment.duration).map((cue) => cue.text), ''])].join('\n');
  const summary = [`# ${recording.title}`, '', `- 录音 ID：${id}`, `- 总时长：${formatTime(duration)}`, `- 成功 ${stats.success} / 失败 ${stats.failed} / 跳过 ${stats.skipped}`, `- 处理：${options.mode} / ${options.model}`, '', '## 时间线摘要', '', ...recording.chapters.flatMap((chapter) => [`### ${formatTime(chapter.start)} → ${formatTime(chapter.end)} / ${chapter.title}`, chapter.description, ...chapter.bullets.map((bullet) => `- ${bullet}`), '']), '## 书签', ...recording.markers.map((marker) => `- ${formatTime(marker)} (${marker}s)`), '', '## 缺片与存疑', ...recording.warnings.map((warning) => `- ${warning}`), '', '## 处理与隐私', options.mode === 'cloud' ? '语音识别使用云端服务，音频曾上传第三方。网页使用本地播放缓存，未公开部署。' : '语音识别在本机进行。网页使用本地播放缓存，未公开部署。', '', '## 完整分段稿', '', segmentText].join('\n');
  const registryPath = join(root, 'public', 'private', 'recordings.json');
  await mkdir(dirname(registryPath), { recursive: true });
  const release = await acquireFileLock(join(dirname(registryPath), '.import.lock'));
  try {
  const registry = await exists(registryPath) ? await readJson(registryPath) : { version: 1, recordings: [] };
  if (!Array.isArray(registry.recordings) || registry.recordings.some((entry) => entry.id === id)) throw new Error('Invalid or duplicate registry entry');
  const free = await statfs(root);
  if (Number(free.bavail) * Number(free.bsize) < stats.effective_duration * 32000 * 2 + 1024 * 1024) throw new Error('Insufficient disk space for PCM cache');
  let registered = false;
  try {
    await mkdir(output, { recursive: true });
    await mkdir(web, { recursive: true });
    await mkdir(audioOutput, { recursive: true });
    for (const item of media) {
      const target = join(audioOutput, item.cacheName);
      if (!(await exists(target))) run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-i', item.source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target]);
    }
    for (const [file, content] of Object.entries({ 'recording.json': json(recording), 'merged_stats.json': json(stats), 'merged_transcript.md': transcript, 'merged_segments.md': segmentText, 'recording_summary.md': summary })) await writeFile(join(output, file), content);
    await writeFile(join(web, 'recording.json'), json(recording));
    registry.recordings.push({ id });
    await writeFile(`${registryPath}.tmp`, json(registry));
    await rename(`${registryPath}.tmp`, registryPath);
    registered = true;
    return { recording, stats, output };
  } finally {
    if (!registered) for (const path of [output, web, audioOutput]) await rm(path, { recursive: true, force: true });
  }
  } finally { await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['task-json', 'transcripts', 'chapters', 'audio-dir', 'mode', 'model', 'id', 'title'].map((key) => [key, { type: 'string' }])) });
    const result = await importRecording(values);
    console.log(`Imported ${result.recording.id}: success=${result.stats.success}, failed=${result.stats.failed}, skipped=${result.stats.skipped}`);
    console.log('Private data is now present. Do not publish public/ or dist/. Run npm run check:public before any release.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}