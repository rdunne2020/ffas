import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaFile, parseJob, parseHealth, parseList } from '../shared/model.js';
import { buildCommand, validateEdit } from '../lib/media.js';

test('JSON boundaries reject malformed responses and unsafe stored paths', () => {
  for (const value of [null, [], 'media', { id: '../../file' }]) assert.throws(() => parseMediaFile(value));
  for (const value of [null, {}, { status: 'invented' }]) assert.throws(() => parseJob(value));
  assert.throws(() => parseHealth({ available: 'true', maxUploadBytes: 1 }));
  assert.throws(() => parseList({}, parseJob));
  const metadata = { duration: 4, hasVideo: true, hasAudio: true };
  for (const value of [null, [], 1, { clips: [{ start: '0', end: 1 }], format: 'mp4' }]) {
    assert.throws(() => validateEdit(value, metadata));
  }
});

test('stored JavaScript-era records retain their schema through typed parsing', () => {
  const media = {
    id: '00000000-0000-4000-8000-000000000000', name: 'sample.mp4', extension: '.mp4',
    bytes: 100, duration: 4, hasVideo: true, hasAudio: false, videoIndex: 0,
    width: 320, height: 180, videoCodec: 'h264', createdAt: '2026-10-02T00:00:00.000Z',
  };
  assert.deepEqual(parseMediaFile(JSON.parse(JSON.stringify(media))), media);
  const job = {
    id: media.id, uploadId: media.id, name: 'sample-edited.mp4',
    edit: validateEdit({ clips: [{ start: 0, end: 1 }], format: 'mp4' }, media),
    status: 'completed', progress: 100, bytes: 50, createdAt: media.createdAt,
  };
  assert.deepEqual(parseJob(JSON.parse(JSON.stringify(job))), job);
  assert.throws(() => parseMediaFile({ ...media, extension: '/../outside' }));
  assert.throws(() => parseJob({ ...job, edit: { ...job.edit, format: '../../outside' } }));
});


test('CRF zero is preserved and target bitrate omits CRF', () => {
  const media = { duration: 4, hasVideo: true, hasAudio: true, videoIndex: 0, audioIndex: 1 };
  const base = { clips: [{ start: 0, end: 1 }], format: 'mp4', videoCodec: 'libx265' };
  const crf = buildCommand(media, validateEdit({ ...base, crf: 0 }, media), 'input.mp4', 'output.mp4');
  assert.equal(crf[crf.indexOf('-crf') + 1], '0');
  const bitrate = buildCommand(media, validateEdit({ ...base, rateControl: 'bitrate', videoBitrateKbps: 1200 }, media), 'input.mp4', 'output.mp4');
  assert.equal(bitrate[bitrate.indexOf('-b:v') + 1], '1200k'); assert.ok(!bitrate.includes('-crf'));
});
