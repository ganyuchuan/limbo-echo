import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapters, locateSegment, parseTranscript, formatTime } from './timeline.js';
import { createSignalEnvelope } from './signal.js';
import { demo } from './demo.js';
import { createDemoWav } from '../scripts/demo-audio.mjs';
import { validateRecording, createPlaybackSession } from './recording.js';
import { normalizeUtterances, importRecording } from '../scripts/import-recording.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('ASR adapter converts raw cloud milliseconds once and preserves normalized seconds', () => {
  assert.deepEqual(normalizeUtterances({ result: { utterances: [{ start_time: 430, end_time: 1750, text: '测试' }] } }), [{ start: 0.43, end: 1.75, text: '测试' }]);
  assert.deepEqual(normalizeUtterances({ utterances: [{ start: 0.43, end: 1.75, text: '测试' }] }), [{ start: 0.43, end: 1.75, text: '测试' }]);
  assert.throws(() => normalizeUtterances({}), /Missing utterances/);
});

test('fixed importer registers multiple synthetic recordings without changing source', async (context) => {
  if (spawnSync('ffmpeg', ['-version']).error || spawnSync('ffprobe', ['-version']).error) { context.skip('FFmpeg and FFprobe are required'); return; }
  const root = await mkdtemp(join(tmpdir(), 'limbo-import-'));
  try {
    await mkdir(join(root, 'input'));
    await mkdir(join(root, 'transcripts'));
    await writeFile(join(root, 'input', 'full-uuid-first.wav'), createDemoWav(0, 2));
    await writeFile(join(root, 'task.json'), JSON.stringify({ segments: [{ file: 'full-uuid-first.wav', offset: 0, duration: 2 }], markers: [0.43] }));
    await writeFile(join(root, 'transcripts', 'full-uuid-first.json'), JSON.stringify({ utterances: [{ start: 0.43, end: 1.75, text: '合成测试' }] }));
    await writeFile(join(root, 'chapters.json'), JSON.stringify({ title: '合成测试', chapters: [{ ...chapters[0], end: 2 }] }));
    const options = { 'task-json': join(root, 'task.json'), 'audio-dir': join(root, 'input'), transcripts: join(root, 'transcripts'), chapters: join(root, 'chapters.json'), mode: 'local', model: 'synthetic-test', id: 'first' };
    const first = await importRecording(options, root);
    const second = await importRecording({ ...options, id: 'second' }, root);
    assert.equal(first.stats.success, 1);
    assert.equal(first.recording.utterances[0].start, 0.43);
    assert.notEqual(first.recording.segments[0].audioUrl, second.recording.segments[0].audioUrl);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'public', 'private', 'recordings.json'), 'utf8')).recordings, [{ id: 'first' }, { id: 'second' }]);
    assert.match(await readFile(join(first.output, 'recording_summary.md'), 'utf8'), /合成测试/);
    await assert.rejects(importRecording(options, root), /already exists/);
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts', 'check-public.mjs'), await readFile(new URL('../scripts/check-public.mjs', import.meta.url)));
    const publicCheck = spawnSync(process.execPath, [join(root, 'scripts', 'check-public.mjs')], { encoding: 'utf8' });
    assert.equal(publicCheck.status, 1);
    assert.match(publicCheck.stderr, /private data|recording-derived/);
    await writeFile(join(root, 'task.json'), JSON.stringify({ segments: [{ file: 'full-uuid-first.wav', offset: 0, duration: 2, sha256: 'incorrect' }] }));
    await assert.rejects(importRecording({ ...options, id: 'bad-hash' }, root), /SHA256 mismatch/);
    await writeFile(join(root, 'task.json'), JSON.stringify({ segments: [{ file: 'full-uuid-first.wav', offset: 0, duration: 2 }] }));
    await writeFile(join(root, 'transcripts', 'full-uuid-first.ERROR.txt'), 'synthetic failure');
    await assert.rejects(importRecording({ ...options, id: 'failed' }, root), /No successful transcripts/);
    await writeFile(join(root, 'task.json'), JSON.stringify({ segments: [{ file: '../escape.wav', offset: 0, duration: 2 }] }));
    await assert.rejects(importRecording({ ...options, id: 'unsafe' }, root), /Unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function syntheticRecording(id = 'test-recording') {
  return { version: 1, id, title: '测试录音', duration: 60, recordingDate: null, startedAt: null, timezone: null, processing: { mode: 'synthetic', model: 'generated' }, segments: demo.segments.map((segment) => ({ ...segment, audioUrl: `audio/${id}/${segment.file}` })), chapters: structuredClone(chapters), utterances: [{ start: 0.25, end: 1.75, text: '<img src=x onerror=alert(1)>' }], markers: [...demo.markers], warnings: [] };
}

test('recording contract preserves fractional timestamps and isolates audio by recording', () => {
  const first = validateRecording(syntheticRecording());
  const second = validateRecording(syntheticRecording('second'));
  assert.equal(first.utterances[0].start, 0.25);
  assert.notEqual(first.segments[0].audioUrl, second.segments[0].audioUrl);
  assert.match(first.utterances[0].text, /<img/);
  for (const patch of [
    { duration: NaN }, { markers: [61] }, { id: '../escape' },
    { segments: [{ file: 'bad.wav', offset: 0, duration: 60, audioUrl: 'https://example.com/audio.wav' }] },
    { chapters: [{ ...chapters[0], end: 61 }] },
  ]) assert.throws(() => validateRecording({ ...syntheticRecording(), ...patch }), /Invalid recording/);
});

test('switching recording invalidates pending playback and pauses old audio', () => {
  let pauses = 0;
  const session = createPlaybackSession({ pause() { pauses += 1; } });
  const old = session.invalidate();
  const latest = session.invalidate();
  assert.equal(session.current(old), false);
  assert.equal(session.current(latest), true);
  assert.equal(pauses, 2);
});

test('all demo chapter starts resolve to synthetic audio', () => {
  for (const chapter of chapters) {
    const result = locateSegment(demo.segments, chapter.start, chapter.end);
    assert.ok(result);
    assert.ok(result.segment.duration >= 1);
    assert.match(result.segment.file, /^demo-[a-z]+\.wav$/);
    assert.ok(result.localTime < result.segment.duration);
  }
});
test('slice boundaries, gaps and tiny slices resolve forward', () => {
  const segments = [{ offset: 0, duration: 10 }, { offset: 11, duration: 0.04 }, { offset: 13, duration: 10 }];
  assert.equal(locateSegment(segments, 10).time, 13);
  assert.equal(locateSegment(segments, 14).localTime, 1);
  assert.equal(locateSegment(segments, 10, 12), null);
  assert.equal(locateSegment(segments, 23), null);
  assert.equal(locateSegment([{ offset: 0, duration: 5, playable: false }, { offset: 7, duration: 3 }], 0).time, 7);
});
test('chapters are continuous and transcript timestamps are parsed', () => {
  chapters.slice(1).forEach((chapter, index) => assert.equal(chapters[index].end, chapter.start));
  assert.deepEqual(parseTranscript('**[00:00:08]**　示例文本。'), [{ time: 8, text: '示例文本。' }]);
  assert.equal(formatTime(3661), '01:01:01');
});
test('summary quotations are excluded from synchronized transcript', () => {
  const markdown = '**[00:00:08]** 摘要引用。\n# 六、完整分段整理稿\n**[00:00:00]** 示例开始。\n**[00:00:08]** 示例原文。';
  const cues = parseTranscript(markdown);
  assert.equal(cues.filter((cue) => cue.time === 8).length, 1);
  cues.slice(1).forEach((cue, index) => assert.ok(cue.time >= cues[index].time));
});
test('demo WAV is deterministic mono PCM with sound and silent gaps', () => {
  const buffer = createDemoWav(0, 1);
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt16LE(22), 1);
  assert.equal(buffer.readUInt32LE(24), 16000);
  assert.equal(buffer.length, 44 + 32000);
  assert.ok(buffer.subarray(44, 16044).some((value) => value !== 0));
  assert.ok(buffer.subarray(44 + 24000).every((value) => value === 0));
  assert.deepEqual(buffer, createDemoWav(0, 1));
});
test('quiet speech produces visible movement while silence and pause stay flat', () => {
  const envelope = createSignalEnvelope();
  assert.equal(envelope(0, false, 0), 0);
  let quietSpeech;
  for (let frame = 1; frame <= 30; frame += 1) quietSpeech = envelope(0.01, true, frame * 1000 / 60);
  assert.ok(quietSpeech > 0.6);
  const loudSpeech = envelope(0.05, true, 600);
  assert.ok(loudSpeech > quietSpeech);
  assert.ok(loudSpeech <= 1.8);
  let silence;
  for (let frame = 1; frame <= 120; frame += 1) silence = envelope(0.001, true, 600 + frame * 1000 / 60);
  assert.ok(silence < 0.001);
  assert.equal(envelope(0.05, false, 2700), 0);
});