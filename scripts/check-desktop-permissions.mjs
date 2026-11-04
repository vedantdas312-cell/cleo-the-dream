import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, requirement, stopCanonical } from './desktop-install.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = join(root, 'output/Cleo.app');
const report = join(root, '.local/desktop-permission-check.json');
requirement(app);
const buildID = command('/usr/bin/plutil', ['-extract', 'CleoBuildID', 'raw', join(app, 'Contents/Info.plist')]).trim();
await stopCanonical(app);
const start = Date.now();
command('/usr/bin/open', ['-n', app, '--args', '--permission-check']);
for (let attempt = 0; attempt < 100; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  let result;
  try { if ((await stat(report)).mtimeMs >= start) result = JSON.parse(await readFile(report, 'utf8')); } catch {}
  if (!result) continue;
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed || result.buildID !== buildID || result.bundlePath !== app || result.parentPID !== 1) {
    throw new Error('Independent permission acceptance failed. No permissions were reset or requested.');
  }
  process.exit(0);
}
throw new Error('Independent permission acceptance timed out. No permissions were reset or requested.');
