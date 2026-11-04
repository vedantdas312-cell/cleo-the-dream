import { inspectDesktopSource } from '../src/desktop-source.ts';
import { DocumentError } from '../src/docx.ts';

try {
  const [path, expectedSha256, extra] = process.argv.slice(2);
  if (!path || extra !== undefined) throw new DocumentError('Select one DOCX source.');
  console.log(JSON.stringify({ ok: true, source: await inspectDesktopSource(path, expectedSha256) }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof DocumentError ? error.message
    : 'The selected file could not be read. Check its location and access, then select it again.' }));
  process.exitCode = 1;
}
