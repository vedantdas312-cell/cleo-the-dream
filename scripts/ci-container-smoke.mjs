import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
assert.ok(image, 'Pass the locally built test image name.');
const name = `cleo-ci-${randomBytes(6).toString('hex')}`;
// Ephemeral test credentials only. No real account, provider or production DB.
const environment = {
  ...process.env,
  KEIKI_WEBHOOK_KEY: randomBytes(32).toString('hex'),
  DOWNLOAD_SIGNING_SECRET: randomBytes(32).toString('hex'),
  KEIKI_AGENT_ID: 'ci-agent',
  KEIKI_IMESSAGE_LINE: 'ci-line',
  KEIKI_ATTACHMENT_ORIGINS: 'https://attachments.invalid',
  PUBLIC_URL: 'https://cleo-ci.invalid',
  PORT: '18789',
};
const keys = ['KEIKI_WEBHOOK_KEY', 'DOWNLOAD_SIGNING_SECRET', 'KEIKI_AGENT_ID', 'KEIKI_IMESSAGE_LINE', 'KEIKI_ATTACHMENT_ORIGINS', 'PUBLIC_URL', 'PORT'];
const docker = (...args) => execFileSync('docker', args, { env: environment, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
let base;
async function request(path, options) {
  return fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5000), redirect: 'error' });
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(docker('inspect', '--format', '{{.State.Running}}', name).trim(), 'true', 'The test container exited during startup.');
    try {
      const response = await request('/health');
      if (response.ok) {
        assert.deepEqual(await response.json(), { ok: true, service: 'cleo-redlines', revision: process.argv[3] ?? 'development' });
        return;
      }
    } catch { /* Wait for PostgreSQL initialization and migrations. */ }
    await delay(1000);
  }
  throw new Error('The local test container did not become healthy.');
}
const bodyFor = (phone='+15555550100') => JSON.stringify({
  context: { phone, agentId:environment.KEIKI_AGENT_ID, channel: {channel:'imessage',provider:'blooio',gateway:environment.KEIKI_IMESSAGE_LINE,userId:phone,isDirect:true} },
  input: { draft: { title: 'CI synthetic draft', blocks: [{ kind: 'paragraph', text: 'Synthetic test text; no customer information.' }] } },
});
const body=bodyFor();
async function draft(phone) {
  const response = await request('/tools/create_legal_draft', {
    method: 'POST', body:bodyFor(phone), headers: { 'Content-Type': 'application/json', 'X-Orchid-Api-Key': environment.KEIKI_WEBHOOK_KEY },
  });
  assert.equal(response.status, 200, 'Authenticated draft generation must succeed.');
  const result = await response.json();
  assert.equal(result.status, 'generated_draft');
  assert.equal(result.delivery_status, 'not_sent');
  return result;
}
async function download(result) {
  const url = new URL(result.download_url);
  assert.equal(url.origin, environment.PUBLIC_URL, 'Download must remain on the local test service.');
  const response = await request(url.pathname + url.search);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 100);
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.output_sha256);
}
try {
  docker('run', '--detach', '--name', name, '--publish', '127.0.0.1::18789', ...keys.flatMap(key => ['--env', key]), image);
  const port = docker('port', name, '18789/tcp').trim();
  assert.match(port, /^127\.0\.0\.1:\d+$/);
  base = `http://${port}`;
  await ready();
  const homepage = await request('/');
  assert.equal(homepage.status, 200, 'The built homepage must ship in the production image.');
  const html = await homepage.text();
  assert.match(html, /Text Cleo/);
  const assets = [...html.matchAll(/(?:src|href)="(\/landing-assets\/[^"]+)"/g)];
  assert.equal(assets.length, 2);
  for (const [, path] of assets) assert.equal((await request(path)).status, 200, 'The homepage bundle must be available.');
  assert.equal((await request('/tools/create_legal_draft', { method: 'POST', body })).status, 401);
  const denied = await request('/tools/create_legal_draft', {
    method: 'POST', body: body.replace('+15555550100', '+15555550101'),
    headers: { 'Content-Type': 'application/json', 'X-Orchid-Api-Key': environment.KEIKI_WEBHOOK_KEY },
  });
  assert.equal(denied.status, 422, 'Phone mismatches must be refused, even in an authenticated webhook.');
  const first = await draft();
  const second = await draft('+15555550101');
  const firstUrl=new URL(first.download_url),secondUrl=new URL(second.download_url);
  assert.notEqual(firstUrl.searchParams.get('owner'),secondUrl.searchParams.get('owner'));
  const crossed=new URL(firstUrl);crossed.searchParams.set('owner',secondUrl.searchParams.get('owner'));
  assert.equal((await request(crossed.pathname+crossed.search)).status,422,'A different owner invalidates a file capability.');
  await download(first);
  await download(second);
  docker('restart', '--time', '15', name);
  // Docker may allocate a new ephemeral host port when restarting the container.
  const restartedPort = docker('port', name, '18789/tcp').trim();
  assert.match(restartedPort, /^127\.0\.0\.1:\d+$/);
  base = `http://${restartedPort}`;
  await ready();
  await download(first);
  await download(second);
  assert.equal((await draft()).output_sha256, first.output_sha256);
  // Real PostgreSQL readback after restart; no in-memory fixture can hide missing migrations.
  docker('exec',name,'gosu','node','node','--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {PostgresStore} from './src/store.ts';
    import {createHmac} from 'node:crypto';
    const store=new PostgresStore('postgresql:///postgres?host=/tmp/cleo-pg&user=node');
    try {
      await store.migrate();await store.migrate();
      const owners=['+15555550100','+15555550101'].map(p=>createHmac('sha256',process.env.DOWNLOAD_SIGNING_SECRET).update(p).digest('hex'));
      for(let i=0;i<2;i++)assert.equal(await store.getSender(owners[i],'ci-agent','ci-line'),'+1555555010'+i);
      assert.equal(await store.getSender(owners[0],'ci-agent','other-line'),undefined);
      await assert.rejects(store.saveSender({owner:owners[0],phone:'+15555550101',agentId:'ci-agent',line:'ci-line'}),/conflict/);
      await store.saveSource({id:'isolation-fixture',owner:owners[0],bytes:Buffer.from('A'),filename:'a.docx'});
      assert.equal(await store.getSource('isolation-fixture',owners[1]),undefined);
      await store.saveSource({id:'isolation-fixture',owner:owners[1],bytes:Buffer.from('B'),filename:'b.docx'});
      assert.equal((await store.getSource('isolation-fixture',owners[0])).bytes.toString(),'A');
      assert.equal((await store.getSource('isolation-fixture',owners[1])).bytes.toString(),'B');
      assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM cleo_drafts')).rows[0].n,2);
    } finally {await store.pool.end();}
  `);
  console.log('Two-user access, isolated PostgreSQL ownership and recipients, restart persistence, and Word checksums passed. No message sent.');
} catch (error) {
  try {
    let logs = docker('logs', '--tail', '80', name);
    for (const key of keys) logs = logs.replaceAll(environment[key], '[test value redacted]');
    console.error(logs);
  } catch { /* Preserve the original test failure if logs are unavailable. */ }
  throw error;
} finally {
  // This randomly named container is created solely by this test; no host data is mounted.
  docker('rm', '--force', '--volumes', name);
}
