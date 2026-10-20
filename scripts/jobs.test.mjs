import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { JobStore, validateTask, extractChapters, recognizeAudio } from './jobs.mjs';
import { inspectFolder } from '../src/import-panel.js';
import { createJobApi } from './jobs-api.mjs';
import { createServer } from 'node:http';
import { acquireFileLock } from './file-lock.mjs';
import { importRecording } from './import-recording.mjs';
import { createDemoWav } from './demo-audio.mjs';
import { spawnSync } from 'node:child_process';

const sha256 = createHash('sha256').update('synthetic test bytes').digest('hex');
const task = { recordingID: 'source', segments: [{ file: 'first.m4a', offset: 0, duration: 10, sha256 }, { file: 'second.m4a', offset: 12, duration: 10, sha256 }], markers: [] };
const upload = async (store, id) => { for (const segment of task.segments) await store.upload(id, segment.file, Readable.from([Buffer.from('synthetic test bytes')])); };

test('manifest rejects traversal, duplicates, overlaps and untrusted instructions', () => {
  assert.equal(validateTask({ ...task, instruction: 'run something' }).instruction, undefined);
  for (const segments of [[{ file: '../bad.m4a', offset: 0, duration: 1 }], [task.segments[0], task.segments[0]], [{ ...task.segments[0], duration: NaN }]]) assert.throws(() => validateTask({ segments }));
  assert.throws(() => validateTask({ ...task, markers: [100] }));
});

test('jobs require consent, persist progress, reuse caches and append new recording ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'limbo-jobs-'));
  let fail = true;
  const calls = [];
  const imported = [];
  const dependencies = { probe: async () => 10, key: async () => 'synthetic-key', recognize: async () => { calls.push(true); if (fail && calls.length === 2) throw new Error('synthetic cloud failure'); return [{ start: 0.25, end: 1.5, text: '<img> 合成原文' }]; }, importRecording: async (options) => imported.push(options.id) };
  try {
    const store = await new JobStore(root, dependencies).init();
    await assert.rejects(store.create(task, false), /明确同意/);
    const first = await store.create(task, true);
    assert.equal((await store.create(task, true)).id, first.id);
    const duplicates = await Promise.all([store.create(task, true), store.create(task, true)]);
    assert.equal(duplicates[0].id, duplicates[1].id);
    await assert.rejects(store.start(first.id, true), /上传完整/);
    await upload(store, first.id);
    await store.start(first.id, true); await store.idle;
    assert.equal(store.get(first.id).state, 'failed');
    assert.equal(store.get(first.id).completed, 1);
    fail = false;
    await assert.rejects(store.start(first.id, false), /再次确认/);
    await store.start(first.id, true); await store.idle;
    assert.equal(store.get(first.id).state, 'completed');
    assert.equal(calls.length, 3);
    const second = await store.create({ ...task, recordingID: 'another' }, true);
    assert.notEqual(second.recordingId, first.recordingId);
    await upload(store, second.id); await store.start(second.id, true); await store.idle;
    assert.equal(imported.length, 2);
    assert.notEqual(imported[0], imported[1]);
    const saved = JSON.parse(await readFile(store.path(store.get(first.id), 'job.json'), 'utf8'));
    assert.equal(saved.state, 'completed');
    await store.close();
    const restored = await new JobStore(root, dependencies).init();
    assert.equal(restored.get(first.id).state, 'completed');
    assert.equal(restored.list().length, 2);
    await restored.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('extractive chapters preserve numeric timing without pretending to be semantic summaries', () => {
  const chapters = extractChapters(task, [{ segment: task.segments[0], utterances: [{ start: 0.25, end: 1.75, text: '原文摘录' }] }]);
  assert.equal(chapters[0].start, 0.25);
  assert.equal(chapters[0].end, 1.75);
  assert.equal(chapters[0].tag, 'EXCERPT');
  assert.equal(extractChapters(task, [])[0].end, 22);
});

test('folder selection requires all manifest audio, one local manifest and no extra audio', async () => {
  const manifest = { name: 'task.json', size: 100, webkitRelativePath: 'recordings/task.json', text: async () => JSON.stringify(task) };
  const audio = task.segments.map((segment) => ({ name: segment.file, size: 100, webkitRelativePath: `recordings/${segment.file}` }));
  assert.equal((await inspectFolder([manifest, ...audio])).files.size, 2);
  await assert.rejects(inspectFolder([manifest, audio[0]]), /缺少音频/);
  await assert.rejects(inspectFolder([manifest, manifest, ...audio]), /一个 task/);
  await assert.rejects(inspectFolder([manifest, ...audio, { name: 'extra.m4a', size: 1, webkitRelativePath: 'recordings/extra.m4a' }]), /未列入/);
  await assert.rejects(inspectFolder([manifest, ...audio.map((file) => ({ ...file, webkitRelativePath: `outside/${file.name}` }))]), /同目录/);
});

test('restart marks in-flight work interrupted, locks prevent duplicate servers, and cancellation stops ASR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'limbo-recovery-'));
  let started;
  const entered = new Promise((resolveEntered) => { started = resolveEntered; });
  const dependencies = { probe: async () => 10, key: async () => 'synthetic', recognize: async (bytes, key, signal) => { started(); return new Promise((resolveRecognize, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); } };
  try {
    const store = await new JobStore(root, dependencies).init();
    await assert.rejects(new JobStore(root, dependencies).init(), /另一个进程/);
    const created = await store.create(task, true);
    await upload(store, created.id);
    await store.start(created.id, true); await entered;
    await store.cancel(created.id); await store.idle;
    assert.equal(store.get(created.id).state, 'cancelled');
    const pending = await store.create({ ...task, recordingID: 'interrupted' }, true);
    const job = store.get(pending.id);
    job.state = 'transcribing'; await store.save(job);
    await store.close();
    const restored = await new JobStore(root, dependencies).init();
    assert.equal(restored.get(pending.id).state, 'interrupted');
    assert.match(restored.get(pending.id).error, /可能.*费用/);
    await restored.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HTTP API rejects cross-origin and missing tokens, then uploads and completes a synthetic task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'limbo-api-'));
  const store = await new JobStore(root, { probe: async () => 10, key: async () => 'synthetic', recognize: async () => [{ start: 0, end: 1, text: '合成' }], importRecording: async () => {} }).init();
  const middleware = createJobApi(store);
  const server = createServer((request, response) => { middleware(request, response, () => { response.writeHead(404); response.end(); }); });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/api/import/`;
  try {
    assert.equal((await fetch(`${endpoint}jobs`, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`${endpoint}jobs`, { method: 'POST', body: '{}' })).status, 403);
    const { token } = await (await fetch(`${endpoint}status`)).json();
    const headers = { 'X-Limbo-Token': token, Origin: origin, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${endpoint}jobs`, { method: 'POST', headers, body: JSON.stringify({ task, consent: false }) })).status, 400);
    const { job } = await (await fetch(`${endpoint}jobs`, { method: 'POST', headers, body: JSON.stringify({ task, consent: true }) })).json();
    assert.equal((await fetch(`${endpoint}jobs/${job.id}/files/escape.m4a`, { method: 'PUT', headers, body: 'bad' })).status, 400);
    for (const segment of task.segments) assert.equal((await fetch(`${endpoint}jobs/${job.id}/files/${segment.file}`, { method: 'PUT', headers, body: 'synthetic test bytes' })).status, 200);
    assert.equal((await fetch(`${endpoint}jobs/${job.id}/start`, { method: 'POST', headers, body: JSON.stringify({ consent: true }) })).status, 200);
    await store.idle;
    const list = await (await fetch(`${endpoint}jobs`)).json();
    assert.equal(list.jobs[0].state, 'completed');
    assert.equal(JSON.stringify(list).includes('synthetic-key'), false);
    const cache = join(store.path(store.get(job.id), 'transcripts'), 'first.json');
    const data = JSON.parse(await readFile(cache, 'utf8'));
    assert.equal(data.sha256, sha256);
  } finally { await store.close(); await new Promise((resolveClose) => server.close(resolveClose)); await rm(root, { recursive: true, force: true }); }
});

