import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MeetingRoutes } from '../src/meeting-routes.ts';
import type { MeetingTransport } from '../src/meeting-transport.ts';
import type { Workflow } from '../src/workflow.ts';

test('presentation events require bearer authorization and revoke without transmitting document or private data', async () => {
  const token = 'x'.repeat(43);
  const listeners = new Set<() => void>();
  let active = true;
  const transport = {
    presentation: (provided: string) => provided === token && active
      ? { active: true, document: { title: 'PUBLIC_DOCUMENT_CANARY' }, private: 'PRIVATE_CANARY' } : undefined,
    sessions: { onRevoke: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); } },
  } as unknown as MeetingTransport;
  const routes = new MeetingRoutes(transport, {} as Workflow, {secret:'s'.repeat(32),agentId:'fixture',line:'fixture'});
  const server = createServer((request, response) => {
    void routes.handle(request, response, new URL(request.url!, 'http://localhost')).catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const unauthenticated = await fetch(origin + '/meeting/presentation-events?token=' + token);
    assert.equal(unauthenticated.status, 403);
    const abort = new AbortController();
    const response = await fetch(origin + '/meeting/presentation-events', {headers:{Authorization:'Bearer '+token},signal:abort.signal});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: refresh/);
    assert.doesNotMatch(first, /CANARY|document/);
    assert.equal(listeners.size, 1);
    active = false;
    for (const notify of listeners) notify();
    const last = new TextDecoder().decode((await reader.read()).value);
    assert.match(last, /event: revoked/);
    assert.doesNotMatch(last, /CANARY|document/);
    assert.equal(listeners.size, 0);
    assert.equal((await reader.read()).done, true);
    abort.abort();
    const stale = await fetch(origin + '/meeting/presentation-events', {headers:{Authorization:'Bearer '+token}});
    assert.equal(stale.status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
