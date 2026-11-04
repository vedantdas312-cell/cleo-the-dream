import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { importDocument, structuredTextBlocks, pdfReviewText } from '../src/import-document.ts';
import { inspectDocx, redlineDocx } from '../src/docx.ts';
import { spawnSync } from 'node:child_process';

test('conversion recovers clause and checklist boundaries without changing wording or cross-references', () => {
  const text = '2. Final fee settlement\n2.1 October fee.\nThe Company will pay USD 650 under Section 11.1\nof the Original Agreement.\n2.2 Payment timing\nPayment is due in thirty days.\n\nSCHEDULE A\n☐ Return equipment\n☐ Transfer access';
  const blocks = structuredTextBlocks(text);
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks.filter(b => b.text.startsWith('☐')).length, 2);
  assert.ok(blocks.some(b => b.text.includes('Section 11.1 of the Original Agreement.')));
  assert.equal(blocks.map(b => b.text).join(' '), text.replace(/\s+/g, ' '));
});

// A complete, tiny synthetic PDF; no real contract data is used.
function pdf(pages: string[]) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < pages.length; i++) {
    const stream = `BT /F1 12 Tf 50 750 Td (${pages[i]}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(data);
}

test('native PDF extraction preserves page order and rejects unreadable pages', { skip: spawnSync('pdftotext', ['-v']).error ? 'Requires Poppler; installed in the production image' : false }, async () => {
  const result = await importDocument(pdf(['Notice is sixty days.', 'Payment is monthly.']), 'contract.pdf');
  const text = (await inspectDocx(result.bytes)).paragraphs.map(p => p.text).join('\n');
  assert.match(text, /Notice is sixty days\.\nPayment is monthly\./);
  assert.doesNotMatch(text, /Page [12]/);
  await assert.rejects(importDocument(pdf(['Notice is sixty days.', '']), 'mixed.pdf'), /no extractable text/);
  await assert.rejects(importDocument(pdf(['']), 'scanned.pdf'), /no extractable text/);
});

test('PDF navigation wrappers are excluded, while an in-clause reference to an envelope is preserved',()=>{
 const envelope='Docusign Envelope ID: 12345678-1234-1234-1234-123456789abc';
 const result=pdfReviewText('Annexure A-002 Signed agreement\nThis cover sheet and page labels were added for navigation. Original source files are preserved separately.\f'+envelope+'\n\n1. SERVICES\nThe parties refer to '+envelope+' for the executed copy.\n\nAnnexure A-002 | Page 2 | Source page 1\f');
 assert.deepEqual(result.omittedSourceFurniture,{coverSheets:1,pageLabels:2});
 assert.ok(result.text.startsWith('1. SERVICES'));
 assert.ok(result.text.includes('The parties refer to '+envelope));
 assert.doesNotMatch(result.text,/Annexure|Source page|cover sheet/);
});

for (const ext of ['txt', 'md', 'html', 'htm']) {
  test(`${ext} converts to a disclosed Word baseline and genuine tracked changes`, async () => {
    const text = ext.startsWith('ht') ? '<h1>Agreement</h1><p>Notice is sixty days.</p><script>secretScript()</script><img src="https://invalid.example/tracker">' : 'Agreement\n\nNotice is sixty days.';
    const imported = await importDocument(Buffer.from(text), 'contract.' + ext);
    assert.equal(imported.metadata.converted, true);
    const doc = await inspectDocx(imported.bytes);
    assert.ok(doc.paragraphs[2].text.includes('Converted text-only'));
    assert.ok(!doc.paragraphs.some(p => p.text.includes('secretScript')));
    const p = doc.paragraphs.find(p => p.text === 'Notice is sixty days.'); assert.ok(p);
    const redline = await redlineDocx(imported.bytes, { sourceSha256: doc.sourceSha256, changes: [{ paragraphId: p.id, original: 'sixty', replacement: 'thirty', reason: 'Test' }] });
    const zip = await JSZip.loadAsync(redline.bytes); const xml = await zip.file('word/document.xml')!.async('string');
    assert.ok(xml.includes('<w:ins')); assert.ok(xml.includes('<w:del'));
  });
}
async function slides(empty = false) {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="2" r:id="second"/><p:sldId id="1" r:id="first"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>');
  for (let n = 1; n <= 2; n++) zip.file(`ppt/slides/slide${n}.xml`, `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>${empty ? '' : 'Content ' + n}</a:t></a:r></a:p></p:sld>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
test('PPTX uses presentation order rather than filenames and discloses coverage', async () => {
  const result = await importDocument(await slides(), 'contract.pptx');
  const p = (await inspectDocx(result.bytes)).paragraphs.map(p => p.text);
  assert.ok(p.indexOf('Content 2') < p.indexOf('Content 1'));
  assert.ok(result.metadata.warnings.some(w => w.includes('speaker notes')));
});
test('refuses empty slides, malformed binary files, oversized text and deep truncated HTML', async () => {
  await assert.rejects(importDocument(await slides(true), 'file.pptx'), /no extractable text/);
  for (const ext of ['pdf','doc','ppt']) await assert.rejects(importDocument(Buffer.from('not a document'), 'file.' + ext), /does not match/);
  await assert.rejects(importDocument(Buffer.from('x'.repeat(96_000)), 'file.txt'), /95,000/);
  await assert.rejects(importDocument(Buffer.from('<div>'.repeat(150) + 'Clause' + '</div>'.repeat(150)), 'file.html'), /too complex/);
  await assert.rejects(importDocument(Buffer.from('test'), 'file.exe'), /Supported files/);
});
