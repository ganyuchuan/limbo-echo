export const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

export function validateRecording(input) {
  const fail = (message) => { throw new Error(`Invalid recording: ${message}`); };
  const seconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const text = (value) => typeof value === 'string';
  if (!input || input.version !== 1 || !safeId(input.id) || !text(input.title)) fail('version, id or title');
  if (!seconds(input.duration) || input.duration === 0) fail('duration');
  if (!['local', 'cloud', 'synthetic'].includes(input.processing?.mode) || !text(input.processing.model)) fail('processing');
  if (input.recordingDate !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(input.recordingDate) || !Number.isFinite(Date.parse(input.recordingDate)))) fail('recordingDate');
  if (input.startedAt !== null && (!text(input.startedAt) || !/(Z|[+-]\d{2}:\d{2})$/.test(input.startedAt) || !Number.isFinite(Date.parse(input.startedAt)))) fail('startedAt');
  if (input.timezone !== null && !text(input.timezone)) fail('timezone');
  if (input.timezone) { try { new Intl.DateTimeFormat('zh-CN', { timeZone: input.timezone }); } catch { fail('timezone'); } }
  for (const key of ['segments', 'chapters', 'utterances', 'markers', 'warnings']) if (!Array.isArray(input[key])) fail(key);
  const files = new Set();
  let previousEnd = 0;
  for (const segment of input.segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment.file) || files.has(segment.file)) fail('segment file');
    files.add(segment.file);
    if (!seconds(segment.offset) || !seconds(segment.duration) || segment.offset < previousEnd) fail('segment timing or overlap');
    previousEnd = segment.offset + segment.duration;
    if (segment.playable !== false && (typeof segment.audioUrl !== 'string' || !segment.audioUrl.startsWith(`audio/${input.id}/`) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment.audioUrl.slice(`audio/${input.id}/`.length)))) fail('audioUrl');
  }
  if (!input.segments.length || Math.abs(previousEnd - input.duration) > 0.001) fail('manifest duration');
  const chapterIds = new Set();
  previousEnd = 0;
  for (const chapter of input.chapters) {
    if (!safeId(chapter.id) || chapterIds.has(chapter.id)) fail('chapter id');
    chapterIds.add(chapter.id);
    if (!seconds(chapter.start) || !seconds(chapter.end) || chapter.end <= chapter.start || chapter.start < previousEnd || chapter.end > input.duration) fail('chapter timing');
    for (const key of ['title', 'tag', 'icon', 'location', 'description']) if (!text(chapter[key])) fail(`chapter ${key}`);
    if (!Array.isArray(chapter.bullets) || !chapter.bullets.every(text)) fail('chapter bullets');
    previousEnd = chapter.end;
  }
  if (!input.chapters.length) fail('chapters must be prepared before import');
  let previousStart = 0;
  for (const cue of input.utterances) {
    if (!seconds(cue.start) || !seconds(cue.end) || cue.end < cue.start || cue.start < previousStart || cue.end > input.duration || !text(cue.text)) fail('utterance');
    previousStart = cue.start;
  }
  if (!input.markers.every((value) => seconds(value) && value <= input.duration) || !input.warnings.every(text)) fail('markers or warnings');
  return input;
}

export function createPlaybackSession(audio) {
  let revision = 0;
  return {
    invalidate() { revision += 1; audio.pause(); return revision; },
    current(token) { return revision === token; },
  };
}