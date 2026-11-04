import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.ts';
import type { Workflow } from '../src/workflow.ts';

test('public landing serves its built assets without exposing backend files or bypassing tool authentication', async () => {
  const server = createApp({ config: { publicUrl: 'http://localhost', webhookKey: 'test-landing-key', downloadSecret: 'test-landing-secret' } } as Workflow);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const home = await fetch(origin);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type')!, /text\/html/);
    assert.match(home.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const html = await home.text();
    assert.match(html, /Text Cleo/);
    const sms = new URL(html.match(/href="(sms:[^"]+)"/)![1]);
    assert.equal(sms.searchParams.get('body'), 'Hi! (K-Q9C4YM)');
    const assets = [...html.matchAll(/(?:src|href)="(\/landing-assets\/[^"]+)"/g)].map(match => match[1]);
    assert.equal(assets.length, 2);
    for (const path of assets) {
      const asset = await fetch(origin + path);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('cache-control')!, /immutable/);
      assert.ok((await asset.text()).length > 100);
    }
    const head = await fetch(origin, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    for (const path of ['/package.json', '/src/server.ts', '/web/main.tsx', '/landing-assets/missing.js', '/landing-assets/%2e%2e%2fsrc%2fserver.ts']) {
      assert.equal((await fetch(origin + path)).status, 404, path);
    }
    assert.equal((await fetch(origin + '/tools/redline_contract', { method: 'POST' })).status, 401);
    assert.equal((await fetch(origin + '/health')).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
