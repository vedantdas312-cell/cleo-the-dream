import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleDocs } from '../src/google-docs.mjs';
import { approvalDigest, planReplacement } from '../src/docs-plan.mjs';

const change = { tabId: 't.0', original: 'sixty days', replacement: 'thirty days' };
function document(revisionId = 'r1', suggested = false) {
  let index = 1;
  const texts = suggested ? [
    { content: 'Notice is ' }, { content: 'sixty days', suggestedDeletionIds: ['s1'] },
    { content: 'thirty days', suggestedInsertionIds: ['s2'] }, { content: '.\nPayment remains unresolved.\n' },
  ] : [{ content: 'Notice is sixty days.\nPayment remains unresolved.\n' }];
  const elements = texts.map(textRun => { const startIndex = index; index += textRun.content.length; return { startIndex, endIndex: index, textRun }; });
  return { documentId: 'test-doc', revisionId, tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [{ startIndex: 1, endIndex: index, paragraph: { elements } }] } } }] };
}
function client(responses) {
  const calls = [];
  const api = new GoogleDocs({ accessToken: 'test-only-token', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'Unexpected extra API request');
    return { ok: true, json: async () => next };
  } });
  return { api, calls };
}
test('preview reads only; apply writes suggestions once and verifies original + unchanged text', async () => {
  const { api, calls } = client([document(), document(), { suggestionResponses: [{ createdSuggestionIds: ['s1', 's2'] }] }, document('r2', true)]);
  const plan = await api.preview('test-doc', change);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /SUGGESTIONS_INLINE/u);
  const result = await api.apply(plan, approvalDigest(plan));
  assert.equal(result.status, 'verified-suggestions');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(JSON.parse(calls[2].options.body).writeControl.writeMode, 'SUGGEST');
});
test('missing approval and changed revision never write', async () => {
  const plan = planReplacement(document(), change);
  const { api, calls } = client([document('r2')]);
  await assert.rejects(api.apply(plan, ''), /Approve/);
  assert.equal(calls.length, 0);
  await assert.rejects(api.apply(plan, approvalDigest(plan)), /document changed/);
  assert.equal(calls.length, 1);
});
test('unverified readback does not claim success or repeat the write', async () => {
  const plan = planReplacement(document(), change);
  const { api, calls } = client([document(), { suggestionResponses: [{ createdSuggestionIds: ['s1', 's2'] }] }, document('r2')]);
  await assert.rejects(api.apply(plan, approvalDigest(plan)), /readback is unverified/);
  assert.equal(calls.length, 3);
});
test('lost write response is ambiguous and is never automatically retried', async () => {
  const plan = planReplacement(document(), change);
  const { api, calls } = client([document(), new Error('Connection lost')]);
  await assert.rejects(api.apply(plan, approvalDigest(plan)), /may have reached Google/);
  assert.equal(calls.length, 2);
});
test('a modified request body cannot bypass suggested-edit mode', async () => {
  const plan = planReplacement(document(), change);
  plan.body.writeControl.writeMode = 'EDIT';
  const { api, calls } = client([document()]);
  await assert.rejects(api.apply(plan, approvalDigest(plan)), /preview no longer matches/);
  assert.equal(calls.length, 1);
});
test('readback detects an unrelated clause being changed', async () => {
  const plan = planReplacement(document(), change);
  const after = document('r2', true);
  after.tabs[0].documentTab.body.content[0].paragraph.elements.at(-1).textRun.content = '.\nPayment was changed.\n';
  const { api } = client([document(), { suggestionResponses: [{ createdSuggestionIds: ['s1', 's2'] }] }, after]);
  await assert.rejects(api.apply(plan, approvalDigest(plan)), /readback is unverified/);
});
