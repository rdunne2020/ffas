import type { Clip, ClipEdge, MediaFile, Job, EditRequest } from '../shared/model.js';
import { errorMessage, isRecord, isClip, isOutputFormat, isQuality, isResolution, parseMediaFile, parseJob, parseHealth, parseList } from '../shared/model.js';

function element<T extends HTMLElement>(id: string, constructor: { new(): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof constructor)) throw new Error(`Missing or incorrect editor element: ${id}`);
  return value;
}
const elements = {
  'source-title': element('source-title', HTMLHeadingElement),
  'result-title': element('result-title', HTMLHeadingElement),
  'engine': element('engine', HTMLElement),
  'file-count': element('file-count', HTMLElement),
  'upload-button': element('upload-button', HTMLButtonElement),
  'file-input': element('file-input', HTMLInputElement),
  'upload-status': element('upload-status', HTMLElement),
  'file-list': element('file-list', HTMLElement),
  'library-empty': element('library-empty', HTMLElement),
  'source-kind': element('source-kind', HTMLElement),
  'drop-zone': element('drop-zone', HTMLElement),
  'empty-view': element('empty-view', HTMLElement),
  'browse': element('browse', HTMLButtonElement),
  'media-view': element('media-view', HTMLElement),
  'source-player': element('source-player', HTMLVideoElement),
  'audio-art': element('audio-art', HTMLElement),
  'audio-name': element('audio-name', HTMLElement),
  'viewer-badge': element('viewer-badge', HTMLElement),
  'play': element('play', HTMLButtonElement),
  'current-time': element('current-time', HTMLElement),
  'total-time': element('total-time', HTMLElement),
  'play-edit': element('play-edit', HTMLButtonElement),
  'source-info': element('source-info', HTMLElement),
  'playback-notice': element('playback-notice', HTMLElement),
  'timeline': element('timeline', HTMLElement),
  'timeline-track': element('timeline-track', HTMLElement),
  'timeline-clips': element('timeline-clips', HTMLElement),
  'selection': element('selection', HTMLElement),
  'start-handle': element('start-handle', HTMLButtonElement),
  'end-handle': element('end-handle', HTMLButtonElement),
  'playhead': element('playhead', HTMLElement),
  'timeline-empty': element('timeline-empty', HTMLElement),
  'ruler': element('ruler', HTMLElement),
  'scrubber': element('scrubber', HTMLInputElement),
  'clip-start': element('clip-start', HTMLInputElement),
  'mark-in': element('mark-in', HTMLButtonElement),
  'clip-end': element('clip-end', HTMLInputElement),
  'mark-out': element('mark-out', HTMLButtonElement),
  'split-clip': element('split-clip', HTMLButtonElement),
  'add-clip': element('add-clip', HTMLButtonElement),
  'clip-list': element('clip-list', HTMLElement),
  'clip-count': element('clip-count', HTMLElement),
  'sequence-duration': element('sequence-duration', HTMLElement),
  'settings': element('settings', HTMLFieldSetElement),
  'format': element('format', HTMLSelectElement),
  'format-description': element('format-description', HTMLElement),
  'quality': element('quality', HTMLSelectElement),
  'resolution': element('resolution', HTMLSelectElement),
  'flip-h': element('flip-h', HTMLInputElement),
  'flip-v': element('flip-v', HTMLInputElement),
  'mute': element('mute', HTMLInputElement),
  'output-duration': element('output-duration', HTMLElement),
  'export-description': element('export-description', HTMLElement),
  'export': element('export', HTMLButtonElement),
  'render-preview': element('render-preview', HTMLButtonElement),
  'job-count': element('job-count', HTMLElement),
  'jobs-empty': element('jobs-empty', HTMLElement),
  'job-list': element('job-list', HTMLElement),
  'toast': element('toast', HTMLElement),
  'result-dialog': element('result-dialog', HTMLDialogElement),
  'close-dialog': element('close-dialog', HTMLButtonElement),
  'result-player': element('result-player', HTMLVideoElement),
  'result-notice': element('result-notice', HTMLElement),
  'result-download': element('result-download', HTMLAnchorElement),
};
function $<K extends keyof typeof elements>(id: K): typeof elements[K] { return elements[id]; }
interface EditorState {
  files: MediaFile[];
  source: MediaFile | null;
  clips: Clip[];
  selected: number;
  jobs: Job[];
  sequencePlaying: boolean;
  sequenceIndex: number;
  uploading: boolean;
  pendingPreview: string | null;
  engine: boolean;
  submitting: boolean;
}
const state: EditorState = { files: [], source: null, clips: [], selected: 0, jobs: [], sequencePlaying: false, sequenceIndex: 0, uploading: false, pendingPreview: null, engine: false, submitting: false };
const player = $('source-player');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const time = (seconds: number) => { const value = Math.max(0, Number(seconds) || 0); const hours = Math.floor(value / 3600); return `${hours ? String(hours).padStart(2, '0') + ':' : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`; };
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
const escape = (text: string) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
function toast(message: string) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
async function api<T>(url: string, parse: (value: unknown) => T, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data: unknown = await res.json();
  if (!res.ok) throw new Error(isRecord(data) && typeof data.error === 'string' ? data.error : 'The request failed.');
  return parse(data);
}
const post = (url: string, data: unknown = {}): Promise<Job> => api(url, parseJob, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
function renderLibrary() {
  $('file-count').textContent = String(state.files.length);
  $('library-empty').hidden = state.files.length > 0;
  $('file-list').innerHTML = state.files.map(file => `<button class="file-item ${state.source?.id === file.id ? 'selected' : ''}" data-file="${file.id}" aria-pressed="${state.source?.id === file.id}" title="${escape(file.name)}"><span class="file-icon">${file.hasVideo ? 'VID' : 'AUD'}</span><span class="file-copy"><span class="file-name">${escape(file.name)}</span><span class="file-meta">${time(file.duration)} · ${size(file.bytes)}</span></span></button>`).join('');
}
function selectFile(file: MediaFile) {
  player.pause(); state.sequencePlaying = false; state.source = file;
  state.clips = [{ start: 0, end: file.duration }]; state.selected = 0;
  $('source-title').textContent = file.name; $('source-kind').textContent = file.hasVideo ? 'Video source' : 'Audio source';
  $('empty-view').hidden = true; $('media-view').hidden = false; $('audio-art').hidden = file.hasVideo; $('audio-name').textContent = file.name;
  $('playback-notice').hidden = true;
  player.src = `/media/${file.id}`; player.load();
  $('total-time').textContent = time(file.duration);
  $('source-info').textContent = `${file.hasVideo ? `${file.width} × ${file.height} · ` : ''}${size(file.bytes)}`;
  $('format').value = file.hasVideo ? 'mp4' : 'mp3';
  for (const option of $('format').options) option.disabled = ['mp4', 'webm'].includes(option.value) ? !file.hasVideo : !file.hasAudio;
  (['play', 'play-edit', 'clip-start', 'clip-end', 'mark-in', 'mark-out', 'add-clip', 'split-clip', 'scrubber', 'settings'] as const).forEach(id => $(id).disabled = false);
  (['flip-h', 'flip-v', 'mute'] as const).forEach(id => $(id).checked = false);
  $('scrubber').max = String(file.duration); $('scrubber').value = '0';
  $('clip-start').max = String(file.duration); $('clip-end').max = String(file.duration);
  $('ruler').innerHTML = [0, .25, .5, .75, 1].map(n => `<span>${time(n * file.duration).replace(/\.\d+$/, '')}</span>`).join('');
  $('timeline-empty').hidden = true; $('selection').hidden = false; $('playhead').hidden = false;
  renderLibrary(); renderClips(); updateSettings(); updatePlayback();
}
function renderClips(preserveInputs = false) {
  const selected = state.clips[state.selected];
  if (!selected || !state.source) return;
  const duration = state.source.duration;
  if (!preserveInputs) { $('clip-start').value = String(Number(selected.start.toFixed(3))); $('clip-end').value = String(Number(selected.end.toFixed(3))); }
  $('selection').style.left = `${selected.start / duration * 100}%`;
  $('selection').style.width = `${(selected.end - selected.start) / duration * 100}%`;
  for (const [id, value] of [['start-handle', selected.start], ['end-handle', selected.end]] as const) {
    $(id).setAttribute('aria-valuemax', String(duration)); $(id).setAttribute('aria-valuenow', value.toFixed(2)); $(id).setAttribute('aria-valuetext', time(value));
  }
  $('timeline-clips').innerHTML = state.clips.map((clip, i) => `<div class="timeline-region" style="left:${clip.start / duration * 100}%;width:${(clip.end - clip.start) / duration * 100}%"><span>${String(i + 1).padStart(2, '0')}</span></div>`).join('');
  $('clip-list').innerHTML = state.clips.map((clip, i) => `<li class="clip-row ${state.selected === i ? 'selected' : ''}"><button class="clip-select" data-select="${i}" aria-label="Select clip ${i + 1}" aria-pressed="${state.selected === i}"><span class="clip-number">${String(i + 1).padStart(2, '0')}</span><span class="clip-times">${time(clip.start)} - ${time(clip.end)}</span><span class="clip-length">${(clip.end - clip.start).toFixed(2)}s</span></button><div class="clip-actions"><button data-move="${i}" data-direction="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move clip ${i + 1} earlier">Earlier</button><button data-move="${i}" data-direction="1" ${i === state.clips.length - 1 ? 'disabled' : ''} aria-label="Move clip ${i + 1} later">Later</button><button data-remove="${i}" ${state.clips.length === 1 ? 'disabled' : ''} aria-label="Remove clip ${i + 1}">Remove</button></div></li>`).join('');
  const total = state.clips.reduce((sum, clip) => sum + clip.end - clip.start, 0);
  $('sequence-duration').textContent = time(total); $('output-duration').textContent = time(total);
  $('clip-count').textContent = `${state.clips.length} clip${state.clips.length === 1 ? '' : 's'}`;
  $('add-clip').disabled = state.clips.length >= 32;
  updateSummary();
}
function updateSummary() { if (state.source) $('export-description').textContent = `${state.clips.length} clip${state.clips.length === 1 ? '' : 's'} merged into one ${$('format').value.toUpperCase()} file.`; }
function updateSettings() {
  const format = $('format').value;
  if (!isOutputFormat(format)) return;
  const video = ['mp4', 'webm'].includes($('format').value);
  const lossless = ['wav', 'flac'].includes($('format').value);
  $('resolution').disabled = !video; $('quality').disabled = lossless;
  (['flip-h', 'flip-v'] as const).forEach(id => $(id).disabled = !state.source?.hasVideo);
  $('mute').disabled = !video || !state.source?.hasAudio;
  player.style.transform = `scale(${$('flip-h').checked ? -1 : 1}, ${$('flip-v').checked ? -1 : 1})`;
  player.muted = video && $('mute').checked;
  $('format-description').textContent = { mp4: 'A good fit for sharing and everyday playback.', webm: 'An open video format for the web.', mp3: 'Compact audio for almost any player.', m4a: 'Efficient AAC audio in an M4A container.', wav: 'Uncompressed audio. Larger files, full fidelity.', flac: 'Lossless audio with a smaller footprint.' }[format];
  $('export').disabled = !state.source || !state.engine || state.submitting;
  $('render-preview').disabled = !state.source || !state.engine || state.submitting;
  updateSummary();
}
function stopSequence() { state.sequencePlaying = false; $('play-edit').textContent = 'Play selected clips'; }
function seek(value: number) { stopSequence(); if (state.source) { player.currentTime = Math.max(0, Math.min(state.source.duration, value)); updatePlayback(); } }
function updatePlayback() {
  const value = player.currentTime || 0;
  $('current-time').textContent = time(value); $('scrubber').value = String(value);
  if (state.source) $('playhead').style.left = `${Math.min(100, value / state.source.duration * 100)}%`;
  $('play').textContent = player.paused ? 'Play' : 'Pause'; $('play').setAttribute('aria-label', player.paused ? 'Play source' : 'Pause source');
}
function changeRange(edge: ClipEdge, value: number) {
  if (!state.source || !Number.isFinite(value)) return;
  stopSequence();
  const clip = state.clips[state.selected];
  if (!clip) return;
  if (edge === 'start') clip.start = Math.max(0, Math.min(value, clip.end - .04));
  else clip.end = Math.min(state.source.duration, Math.max(value, clip.start + .04));
  renderClips();
}
async function play() { try { await player.play(); } catch { toast('This source may not play in your browser. Use Render preview to make a compatible version.'); } }
$('play').onclick = () => { stopSequence(); if (player.paused) void play(); else player.pause(); };
$('play-edit').onclick = () => {
  if (state.sequencePlaying) { player.pause(); stopSequence(); return; }
  state.sequencePlaying = true; state.sequenceIndex = 0; const first = state.clips[0]; if (!first) { stopSequence(); return; } player.currentTime = first.start;
  $('play-edit').textContent = 'Stop clip playback'; void play();
};
function advanceSequence() {
  if (!state.sequencePlaying) return;
  const clip = state.clips[state.sequenceIndex];
  if (!clip) { player.pause(); stopSequence(); return; }
  if (player.currentTime >= clip.end - .025 || player.ended) {
    state.sequenceIndex++;
    if (state.sequenceIndex >= state.clips.length) { player.pause(); stopSequence(); }
    else { const next = state.clips[state.sequenceIndex]; if (next) { player.currentTime = next.start; void play(); } }
  }
}
function playbackFrame() { if (!player.paused) { advanceSequence(); updatePlayback(); } requestAnimationFrame(playbackFrame); }
requestAnimationFrame(playbackFrame);
player.addEventListener('timeupdate', updatePlayback);
player.addEventListener('play', updatePlayback); player.addEventListener('pause', updatePlayback);
player.addEventListener('ended', () => { advanceSequence(); updatePlayback(); });
player.addEventListener('error', () => { if (!state.source) return; $('playback-notice').textContent = 'Your browser cannot play this source format. You can still edit its time ranges and render a compatible preview.'; $('playback-notice').hidden = false; });
$('scrubber').oninput = () => seek(Number($('scrubber').value));
$('clip-start').onchange = () => changeRange('start', Number($('clip-start').value));
$('clip-end').onchange = () => changeRange('end', Number($('clip-end').value));
for (const edge of ['start', 'end'] as const) $(`clip-${edge}`).oninput = () => {
  if (!state.source || $(`clip-${edge}`).value === '') return;
  const value = Number($(`clip-${edge}`).value), clip = state.clips[state.selected];
  if (!clip || !Number.isFinite(value) || value < 0 || value > state.source.duration) return;
  if (edge === 'start' ? clip.end - value < .04 : value - clip.start < .04) return;
  stopSequence(); clip[edge] = value; renderClips(true);
};
$('mark-in').onclick = () => changeRange('start', player.currentTime);
$('mark-out').onclick = () => changeRange('end', player.currentTime);
const pointerTime = (event: PointerEvent) => { const rect = $('timeline-track').getBoundingClientRect(); return (event.clientX - rect.left) / rect.width * (state.source?.duration ?? 0); };
$('timeline-track').addEventListener('pointerdown', event => { if (state.source && event.target instanceof Element && !event.target.closest('.trim-handle')) seek(pointerTime(event)); });
for (const edge of ['start', 'end'] as const) {
  const handle = $(`${edge}-handle`);
  handle.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); handle.setPointerCapture(event.pointerId); });
  handle.addEventListener('pointermove', event => { if (handle.hasPointerCapture(event.pointerId)) changeRange(edge, pointerTime(event)); });
  handle.addEventListener('pointerup', event => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); });
  handle.addEventListener('keydown', event => {
    const clip = state.clips[state.selected];
    if (!clip) return;
    const step = event.shiftKey ? 1 : .1;
    if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); changeRange(edge, event.key === 'Home' ? 0 : event.key === 'End' ? (state.source?.duration ?? 0) : clip[edge] + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -step : step));
    }
  });
}
$('add-clip').onclick = () => {
  const selected = state.clips[state.selected];
  if (!state.source || !selected || state.clips.length >= 32) return;
  stopSequence(); const duration = state.source.duration; const end = selected.end;
  const start = end < duration - .04 ? end : 0;
  state.clips.push({ start, end: Math.min(start + 5, duration) }); state.selected = state.clips.length - 1; seek(start); renderClips();
};
$('split-clip').onclick = () => {
  const clip = state.clips[state.selected], point = player.currentTime;
  if (!clip) return;
  if (state.clips.length >= 32) return toast('A sequence can contain up to 32 clips.');
  if (point - clip.start < .04 || clip.end - point < .04) return toast('Move the playhead inside the selected clip to split it.');
  stopSequence(); state.clips.splice(state.selected, 1, { start: clip.start, end: point }, { start: point, end: clip.end }); renderClips();
};
$('clip-list').onclick = event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('button'); if (!button) return;
  stopSequence();
  if (button.dataset.select !== undefined) { state.selected = Number(button.dataset.select); const selected = state.clips[state.selected]; if (selected) seek(selected.start); }
  if (button.dataset.remove !== undefined && state.clips.length > 1) { state.clips.splice(Number(button.dataset.remove), 1); state.selected = Math.min(state.selected, state.clips.length - 1); }
  if (button.dataset.move !== undefined) {
    const from = Number(button.dataset.move), to = from + Number(button.dataset.direction);
    if (to < 0 || to >= state.clips.length) return;
    const current = state.clips[state.selected], fromClip = state.clips[from], toClip = state.clips[to];
    if (!current || !fromClip || !toClip) return;
    [state.clips[from], state.clips[to]] = [toClip, fromClip]; state.selected = state.clips.indexOf(current);
  }
  renderClips();
};
$('settings').onchange = updateSettings;
$('file-list').onclick = event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>('[data-file]');
  const file = state.files.find(file => file.id === button?.dataset.file);
  if (file) selectFile(file);
};
$('browse').onclick = () => $('file-input').click();
$('upload-button').onclick = () => $('file-input').click();
$('file-input').onchange = () => { void uploadFiles([...($('file-input').files ?? [])]); $('file-input').value = ''; };
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', event => { if (!(event.relatedTarget instanceof Node) || !$('drop-zone').contains(event.relatedTarget)) $('drop-zone').classList.remove('dragging'); });
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); void uploadFiles([...(event.dataTransfer?.files ?? [])]); });
function upload(file: File): Promise<MediaFile> {
  return new Promise<MediaFile>((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('POST', '/api/uploads'); request.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = event => { $('upload-status').textContent = `${file.name} · ${event.lengthComputable ? Math.round(event.loaded / event.total * 100) + '%' : 'uploading'}`; };
    request.upload.onload = () => { $('upload-status').textContent = `${file.name} · inspecting media…`; };
    request.onload = () => { try { const result: unknown = JSON.parse(request.responseText); if (request.status >= 400) reject(new Error(isRecord(result) && typeof result.error === 'string' ? result.error : 'Upload failed.')); else resolve(parseMediaFile(result)); } catch { reject(new Error('The upload could not be completed.')); } };
    request.onerror = () => reject(new Error('Upload connection lost. Check that the local server is running.'));
    request.send(file);
  });
}
async function uploadFiles(files: File[]) {
  if (state.uploading) return toast('Wait for the current uploads to finish.');
  if (!state.engine) return toast('The FFmpeg engine is not available.');
  state.uploading = true;
  for (const file of files) {
    try { if (file.size > 1024 ** 3) throw new Error(`${file.name} exceeds the 1 GB limit.`); const media = await upload(file); state.files.unshift(media); selectFile(media); }
    catch (error) { toast(errorMessage(error)); }
  }
  state.uploading = false; $('upload-status').textContent = '';
}
async function submit(preview: boolean) {
  if (!state.source || state.submitting) return;
  state.submitting = true; updateSettings();
  try {
    const format = $('format').value, quality = $('quality').value, resolution = $('resolution').value;
    if (!isOutputFormat(format) || !isQuality(quality) || !isResolution(resolution)) throw new Error('Choose valid export settings.');
    const request: EditRequest = { uploadId: state.source.id, clips: state.clips, format, quality, resolution, flipH: $('flip-h').checked, flipV: $('flip-v').checked, mute: $('mute').checked, preview };
    const job = await post('/api/jobs', request);
    if (preview) state.pendingPreview = job.id;
    state.jobs.unshift(job); renderJobs(); toast(preview ? 'Rendering your preview. It will open when ready.' : 'Export added to the queue.');
    return { id: job.id, status: job.status };
  } catch (error) { toast(errorMessage(error)); }
  finally { state.submitting = false; updateSettings(); }
}
$('export').onclick = () => void submit(false); $('render-preview').onclick = () => void submit(true);
function renderJobs() {
  $('job-count').textContent = String(state.jobs.length); $('jobs-empty').hidden = state.jobs.length > 0;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset : undefined;
  $('job-list').innerHTML = state.jobs.map(job => `<article class="job"><div><div class="job-name">${escape(job.name)}</div><div class="job-meta">${job.edit.preview ? 'PREVIEW' : job.edit.format.toUpperCase()} · ${time(job.edit.duration)} · ${job.edit.clips.length} clip${job.edit.clips.length === 1 ? '' : 's'}${job.bytes ? ' · ' + size(job.bytes) : ''}</div></div><div class="job-status ${job.status}">${{ queued: 'Waiting in queue', running: `Processing · ${job.progress}%`, completed: 'Ready to download', failed: 'Export failed', cancelled: 'Cancelled' }[job.status]}${['queued', 'running'].includes(job.status) ? `<progress max="100" value="${job.progress}" aria-label="Export progress"></progress>` : ''}</div><div class="job-actions">${job.status === 'completed' ? `<button class="button subtle" data-preview="${job.id}">Play</button><a class="button subtle" href="/results/${job.id}?download" download>Download</a>` : ['queued', 'running'].includes(job.status) ? `<button class="button subtle" data-cancel="${job.id}">Cancel</button>` : ''}</div>${job.error ? `<p class="job-error">${escape(job.error)}</p>` : ''}</article>`).join('');
  if (focused?.preview) document.querySelector<HTMLButtonElement>(`[data-preview="${focused.preview}"]`)?.focus({ preventScroll: true });
  if (focused?.cancel) document.querySelector<HTMLButtonElement>(`[data-cancel="${focused.cancel}"]`)?.focus({ preventScroll: true });
}
function openResult(job: Job) {
  player.pause(); stopSequence(); $('result-title').textContent = job.name; $('result-player').src = `/results/${job.id}`;
  $('result-player').classList.toggle('audio-result', !['mp4', 'webm'].includes(job.edit.format));
  $('result-download').href = `/results/${job.id}?download`; $('result-notice').hidden = true;
  $('result-dialog').showModal(); $('result-player').play().catch(() => {});
}
$('result-player').onerror = () => { $('result-notice').hidden = false; };
$('close-dialog').onclick = () => $('result-dialog').close();
$('result-dialog').addEventListener('close', () => { $('result-player').pause(); $('result-player').removeAttribute('src'); $('result-player').load(); });
$('job-list').onclick = async event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.preview) { const job = state.jobs.find(job => job.id === button.dataset.preview); if (job) openResult(job); }
  if (button.dataset.cancel) { try { await post(`/api/jobs/${button.dataset.cancel}/cancel`); await refreshJobs(); } catch (error) { toast(errorMessage(error)); } }
};
async function refreshJobs() {
  const jobs = await api('/api/jobs', value => parseList(value, parseJob));
  if (JSON.stringify(jobs) !== JSON.stringify(state.jobs)) { state.jobs = jobs; renderJobs(); }
  const preview = state.jobs.find(job => job.id === state.pendingPreview);
  if (preview && ['completed', 'failed', 'cancelled'].includes(preview.status)) { state.pendingPreview = null; if (preview.status === 'completed') openResult(preview); }
}
async function init() {
  try {
    const [health, files, jobs] = await Promise.all([api('/api/health', parseHealth), api('/api/uploads', value => parseList(value, parseMediaFile)), api('/api/jobs', value => parseList(value, parseJob))]);
    state.engine = health.available; state.files = files; state.jobs = jobs;
    $('engine').textContent = health.available ? 'Local engine ready' : 'FFmpeg unavailable'; $('engine').classList.toggle('ready', health.available);
    renderLibrary(); renderJobs(); if (files[0]) selectFile(files[0]);
    if (!health.available) toast('Install FFmpeg and FFprobe, then restart the server.');
  } catch { $('engine').textContent = 'Engine disconnected'; toast('Cannot reach the local server. Start it with npm start, then reload.'); }
}
await init();
let polling = false;
setInterval(async () => {
  if (polling || document.hidden) return;
  polling = true;
  try { await refreshJobs(); $('engine').textContent = state.engine ? 'Local engine ready' : 'FFmpeg unavailable'; $('engine').classList.toggle('ready', state.engine); }
  catch { $('engine').textContent = 'Engine disconnected'; $('engine').classList.remove('ready'); }
  finally { polling = false; }
}, 1500);


