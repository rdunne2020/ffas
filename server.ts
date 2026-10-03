import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { MediaFile, Job } from './shared/model.js';
import { isRecord, errorMessage, parseMediaFile, parseJob } from './shared/model.js';
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
import { hostname, networkInterfaces } from 'node:os';
import { probe, validateEdit, buildCommand, formats } from './lib/media.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const uuid = /^[a-f0-9-]{36}$/;
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac' };
function json(res: ServerResponse, status: number, data: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
async function body(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 32768) throw new Error('Request is too large.'); }
  try { return JSON.parse(data); } catch { throw new Error('Invalid JSON request.'); }
}
async function serveFile(req: IncomingMessage, res: ServerResponse, filename: string, type: string, downloadName?: string | null) {
  const { size } = await stat(filename);
  const headers: OutgoingHttpHeaders = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size };
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
export interface AppOptions { dataDir?: string; maxUploadBytes?: number; allowRemote?: boolean }
export async function createApp({ dataDir = path.join(root, '.data'), maxUploadBytes = 1024 ** 3, allowRemote = false }: AppOptions = {}) {
  await mkdir(dataDir, { recursive: true });
  await Promise.all(['uploads', 'jobs'].map(dir => mkdir(path.join(dataDir, dir), { recursive: true })));
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (allowRemote) {
    allowedHosts.add(hostname().toLowerCase());
    allowedHosts.add('0.0.0.0');
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) allowedHosts.add(address.family === 'IPv6' ? `[${address.address}]` : address.address);
    }
  }
  const uploads = new Map<string, MediaFile>(), jobs = new Map<string, Job>();
  let active: { job: Job; child: ChildProcess } | null = null;
  let uploadCount = 0, stopping = false;
  let available = true;
  try { await Promise.all(['ffmpeg', 'ffprobe'].map(bin => exec(bin, ['-version'], { timeout: 5000 }))); } catch { available = false; }
  const save = (kind: 'uploads' | 'jobs', record: MediaFile | Job) => writeFile(path.join(dataDir, kind, `${record.id}.json`), JSON.stringify(record, null, 2));
  for (const kind of ['uploads', 'jobs'] as const) {
    for (const name of await readdir(path.join(dataDir, kind))) {
      if (!name.endsWith('.json')) continue;
      try {
        const value: unknown = JSON.parse(await readFile(path.join(dataDir, kind, name), 'utf8'));
        if (kind === 'uploads') {
          const record = parseMediaFile(value);
          uploads.set(record.id, record);
        } else {
          const record = parseJob(value);
          if (['queued', 'running'].includes(record.status)) {
            record.status = 'failed';
            record.error = 'The server stopped before this job finished. Submit the edit again.';
            await save(kind, record);
          }
          jobs.set(record.id, record);
        }
      } catch { /* Ignore incomplete or invalid metadata from an interrupted write. */ }
    }
  }
  const sourcePath = (m: MediaFile) => path.join(dataDir, 'uploads', `${m.id}${m.extension}`);
  const resultPath = (j: Job) => path.join(dataDir, 'jobs', `${j.id}.${j.edit.format}`);
  async function runNext() {
    if (active || stopping) return;
    const job = [...jobs.values()].find(j => j.status === 'queued');
    if (!job) return;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const media = uploads.get(job.uploadId);
    if (!media) {
      job.status = 'failed'; job.error = 'Source file not found. Upload it again.';
      await save('jobs', job); void runNext(); return;
    }
    const child = spawn('ffmpeg', buildCommand(media, job.edit, sourcePath(media), resultPath(job)), { stdio: ['ignore', 'pipe', 'pipe'] });
    active = { job, child };
    let stderr = '', progressBuffer = '', timedOut = false;
    let spawnError: Error | undefined;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60 * 60 * 1000);
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000); });
    child.stdout.on('data', data => {
      progressBuffer += data.toString();
      const lines = progressBuffer.split('\n'); progressBuffer = lines.pop() ?? '';
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
      } catch (error) { job.status = 'failed'; job.error = 'Could not save the output. Check available disk space.'; console.error(errorMessage(error)); }
      finally { active = null; void runNext(); }
    });
    await save('jobs', job).catch(error => console.error(errorMessage(error)));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      if (!host || !allowedHosts.has(new URL(`http://${host}`).hostname.toLowerCase())) return json(res, 403, { error: 'This hostname is not allowed.' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
      const url = new URL(req.url ?? '/', `http://${host}`);
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { available, maxUploadBytes });
      if (req.method === 'GET' && pathname === '/api/uploads') return json(res, 200, [...uploads.values()].reverse());
      if (req.method === 'GET' && pathname === '/api/jobs') return json(res, 200, [...jobs.values()].reverse());
      if (req.method === 'POST' && pathname === '/api/uploads') {
        if (!available) return json(res, 503, { error: 'Install FFmpeg and FFprobe, then restart the server.' });
        if (uploadCount >= 2) return json(res, 429, { error: 'Two uploads are already in progress. Try again shortly.' });
        if (Number(req.headers['content-length']) > maxUploadBytes) return json(res, 413, { error: 'The upload limit is 1 GB.' });
        let name;
        try { const filenameHeader = req.headers['x-file-name']; if (Array.isArray(filenameHeader)) throw new Error('Invalid filename.'); name = decodeURIComponent(filenameHeader || 'media'); } catch { throw new Error('Invalid filename.'); }
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
        const request = await body(req);
        if (!isRecord(request) || typeof request.uploadId !== 'string') throw new Error('Invalid upload ID.');
        const media = uploads.get(request.uploadId);
        if (!media) return json(res, 404, { error: 'Source file not found. Upload it again.' });
        const edit = validateEdit(request, media);
        const job: Job = { id: randomUUID(), uploadId: media.id, name: media.name.replace(/\.[^.]+$/, '') + (edit.preview ? '-preview.' : '-edited.') + edit.format, edit, status: 'queued', progress: 0, createdAt: new Date().toISOString() };
        await save('jobs', job); jobs.set(job.id, job);
        json(res, 202, job); void runNext(); return;
      }
      const cancel = /^\/api\/jobs\/([a-f0-9-]+)\/cancel$/.exec(pathname);
      if (req.method === 'POST' && cancel?.[1]) {
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
      if (['GET', 'HEAD'].includes(req.method ?? '') && file?.[2] && uuid.test(file[2])) {
        if (file[1] === 'media') {
          const media = uploads.get(file[2]);
          if (!media) return json(res, 404, { error: 'File not found.' });
          await serveFile(req, res, sourcePath(media), contentTypes[media.extension] ?? 'application/octet-stream', url.searchParams.has('download') ? media.name : null);
        } else {
          const job = jobs.get(file[2]);
          if (!job || job.status !== 'completed') return json(res, 404, { error: 'File not found.' });
          await serveFile(req, res, resultPath(job), formats[job.edit.format].mime, url.searchParams.has('download') ? job.name : null);
        }
        return;
      }
      const staticFiles: Record<string, string> = { '/': 'public/index.html', '/app.js': 'dist/public/app.js', '/shared/model.js': 'dist/shared/model.js', '/style.css': 'public/style.css', '/favicon.svg': 'public/favicon.svg' };
      const filename = staticFiles[pathname];
      if (['GET', 'HEAD'].includes(req.method ?? '') && Object.hasOwn(staticFiles, pathname) && filename) {
        await serveFile(req, res, path.join(root, filename), contentTypes[path.extname(filename)] ?? 'application/octet-stream'); return;
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const missing = isRecord(error) && error.code === 'ENOENT';
      json(res, missing ? 404 : 400, { error: missing ? 'File no longer exists.' : errorMessage(error) });
    }
  });
  server.requestTimeout = 30 * 60 * 1000;
  return { server, stop() { stopping = true; active?.child.kill('SIGKILL'); server.close(); server.closeAllConnections(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const app = await createApp({ dataDir: process.env.FFAS_DATA_DIR || undefined, allowRemote: !['127.0.0.1', '::1', 'localhost'].includes(host) });
  app.server.listen(port, host, () => console.log(`FFAS is listening on ${host}:${port}`));
  app.server.on('error', error => { console.error(errorMessage(error)); process.exitCode = 1; });
  process.on('SIGINT', () => app.stop());
  process.on('SIGTERM', () => app.stop());
}
