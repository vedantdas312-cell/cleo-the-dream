import { mkdir, mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, requirement, assertSameRequirement, exists, command } from './desktop-install.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or later to build Cleo.');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'desktop');
let signingConfig = {};
try { signingConfig = JSON.parse(await readFile(join(root, '.local', 'desktop-signing.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const signingIdentity = process.env.CLEO_CODESIGN_IDENTITY || signingConfig.identity;
if (!signingIdentity || signingIdentity === '-') throw new Error('Configure a stable Apple Development identity before building Cleo. No ad-hoc fallback or permission reset is allowed.');
if (signingConfig.identity && signingIdentity !== signingConfig.identity) throw new Error('Refusing to override the configured signing identity.');
if (process.env.CLEO_BUILD_APP_NAME && process.env.CLEO_BUILD_APP_NAME !== 'Cleo.app') throw new Error('Use the canonical output/Cleo.app; alternate launchable bundles cause ambiguous permission checks.');
if (signingIdentity !== '-') {
  const identities = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (identities.status !== 0 || !identities.stdout.includes(signingIdentity)) {
    throw new Error('The configured signing identity is unavailable. Restore its private key in Keychain; Cleo was not replaced.');
  }
}
await import('./build-notepad.mjs');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed. Fix the reported build error before launching.`);
}
run('swift', ['build', '--package-path', desktop]);
const result = spawnSync('swift', ['build', '--package-path', desktop, '--show-bin-path'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('Could not locate the Swift build.');
await mkdir(join(root, '.local/desktop-staging'), { recursive: true });
const stage = await mkdtemp(join(root, '.local/desktop-staging/build-'));
const app = join(stage, 'Cleo.app');
const bundle = join(app, 'Contents');
await mkdir(join(bundle, 'MacOS'), { recursive: true });
await mkdir(join(bundle, 'Resources'), { recursive: true });
await copyFile(join(result.stdout.trim(), 'CleoDesktop'), join(bundle, 'MacOS', 'CleoDesktop'));
const buildID = createHash('sha256').update(await readFile(join(bundle, 'MacOS', 'CleoDesktop'))).digest('hex').slice(0, 16);
for (const notice of ['Glide-LICENSE', 'Clicky-LICENSE']) {
  await copyFile(join(desktop, 'ThirdParty', notice), join(bundle, 'Resources', notice));
}
await writeFile(join(bundle, 'Info.plist'), JSON.stringify({
  CFBundleIdentifier: 'dev.vdfrz.cleo.source-preview',
  CFBundleName: 'Cleo', CFBundleDisplayName: 'Cleo', CFBundleExecutable: 'CleoDesktop',
  CFBundlePackageType: 'APPL', CFBundleVersion: '3', CFBundleShortVersionString: '0.3.0',
  NSMicrophoneUsageDescription: 'Cleo listens while your voice session is active so you can discuss the clause you point to. Audio is sent to OpenAI. Stop or dismiss Cleo to turn the microphone off.',
  CleoNodeExecutable: process.execPath, CleoWorkspace: root, CleoBuildID: buildID,
  LSMinimumSystemVersion: '13.0', LSUIElement: true, NSHighResolutionCapable: true
}));
run('/usr/bin/plutil', ['-convert', 'xml1', join(bundle, 'Info.plist')]);
run('/usr/bin/codesign', ['--force', '--sign', signingIdentity, app]);
run('/usr/bin/codesign', ['--verify', '--strict', app]);
const canonical = join(root, 'output/Cleo.app');
if (await exists(canonical)) assertSameRequirement(requirement(canonical), requirement(app));
if (process.argv.includes('--stage-only')) {
  console.log(`Verified staged build ${buildID}: ${app}. The installed app is unchanged.`);
} else {
  const installed = await install(root, app);
  await rm(stage, { recursive: true });
  console.log(`Installed signed build ${buildID} at ${installed.app}. Previous build: ${installed.backup ?? 'none'}.`);
  if (process.argv.includes('--launch')) command('/usr/bin/open', ['-n', installed.app]);
}
