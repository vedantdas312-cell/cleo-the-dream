import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { inspectDesktopSource } from '../src/desktop-source.ts';
import { sha256, MAX_FILE_BYTES } from '../src/docx.ts';

async function fixture(revised = false) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${revised ? '<w:ins>' : ''}<w:r><w:t>Notice is sixty days.</w:t></w:r>${revised ? '</w:ins>' : ''}</w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('desktop picker source preserves bytes and exact paragraph/hash identity across rereads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cleo-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'Contract with spaces; $literal.docx'), bytes = await fixture();
  await writeFile(path, bytes);
  const source = await inspectDesktopSource(path);
  assert.equal(source.sourceSha256, sha256(bytes));
  assert.equal(source.byteLength, bytes.length);
  assert.deepEqual(source.paragraphs, [{ id: 'p0', text: 'Notice is sixty days.', editable: true, style: 'Normal' }]);
  assert.match(source.coverage.scope, /Headers/);
  assert.deepEqual(await inspectDesktopSource(path, source.sourceSha256), source);
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/desktop-source.ts', path]);
  assert.deepEqual(JSON.parse(stdout), { ok: true, source });
  assert.deepEqual(await readFile(path), bytes);
  await writeFile(path, await fixture(true));
  await assert.rejects(inspectDesktopSource(path, source.sourceSha256), /changed/);
  await assert.rejects(inspectDesktopSource(path), /Existing revisions/);
});

test('desktop source rejects wrong formats, invalid versions, directories and oversized inputs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cleo-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'input.docx');
  await assert.rejects(inspectDesktopSource('relative.docx'), /local .docx/);
  await assert.rejects(inspectDesktopSource(join(dir, 'input.pdf')), /local .docx/);
  await assert.rejects(inspectDesktopSource(path, 'not-a-version'), /Invalid source version/);
  await mkdir(path);
  await assert.rejects(inspectDesktopSource(path), /regular/);
  await rm(path, { recursive: true });
  await writeFile(path, Buffer.alloc(MAX_FILE_BYTES + 1));
  await assert.rejects(inspectDesktopSource(path), /10 MB/);
  await writeFile(path, 'not a Word document');
  await assert.rejects(inspectDesktopSource(path), /valid .docx/);
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/desktop-source.ts', join(dir, 'missing.docx')]), (error: any) => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.ok, false);
    assert.match(result.error, /could not be read/);
    assert.ok(!result.error.includes(dir));
    return true;
  });
});