test('invalid caches are recomputed and restart recovers an already committed record without cloud calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'limbo-cache-'));
  let calls = 0;
  const dependencies = { probe: async () => 10, key: async () => 'synthetic', recognize: async () => { calls += 1; return [{ start: 0.1, end: 1, text: '测试' }]; }, importRecording: async () => { throw new Error('simulated import interruption'); } };
  try {
    const store = await new JobStore(root, dependencies).init();
    const created = await store.create(task, true); await upload(store, created.id);
    const job = store.get(created.id);
    await store.start(job.id, true); await store.idle;
    assert.equal(calls, 2);
    const firstCache = store.path(job, 'transcripts', 'first.json');
    const corrupted = JSON.parse(await readFile(firstCache, 'utf8')); corrupted.sha256 = 'bad';
    await writeFile(firstCache, JSON.stringify(corrupted));
    await store.start(job.id, true); await store.idle;
    assert.equal(calls, 3);
    const web = join(root, 'public', 'private');
    await mkdir(join(web, job.recordingId), { recursive: true });
    await writeFile(join(web, job.recordingId, 'recording.json'), JSON.stringify({ version: 1, id: job.recordingId, title: '合成恢复记录', recordingDate: null, startedAt: null, timezone: null, duration: 22, processing: { mode: 'cloud', model: 'synthetic' }, segments: task.segments.map((segment) => ({ ...segment, audioUrl: `audio/${job.recordingId}/${segment.file}.wav` })), chapters: extractChapters(task, []), utterances: [], markers: [], warnings: [] }));
    await writeFile(join(web, 'recordings.json'), JSON.stringify({ recordings: [{ id: job.recordingId }, { id: 'old-recording' }] }));
    await store.start(job.id, true); await store.idle;
    assert.equal(store.get(job.id).state, 'completed');
    assert.equal(calls, 3);
    assert.equal(JSON.parse(await readFile(join(web, 'recordings.json'), 'utf8')).recordings.length, 2);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dead-process locks recover and live-process locks never overwrite an owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'limbo-lock-'));
  const path = join(root, 'lock');
  try {
    await writeFile(path, JSON.stringify({ pid: 2147483647, token: 'stale' }));
    const release = await acquireFileLock(path);
    await assert.rejects(acquireFileLock(path), /另一个进程/);
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cloud adapter handles milliseconds, silence and sanitized provider failures without real network', async (context) => {
  const mocked = context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
    assert.equal(JSON.parse(options.body).audio.data, Buffer.from('synthetic').toString('base64'));
    return new Response(JSON.stringify({ result: { utterances: [{ start_time: 430, end_time: 1750, text: '合成' }] } }), { headers: { 'X-Api-Status-Code': '20000000' } });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await recognizeAudio(Buffer.from('synthetic'), 'test-only', signal), [{ start: 0.43, end: 1.75, text: '合成' }]);
  mocked.mock.mockImplementation(async () => new Response(JSON.stringify({ result: { utterances: [{ start: 430, end: 1750, text: '合成' }] } }), { headers: { 'X-Api-Status-Code': '20000000' } }));
  assert.deepEqual(await recognizeAudio(Buffer.from('synthetic'), 'test-only', signal), [{ start: 0.43, end: 1.75, text: '合成' }]);
  mocked.mock.mockImplementation(async () => new Response('{}', { headers: { 'X-Api-Status-Code': '20000003' } }));
  assert.deepEqual(await recognizeAudio(Buffer.from('synthetic'), 'test-only', signal), []);
  mocked.mock.mockImplementation(async () => new Response('provider text must not be echoed', { status: 403, headers: { 'X-Api-Status-Code': '45000030' } }));
  await assert.rejects(recognizeAudio(Buffer.from('synthetic'), 'test-only', signal), (error) => error.message.includes('45000030') && !error.message.includes('provider text'));
});

