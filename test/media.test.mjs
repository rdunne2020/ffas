import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { probe, validateEdit } from '../lib/media.mjs';
const exec = promisify(execFile);
let dir, app, base, video, audio, silent;
async function request(route, data) {
  const response = await fetch(base + route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { status: response.status, data: await response.json() };
}
async function upload(name) {
  const response = await fetch(base + '/api/uploads', { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(name) }, body: await readFile(path.join(dir, name)) });
  const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); return data;
}
async function finish(edit) {
  const queued = await request('/api/jobs', edit); assert.equal(queued.status, 202, JSON.stringify(queued.data));
  for (let i = 0; i < 400; i++) {
    const { data } = await request('/api/jobs');
    const job = data.find(j => j.id === queued.data.id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) { assert.equal(job.status, 'completed', job.error); return job; }
    await delay(50);
  }
  throw new Error('Job timed out');
}
async function outputMetadata(job) {
  const response = await fetch(`${base}/results/${job.id}`); assert.equal(response.status, 200);
  const filename = path.join(dir, `result-${job.id}.${job.edit.format}`);
  await writeFile(filename, Buffer.from(await response.arrayBuffer()));
  return probe(filename);
}
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ffas-test-'));
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'video.mp4')]);
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', path.join(dir, 'audio.wav')]);
  await exec('ffmpeg', ['-v', 'error', '-i', path.join(dir, 'video.mp4'), '-c:v', 'copy', '-an', path.join(dir, 'silent.mp4')]);
  app = await createApp({ dataDir: path.join(dir, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  video = await upload('video.mp4'); audio = await upload('audio.wav'); silent = await upload('silent.mp4');
});
after(async () => { app?.stop(); await rm(dir, { recursive: true, force: true }); });
test('uploads inspect video, audio and silent sources', () => {
  assert.equal(video.hasVideo, true); assert.equal(video.hasAudio, true); assert.equal(video.width, 320);
  assert.equal(audio.hasVideo, false); assert.equal(audio.hasAudio, true); assert.equal(silent.hasAudio, false);
});
test('splices out-of-order clips, flips both axes, and creates an accurate MP4', async () => {
  const job = await finish({ uploadId: video.id, clips: [{ start: 2, end: 3 }, { start: .2, end: 1.2 }], format: 'mp4', flipH: true, flipV: true, quality: 'small', resolution: '480' });
  const metadata = await outputMetadata(job);
  assert.ok(Math.abs(metadata.duration - 2) < .15, `duration ${metadata.duration}`);
  assert.equal(metadata.hasAudio, true); assert.equal(metadata.width, 320); assert.equal(metadata.height, 180);
  // Compare a decoded frame against an independently flipped source frame.
  const rawArgs = ['-v', 'error', '-i'];
  const original = await exec('ffmpeg', [...rawArgs, path.join(dir, 'video.mp4'), '-ss', '2', '-vf', 'hflip,vflip,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  const result = await exec('ffmpeg', [...rawArgs, path.join(dir, `result-${job.id}.mp4`), '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  assert.equal(original.stdout.length, result.stdout.length);
  const meanDifference = original.stdout.reduce((sum, value, i) => sum + Math.abs(value - result.stdout[i]), 0) / original.stdout.length;
  assert.ok(meanDifference < 12, `Frame order / transform mismatch: mean difference ${meanDifference}`);
});
test('exports silent video and muted video without inventing an audio track', async () => {
  for (const [source, mute] of [[silent, false], [video, true]]) {
    const job = await finish({ uploadId: source.id, clips: [{ start: 0, end: 1 }], format: 'mp4', mute });
    const metadata = await outputMetadata(job); assert.equal(metadata.hasVideo, true); assert.equal(metadata.hasAudio, false);
  }
});
test('extracts audio and supports every audio output container', async () => {
  for (const format of ['mp3', 'm4a', 'wav', 'flac']) {
    const job = await finish({ uploadId: format === 'mp3' ? video.id : audio.id, clips: [{ start: 0, end: .5 }, { start: 1, end: 1.5 }], format });
    const metadata = await outputMetadata(job); assert.equal(metadata.hasAudio, true); assert.equal(metadata.hasVideo, false); assert.ok(Math.abs(metadata.duration - 1) < .15);
  }
});
test('renders browser previews and WebM exports', async () => {
  const preview = await finish({ uploadId: video.id, clips: [{ start: 1, end: 2 }], format: 'flac', preview: true });
  assert.equal(preview.edit.format, 'mp4'); assert.equal((await outputMetadata(preview)).hasVideo, true);
  const webm = await finish({ uploadId: video.id, clips: [{ start: .5, end: 1.5 }], format: 'webm' });
  const metadata = await outputMetadata(webm); assert.equal(metadata.videoCodec, 'vp9'); assert.equal(metadata.hasAudio, true);
  const audioPreview = await finish({ uploadId: audio.id, clips: [{ start: 0, end: 1 }], format: 'wav', preview: true });
  assert.equal(audioPreview.edit.format, 'm4a'); assert.equal((await outputMetadata(audioPreview)).hasAudio, true);
});
test('rejects malformed edits, missing streams and arbitrary options', async () => {
  const good = { uploadId: video.id, clips: [{ start: 0, end: 1 }], format: 'mp4' };
  for (const edit of [{ ...good, clips: [] }, { ...good, clips: [{ start: 2, end: 1 }] }, { ...good, clips: [{ start: 0, end: 999 }] }, { ...good, format: '../../bad' }, { ...good, flipH: 'yes' }, { ...good, uploadId: audio.id }, { ...good, uploadId: silent.id, format: 'mp3' }]) assert.equal((await request('/api/jobs', edit)).status, 400);
  assert.throws(() => validateEdit({ ...good, clips: [{ start: NaN, end: 1 }] }, video));
  const invalid = await fetch(base + '/api/uploads', { method: 'POST', headers: { 'X-File-Name': 'fake.mp4' }, body: 'not media' });
  assert.equal(invalid.status, 400);
});
test('serves seekable media and download headers; rejects bad ranges and cross-origin writes', async () => {
  const range = await fetch(`${base}/media/${video.id}`, { headers: { Range: 'bytes=0-99' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
  const suffix = await fetch(`${base}/media/${video.id}`, { headers: { Range: 'bytes=-10' } }); assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 10);
  assert.equal((await fetch(`${base}/media/${video.id}`, { headers: { Range: 'bytes=9999999999-' } })).status, 416);
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
  const jobs = (await request('/api/jobs')).data; const done = jobs.find(j => j.status === 'completed');
  const download = await fetch(`${base}/results/${done.id}?download`); assert.match(download.headers.get('content-disposition'), /^attachment;/); await download.arrayBuffer();
  const html = await fetch(base); assert.equal(html.status, 200); assert.match(await html.text(), /Build your sequence/);
});
test('queued work can be cancelled without producing a result', async () => {
  const edit = { uploadId: video.id, clips: Array.from({ length: 32 }, () => ({ start: 0, end: 4 })), format: 'webm' };
  const first = (await request('/api/jobs', edit)).data;
  const second = (await request('/api/jobs', edit)).data;
  assert.equal((await request(`/api/jobs/${second.id}/cancel`, {})).data.status, 'cancelled');
  assert.equal((await request(`/api/jobs/${first.id}/cancel`, {})).data.status, 'cancelled');
  assert.equal((await fetch(`${base}/results/${second.id}`)).status, 404);
  await delay(200);
});
test('media and completed exports survive restarting the server', async () => {
  const originalFiles = (await request('/api/uploads')).data;
  app.stop();
  app = await createApp({ dataDir: path.join(dir, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await request('/api/uploads')).data.length, originalFiles.length);
  assert.ok((await request('/api/jobs')).data.some(job => job.status === 'completed'));
});
