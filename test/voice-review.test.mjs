import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceReviews, reviewWithOpenAI } from '../src/voice-review.mjs';

test('deeper review uses verified legal guidance and cancellation prevents a provider request', async () => {
  let body;
  const request = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'Finding' }] }] }) };
  };
  const snapshot = { lines: [{ id: '2', text: 'Either party may terminate on thirty days notice.' }] };
  assert.equal(await reviewWithOpenAI('test-only', 'Explain the risk neutrally', snapshot, new AbortController().signal,
    ['cleo-negotiation-prep'], { request }), 'Finding');
  const input = JSON.parse(body.input);
  assert.deepEqual(input.workflowReferences.map(x => x.id), ['cleo-contract-risk-review', 'cleo-negotiation-prep']);
  assert.deepEqual(input.visibleExcerpt, snapshot.lines);
  assert.equal(body.store, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reviewWithOpenAI('test-only', 'Explain', snapshot, controller.signal, [],
    { request: () => assert.fail('Cancelled review reached provider') }), { name: 'AbortError' });
});

test('accepted review deduplicates, reports actual completion and cancellation suppresses results', async () => {
  let finish;
  const delivered = [];
  const reviews = new VoiceReviews(() => new Promise(resolve => { finish = resolve; }), (...args) => delivered.push(args));
  const snapshot = { lines: [{ id: '0', text: 'Example clause.' }] };
  const first = reviews.start('Explain it', snapshot);
  assert.equal(first.accepted, true);
  assert.equal(reviews.start('Explain it', snapshot).id, first.id);
  assert.equal(reviews.status(first.id).status, 'running');
  await new Promise(resolve => setImmediate(resolve));
  reviews.cancel(first.id); finish('must not be announced');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reviews.status(first.id).status, 'cancelled');
  assert.deepEqual(delivered, []);
  const second = reviews.start('Another question', snapshot);
  await new Promise(resolve => setImmediate(resolve));
  finish('Actual finding');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reviews.status(second.id).status, 'completed');
  assert.deepEqual(delivered, [[second.id, 'Actual finding']]);
  assert.ok(reviews.start('Missing clause', {}).error);
});
