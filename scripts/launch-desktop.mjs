import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, requirement, stopCanonical } from './desktop-install.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = join(root, 'output/Cleo.app');
requirement(app);
await stopCanonical(app);
command('/usr/bin/open', ['-n', app]);
console.log('Launched the canonical signed Cleo.app. Control-C starts voice.');
