import { mkdir, readFile, writeFile, rename, readdir, stat, rm, statfs } from 'node:fs/promises';
import { join, resolve, basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { normalizeUtterances } from './import-recording.mjs';
import { acquireFileLock } from './file-lock.mjs';
import { validateRecording } from '../src/recording.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const filename = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\.m4a$/i.test(value);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };
const terminalStates = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

export function validateTask(input) {
  if (!input || !Array.isArray(input.segments) || !input.segments.length || input.segments.length > 2000) throw new Error('清单必须包含 1 到 2000 个切片');
  const files = new Set();
  let previousEnd = 0;
  const segments = input.segments.map((segment) => ({ file: segment.file, offset: segment.offset, duration: segment.duration, ...(segment.sha256 === undefined ? {} : { sha256: segment.sha256 }) })).sort((first, second) => first.offset - second.offset);
  for (const segment of segments) {
    if (!filename(segment.file) || files.has(segment.file)) throw new Error('切片文件名非法或重复');
    files.add(segment.file);
    if (![segment.offset, segment.duration].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) || segment.offset < previousEnd) throw new Error('切片时码非法或重叠');
    if (segment.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(segment.sha256)) throw new Error('SHA-256 格式错误');
    previousEnd = segment.offset + segment.duration;
  }
  if (previousEnd <= 0) throw new Error('录音总时长必须大于零');
  const markers = input.markers ?? [];
  if (!Array.isArray(markers) || !markers.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= previousEnd)) throw new Error('书签时码非法');
  return { version: 1, recordingID: typeof input.recordingID === 'string' ? input.recordingID.slice(0, 128) : null, segments, markers };
}

export function extractChapters(task, transcripts) {
  const duration = Math.max(...task.segments.map((segment) => segment.offset + segment.duration));
  const cues = transcripts.flatMap(({ segment, utterances }) => utterances.map((cue) => ({ start: segment.offset + cue.start, end: segment.offset + cue.end, text: cue.text }))).filter((cue) => cue.text.trim() && cue.end > cue.start).sort((first, second) => first.start - second.start);
  const groups = [];
  for (const cue of cues) {
    let group = groups.at(-1);
    if (!group || cue.start - group.end > 90 || (cue.start >= group.end && (cue.end - group.start > 300 || group.text.length + cue.text.length > 1600))) {
      group = { start: cue.start, end: cue.end, text: '' };
      groups.push(group);
    }
    group.end = Math.max(group.end, cue.end);
    group.text += `${group.text ? ' ' : ''}${cue.text}`;
  }
  if (!groups.length) return [{ id: 'audio-only', start: task.segments.find((segment) => segment.duration >= 1)?.offset ?? 0, end: duration, title: '录音片段', tag: 'NO SPEECH', icon: 'audio-lines', location: '', description: '识别服务未返回可辨认原文。', bullets: [] }];
  return groups.map((group, index) => ({ id: `chapter-${index + 1}`, start: group.start, end: Math.min(duration, group.end), title: `原文摘录 ${String(index + 1).padStart(2, '0')}`, tag: 'EXCERPT', icon: 'audio-lines', location: '', description: group.text.slice(0, 140), bullets: [] }));
}

async function atomicJson(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function command(executable, args, signal) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (bytes) => { output = (output + bytes).slice(-4 * 1024 * 1024); });
    child.stderr.on('data', (bytes) => { errorOutput = (errorOutput + bytes).slice(-4096); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolveCommand(output) : reject(new Error(`${basename(executable)} 执行失败：${errorOutput.slice(-800)}`)));
  });
}

async function cloudKey(root) {
  if (process.env.DOUBAO_API_KEY) return process.env.DOUBAO_API_KEY;
  for (const file of ['.env.local', '.env', 'recording-transcribe/scripts/.env']) {
    try { const value = parseEnv(await readFile(join(root, file), 'utf8')).DOUBAO_API_KEY; if (value) return value; } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本地云端配置'); }
  }
  throw new Error('缺少 DOUBAO_API_KEY，请在本机 .env.local 中配置后重试，不要在聊天或网页中输入密钥。');
}

