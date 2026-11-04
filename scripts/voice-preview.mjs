import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { RealtimeAgent, RealtimeSession, setSensitiveDataLoggingEnabled } from '@openai/agents/realtime';

// A short, explicitly requested audition. No microphone or screen capture.
setSensitiveDataLoggingEnabled(false);
const credentials = parseEnv(await readFile(process.env.CLEO_VOICE_ENV || '.local/voice.env', 'utf8'));
const apiKey = credentials.OPENAI_API_KEY;
if (!apiKey) throw new Error('No OpenAI key configured.');
const voices = process.argv.slice(2);
if (!voices.length || voices.some(v => !['marin', 'cedar', 'coral', 'sage', 'shimmer'].includes(v))) {
  throw new Error('Choose marin, cedar, coral, sage or shimmer.');
}
await mkdir('output/voice-previews', { recursive: true });
for (const voice of voices) {
  const agent = new RealtimeAgent({ name: 'Cleo voice audition', instructions:
    'Read only the requested script, word for word. Speak warmly, clearly and conversationally, with natural pauses. Do not add an introduction.' });
  const session = new RealtimeSession(agent, { transport: 'websocket', model: 'gpt-realtime-2.1',
    tracingDisabled: true, historyStoreAudio: false,
    config: { outputModalities: ['audio'], audio: { input: { turnDetection: null },
      output: { voice, format: { type: 'audio/pcm', rate: 24000 } } } } });
  const chunks = [];
  try {
    await new Promise((complete, fail) => {
      const timer = setTimeout(() => fail(new Error('Preview timed out.')), 45000);
      let requested = false;
      const reject = () => { clearTimeout(timer); fail(new Error('OpenAI voice preview failed; no provider details logged.')); };
      session.on('error', reject);
      session.on('audio', event => chunks.push(Buffer.from(event.data)));
      session.transport.on('*', event => {
        if (event.type === 'session.updated' && !requested) {
          requested = true;
          session.sendMessage('Read this script: Hi, I’m Cleo, your AI companion. That clause deserves a closer look. Let’s break it down together, one sentence at a time. You can interrupt me whenever you like.');
        }
        if (event.type === 'response.done') {
          clearTimeout(timer);
          if (event.response?.status !== 'completed' || !chunks.length) reject();
          else complete();
        }
      });
      session.connect({ apiKey }).catch(reject);
    });
    const pcm = Buffer.concat(chunks), header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    const path = resolve(`output/voice-previews/cleo-${voice}.wav`);
    await writeFile(path, Buffer.concat([header, pcm]));
    console.log(JSON.stringify({ voice, path, seconds: +(pcm.length / 48000).toFixed(1) }));
  } finally { session.close(); }
}
