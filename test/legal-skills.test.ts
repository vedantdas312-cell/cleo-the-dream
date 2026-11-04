import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegalSkillLibrary } from '../src/legal-skills.ts';
import { Workflow } from '../src/workflow.ts';
import { createApp } from '../src/server.ts';
import type { Store } from '../src/store.ts';

test('catalog loads every pinned reference, including table schemas and GRC references', async () => {
  const library = new LegalSkillLibrary();
  const catalog = await library.catalog();
  assert.equal(new Set(catalog.map(s => s.id)).size, catalog.length);
  for (const skill of catalog) {
    const loaded = await library.get({ skill_id: skill.id });
    assert.equal(loaded.references.length, skill.files.length);
    assert.ok(loaded.references[0].content);
    assert.equal(loaded.license, skill.license);
  }
  const table = await library.get({ skill_id: 'mike-commercial-agreement-tabular-review' });
  assert.ok(table.references.some(f => f.path.endsWith('table-columns.yaml')));
  const privacy = await library.get({ skill_id: 'grc-gdpr-compliance' });
  assert.ok(privacy.references.some(f => f.path.includes('/references/')));
  assert.equal((await library.get({ skill_id: 'mike-msa-review' })).requires_user_template, true);
});

test('search paginates and rejects unknown, excluded and path-like skill IDs', async () => {
  const library = new LegalSkillLibrary();
  const first = await library.list();
  assert.equal(first.skills.length, 20);
  assert.equal(first.next_offset, 20);
  const next = await library.list({ offset: first.next_offset });
  assert.ok(!first.skills.some(s => next.skills.some(n => n.id === s.id)));
  assert.ok((await library.list({ query: 'GDPR' })).skills.some(s => s.id === 'grc-gdpr-compliance'));
  for (const id of ['../../.env', 'mike-opposing-counsel-attack', 'adeu-redlining', 'unknown-skill']) {
    await assert.rejects(library.get({ skill_id: id }), /skill_id|approved workflow/);
  }
  await assert.rejects(library.list({ offset: -1 }), /non-negative/);
  await assert.rejects(library.list({ query: 'x'.repeat(201) }), /short skill query/);
});

test('modified source text fails closed instead of silently changing agent instructions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cleo-skill-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = (await new LegalSkillLibrary().catalog()).find(s => s.id === 'cleo-contract-intake')!;
  await mkdir(join(root, 'skills/legal/cleo/cleo-contract-intake'), { recursive: true });
  await writeFile(join(root, 'skills/legal/manifest.json'), JSON.stringify({ schemaVersion: 1, skills: [entry] }));
  await writeFile(join(root, entry.path), await readFile(entry.path));
  const library = new LegalSkillLibrary(root);
  await library.get({ skill_id: entry.id });
  await writeFile(join(root, entry.path), 'Unexpected instructions');
  await assert.rejects(library.get({ skill_id: entry.id }), /content changed/);
});

test('drafting sources retain licences, template scope and integration limitations', async () => {
  const library = new LegalSkillLibrary();
  const template = await library.get({ skill_id: 'general-legal-employee-offer-letter' });
  assert.equal(template.license, 'CC0-1.0');
  assert.ok(template.references.some(r => r.path.endsWith('LICENSE.txt') && r.content.includes('CC0 1.0')));
  assert.ok(template.integration_notes.some(n => n.includes('California exempt')));
  assert.ok(template.references[0].content.includes('<mark>'));
  const policy = await library.get({ skill_id: 'anthropic-employment-policy-drafting' });
  assert.equal(policy.license, 'Apache-2.0');
  assert.ok(policy.references.some(r => r.path.endsWith('LICENSE.txt') && r.content.includes('Apache License')));
  assert.ok(policy.integration_notes.some(n => n.includes('not installed')));
  assert.ok((await library.list({ query: 'General Legal mutual NDA' })).skills.some(s => s.id === 'general-legal-mutual-nda'));
  await assert.rejects(library.get({ skill_id: 'anthropic-general-signature-request' }), /approved workflow/);
});

test('skill HTTP routes require webhook authentication and valid local iMessage context', async t => {
  const config = { webhookKey: 'test-only-webhook-key-123456', downloadSecret: 'test-only-signing-secret-123456789012',
    publicUrl: 'https://cleo.example', localOnly: true, attachmentOrigins: ['https://media.example'] };
  const store: Store = { async saveSender() {}, async getSender() { return undefined; }, async saveSource() {}, async getSource() { return undefined; }, async saveOutput() {}, async getOutput() { return undefined; }, async saveDraft() {}, async getDraft() { return undefined; } };
  const workflow = new Workflow(store, config);
  const server = createApp(workflow); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;
  const post = (tool: string, body: unknown, authenticated = true) => fetch(base + '/tools/' + tool, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Orchid-Api-Key': config.webhookKey } : {}) },
    body: JSON.stringify(body),
  });
  const context = { phone: 'tester', channel: 'imessage' };
  assert.equal((await post('list_review_skills', { input: {}, context }, false)).status, 401);
  assert.equal((await post('list_review_skills', { input: {}, context: { ...context, phone: '' } })).status, 422);
  assert.equal((await post('get_review_skill', { input: { skill_id: 'cleo-contract-intake' }, context: { ...context, internal: true } })).status, 422);
  assert.equal((await post('list_review_skills', { input: {}, context: { ...context, channel: 'slack' } })).status, 422);
  const result = await post('get_review_skill', { input: { skill_id: 'cleo-contract-risk-review' }, context });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.ok(body.boundaries.some((s: string) => s.includes('Private fallbacks')));
  assert.ok(body.references[0].content.includes('paragraphId'));
  assert.equal((await post('get_review_skill', { input: { skill_id: '../../.env' }, context })).status, 422);
});
