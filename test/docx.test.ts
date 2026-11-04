import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { inspectDocx, redlineDocx, sha256 } from '../src/docx.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function fixture(body = '<w:p><w:r><w:t>Notice is </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>sixty</w:t></w:r><w:r><w:t> days.</w:t></w:r></w:p><w:p><w:r><w:t>Payment remains unchanged.</w:t></w:r></w:p>') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`);
  zip.file('word/styles.xml', `<w:styles xmlns:w="${W}"/>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const change = { paragraphId: 'p0', original: 'sixty days', replacement: 'thirty days', reason: 'User requested thirty days.' };

test('edits across formatted runs are native revisions; rejecting recovers original text', async () => {
  const input = await fixture();
  const result = await redlineDocx(input, { sourceSha256: sha256(input), changes: [change] });
  const zip = await JSZip.loadAsync(result.bytes);
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  const del = doc.getElementsByTagNameNS(W, 'del')[0], ins = doc.getElementsByTagNameNS(W, 'ins')[0];
  assert.equal(del.getAttributeNS(W, 'author'), 'Cleo');
  assert.equal(del.textContent, 'sixty');
  assert.equal(ins.textContent, 'thirty');
  assert.equal(del.getElementsByTagNameNS(W, 'b').length, 1);
  assert.equal(ins.getElementsByTagNameNS(W, 'b').length, 1);
  assert.equal(doc.getElementsByTagNameNS(W, 'p')[1].textContent, 'Payment remains unchanged.');
  assert.equal(await zip.file('word/styles.xml')!.async('string'), await (await JSZip.loadAsync(input)).file('word/styles.xml')!.async('string'));
  const paragraph = doc.getElementsByTagNameNS(W, 'p')[0];
  assert.equal(Array.from(paragraph.childNodes).filter(n => n !== ins).map(n => n.textContent).join(''), 'Notice is sixty days.');
  assert.equal(Array.from(paragraph.childNodes).filter(n => n !== del).map(n => n.textContent).join(''), 'Notice is thirty days.');
});

test('stale source, missing wording and duplicate paragraph edits fail closed', async () => {
  const input = await fixture();
  await assert.rejects(redlineDocx(input, { sourceSha256: 'stale', changes: [change] }), /changed/);
  await assert.rejects(redlineDocx(input, { sourceSha256: sha256(input), changes: [{ ...change, original: 'not present' }] }), /exactly once/);
  await assert.rejects(redlineDocx(input, { sourceSha256: sha256(input), changes: [change, change] }), /one replacement/);
});

test('existing revisions are never flattened or accepted', async () => {
  const input = await fixture(`<w:p><w:ins w:id="1"><w:r><w:t>Previous change</w:t></w:r></w:ins></w:p>`);
  await assert.rejects(inspectDocx(input), /Existing revisions/);
});

test('table paragraphs can be edited while links and fields are marked unsupported', async () => {
  const input = await fixture('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>sixty days</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:hyperlink><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>');
  const inspected = await inspectDocx(input);
  assert.deepEqual(inspected.paragraphs.map(p => p.editable), [true, false]);
  await redlineDocx(input, { sourceSha256: inspected.sourceSha256, changes: [change] });
  await assert.rejects(redlineDocx(input, { sourceSha256: inspected.sourceSha256, changes: [{ ...change, paragraphId: 'p1', original: 'link' }] }), /unsupported/);
});

test('ambiguous wording, XML injection, and invalid files are rejected', async () => {
  const input = await fixture('<w:p><w:r><w:t>sixty days or sixty days</w:t></w:r></w:p>');
  await assert.rejects(redlineDocx(input, { sourceSha256: sha256(input), changes: [change] }), /exactly once/);
  await assert.rejects(inspectDocx(Buffer.from('not a DOCX')), /valid .docx/);
  const hostile = await fixture('<!ENTITY unsafe SYSTEM "file:///etc/passwd"><w:p/>');
  await assert.rejects(inspectDocx(hostile), /entity declarations/);
});

test('special characters remain text, deletion-only edits and emoji offsets survive', async () => {
  const input = await fixture('<w:p><w:r><w:t>😀 sixty days &amp; more</w:t></w:r></w:p>');
  for (const replacement of ['', 'thirty & <forty> days']) {
    const result = await redlineDocx(input, { sourceSha256: sha256(input), changes: [{ ...change, replacement }] });
    const zip = await JSZip.loadAsync(result.bytes);
    const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
    const paragraph = doc.getElementsByTagNameNS(W, 'p')[0];
    const accepted = Array.from(paragraph.getElementsByTagNameNS(W, 't')).map(n => n.textContent).join('');
    assert.equal(accepted, '😀 ' + replacement + ' & more');
  }
});

test('whole-clause proposals keep identical text unmarked and anchor explanatory comments', async () => {
  const original = 'Payment is due within sixty days. Fees remain USD 650. Notices must be written.';
  const replacement = 'Payment is due within thirty days. Fees remain USD 650. Notices must be written and delivered by email.';
  const input = await fixture(`<w:p><w:r><w:t>${original}</w:t></w:r></w:p>`);
  const result = await redlineDocx(input, { sourceSha256: sha256(input), changes: [{ paragraphId: 'p0', original, replacement, reason: 'Shorten payment timing and clarify notice delivery.' }] });
  const zip = await JSZip.loadAsync(result.bytes);
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  assert.equal(Array.from(doc.getElementsByTagNameNS(W, 'delText')).map(n => n.textContent).join(''), 'sixty');
  const added = Array.from(doc.getElementsByTagNameNS(W, 'ins')).map(n => n.textContent).join('');
  assert.ok(!added.includes('Fees remain USD 650'));
  assert.ok(added.includes('thirty')); assert.ok(added.includes('and delivered by email'));
  const comments = new DOMParser().parseFromString(await zip.file('word/comments.xml')!.async('string'), 'application/xml');
  const id = comments.getElementsByTagNameNS(W, 'comment')[0].getAttributeNS(W, 'id');
  for (const tag of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) assert.equal(doc.getElementsByTagNameNS(W, tag)[0].getAttributeNS(W, 'id'), id);
  assert.equal(comments.getElementsByTagNameNS(W, 't')[0].textContent, 'Shorten payment timing and clarify notice delivery.');
  assert.match(await zip.file('word/_rels/document.xml.rels')!.async('string'), /relationships\/comments/);
  assert.match(await zip.file('[Content_Types].xml')!.async('string'), /word\/comments.xml/);
  assert.match(await zip.file('word/settings.xml')!.async('string'), /revisionView/);
});

test('existing comments and settings are retained with collision-free new comment IDs', async () => {
  const z = await JSZip.loadAsync(await fixture());
  z.file('word/comments.xml', `<w:comments xmlns:w="${W}"><w:comment w:id="42" w:author="Original reviewer"><w:p><w:r><w:t>Keep original note.</w:t></w:r></w:p></w:comment></w:comments>`);
  z.file('word/settings.xml', `<w:settings xmlns:w="${W}"><w:zoom w:percent="125"/></w:settings>`);
  const input = await z.generateAsync({ type: 'nodebuffer' });
  const result = await redlineDocx(input, { sourceSha256: sha256(input), changes: [change] });
  const saved = await JSZip.loadAsync(result.bytes);
  const comments = new DOMParser().parseFromString(await saved.file('word/comments.xml')!.async('string'), 'application/xml');
  assert.deepEqual(Array.from(comments.getElementsByTagNameNS(W, 'comment')).map(n => n.getAttributeNS(W, 'id')), ['42', '43']);
  assert.match(await saved.file('word/comments.xml')!.async('string'), /Keep original note/);
  assert.match(await saved.file('word/settings.xml')!.async('string'), /125/);
});

test('substantial rewrites remain readable while preserving unchanged wording', async () => {
  const original = 'Company may terminate this agreement at any time. Fees remain payable in full.';
  const replacement = 'Either party can end this agreement upon written notice. Fees remain payable in full.';
  const input = await fixture(`<w:p><w:r><w:t>${original}</w:t></w:r></w:p>`);
  const result = await redlineDocx(input, { sourceSha256: sha256(input), changes: [{paragraphId: 'p0', original, replacement, reason: 'Balance the termination right.'}] });
  const zip = await JSZip.loadAsync(result.bytes);
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  const deleted = Array.from(doc.getElementsByTagNameNS(W, 'delText')).map(n => n.textContent).join('');
  const inserted = Array.from(doc.getElementsByTagNameNS(W, 'ins')).map(n => n.textContent).join('');
  assert.ok(!deleted.includes('Fees remain payable'));
  assert.ok(!inserted.includes('Fees remain payable'));
  assert.ok(result.revisionCount <= 4);
});

test('short unchanged legal words remain outside revision markup', async()=>{
 const original='The supplier shall not disclose confidential information or transfer personal data.';
 const replacement='The processor must not reveal confidential information or sell personal data.';
 const input=await fixture(`<w:p><w:r><w:t>${original}</w:t></w:r></w:p>`);
 const result=await redlineDocx(input,{sourceSha256:sha256(input),changes:[{paragraphId:'p0',original,replacement,reason:'Targeted terminology change.'}]});
 const zip=await JSZip.loadAsync(result.bytes);
 const doc=new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'),'application/xml');
 const del=Array.from(doc.getElementsByTagNameNS(W,'del')).map(n=>n.textContent).join('|');
 const ins=Array.from(doc.getElementsByTagNameNS(W,'ins')).map(n=>n.textContent).join('|');
 for(const text of [del,ins]) { assert.doesNotMatch(text,/\bnot\b|\bor\b|confidential information|personal data/); }
});

test('new exhibit sections retain tracked line breaks and reject a flattened numbered block', async () => {
  const input=await fixture('<w:p><w:r><w:t>Payment within thirty days.</w:t></w:r></w:p>');
  const original='Payment within thirty days.';
  const replacement=original+'\n\nA.1 Reserved IP: [DESCRIBE].\n\nA.2 Equity: [AMOUNT].\n\nA.3 Trigger: [AGREE EVENT].';
  const plan={sourceSha256:sha256(input),changes:[{paragraphId:'p0',original,replacement,reason:'Keep new terms separately readable.'}]};
  const result=await redlineDocx(input,plan);
  const zip=await JSZip.loadAsync(result.bytes);
  const doc=new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'),'application/xml');
  const inserted=Array.from(doc.getElementsByTagNameNS(W,'ins'));
  assert.equal(inserted.reduce((n,e)=>n+e.getElementsByTagNameNS(W,'br').length,0),6);
  assert.equal(doc.getElementsByTagNameNS(W,'del').length,0,'unchanged payment wording stays untouched');
  await assert.rejects(redlineDocx(input,{...plan,changes:[{...plan.changes[0],replacement:replacement.replaceAll('\n',' ')}]}),/Separate new numbered sections/);
});
