import { createPixelWave } from './pixel-wave';
import { createSignalEnvelope } from './signal';
import { createIcons, Bike, MapPin, Dumbbell, Footprints, MessagesSquare, Utensils, Play, Pause, SkipBack, SkipForward, RotateCcw, RotateCw, Volume2, VolumeX, Search, ArrowUpRight, Headphones, Bookmark, ChevronRight, AudioLines, Github } from 'lucide';
import { demo } from './demo';
import { chapters as demoChapters, locateSegment, formatTime } from './timeline';
import { validateRecording, createPlaybackSession, safeId } from './recording';
import './style.css';
import './monochrome.css';

let task = demo;
let transcript = demo.transcript;
let chapters = demoChapters;
const icons = { Bike, MapPin, Dumbbell, Footprints, MessagesSquare, Utensils, Play, Pause, SkipBack, SkipForward, RotateCcw, RotateCw, Volume2, VolumeX, Search, ArrowUpRight, Headphones, Bookmark, ChevronRight, AudioLines, Github };
const iconNames = new Set(Object.keys(icons).map((name) => name.replace(/[A-Z]/g, (letter, index) => `${index ? '-' : ''}${letter.toLowerCase()}`)));
const icon = (name) => `<i data-lucide="${iconNames.has(name) ? name : 'audio-lines'}" aria-hidden="true"></i>`;
const refreshIcons = () => createIcons({ icons, attrs: { 'stroke-width': 1.5 } });
let selected = 0;
let current = 0;
let activeSegment = null;
let activeTab = 'transcript';
let activeCue = -1;
let context;
let analyser;
let samples;
let loading = false;
const audio = new Audio();
const playbackSession = createPlaybackSession(audio);
audio.preload = 'metadata';

