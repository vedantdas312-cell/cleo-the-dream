import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createDraftDocx, validateDraft } from '../src/draft-docx.ts';
import { inspectDocx, redlineDocx } from '../src/docx.ts';

test('new draft retains exact text, escapes XML and can later receive genuine tracked edits', async () => {
  const draft = await createDraftDocx({ title: 'Agreement for A & B', blocks: [
    { kind: 'heading', text: '1 Scope' }, { kind: 'paragraph', text: 'A < B & “C” – café. </w:t><w:ins>literal</w:ins>' },
  ] });
  const inspected = await inspectDocx(draft.bytes);
  assert.deepEqual(inspected.paragraphs.map(p => p.text), [draft.input.title, 'DRAFT FOR REVIEW', ...draft.input.blocks.map(b => b.text)]);
  const zip = await JSZip.loadAsync(draft.bytes);
  assert.ok(!(await zip.file('word/document.xml')!.async('string')).includes('<w:ins>'));
  assert.ok(!(await zip.file('word/_rels/document.xml.rels')!.async('string')).includes('External'));
  const redline = await redlineDocx(draft.bytes, { sourceSha256: draft.outputSha256, changes: [
    { paragraphId: 'p2', original: '1 Scope', replacement: '1 Services', reason: 'User requested this heading.' },
  ] });
  assert.ok(redline.revisionCount > 0);
});

test('rejects malformed, excessive and unsupported draft payloads', () => {
  const valid = { title: 'Draft', blocks: [{ kind: 'paragraph', text: 'Body' }] };
  for (const value of [null, {}, { ...valid, title: '' }, { ...valid, html: '<script/>' },
    { ...valid, blocks: [] }, { ...valid, blocks: [{ kind: 'heading', text: 'Only heading' }] },
    { ...valid, blocks: [{ kind: 'paragraph', text: 'text\u0000' }] },
    { ...valid, blocks: [{ kind: 'paragraph', text: '\ud800' }] },
    { ...valid, blocks: Array(501).fill(valid.blocks[0]) },
    { ...valid, blocks: Array(20).fill({ kind: 'paragraph', text: 'a'.repeat(6000) }) },
  ]) assert.throws(() => validateDraft(value));
});
