export { chapters } from './demo.js';

export function locateSegment(segments, time, end = Infinity) {
  const segment = segments.find((entry) => entry.playable !== false && entry.duration >= 1 && entry.offset + entry.duration > time && entry.offset < end);
  return segment ? { segment, localTime: Math.max(0, time - segment.offset), time: Math.max(time, segment.offset) } : null;
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function wallTime(seconds) {
  return formatTime(seconds).slice(3);
}

export function parseTranscript(markdown) {
  const transcriptStart = markdown.indexOf('# 六、完整分段整理稿');
  const source = transcriptStart >= 0 ? markdown.slice(transcriptStart) : markdown;
  return [...source.matchAll(/\*\*\[(\d{2}):(\d{2}):(\d{2})\]\*\*\s*([^\n]+)/g)].map((match) => ({ time: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]), text: match[4].trim() }));
}