document.querySelector('#app').innerHTML = `
  <header class="header">
    <a class="brand" href="./" aria-label="Limbo Echo 首页"><span class="brand-mark">[<span>*</span>]</span><strong>LIMBO<span class="brand-slash">/</span>ECHO</strong><span class="brand-caption">把一天的声音，整理成记忆。</span></a>
    <div class="header-right"><a class="github-link" href="https://github.com/ganyuchuan" target="_blank" rel="noopener noreferrer" aria-label="访问 GitHub：ganyuchuan" title="GitHub · ganyuchuan">${icon('github')}</a></div>
  </header>
  <main>
    <section class="page-heading">
      <div><div class="eyebrow">AUDIO JOURNAL <span>//</span> DEMO</div><h1>${demo.title}<span class="cursor">_</span></h1><p class="day-meta">SYNTHETIC <span>/</span> 无真实录音 <span>/</span> 相对时码</p></div>
      <div class="record-stats"><div><strong>${String(Math.floor(demo.duration / 60)).padStart(2, '0')}<span>m</span> ${String(demo.duration % 60).padStart(2, '0')}<span>s</span></strong><small>GENERATED</small></div><span class="stats-divider">/</span><div><strong>${String(chapters.length).padStart(2, '0')}</strong><small>CHAPTERS</small></div><a class="profile-logo" href="https://limbo.ganyuchuan.cn" target="_blank" rel="noopener noreferrer" aria-label="访问 Agent Limbo" title="Agent Limbo"><img src="${import.meta.env.BASE_URL}limbo-logo.png" alt="Agent Limbo 像素点赞标志" width="128" height="128" /></a></div>
    </section>
    <div class="recording-toolbar"><label for="recording-select">录音档案</label><select id="recording-select" aria-label="选择录音档案"><option value="synthetic-demo">演示档案</option></select><span id="recording-method">SYNTHETIC</span></div>
    <p id="recording-warnings" class="error" role="status" hidden></p>
    <div class="workspace">
      <section class="journal" aria-labelledby="timeline-title">
        <div class="section-bar"><h2 id="timeline-title"><span class="accent">01</span> / 演示时间轴</h2><span class="small-code">${chapters.length} ENTRIES</span></div>
        <label class="search">${icon('search')}<input id="search" type="search" placeholder="查找这一天的片段…" aria-label="搜索摘要" /><span>/</span></label>
        <div class="timeline" id="timeline"></div><p class="empty" id="empty" hidden>没有匹配的片段。</p>
        <div class="timeline-end"><span>[ END OF DAY ]</span><span>每一天，都值得被记住。</span></div>
      </section>
      <aside class="listen" aria-label="音频播放器">
        <div class="section-bar"><h2><span class="accent">02</span> / 回到那一刻</h2><span class="small-code">AUDIO PLAYER</span></div>
        <div class="player">
          <div class="player-top"><span id="chapter-number">TRACK 01 / ${String(chapters.length).padStart(2, '0')}</span><span class="pill" id="player-status">[ READY ]</span></div>
          <div class="player-title"><div class="track-icon" id="track-icon">${icon(chapters[0].icon)}</div><div><p id="track-label">${chapters[0].tag}</p><h3 id="track-title">${chapters[0].title}</h3></div></div>
          <div class="wave-stage"><div class="wave-coordinate top-left">+ AUDIO SIGNAL</div><div class="wave-coordinate top-right">LIVE / <span id="signal-level">00</span></div><div id="siri-wave" aria-label="随音频音量变化的 Siri 声纹"></div><div class="wave-baseline" aria-hidden="true">· · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·</div><div class="wave-coordinate bottom-left" id="wave-state">STANDBY_</div><div class="wave-coordinate bottom-right">L ─── R</div></div>
          <div class="scrubber"><input id="progress" type="range" min="0" max="${chapters[0].end}" value="0" step="0.1" aria-label="章节播放进度" /><div class="time-labels"><span id="elapsed">00:00:00</span><span id="duration">${formatTime(chapters[0].end)}</span></div></div>
          <div class="transport"><button class="icon-button" id="previous" title="上一章节" aria-label="上一章节">${icon('skip-back')}</button><button class="icon-button seek-button" id="back" title="后退 15 秒" aria-label="后退 15 秒">${icon('rotate-ccw')}<span>15</span></button><button class="play-button" id="play" title="播放" aria-label="播放">${icon('play')}</button><button class="icon-button seek-button" id="forward" title="前进 15 秒" aria-label="前进 15 秒">${icon('rotate-cw')}<span>15</span></button><button class="icon-button" id="next" title="下一章节" aria-label="下一章节">${icon('skip-forward')}</button></div>
          <div class="player-options"><div class="volume"><button class="icon-button" id="mute" title="静音" aria-label="静音">${icon('volume-2')}</button><input id="volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="音量" /></div><label class="speed-label"><select id="speed" aria-label="播放速度"><option value="0.75">0.75×</option><option value="1" selected>1.0×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2.0×</option></select></label></div>
          <p id="error" class="error" role="alert" hidden></p>
          <div class="source-strip">${icon('headphones')}<span id="source-time">00:00 → 00:20</span><span>程序合成音频</span></div>
        </div>
        <section class="notes"><div class="tabs" role="tablist" aria-label="演示详情"><button id="transcript-tab" role="tab" aria-selected="true" aria-controls="cue-list" data-tab="transcript">${icon('audio-lines')}示例文本</button><button id="markers-tab" role="tab" aria-selected="false" aria-controls="cue-list" data-tab="markers">${icon('bookmark')}演示标记 <span>${demo.markers.length}</span></button></div><div class="cue-heading"><span id="cue-label">DEMO / 当前片段</span><span class="text-dim">[ SYNTHETIC ]</span></div><div id="cue-list" class="cue-list" role="tabpanel" aria-labelledby="transcript-tab"></div><p class="transcript-note">* 音频与文字均为虚构示例，不包含真实录音。</p></section>
        <div class="archive-note"><span>[i]</span><p>Limbo Echo · 合成演示<br><span>不包含个人数据，音频由本机程序生成。</span></p>${icon('arrow-up-right')}</div>
      </aside>
    </div>
    <footer><span>+ ────────────────────── +</span><span>LIMBO / ECHO <span class="accent">/</span> OPEN DEMO</span><span>KEEP THE ORDINARY.</span></footer>
  </main>`;

