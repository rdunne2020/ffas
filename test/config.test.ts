import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

test('upload limit environment supports defaults, larger and fractional limits, and rejects invalid values', async () => {
  const original = process.env.FFAS_MAX_UPLOAD_GB;
  const dir = await mkdtemp(path.join(tmpdir(), 'ffas-config-'));
  try {
    for (const value of [undefined, '10', '2.5']) {
      if (value === undefined) delete process.env.FFAS_MAX_UPLOAD_GB;
      else process.env.FFAS_MAX_UPLOAD_GB = value;
      const app = await createApp({ dataDir: dir });
      try {
        await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/health`);
        assert.equal((await response.json()).maxUploadBytes, Number(value ?? 1) * 1024 ** 3);
      } finally { app.stop(); }
    }
    for (const value of ['', '0', '-1', 'abc', 'Infinity', '100000000']) {
      process.env.FFAS_MAX_UPLOAD_GB = value;
      await assert.rejects(createApp({ dataDir: dir }), /Upload limit/);
    }
    for (const maxUploadBytes of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(createApp({ dataDir: dir, maxUploadBytes }), /Upload limit/);
    }
  } finally {
    if (original === undefined) delete process.env.FFAS_MAX_UPLOAD_GB;
    else process.env.FFAS_MAX_UPLOAD_GB = original;
    await rm(dir, { recursive: true, force: true });
  }
});
