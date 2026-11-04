import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { CleoVoice } from '../src/voice-runtime.mjs';
import { MatterContext } from '../src/matter-context.ts';
import { Supermemory } from '../src/supermemory.ts';
import { VoiceContext } from '../src/voice-context.mjs';
import { DesktopContextClient } from '../src/desktop-context-client.mjs';
import { openSync, writeSync, closeSync, renameSync } from 'node:fs';

const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let voice;
try {
  const env = parseEnv(await readFile(process.env.CLEO_VOICE_ENV || '.local/voice.env', 'utf8'));
  if (!env.OPENAI_API_KEY) throw new Error('Missing key');
  // Numeric levels and event names only. Never retain audio, text, IDs or keys.
  // Retain four bounded prior sessions so a reconnect cannot erase the failure.
  // Diagnostics must not block startup and never retain user audio or text.
  let diagnosticFile;
  try {
    for (let i = 3; i >= 0; i--) {
      try { renameSync(i ? `.local/voice-diagnostics.${i}.jsonl` : '.local/voice-diagnostics.jsonl', `.local/voice-diagnostics.${i + 1}.jsonl`); } catch {}
    }
    diagnosticFile = openSync('.local/voice-diagnostics.jsonl', 'w', 0o600);
  } catch {}
  let diagnosticBytes = 0;
  const diagnose = event => {
    if (diagnosticFile === undefined || diagnosticBytes >= 1000000) return;
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
      diagnosticBytes += writeSync(diagnosticFile, line);
    } catch { try { closeSync(diagnosticFile); } catch {} diagnosticFile = undefined; }
  };
  let context;
  try {
    const paired = parseEnv(await readFile('.local/context.env','utf8'));
    if (paired.CLEO_CONTEXT_URL && paired.CLEO_DESKTOP_TOKEN) {
      context = new VoiceContext(new DesktopContextClient(paired.CLEO_CONTEXT_URL,paired.CLEO_DESKTOP_TOKEN), 'server-bound');
    } else if (paired.CLEO_CONTEXT_OWNER && paired.CLEO_CONTEXT_DB) {
      const memory = parseEnv(await readFile('.local/supermemory.env','utf8'));
      context = new VoiceContext(new MatterContext(paired.CLEO_CONTEXT_DB,
        memory.SUPERMEMORY_API_KEY ? new Supermemory(memory.SUPERMEMORY_API_KEY) : undefined), paired.CLEO_CONTEXT_OWNER);
    }
  } catch { diagnose({event:'shared_context_not_configured'}); }
  voice = new CleoVoice({ apiKey: env.OPENAI_API_KEY, emit, diagnose, context });
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
    if (input.length > 512000) { voice.fail('Voice input exceeded its limit.'); return; }
    let end;
    while ((end = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      try { voice.input(JSON.parse(line)); }
      catch { voice.fail('Invalid voice input.'); }
    }
  });
  process.stdin.on('end', () => voice.close());
  process.on('SIGTERM', () => { voice.close(); process.exit(0); });
  process.on('uncaughtException', () => { voice.fail('Voice session stopped unexpectedly.'); process.exit(1); });
  await voice.connect({ nativeHandshake: true });
} catch {
  emit({ type: 'error', message: 'Add an OpenAI key to the local voice credentials file.' });
  process.exitCode = 1;
}