const element = (id) => document.getElementById(id);
function renderTimeline(query = '') {
  const normalized = query.trim().toLowerCase();
  element('timeline').replaceChildren();
  chapters.forEach((chapter, index) => {
    if (normalized && ![chapter.title, chapter.description, chapter.location, ...chapter.bullets].join(' ').toLowerCase().includes(normalized)) return;
    const seconds = chapter.end - chapter.start;
    const durationLabel = seconds < 60 ? `${Math.round(seconds)} SEC` : `${Math.round(seconds / 60)} MIN`;
    const article = document.createElement('article');
    article.className = `entry ${index === selected ? 'selected' : ''}`;
    article.innerHTML = `<div class="entry-rail"><span class="entry-time"></span><span class="entry-node">${String(index + 1).padStart(2, '0')}</span><span class="entry-line"></span></div><button class="entry-body" data-chapter="${index}" aria-pressed="${index === selected}"><div class="entry-kicker"><span></span><span class="entry-duration">${durationLabel}</span></div><div class="entry-title"><h3></h3><span class="entry-play">${icon(index === selected && !audio.paused ? 'audio-lines' : 'play')}</span></div><p class="entry-location">${icon(chapter.icon)}<span class="location-name"></span><span class="location-time"></span></p><p class="entry-description"></p><ul></ul><div class="entry-bottom"><span>${index === selected ? '[ SELECTED ]' : `[ ${String(index + 1).padStart(2, '0')} ]`}</span><span>${index === selected ? (audio.paused ? '已选片段' : '正在回放') : '回听片段'} ${icon('chevron-right')}</span></div></button>`;
    article.querySelector('.entry-time').textContent = displayTime(chapter.start);
    article.querySelector('.entry-kicker > span').textContent = chapter.tag;
    article.querySelector('h3').textContent = chapter.title;
    article.querySelector('.location-name').textContent = chapter.location;
    article.querySelector('.location-time').textContent = `${displayTime(chapter.start)} → ${displayTime(chapter.end)}`;
    article.querySelector('.entry-description').textContent = chapter.description;
    chapter.bullets.forEach((bullet) => {
      const item = document.createElement('li');
      item.textContent = `+ ${bullet}`;
      article.querySelector('ul').append(item);
    });
    element('timeline').append(article);
  });
  element('empty').hidden = Boolean(element('timeline').children.length);
  refreshIcons();
}

function renderCues() {
  const chapter = chapters[selected];
  const entries = activeTab === 'transcript' ? transcript.filter((cue) => cue.time >= chapter.start && cue.time < chapter.end) : task.markers.map((time, index) => ({ time, text: `标记 ${String(index + 1).padStart(2, '0')} / ${chapters.find((entry) => time >= entry.start && time < entry.end)?.title || '录音片段'}` }));
  element('cue-list').replaceChildren();
  entries.forEach((cue) => {
    const button = document.createElement('button');
    button.className = 'cue';
    button.dataset.time = cue.time;
    const timestamp = document.createElement('span');
    timestamp.textContent = formatTime(cue.time);
    const text = document.createElement('span');
    text.textContent = cue.text;
    button.append(timestamp, text);
    element('cue-list').append(button);
  });
  if (!entries.length) element('cue-list').textContent = '此片段没有可辨认的原文。';
  activeCue = -1;
  updateProgress();
}

function selectChapter(index) {
  selected = Math.max(0, Math.min(chapters.length - 1, index));
  const chapter = chapters[selected];
  element('chapter-number').textContent = `TRACK ${String(selected + 1).padStart(2, '0')} / ${String(chapters.length).padStart(2, '0')}`;
  element('track-label').textContent = chapter.tag;
  element('track-title').textContent = chapter.title;
  element('track-icon').innerHTML = icon(chapter.icon);
  element('source-time').textContent = `${displayTime(chapter.start)} → ${displayTime(chapter.end)}`;
  element('progress').max = chapter.end - chapter.start;
  element('duration').textContent = formatTime(chapter.end - chapter.start);
  current = chapter.start;
  renderTimeline(element('search').value);
  renderCues();
}

