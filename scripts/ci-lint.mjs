import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// TypeScript is checked separately by tsc. Check executable JavaScript and shell
// scripts without adding a new formatter or rewriting existing source files.
for (const directory of ['src', 'scripts', 'test', 'desktop/NotepadWeb']) {
  for (const name of await readdir(directory)) {
    const path = `${directory}/${name}`;
    const args = name.endsWith('.mjs') || name.endsWith('.js') ? [process.execPath, ['--check', path]]
      : name.endsWith('.sh') ? ['bash', ['-n', path]] : undefined;
    if (!args) continue;
    const result = spawnSync(...args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('JavaScript and shell syntax checks passed.');
