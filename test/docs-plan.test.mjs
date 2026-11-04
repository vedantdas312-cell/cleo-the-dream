import test from 'node:test';
import assert from 'node:assert/strict';
import { planReplacement, approvalDigest } from '../src/docs-plan.mjs';

export function fixture(text = 'Notice is sixty days.\n') {
  return {
    documentId: 'synthetic-doc', revisionId: 'rev-1',
    tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      { startIndex: 1, endIndex: 1 + text.length, paragraph: { elements: [
        { startIndex: 1, endIndex: 1 + text.length, textRun: { content: text } },
      ] } },
    ] } } }],
  };
}
const change = { tabId: 't.0', original: 'sixty days', replacement: 'thirty days' };

test('creates suggested replacement with revision protection and explicit tab', () => {
  const plan = planReplacement(fixture(), change);
  assert.deepEqual(plan.body.writeControl, { writeMode: 'SUGGEST', requiredRevisionId: 'rev-1' });
  assert.deepEqual(plan.body.requests, [
    { insertText: { location: { index: 21, tabId: 't.0' }, text: 'thirty days' } },
    { deleteContentRange: { range: { startIndex: 11, endIndex: 21, tabId: 't.0' } } },
  ]);
});
test('handles UTF-16 and excerpts crossing formatting runs', () => {
  const doc = fixture('📄 Notice is sixty days.\n');
  const paragraph = doc.tabs[0].documentTab.body.content[1].paragraph;
  paragraph.elements = [
    { startIndex: 1, endIndex: 17, textRun: { content: '📄 Notice is six' } },
    { startIndex: 17, endIndex: 26, textRun: { content: 'ty days.\n' } },
  ];
  // Fixture offsets intentionally validated against real UTF-16 lengths below.
  paragraph.elements[0].endIndex = 1 + paragraph.elements[0].textRun.content.length;
  paragraph.elements[1].startIndex = paragraph.elements[0].endIndex;
  paragraph.elements[1].endIndex = paragraph.elements[1].startIndex + paragraph.elements[1].textRun.content.length;
  assert.equal(planReplacement(doc, change).body.requests[1].deleteContentRange.range.startIndex, 14);
});
test('refuses missing, duplicated and overlapping ambiguous excerpts', () => {
  assert.throws(() => planReplacement(fixture('Other text\n'), change), /found 0/);
  assert.throws(() => planReplacement(fixture('sixty days and sixty days\n'), change), /found 2/);
  assert.throws(() => planReplacement(fixture('aaa\n'), { ...change, original: 'aa' }), /found 2/);
});
test('refuses stale-selection hazards: unknown tab, no revision, existing suggestions', () => {
  assert.throws(() => planReplacement(fixture(), { ...change, tabId: 'missing' }), /existing/);
  assert.throws(() => planReplacement({ ...fixture(), revisionId: undefined }, change), /revision/);
  const doc = fixture();
  doc.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.suggestedInsertionIds = ['old'];
  assert.throws(() => planReplacement(doc, change), /existing suggestions/);
});
test('refuses structure edits and changes approval when wording changes', () => {
  assert.throws(() => planReplacement(fixture(), { ...change, replacement: 'thirty\ndays' }), /single-line/);
  const doc = fixture();
  doc.tabs[0].documentTab.body.content.push({ table: {} });
  assert.throws(() => planReplacement(doc, change), /tables/);
  assert.notEqual(approvalDigest(planReplacement(fixture(), change)),
    approvalDigest(planReplacement(fixture(), { ...change, replacement: 'twenty days' })));
});