async function initAudio() {
  if (!context) {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaElementSource(audio).connect(analyser);
    analyser.connect(context.destination);
    samples = new Uint8Array(analyser.fftSize);
  }
  if (context.state === 'suspended') await context.resume();
}

async function seek(time, shouldPlay = !audio.paused) {
  const token = playbackSession.invalidate();
  const chapter = chapters[selected];
  const bounded = Math.max(chapter.start, Math.min(time, chapter.end));
  if (bounded >= chapter.end) { audio.pause(); current = chapter.end; updateProgress(); return; }
  const target = locateSegment(task.segments, bounded, chapter.end);
  if (!target) { audio.pause(); current = chapter.end; updateProgress(); return; }
  loading = true;
  element('error').hidden = true;
  current = target.time;
  updateProgress();
  try {
    if (shouldPlay) await initAudio();
    if (!playbackSession.current(token)) return;
    if (activeSegment?.file !== target.segment.file) {
      audio.pause();
      activeSegment = target.segment;
      audio.src = `${import.meta.env.BASE_URL}${target.segment.audioUrl || `audio/${target.segment.file}`}`;
      audio.load();
    }
    audio.currentTime = target.localTime;
    audio.playbackRate = Number(element('speed').value);
    if (shouldPlay) await audio.play();
  } catch (error) {
    if (playbackSession.current(token) && error.name !== 'AbortError') {
      audio.pause();
      element('error').textContent = '音频无法播放，请检查本地音频文件后重试。';
      element('error').hidden = false;
    }
  } finally {
    if (playbackSession.current(token)) { loading = false; updatePlayback(); }
  }
}

function updatePlayback() {
  const playing = !audio.paused;
  element('play').innerHTML = icon(playing ? 'pause' : 'play');
  element('play').setAttribute('aria-label', playing ? '暂停' : '播放');
  element('play').title = playing ? '暂停' : '播放';
  element('player-status').textContent = playing ? '[ PLAYING ]' : '[ PAUSED ]';
  element('player-status').classList.toggle('playing', playing);
  element('wave-state').textContent = playing ? 'LISTENING_' : 'STANDBY_';
  renderTimeline(element('search').value);
}

function updateProgress() {
  const chapter = chapters[selected];
  const elapsed = Math.max(0, current - chapter.start);
  element('progress').value = elapsed;
  element('progress').style.setProperty('--progress', `${elapsed / (chapter.end - chapter.start) * 100}%`);
  element('elapsed').textContent = formatTime(elapsed);
  const cues = [...element('cue-list').querySelectorAll('.cue')];
  const index = cues.findLastIndex((cue) => Number(cue.dataset.time) <= current);
  if (index !== activeCue) {
    cues.forEach((cue, cueIndex) => { cue.classList.toggle('active', cueIndex === index); if (cueIndex === index) cue.setAttribute('aria-current', 'true'); else cue.removeAttribute('aria-current'); });
    if (index >= 0) element('cue-list').scrollTo({ top: cues[index].offsetTop - element('cue-list').offsetTop - 36, behavior: 'smooth' });
    activeCue = index;
  }
}

audio.addEventListener('timeupdate', () => {
  if (loading || !activeSegment) return;
  current = activeSegment.offset + audio.currentTime;
  if (current >= chapters[selected].end) { current = chapters[selected].end; audio.pause(); }
  else if (current >= activeSegment.offset + activeSegment.duration) { seek(activeSegment.offset + activeSegment.duration, !audio.paused || audio.ended); return; }
  updateProgress();
});
audio.addEventListener('ended', () => {
  if (!loading && activeSegment) seek(activeSegment.offset + activeSegment.duration, true);
});
audio.addEventListener('play', updatePlayback);
audio.addEventListener('pause', updatePlayback);
audio.addEventListener('error', () => { if (audio.error) { audio.pause(); element('error').textContent = '音频读取失败。请确认录音文件可用。'; element('error').hidden = false; } });