test('full queue produces playable files and appends records while preserving the previous archive', async (context) => {
  if (spawnSync('ffmpeg', ['-version']).error || spawnSync('ffprobe', ['-version']).error) { context.skip('FFmpeg and FFprobe required'); return; }
  const root = await mkdtemp(join(tmpdir(), 'limbo-full-queue-'));
  const bytes = createDemoWav(0, 2);
  const synthetic = { recordingID: 'synthetic-first', markers: [0.5], segments: [{ file: 'one.m4a', offset: 0, duration: 2, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const store = await new JobStore(root, { key: async () => 'synthetic', recognize: async () => [{ start: 0.25, end: 1.75, text: '只有程序合成的测试数据。' }], importRecording }).init();
  try {
    const first = await store.create(synthetic, true);
    await store.upload(first.id, 'one.m4a', Readable.from([bytes]));
    await store.start(first.id, true); await store.idle;
    assert.equal(store.get(first.id).state, 'completed');
    const oldPath = join(root, 'public', 'private', first.recordingId, 'recording.json');
    const previous = await readFile(oldPath, 'utf8');
    const recording = JSON.parse(previous);
    assert.match((await readFile(join(root, 'public', recording.segments[0].audioUrl))).toString('ascii', 0, 4), /RIFF/);
    const second = await store.create({ ...synthetic, recordingID: 'synthetic-second' }, true);
    await store.upload(second.id, 'one.m4a', Readable.from([bytes]));
    await store.start(second.id, true); await store.idle;
    assert.equal(store.get(second.id).state, 'completed');
    assert.equal(await readFile(oldPath, 'utf8'), previous);
    const registry = JSON.parse(await readFile(join(root, 'public', 'private', 'recordings.json'), 'utf8'));
    assert.deepEqual(registry.recordings.map((entry) => entry.id), [first.recordingId, second.recordingId]);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('duration mismatch fails validation before any cloud request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'limbo-duration-'));
  let calls = 0;
  const store = await new JobStore(root, { probe: async () => 100, key: async () => 'synthetic', recognize: async () => { calls += 1; return []; } }).init();
  try {
    const created = await store.create(task, true); await upload(store, created.id);
    await store.start(created.id, true); await store.idle;
    assert.equal(calls, 0);
    assert.equal(store.get(created.id).state, 'failed');
    assert.match(store.get(created.id).error, /尚未上传到云端/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling during validation stays cancelled and never advances to cloud', async () => {
  const root = await mkdtemp(join(tmpdir(), 'limbo-cancel-validation-'));
  let releaseProbe;
  let enteredProbe;
  let calls = 0;
  const probeEntered = new Promise((resolveEntered) => { enteredProbe = resolveEntered; });
  const probeResult = new Promise((resolveProbe) => { releaseProbe = resolveProbe; });
  const store = await new JobStore(root, { probe: async () => { enteredProbe(); return probeResult; }, key: async () => 'synthetic', recognize: async () => { calls += 1; return []; } }).init();
  try {
    const created = await store.create(task, true); await upload(store, created.id);
    await store.start(created.id, true); await probeEntered;
    await store.cancel(created.id); releaseProbe(10); await store.idle;
    assert.equal(store.get(created.id).state, 'cancelled');
    assert.equal(calls, 0);
  } finally { releaseProbe(10); await store.close(); await rm(root, { recursive: true, force: true }); }
});