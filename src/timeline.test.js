import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapters, locateSegment, parseTranscript, formatTime } from './timeline.js';
import { createSignalEnvelope } from './signal.js';
import { demo } from './demo.js';
import { createDemoWav } from '../scripts/demo-audio.mjs';

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