element('timeline').addEventListener('click', (event) => {
  const button = event.target.closest('[data-chapter]');
  if (button) { selectChapter(Number(button.dataset.chapter)); seek(chapters[selected].start, true); }
});
element('search').addEventListener('input', (event) => renderTimeline(event.target.value));
element('play').addEventListener('click', () => { if (!audio.paused) audio.pause(); else seek(current >= chapters[selected].end ? chapters[selected].start : current, true); });
element('previous').addEventListener('click', () => { selectChapter(selected === 0 ? 0 : selected - 1); seek(chapters[selected].start, true); });
element('next').addEventListener('click', () => { selectChapter(selected === chapters.length - 1 ? selected : selected + 1); seek(chapters[selected].start, true); });
element('back').addEventListener('click', () => seek(current - 15));
element('forward').addEventListener('click', () => seek(current + 15));
element('progress').addEventListener('input', (event) => seek(chapters[selected].start + Number(event.target.value)));
element('speed').addEventListener('change', (event) => { audio.defaultPlaybackRate = Number(event.target.value); audio.playbackRate = Number(event.target.value); });
element('volume').addEventListener('input', (event) => { audio.volume = Number(event.target.value); audio.muted = audio.volume === 0; updateVolume(); });
element('mute').addEventListener('click', () => { audio.muted = !audio.muted; updateVolume(); });
function updateVolume() {
  element('mute').innerHTML = icon(audio.muted ? 'volume-x' : 'volume-2');
  element('mute').setAttribute('aria-label', audio.muted ? '取消静音' : '静音');
  element('mute').title = audio.muted ? '取消静音' : '静音';
  refreshIcons();
}
document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
  activeTab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach((tab) => tab.setAttribute('aria-selected', tab === button));
  element('cue-label').textContent = activeTab === 'transcript' ? 'TRANSCRIPT / 当前片段' : 'BOOKMARKS / 全部标记';
  element('cue-list').setAttribute('aria-labelledby', button.id);
  renderCues();
}));
element('cue-list').addEventListener('click', (event) => {
  const cue = event.target.closest('[data-time]');
  if (!cue) return;
  const time = Number(cue.dataset.time);
  const index = chapters.findIndex((chapter) => time >= chapter.start && time < chapter.end);
  if (index !== selected && index >= 0) selectChapter(index);
  seek(time, true);
});

const waveContainer = element('siri-wave');
const wave = createPixelWave(waveContainer);
const signalEnvelope = createSignalEnvelope();
let animationFrame;
function animateSignal() {
  let rms = 0;
  if (analyser && !audio.paused) {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
    rms = Math.sqrt(sum / samples.length);
  }
  const amplitude = signalEnvelope(rms, !audio.paused && !loading, performance.now());
  wave.setAmplitude(amplitude);
  wave.render();
  element('signal-level').textContent = String(Math.min(99, Math.round(rms * 300))).padStart(2, '0');
  waveContainer.dataset.amplitude = amplitude.toFixed(3);
  animationFrame = requestAnimationFrame(animateSignal);
}
function displayTime(seconds) {
  if (!task.startedAt) return formatTime(seconds);
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: task.timezone || 'UTC', hour12: false }).format(new Date(Date.parse(task.startedAt) + seconds * 1000));
}