export async function recognizeAudio(bytes, key, signal) {
  const response = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
    headers: { 'X-Api-Key': key, 'X-Api-Resource-Id': 'volc.seedasr.auc', 'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { uid: 'limbo-echo' }, audio: { data: bytes.toString('base64'), format: 'm4a' }, request: { model_name: 'bigmodel', language: 'zh-CN' } }),
  });
  const status = response.headers.get('X-Api-Status-Code');
  if (!response.ok || !['20000000', '20000003'].includes(status)) throw new Error(`豆包请求失败（HTTP ${response.status}，状态 ${status || '未知'}）。请检查资源开通、额度和本地配置。`);
  if (status === '20000003') return [];
  const data = await response.json();
  return normalizeUtterances({ result: { utterances: data.result?.utterances ?? data.utterances } });
}

export class JobStore {
  constructor(root, dependencies = {}) {
    this.root = resolve(root);
    this.directory = join(this.root, 'private', 'jobs');
    this.jobs = new Map();
    this.running = false;
    this.closed = false;
    this.controllers = new Map();
    this.dependencies = dependencies;
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.release = await acquireFileLock(join(this.directory, '.server.lock'));
    try {
    for (const name of await readdir(this.directory)) {
      if (!/^job-[a-f0-9-]{36}$/.test(name)) continue;
      const path = join(this.directory, name, 'job.json');
      try {
        const job = await readJson(path);
        if (job.id !== name || !/^recording-[a-f0-9-]{36}$/.test(job.recordingId)) throw new Error('任务标识无效');
        job.task = validateTask(job.task);
        if (!terminalStates.has(job.state) && job.state !== 'uploading') {
          job.state = 'interrupted';
          job.error = '服务已重启；已完成切片缓存保留。重试可能重新提交未确认的请求并产生费用。';
          await atomicJson(path, job);
        }
        this.jobs.set(job.id, job);
      } catch { throw new Error('本地任务数据损坏；请检查 private/jobs，未自动删除历史任务。'); }
    }
    return this;
    } catch (error) { await this.release(); throw error; }
  }

  path(job, ...parts) { return join(this.directory, job.id, ...parts); }
  get(id) { const job = this.jobs.get(id); if (!job) throw new Error('任务不存在'); return job; }
  list() { return [...this.jobs.values()].map((job) => this.view(job)); }
  view(job) { const { task, ...publicJob } = job; return { ...publicJob, files: task.segments.map((segment) => segment.file) }; }
  async save(job) { job.updatedAt = new Date().toISOString(); await atomicJson(this.path(job, 'job.json'), job); }

  async create(input, consent) {
    this.creation = (this.creation || Promise.resolve()).catch(() => {}).then(() => this.createJob(input, consent));
    return this.creation;
  }

  async createJob(input, consent) {
    if (consent !== true) throw new Error('需要明确同意将音频发送给豆包，涉及第三方谈话与潜在费用');
    const task = validateTask(input);
    const fingerprint = digest(JSON.stringify(task));
    const duplicate = task.segments.every((segment) => segment.sha256) && [...this.jobs.values()].find((job) => job.fingerprint === fingerprint && job.state !== 'cancelled');
    if (duplicate) return this.view(duplicate);
    const id = `job-${randomUUID()}`;
    const job = { id, recordingId: `recording-${randomUUID()}`, fingerprint, task, state: 'uploading', uploaded: [], completed: 0, total: task.segments.length, errors: [], error: null, consentAt: new Date().toISOString(), createdAt: new Date().toISOString() };
    await mkdir(this.path(job, 'input'), { recursive: true, mode: 0o700 });
    await mkdir(this.path(job, 'transcripts'), { mode: 0o700 });
    await atomicJson(this.path(job, 'task.json'), task);
    await this.save(job);
    this.jobs.set(id, job);
    return this.view(job);
  }

