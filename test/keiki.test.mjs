import test from 'node:test';
import assert from 'node:assert/strict';
import { Keiki, conversationId } from '../src/keiki.mjs';

const scope = { userId: 'demo-user', matterId: 'acme', sessionId: 'prep-1', audience: 'private' };
const answer = { choices: [{ finish_reason: 'stop', message: { content: 'Hello, I am Athena.' } }] };
function client(fetchImpl) { return new Keiki({ apiKey: 'test-key', agentId: 'athena-test', fetchImpl }); }

test('conversation identity persists and separates users, matters, sessions and audiences', () => {
  const id = conversationId(scope);
  assert.equal(conversationId(JSON.parse(JSON.stringify(scope))), id);
  for (const [key, value] of Object.entries({ userId: 'other', matterId: 'other', sessionId: 'other', audience: 'meeting' })) {
    assert.notEqual(conversationId({ ...scope, [key]: value }), id);
  }
  assert.throws(() => conversationId({ ...scope, matterId: '' }), /required/);
});

test('private turn uses agent gateway, scoped history, no tools and settled text', async () => {
  const api = client(async (url, options) => {
    assert.equal(url, 'https://onkeiki.com/api/v1/openai/chat/completions');
    assert.equal(options.headers['x-conversation-id'], conversationId(scope));
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice, 'none');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
    return { ok: true, json: async () => answer };
  });
  assert.equal((await api.ask({ text: 'Hello', scope })).text, 'Hello, I am Athena.');
});

test('meeting and invalid inputs are rejected before any network request', async () => {
  const api = client(() => assert.fail('Network must not run'));
  await assert.rejects(api.ask({ text: 'Hello', scope: { ...scope, audience: 'meeting' } }), /disabled/);
  await assert.rejects(api.ask({ text: '', scope }), /nonempty/);
});

test('errors and uncertain outcomes never leak provider data or automatically retry', async () => {
  let calls = 0;
  const api = client(async () => { calls++; throw new Error('secret-key and contract text'); });
  await assert.rejects(api.ask({ text: 'Hello', scope }), error => !error.message.includes('secret-key') && /No automatic retry/.test(error.message));
  assert.equal(calls, 1);
  await assert.rejects(client(async () => ({ ok: false, status: 403, json: () => assert.fail() })).ask({ text: 'Hello', scope }), /HTTP 403/);
});

test('partial answers and unexpected tool calls are not presented as complete replies', async () => {
  for (const choice of [{ finish_reason: 'length', message: { content: 'Partial' } }, { finish_reason: 'stop', message: { content: 'Acting', tool_calls: [{}] } }]) {
    await assert.rejects(client(async () => ({ ok: true, json: async () => ({ choices: [choice] }) })).ask({ text: 'Hello', scope }), /complete text answer/);
  }
});