const recordings = new Map([[demo.id, demo]]);
function switchRecording(id) {
  const next = recordings.get(id);
  if (!next) return;
  playbackSession.invalidate();
  loading = false;
  activeSegment = null;
  audio.removeAttribute('src');
  audio.load();
  task = next;
  chapters = next.chapters || demoChapters;
  transcript = next.utterances ? next.utterances.map((cue) => ({ ...cue, time: cue.start })) : next.transcript;
  activeTab = 'transcript';
  activeCue = -1;
  current = 0;
  wave.setAmplitude(signalEnvelope(0, false, performance.now()));
  element('search').value = '';
  element('error').hidden = true;
  const synthetic = next.id === demo.id;
  const setText = (selector, value) => { document.querySelector(selector).textContent = value; };
  setText('h1', next.title);
  setText('.eyebrow', synthetic ? 'AUDIO JOURNAL // DEMO' : 'AUDIO JOURNAL // PRIVATE');
  setText('.day-meta', `${next.recordingDate || '日期未确认'} / ${next.startedAt ? '录制时间' : '相对时码'}`);
  setText('.record-stats > div:first-child strong', formatTime(next.duration));
  setText('.record-stats > div:first-child small', synthetic ? 'GENERATED' : 'RECORDED');
  setText('.record-stats > div:nth-of-type(2) strong', String(chapters.length).padStart(2, '0'));
  setText('#timeline-title', '01 / 录音时间轴');
  setText('.journal .small-code', `${chapters.length} ENTRIES`);
  setText('.source-strip > span:last-child', synthetic ? '程序合成音频' : '本地录音缓存');
  element('transcript-tab').replaceChildren();
  element('transcript-tab').insertAdjacentHTML('afterbegin', icon('audio-lines'));
  element('transcript-tab').append(synthetic ? '示例文本' : '逐句原文');
  element('markers-tab').replaceChildren();
  element('markers-tab').insertAdjacentHTML('afterbegin', icon('bookmark'));
  element('markers-tab').append(`书签 ${next.markers.length}`);
  document.querySelectorAll('[data-tab]').forEach((tab) => tab.setAttribute('aria-selected', tab.dataset.tab === 'transcript'));
  element('cue-list').setAttribute('aria-labelledby', 'transcript-tab');
  element('cue-label').textContent = 'TRANSCRIPT / 当前片段';
  setText('.cue-heading .text-dim', synthetic ? '[ SYNTHETIC ]' : '[ PRIVATE ]');
  setText('.transcript-note', synthetic ? '音频与文字均为虚构示例。' : next.processing.mode === 'cloud' ? '转写使用云端服务，音频曾上传第三方；当前播放使用本地缓存。' : '录音在本机转写，当前播放使用本地缓存。');
  setText('.archive-note p', `${next.title} / ${synthetic ? '合成演示' : next.id}`);
  setText('footer > span:nth-child(2)', synthetic ? 'LIMBO / ECHO / OPEN DEMO' : 'LIMBO / ECHO / PRIVATE RECORDING');
  element('recording-method').textContent = synthetic ? 'SYNTHETIC' : `${next.processing.mode.toUpperCase()} / ${next.processing.model}`;
  element('recording-warnings').textContent = (next.warnings || []).join('；');
  element('recording-warnings').hidden = !next.warnings?.length;
  selectChapter(0);
  updatePlayback();
  window.scrollTo(0, 0);
}

async function loadRecordings() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}private/recordings.json`, { cache: 'no-store' });
    if (response.status === 404 || response.headers.get('content-type')?.includes('text/html')) return;
    if (!response.ok) throw new Error('无法读取录音列表');
    const manifest = await response.json();
    if (!Array.isArray(manifest.recordings)) throw new Error('录音列表格式错误');
    let newest;
    for (const entry of manifest.recordings) {
      if (!safeId(entry.id) || recordings.has(entry.id)) throw new Error('录音 ID 无效或重复');
      const result = await fetch(`${import.meta.env.BASE_URL}private/${entry.id}/recording.json`, { cache: 'no-store' });
      if (!result.ok) throw new Error('无法读取录音数据');
      const recording = validateRecording(await result.json());
      if (recording.id !== entry.id) throw new Error('录音 ID 不一致');
      recordings.set(entry.id, recording);
      element('recording-select').add(new Option(`${recording.recordingDate || '日期未确认'} / ${recording.title}`, entry.id));
      newest = entry.id;
    }
    if (newest) { element('recording-select').value = newest; switchRecording(newest); }
  } catch (error) {
    element('recording-warnings').textContent = `录音导入失败：${error.message}`;
    element('recording-warnings').hidden = false;
  }
}
element('recording-select').addEventListener('change', (event) => switchRecording(event.target.value));
selectChapter(0);
animateSignal();
loadRecordings();
window.addEventListener('pagehide', () => { playbackSession.invalidate(); cancelAnimationFrame(animationFrame); context?.close(); wave.dispose(); });