  async upload(id, file, stream) {
    const job = this.get(id);
    if (job.state !== 'uploading' || !job.task.segments.some((segment) => segment.file === file)) throw new Error('任务不接受此文件');
    const bytes = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) throw new Error('单片超过 100 MB 限制');
      bytes.push(chunk);
    }
    if (!size) throw new Error('音频文件为空');
    const buffer = Buffer.concat(bytes);
    const segment = job.task.segments.find((entry) => entry.file === file);
    if (segment.sha256 && segment.sha256 !== digest(buffer)) throw new Error('音频 SHA-256 不匹配');
    if (job.state !== 'uploading') throw new Error('任务已停止上传');
    await writeFile(this.path(job, 'input', file), buffer, { mode: 0o600 });
    if (!job.uploaded.includes(file)) job.uploaded.push(file);
    await this.save(job);
    return this.view(job);
  }

  async start(id, consent) {
    const job = this.get(id);
    if (consent !== true) throw new Error('重试需要再次确认云端上传与潜在重复费用');
    if (!['uploading', 'failed', 'interrupted'].includes(job.state)) throw new Error('当前任务不能启动或重试');
    if (job.uploaded.length !== job.total) throw new Error('音频尚未上传完整，请重新选择原文件夹继续上传');
    job.state = 'queued';
    job.error = null;
    job.consentAt = new Date().toISOString();
    await this.save(job);
    this.kick();
    return this.view(job);
  }

  async cancel(id) {
    const job = this.get(id);
    if (job.state === 'importing' || job.state === 'completed') throw new Error('记录正在提交或已经完成，不能取消');
    job.state = 'cancelled';
    this.controllers.get(id)?.abort();
    await this.save(job);
    return this.view(job);
  }

  kick() {
    if (!this.running && !this.closed) this.idle = this.drain();
  }

  async drain() {
    this.running = true;
    try {
      for (const job of this.jobs.values()) if (!this.closed && job.state === 'queued') await this.run(job);
    } finally { this.running = false; if (!this.closed && [...this.jobs.values()].some((job) => job.state === 'queued')) this.kick(); }
  }

  async run(job) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const signal = controller.signal;
    const ensureActive = () => { if (signal.aborted || this.closed) throw new Error('任务已中断'); };
    try {
      const registeredPath = join(this.root, 'public', 'private', job.recordingId, 'recording.json');
      const registryPath = join(this.root, 'public', 'private', 'recordings.json');
      const registered = await exists(registryPath) && (await readJson(registryPath)).recordings.some((entry) => entry.id === job.recordingId);
      ensureActive();
      if (registered && await exists(registeredPath)) {
        const recording = validateRecording(await readJson(registeredPath));
        if (recording.id !== job.recordingId) throw new Error('已登记记录的 ID 不一致，未覆盖');
        job.state = 'completed'; job.error = null; await this.save(job); return;
      }
      if (registered) throw new Error('已登记的记录数据缺失，未自动覆盖，请检查本地档案');
      for (const parts of [['recordings', job.recordingId], ['public', 'private', job.recordingId], ['public', 'audio', job.recordingId]]) await rm(join(this.root, ...parts), { recursive: true, force: true });
      ensureActive();
      job.state = 'validating'; job.completed = 0; job.errors = []; job.currentFile = null; await this.save(job);
      const space = await statfs(this.root);
      if (Number(space.bavail) * Number(space.bsize) < job.task.segments.reduce((sum, segment) => sum + segment.duration, 0) * 64000 + 1024 * 1024) throw new Error('磁盘空间不足，尚未上传到云端');
      const prepared = [];
      for (const segment of job.task.segments) {
        ensureActive();
        job.currentFile = segment.file; await this.save(job);
        const bytes = await readFile(this.path(job, 'input', segment.file));
        const sha256 = digest(bytes);
        if (segment.sha256 && segment.sha256 !== sha256) throw new Error(`音频校验失败：${segment.file}`);
        let duration;
        if (this.dependencies.probe) duration = await this.dependencies.probe(segment);
        else {
          const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', this.path(job, 'input', segment.file)], signal));
          if (!probe.streams?.some((stream) => stream.codec_type === 'audio')) throw new Error(`没有可解码音轨：${segment.file}`);
          duration = Number(probe.format?.duration);
        }
        if (!Number.isFinite(duration) || duration < 0) throw new Error(`音频无法解码：${segment.file}`);
        if (duration > 7200) throw new Error('单片超过豆包极速版 2 小时限制，尚未上传到云端');
        if (duration >= 1 && segment.duration >= 1 && Math.abs(duration - segment.duration) > Math.max(1, segment.duration * 0.01)) throw new Error(`实际时长与清单差异过大：${segment.file}，尚未上传到云端`);
        prepared.push({ segment, sha256, duration });
      }
      if (Number((await statfs(this.root)).bavail) * Number(space.bsize) < prepared.reduce((sum, item) => sum + item.duration, 0) * 64000 + 1024 * 1024) throw new Error('实际音频所需缓存超过可用空间，尚未上传到云端');
      ensureActive();
      job.state = 'transcribing'; await this.save(job);
      const transcripts = [];
      let key;
      for (const item of prepared) {
        ensureActive();
        const { segment, sha256, duration } = item;
        job.currentFile = segment.file; await this.save(job);
        ensureActive();
        const cachePath = this.path(job, 'transcripts', `${basename(segment.file, extname(segment.file))}.json`);
        const identity = { sha256, model: 'doubao/seed-asr', options: { language: 'zh-CN', timeUnit: 'seconds', version: 1 } };
        if (segment.duration < 1 || duration < 1) { job.completed += 1; await this.save(job); continue; }
        let utterances;
        try {
          try { const cached = await readJson(cachePath); if (cached.sha256 === sha256 && cached.model === identity.model && JSON.stringify(cached.options) === JSON.stringify(identity.options)) utterances = normalizeUtterances(cached); } catch {}
          if (utterances?.some((cue) => cue.end > segment.duration || cue.end > duration + 0.1)) utterances = undefined;
          if (!utterances) {
            key ||= this.dependencies.key ? await this.dependencies.key() : await cloudKey(this.root);
            ensureActive();
            utterances = await (this.dependencies.recognize || recognizeAudio)(await readFile(this.path(job, 'input', segment.file)), key, signal);
            if (!Array.isArray(utterances) || utterances.some((cue) => cue.end > segment.duration || cue.end > duration + 0.1)) throw new Error('识别时码超出音频范围');
            await atomicJson(cachePath, { file: segment.file, ...identity, utterances });
          }
          transcripts.push({ segment, utterances });
          await rm(cachePath.replace(/\.json$/, '.ERROR.txt'), { force: true });
        } catch (error) {
          ensureActive();
          job.errors.push({ file: segment.file, message: error.message });
          await writeFile(cachePath.replace(/\.json$/, '.ERROR.txt'), error.message, { mode: 0o600 });
          await this.save(job);
          throw new Error(`${segment.file} 处理失败：${error.message} 已保留成功缓存，重试不会重传已成功切片。`);
        }
        ensureActive(); job.completed += 1; await this.save(job);
      }
      ensureActive(); job.state = 'summarizing'; await this.save(job);
      const chapters = { title: `录音 ${job.recordingId.slice(-8)}`, chapters: extractChapters(job.task, transcripts), warnings: ['章节按停顿和长度自动分段，摘要为原文摘录，未调用额外的语义摘要模型。'] };
      await atomicJson(this.path(job, 'chapters.json'), chapters);
      ensureActive(); job.state = 'importing'; await this.save(job);
      const options = { 'task-json': this.path(job, 'task.json'), 'audio-dir': this.path(job, 'input'), transcripts: this.path(job, 'transcripts'), chapters: this.path(job, 'chapters.json'), mode: 'cloud', model: 'doubao/seed-asr', id: job.recordingId };
      if (this.dependencies.importRecording) await this.dependencies.importRecording(options, this.root);
      else await command(process.execPath, [join(this.root, 'scripts', 'import-recording.mjs'), ...Object.entries(options).flatMap(([name, value]) => [`--${name}`, value])], signal);
      job.state = 'completed'; job.currentFile = null; job.error = null; await this.save(job);
    } catch (error) {
      if (job.state !== 'cancelled') { job.state = this.closed ? 'interrupted' : 'failed'; job.error = error.message; }
      await this.save(job);
    } finally { this.controllers.delete(job.id); }
  }

  async close() { if (this.closed) return; this.closed = true; for (const controller of this.controllers.values()) controller.abort(); await this.idle; await this.release?.(); }
}