import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { probe, validateEdit, buildCommand, formats } from './lib/media.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const uuid = /^[a-f0-9-]{36}$/;
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac' };
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 32768) throw new Error('Request is too large.'); }
  try { return JSON.parse(data); } catch { throw new Error('Invalid JSON request.'); }
}
async function serveFile(req, res, filename, type, downloadName) {
  const { size } = await stat(filename);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="export${path.extname(filename)}"; filename*=UTF-8''${encodeURIComponent(downloadName).replace(/'/g, '%27')}`;
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = end - start + 1;
    status = 206;
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(createReadStream(filename, { start, end }), res);
}
export async function createApp({ dataDir = path.join(root, '.data'), maxUploadBytes = 1024 ** 3 } = {}) {
  await mkdir(dataDir, { recursive: true });
  await Promise.all(['uploads', 'jobs'].map(dir => mkdir(path.join(dataDir, dir), { recursive: true })));
  const uploads = new Map(), jobs = new Map();
  let active = null, uploadCount = 0, stopping = false;
  let available = true;
  try { await Promise.all(['ffmpeg', 'ffprobe'].map(bin => exec(bin, ['-version'], { timeout: 5000 }))); } catch { available = false; }
  const save = (kind, record) => writeFile(path.join(dataDir, kind, `${record.id}.json`), JSON.stringify(record, null, 2));
  for (const [kind, records] of [['uploads', uploads], ['jobs', jobs]]) {
    for (const name of await readdir(path.join(dataDir, kind))) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(path.join(dataDir, kind, name), 'utf8'));
        if (kind === 'jobs' && ['queued', 'running'].includes(record.status)) { record.status = 'failed'; record.error = 'The server stopped before this job finished. Submit the edit again.'; await save(kind, record); }
        records.set(record.id, record);
      } catch { /* Ignore incomplete metadata from an interrupted write. */ }
    }
  }
  const sourcePath = m => path.join(dataDir, 'uploads', `${m.id}${m.extension}`);
  const resultPath = j => path.join(dataDir, 'jobs', `${j.id}.${j.edit.format}`);
  async function runNext() {
    if (active || stopping) return;
    const job = [...jobs.values()].find(j => j.status === 'queued');
    if (!job) return;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const child = spawn('ffmpeg', buildCommand(uploads.get(job.uploadId), job.edit, sourcePath(uploads.get(job.uploadId)), resultPath(job)), { stdio: ['ignore', 'pipe', 'pipe'] });
    active = { job, child };
    let stderr = '', progressBuffer = '', spawnError, timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60 * 60 * 1000);
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000); });
    child.stdout.on('data', data => {
      progressBuffer += data.toString();
      const lines = progressBuffer.split('\n'); progressBuffer = lines.pop();
      for (const line of lines) if (line.startsWith('out_time_us=')) job.progress = Math.min(99, Math.max(0, Math.round(Number(line.slice(12)) / (job.edit.duration * 10000))));
    });
    child.on('error', error => { spawnError = error; });
    child.on('close', async code => {
      clearTimeout(timeout);
      try {
        if (job.status !== 'cancelled') {
          job.status = code === 0 && !spawnError ? 'completed' : 'failed';
          if (job.status === 'completed') { job.progress = 100; job.bytes = (await stat(resultPath(job))).size; }
          else job.error = timedOut ? 'Processing exceeded the one-hour time limit.' : (spawnError ? 'FFmpeg could not be started.' : `FFmpeg could not process this edit. ${stderr.replaceAll(dataDir, '[storage]').slice(-1500)}`);
        }
        if (job.status !== 'completed') await rm(resultPath(job), { force: true });
        job.finishedAt = new Date().toISOString();
        await save('jobs', job);
      } catch (error) { job.status = 'failed'; job.error = 'Could not save the output. Check available disk space.'; console.error(error.message); }
      finally { active = null; void runNext(); }
    });
    await save('jobs', job).catch(error => console.error(error.message));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return json(res, 403, { error: 'Only localhost connections are supported.' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
      const url = new URL(req.url, `http://${host}`);
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { available, maxUploadBytes });
      if (req.method === 'GET' && pathname === '/api/uploads') return json(res, 200, [...uploads.values()].reverse());
      if (req.method === 'GET' && pathname === '/api/jobs') return json(res, 200, [...jobs.values()].reverse());
      if (req.method === 'POST' && pathname === '/api/uploads') {
        if (!available) return json(res, 503, { error: 'Install FFmpeg and FFprobe, then restart the server.' });
        if (uploadCount >= 2) return json(res, 429, { error: 'Two uploads are already in progress. Try again shortly.' });
        if (Number(req.headers['content-length']) > maxUploadBytes) return json(res, 413, { error: 'The upload limit is 1 GB.' });
        let name;
        try { name = decodeURIComponent(req.headers['x-file-name'] || 'media'); } catch { throw new Error('Invalid filename.'); }
        name = path.basename(name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'media';
        const candidate = path.extname(name).toLowerCase();
        const extension = /^\.[a-z0-9]{1,8}$/.test(candidate) ? candidate : '.bin';
        const id = randomUUID(), filename = path.join(dataDir, 'uploads', `${id}${extension}`);
        let bytes = 0;
        uploadCount++;
        try {
          const limit = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > maxUploadBytes ? new Error('The upload limit is 1 GB.') : null, chunk); } });
          await pipeline(req, limit, createWriteStream(filename, { flags: 'wx' }));
          if (!bytes) throw new Error('The file is empty.');
          let metadata;
          try { metadata = await probe(filename); } catch { throw new Error('This file could not be read. Upload a supported video or audio file with a valid duration.'); }
          const media = { id, name, extension, bytes, ...metadata, createdAt: new Date().toISOString() };
          await save('uploads', media); uploads.set(id, media);
          return json(res, 201, media);
        } catch (error) { await rm(filename, { force: true }); throw error; }
        finally { uploadCount--; }
      }
      if (req.method === 'POST' && pathname === '/api/jobs') {
        if (!available) return json(res, 503, { error: 'FFmpeg is unavailable.' });
        if ([...jobs.values()].filter(j => ['queued', 'running'].includes(j.status)).length >= 8) return json(res, 429, { error: 'The queue is full. Wait for an export to finish.' });
        const request = await body(req), media = uploads.get(request.uploadId);
        if (!media) return json(res, 404, { error: 'Source file not found. Upload it again.' });
        const edit = validateEdit(request, media);
        const job = { id: randomUUID(), uploadId: media.id, name: media.name.replace(/\.[^.]+$/, '') + (edit.preview ? '-preview.' : '-edited.') + edit.format, edit, status: 'queued', progress: 0, createdAt: new Date().toISOString() };
        await save('jobs', job); jobs.set(job.id, job);
        json(res, 202, job); void runNext(); return;
      }
      const cancel = /^\/api\/jobs\/([a-f0-9-]+)\/cancel$/.exec(pathname);
      if (req.method === 'POST' && cancel) {
        const job = jobs.get(cancel[1]);
        if (!job) return json(res, 404, { error: 'Job not found.' });
        if (['queued', 'running'].includes(job.status)) {
          job.status = 'cancelled';
          if (active?.job.id === job.id) active.child.kill('SIGKILL');
          await save('jobs', job);
        }
        return json(res, 200, job);
      }
      const file = /^\/(media|results)\/([a-f0-9-]+)$/.exec(pathname);
      if (['GET', 'HEAD'].includes(req.method) && file && uuid.test(file[2])) {
        const record = (file[1] === 'media' ? uploads : jobs).get(file[2]);
        if (!record || (file[1] === 'results' && record.status !== 'completed')) return json(res, 404, { error: 'File not found.' });
        await serveFile(req, res, file[1] === 'media' ? sourcePath(record) : resultPath(record), file[1] === 'media' ? (contentTypes[record.extension] || 'application/octet-stream') : formats[record.edit.format].mime, url.searchParams.has('download') ? record.name : null); return;
      }
      const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
      if (['GET', 'HEAD'].includes(req.method) && Object.hasOwn(staticFiles, pathname)) {
        const filename = staticFiles[pathname];
        await serveFile(req, res, path.join(root, 'public', filename), contentTypes[path.extname(filename)]); return;
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? 'File no longer exists.' : error.message });
    }
  });
  server.requestTimeout = 30 * 60 * 1000;
  return { server, stop() { stopping = true; active?.child.kill('SIGKILL'); server.close(); server.closeAllConnections(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = await createApp({ dataDir: process.env.FFAS_DATA_DIR || undefined });
  app.server.listen(port, '127.0.0.1', () => console.log(`FFAS is ready at http://localhost:${port}`));
  app.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  process.on('SIGINT', () => app.stop());
  process.on('SIGTERM', () => app.stop());
}
