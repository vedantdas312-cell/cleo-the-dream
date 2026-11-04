import { access, mkdir, readdir, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const bundleID = 'dev.vdfrz.cleo.source-preview';
const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
export function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${file} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout;
}
export async function exists(path) { try { await access(path); return true; } catch { return false; } }
export function requirement(app) {
  command('/usr/bin/codesign', ['--verify', '--strict', app]);
  const result = spawnSync('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8' });
  const value = `${result.stdout}\n${result.stderr}`.match(/^designated => (.+)$/m)?.[1];
  if (result.status !== 0 || !value || !value.includes('anchor apple generic') || value.includes('cdhash')) {
    throw new Error('Cleo needs a stable Apple signing identity. The existing app and grants were not changed.');
  }
  return value;
}
export function assertSameRequirement(previous, next) {
  if (previous !== next) throw new Error('The signing requirement changed. Refusing to replace Cleo or reset its permissions.');
}
export async function stopCanonical(app) {
  const executable = join(app, 'Contents/MacOS/CleoDesktop');
  const pids = command('/bin/ps', ['-axo', 'pid=,command=']).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && (match[2] === executable || match[2].startsWith(executable + ' ')) ? [Number(match[1])] : [];
  });
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Cleo is still running. The installed app was not replaced.');
}
export async function install(root, staged) {
  const app = join(root, 'output/Cleo.app');
  const nextRequirement = requirement(staged);
  const installed = await exists(app);
  if (installed) assertSameRequirement(requirement(app), nextRequirement);
  await stopCanonical(app);
  const backups = join(root, '.local/desktop-backups');
  await mkdir(backups, { recursive: true });
  for (const name of await readdir(join(root, 'output'))) {
    if (!name.endsWith('.app') || name === 'Cleo.app') continue;
    const path = join(root, 'output', name);
    const info = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(path, 'Contents/Info.plist')], { encoding: 'utf8' });
    if (info.status !== 0 || info.stdout.trim() !== bundleID) continue;
    // Do not disturb another active development session.
    const running = command('/bin/ps', ['-axo', 'command=']).split('\n').some(line => line.trim().startsWith(join(path, 'Contents/MacOS') + '/'));
    if (running) throw new Error(`Another Cleo copy is running at ${path}. The installed app was not replaced.`);
    command(register, ['-u', path]);
    await rename(path, join(backups, `${Date.now()}-${name}.disabled`));
  }
  const backup = join(backups, `Cleo-${Date.now()}.app.disabled`);
  // Keep recoverable bundles outside LaunchServices discovery and preserve the
  // one canonical path. A failed install restores the original bundle.
  if (installed) await rename(app, backup);
  try { await rename(staged, app); }
  catch (error) { if (installed) await rename(backup, app); throw error; }
  command(register, ['-f', app]);
  return { app, backup: installed ? backup : null };
}