// Optional page-scoped agent controls share the visible editor's state and actions.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const tools: ModelContextTool[] = [
    {
      name: 'get_media_workspace',
      description: 'Read the local media library, selected clip sequence, and export job statuses.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => ({ files: state.files.map(({ id, name, duration, hasVideo, hasAudio }) => ({ id, name, duration, hasVideo, hasAudio })), selectedSource: state.source?.id ?? null, clips: state.clips.map(c => ({ ...c })), jobs: state.jobs.map(({ id, name, status }) => ({ id, name, status })) }),
    },
    {
      name: 'set_clip_sequence',
      description: 'Stage ordered start/end ranges from an already uploaded source in the visible editor. Does not export a file.',
      inputSchema: { type: 'object', properties: { sourceId: { type: 'string' }, clips: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } }, required: ['start', 'end'], additionalProperties: false } } }, required: ['sourceId', 'clips'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!isRecord(input)) throw new Error('Invalid sequence request.');
        const file = state.files.find(file => file.id === input.sourceId);
        if (!file) throw new Error('Select an uploaded source.');
        if (!Array.isArray(input.clips) || input.clips.length < 1 || input.clips.length > 32 || !input.clips.every(isClip) || input.clips.some(c => c.start < 0 || c.end > file.duration || c.end - c.start < .04)) throw new Error('Provide 1 to 32 valid ranges within the source.');
        if (state.source?.id !== file.id) selectFile(file);
        player.pause(); stopSequence(); state.clips = input.clips.map(({ start, end }) => ({ start, end })); state.selected = 0; renderClips();
        return { sourceId: file.id, clips: state.clips.map(c => ({ ...c })), duration: state.clips.reduce((sum, c) => sum + c.end - c.start, 0) };
      },
    },
    {
      name: 'queue_media_export',
      description: 'Queue a real FFmpeg export using the currently visible sequence and settings. Set preview to true to render a browser preview instead. Writes a new local output file.',
      inputSchema: { type: 'object', properties: { preview: { type: 'boolean' } }, required: ['preview'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (!isRecord(input) || typeof input.preview !== 'boolean') throw new Error('preview must be a boolean.');
        if (!state.source || !state.engine || state.submitting) throw new Error('The editor is not ready to export.');
        const result = await submit(input.preview); if (!result) throw new Error('Export could not be queued.'); return result;
      },
    },
  ];
  for (const tool of tools) {
    try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Regular editing works without this optional browser API. */ }
  }
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
