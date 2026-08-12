import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupRig, waitFor } from './smoke/harness.js';

function requestWithOrigin(port, origin, path = '/api/health') {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path, method: 'GET', headers: origin ? { Origin: origin } : {} };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a disallowed Origin gets 403', async () => {
  const rig = setupRig({ port: 4201 });
  try {
    rig.startServer();
    await waitFor(() => requestWithOrigin(rig.port, null).then((r) => r.status === 200));
    const res = await requestWithOrigin(rig.port, 'https://evil.example');
    assert.equal(res.status, 403);
  } finally {
    await rig.teardown();
  }
});

test('an allowed Origin (the Vite dev server) passes', async () => {
  const rig = setupRig({ port: 4202 });
  try {
    rig.startServer();
    await waitFor(() => requestWithOrigin(rig.port, null).then((r) => r.status === 200));
    const res = await requestWithOrigin(rig.port, 'http://localhost:5173');
    assert.equal(res.status, 200);
  } finally {
    await rig.teardown();
  }
});

test('/api/health still answers with no Origin header (same-origin / curl)', async () => {
  const rig = setupRig({ port: 4203 });
  try {
    rig.startServer();
    const res = await waitFor(() => requestWithOrigin(rig.port, null).then((r) => (r.status === 200 ? r : null)));
    assert.equal(JSON.parse(res.body).ok, true);
  } finally {
    await rig.teardown();
  }
});
