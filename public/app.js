const $ = id => document.getElementById(id);
const state = { files: [], source: null, clips: [], selected: 0, jobs: [], sequencePlaying: false, sequenceIndex: 0, uploading: false, pendingPreview: null, engine: false, submitting: false };
const player = $('source-player');
let toastTimer;
const time = seconds => { const value = Math.max(0, Number(seconds) || 0); const hours = Math.floor(value / 3600); return `${hours ? String(hours).padStart(2, '0') + ':' : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`; };
const size = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
async function api(url, options) { const res = await fetch(url, options); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'The request failed.'); return data; }
const post = (url, data = {}) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
function renderLibrary() {
  $('file-count').textContent = state.files.length;
  $('library-empty').hidden = state.files.length > 0;
  $('file-list').innerHTML = state.files.map(file => `<button class="file-item ${state.source?.id === file.id ? 'selected' : ''}" data-file="${file.id}" aria-pressed="${state.source?.id === file.id}" title="${escape(file.name)}"><span class="file-icon">${file.hasVideo ? 'VID' : 'AUD'}</span><span class="file-copy"><span class="file-name">${escape(file.name)}</span><span class="file-meta">${time(file.duration)} · ${size(file.bytes)}</span></span></button>`).join('');
}
function selectFile(file) {
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
  ['play', 'play-edit', 'clip-start', 'clip-end', 'mark-in', 'mark-out', 'add-clip', 'split-clip', 'scrubber', 'settings'].forEach(id => $(id).disabled = false);
  ['flip-h', 'flip-v', 'mute'].forEach(id => $(id).checked = false);
  $('scrubber').max = file.duration; $('scrubber').value = 0;
  $('clip-start').max = file.duration; $('clip-end').max = file.duration;
  $('ruler').innerHTML = [0, .25, .5, .75, 1].map(n => `<span>${time(n * file.duration).replace(/\.\d+$/, '')}</span>`).join('');
  $('timeline-empty').hidden = true; $('selection').hidden = false; $('playhead').hidden = false;
  renderLibrary(); renderClips(); updateSettings(); updatePlayback();
}
function renderClips(preserveInputs = false) {
  const selected = state.clips[state.selected];
  if (!selected || !state.source) return;
  const duration = state.source.duration;
  if (!preserveInputs) { $('clip-start').value = Number(selected.start.toFixed(3)); $('clip-end').value = Number(selected.end.toFixed(3)); }
  $('selection').style.left = `${selected.start / duration * 100}%`;
  $('selection').style.width = `${(selected.end - selected.start) / duration * 100}%`;
  for (const [id, value] of [['start-handle', selected.start], ['end-handle', selected.end]]) {
    $(id).setAttribute('aria-valuemax', duration); $(id).setAttribute('aria-valuenow', value.toFixed(2)); $(id).setAttribute('aria-valuetext', time(value));
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
  const video = ['mp4', 'webm'].includes($('format').value);
  const lossless = ['wav', 'flac'].includes($('format').value);
  $('resolution').disabled = !video; $('quality').disabled = lossless;
  ['flip-h', 'flip-v'].forEach(id => $(id).disabled = !state.source?.hasVideo);
  $('mute').disabled = !video || !state.source?.hasAudio;
  player.style.transform = `scale(${$('flip-h').checked ? -1 : 1}, ${$('flip-v').checked ? -1 : 1})`;
  player.muted = video && $('mute').checked;
  $('format-description').textContent = { mp4: 'A good fit for sharing and everyday playback.', webm: 'An open video format for the web.', mp3: 'Compact audio for almost any player.', m4a: 'Efficient AAC audio in an M4A container.', wav: 'Uncompressed audio. Larger files, full fidelity.', flac: 'Lossless audio with a smaller footprint.' }[$('format').value];
  $('export').disabled = !state.source || !state.engine || state.submitting;
  $('render-preview').disabled = !state.source || !state.engine || state.submitting;
  updateSummary();
}
function stopSequence() { state.sequencePlaying = false; $('play-edit').textContent = 'Play selected clips'; }
function seek(value) { stopSequence(); if (state.source) { player.currentTime = Math.max(0, Math.min(state.source.duration, value)); updatePlayback(); } }
function updatePlayback() {
  const value = player.currentTime || 0;
  $('current-time').textContent = time(value); $('scrubber').value = value;
  if (state.source) $('playhead').style.left = `${Math.min(100, value / state.source.duration * 100)}%`;
  $('play').textContent = player.paused ? 'Play' : 'Pause'; $('play').setAttribute('aria-label', player.paused ? 'Play source' : 'Pause source');
}
function changeRange(edge, value) {
  if (!state.source || !Number.isFinite(value)) return;
  stopSequence();
  const clip = state.clips[state.selected];
  if (edge === 'start') clip.start = Math.max(0, Math.min(value, clip.end - .04));
  else clip.end = Math.min(state.source.duration, Math.max(value, clip.start + .04));
  renderClips();
}
async function play() { try { await player.play(); } catch { toast('This source may not play in your browser. Use Render preview to make a compatible version.'); } }
$('play').onclick = () => { stopSequence(); if (player.paused) void play(); else player.pause(); };
$('play-edit').onclick = () => {
  if (state.sequencePlaying) { player.pause(); stopSequence(); return; }
  state.sequencePlaying = true; state.sequenceIndex = 0; player.currentTime = state.clips[0].start;
  $('play-edit').textContent = 'Stop clip playback'; void play();
};
function advanceSequence() {
  if (!state.sequencePlaying) return;
  const clip = state.clips[state.sequenceIndex];
  if (player.currentTime >= clip.end - .025 || player.ended) {
    state.sequenceIndex++;
    if (state.sequenceIndex >= state.clips.length) { player.pause(); stopSequence(); }
    else { player.currentTime = state.clips[state.sequenceIndex].start; void play(); }
  }
}
function playbackFrame() { if (!player.paused) { advanceSequence(); updatePlayback(); } requestAnimationFrame(playbackFrame); }
requestAnimationFrame(playbackFrame);
player.addEventListener('timeupdate', updatePlayback);
player.addEventListener('play', updatePlayback); player.addEventListener('pause', updatePlayback);
player.addEventListener('ended', () => { advanceSequence(); updatePlayback(); });
player.addEventListener('error', () => { if (!state.source) return; $('playback-notice').textContent = 'Your browser cannot play this source format. You can still edit its time ranges and render a compatible preview.'; $('playback-notice').hidden = false; });
$('scrubber').oninput = event => seek(Number(event.target.value));
$('clip-start').onchange = event => changeRange('start', Number(event.target.value));
$('clip-end').onchange = event => changeRange('end', Number(event.target.value));
for (const edge of ['start', 'end']) $(`clip-${edge}`).oninput = event => {
  if (!state.source || event.target.value === '') return;
  const value = Number(event.target.value), clip = state.clips[state.selected];
  if (!Number.isFinite(value) || value < 0 || value > state.source.duration) return;
  if (edge === 'start' ? clip.end - value < .04 : value - clip.start < .04) return;
  stopSequence(); clip[edge] = value; renderClips(true);
};
$('mark-in').onclick = () => changeRange('start', player.currentTime);
$('mark-out').onclick = () => changeRange('end', player.currentTime);
const pointerTime = event => { const rect = $('timeline-track').getBoundingClientRect(); return (event.clientX - rect.left) / rect.width * state.source.duration; };
$('timeline-track').addEventListener('pointerdown', event => { if (state.source && !event.target.closest('.trim-handle')) seek(pointerTime(event)); });
for (const edge of ['start', 'end']) {
  const handle = $(`${edge}-handle`);
  handle.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); handle.setPointerCapture(event.pointerId); });
  handle.addEventListener('pointermove', event => { if (handle.hasPointerCapture(event.pointerId)) changeRange(edge, pointerTime(event)); });
  handle.addEventListener('pointerup', event => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); });
  handle.addEventListener('keydown', event => {
    const clip = state.clips[state.selected]; if (!clip) return;
    const step = event.shiftKey ? 1 : .1;
    if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); changeRange(edge, event.key === 'Home' ? 0 : event.key === 'End' ? state.source.duration : clip[edge] + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -step : step));
    }
  });
}
$('add-clip').onclick = () => {
  if (state.clips.length >= 32) return;
  stopSequence(); const duration = state.source.duration; const end = state.clips[state.selected].end;
  const start = end < duration - .04 ? end : 0;
  state.clips.push({ start, end: Math.min(start + 5, duration) }); state.selected = state.clips.length - 1; seek(start); renderClips();
};
$('split-clip').onclick = () => {
  const clip = state.clips[state.selected], point = player.currentTime;
  if (state.clips.length >= 32) return toast('A sequence can contain up to 32 clips.');
  if (point - clip.start < .04 || clip.end - point < .04) return toast('Move the playhead inside the selected clip to split it.');
  stopSequence(); state.clips.splice(state.selected, 1, { start: clip.start, end: point }, { start: point, end: clip.end }); renderClips();
};
$('clip-list').onclick = event => {
  const button = event.target.closest('button'); if (!button) return;
  stopSequence();
  if (button.dataset.select !== undefined) { state.selected = Number(button.dataset.select); seek(state.clips[state.selected].start); }
  if (button.dataset.remove !== undefined && state.clips.length > 1) { state.clips.splice(Number(button.dataset.remove), 1); state.selected = Math.min(state.selected, state.clips.length - 1); }
  if (button.dataset.move !== undefined) {
    const from = Number(button.dataset.move), to = from + Number(button.dataset.direction);
    if (to < 0 || to >= state.clips.length) return;
    const current = state.clips[state.selected]; [state.clips[from], state.clips[to]] = [state.clips[to], state.clips[from]]; state.selected = state.clips.indexOf(current);
  }
  renderClips();
};
$('settings').onchange = updateSettings;
$('file-list').onclick = event => { const button = event.target.closest('[data-file]'); if (button) selectFile(state.files.find(file => file.id === button.dataset.file)); };
$('browse').onclick = () => $('file-input').click();
$('upload-button').onclick = () => $('file-input').click();
$('file-input').onchange = event => { void uploadFiles([...event.target.files]); event.target.value = ''; };
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', event => { if (!$('drop-zone').contains(event.relatedTarget)) $('drop-zone').classList.remove('dragging'); });
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); void uploadFiles([...event.dataTransfer.files]); });
function upload(file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('POST', '/api/uploads'); request.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = event => { $('upload-status').textContent = `${file.name} · ${event.lengthComputable ? Math.round(event.loaded / event.total * 100) + '%' : 'uploading'}`; };
    request.upload.onload = () => { $('upload-status').textContent = `${file.name} · inspecting media…`; };
    request.onload = () => { try { const result = JSON.parse(request.responseText); if (request.status >= 400) reject(new Error(result.error)); else resolve(result); } catch { reject(new Error('The upload could not be completed.')); } };
    request.onerror = () => reject(new Error('Upload connection lost. Check that the local server is running.'));
    request.send(file);
  });
}
async function uploadFiles(files) {
  if (state.uploading) return toast('Wait for the current uploads to finish.');
  if (!state.engine) return toast('The FFmpeg engine is not available.');
  state.uploading = true;
  for (const file of files) {
    try { if (file.size > 1024 ** 3) throw new Error(`${file.name} exceeds the 1 GB limit.`); const media = await upload(file); state.files.unshift(media); selectFile(media); }
    catch (error) { toast(error.message); }
  }
  state.uploading = false; $('upload-status').textContent = '';
}
async function submit(preview) {
  if (!state.source || state.submitting) return;
  state.submitting = true; updateSettings();
  try {
    const job = await post('/api/jobs', { uploadId: state.source.id, clips: state.clips, format: $('format').value, quality: $('quality').value, resolution: $('resolution').value, flipH: $('flip-h').checked, flipV: $('flip-v').checked, mute: $('mute').checked, preview });
    if (preview) state.pendingPreview = job.id;
    state.jobs.unshift(job); renderJobs(); toast(preview ? 'Rendering your preview. It will open when ready.' : 'Export added to the queue.');
    return { id: job.id, status: job.status };
  } catch (error) { toast(error.message); }
  finally { state.submitting = false; updateSettings(); }
}
$('export').onclick = () => void submit(false); $('render-preview').onclick = () => void submit(true);
function renderJobs() {
  $('job-count').textContent = state.jobs.length; $('jobs-empty').hidden = state.jobs.length > 0;
  const focused = document.activeElement?.dataset;
  $('job-list').innerHTML = state.jobs.map(job => `<article class="job"><div><div class="job-name">${escape(job.name)}</div><div class="job-meta">${job.edit.preview ? 'PREVIEW' : job.edit.format.toUpperCase()} · ${time(job.edit.duration)} · ${job.edit.clips.length} clip${job.edit.clips.length === 1 ? '' : 's'}${job.bytes ? ' · ' + size(job.bytes) : ''}</div></div><div class="job-status ${job.status}">${{ queued: 'Waiting in queue', running: `Processing · ${job.progress}%`, completed: 'Ready to download', failed: 'Export failed', cancelled: 'Cancelled' }[job.status]}${['queued', 'running'].includes(job.status) ? `<progress max="100" value="${job.progress}" aria-label="Export progress"></progress>` : ''}</div><div class="job-actions">${job.status === 'completed' ? `<button class="button subtle" data-preview="${job.id}">Play</button><a class="button subtle" href="/results/${job.id}?download" download>Download</a>` : ['queued', 'running'].includes(job.status) ? `<button class="button subtle" data-cancel="${job.id}">Cancel</button>` : ''}</div>${job.error ? `<p class="job-error">${escape(job.error)}</p>` : ''}</article>`).join('');
  if (focused?.preview) document.querySelector(`[data-preview="${focused.preview}"]`)?.focus({ preventScroll: true });
  if (focused?.cancel) document.querySelector(`[data-cancel="${focused.cancel}"]`)?.focus({ preventScroll: true });
}
function openResult(job) {
  player.pause(); stopSequence(); $('result-title').textContent = job.name; $('result-player').src = `/results/${job.id}`;
  $('result-player').classList.toggle('audio-result', !['mp4', 'webm'].includes(job.edit.format));
  $('result-download').href = `/results/${job.id}?download`; $('result-notice').hidden = true;
  $('result-dialog').showModal(); $('result-player').play().catch(() => {});
}
$('result-player').onerror = () => $('result-notice').hidden = false;
$('close-dialog').onclick = () => $('result-dialog').close();
$('result-dialog').addEventListener('close', () => { $('result-player').pause(); $('result-player').removeAttribute('src'); $('result-player').load(); });
$('job-list').onclick = async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.preview) openResult(state.jobs.find(job => job.id === button.dataset.preview));
  if (button.dataset.cancel) { try { await post(`/api/jobs/${button.dataset.cancel}/cancel`); await refreshJobs(); } catch (error) { toast(error.message); } }
};
async function refreshJobs() {
  const jobs = await api('/api/jobs');
  if (JSON.stringify(jobs) !== JSON.stringify(state.jobs)) { state.jobs = jobs; renderJobs(); }
  const preview = state.jobs.find(job => job.id === state.pendingPreview);
  if (preview && ['completed', 'failed', 'cancelled'].includes(preview.status)) { state.pendingPreview = null; if (preview.status === 'completed') openResult(preview); }
}
async function init() {
  try {
    const [health, files, jobs] = await Promise.all([api('/api/health'), api('/api/uploads'), api('/api/jobs')]);
    state.engine = health.available; state.files = files; state.jobs = jobs;
    $('engine').textContent = health.available ? 'Local engine ready' : 'FFmpeg unavailable'; $('engine').classList.toggle('ready', health.available);
    renderLibrary(); renderJobs(); if (files.length) selectFile(files[0]);
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
  const tools = [
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
        const file = state.files.find(file => file.id === input?.sourceId);
        if (!file) throw new Error('Select an uploaded source.');
        if (!Array.isArray(input.clips) || input.clips.length < 1 || input.clips.length > 32 || input.clips.some(c => !c || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end > file.duration || c.end - c.start < .04)) throw new Error('Provide 1 to 32 valid ranges within the source.');
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
        if (typeof input?.preview !== 'boolean') throw new Error('preview must be a boolean.');
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
