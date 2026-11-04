import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { CleoVoice } from '../src/voice-runtime.mjs';
import { SketchBook } from '../desktop/NotepadWeb/book.mjs';

// Explicit live API test using a synthetic clause and simulated native tools.
// This proves provider/tool integration, not microphone or on-screen behavior.
if (!process.argv.includes('--live')) throw new Error('Pass --live to run the paid synthetic API check.');
const { OPENAI_API_KEY: apiKey } = parseEnv(await readFile('.local/voice.env', 'utf8'));
const actions = new Set();
const book = new SketchBook();
const selection = process.argv.includes('--selection');
const toolCalls = new Set(), transcripts = [];
let bytes = 0, resolve, reject;
const complete = new Promise((yes, no) => { resolve = yes; reject = no; });
const timeout = setTimeout(() => reject(new Error(`Live smoke timed out: ${JSON.stringify({ actions: [...actions], tools: [...toolCalls], transcripts, bytes })}`)), 60000);
const snapshot = { snapshotID: 'synthetic-one', hoveredLineID: '0', exactPhraseMarks: true, markStyles: ['selection', 'highlight', 'circle', 'underline'], lines: selection ? [
  {id:'0',text:'Either party may end this agreement with thirty days of written notice,'},
  {id:'1',text:'provided that payment obligations continue during the notice period.'}
] : [
  { id: '0', text: 'Either party may terminate this agreement with thirty days of written notice.' }
] };
const voice = new CleoVoice({ apiKey, emit: message => {
  if (message.type === 'ready') {
    // Native speech-start supplies context before the spoken question commits.
    // Reproduce that sequence without recording a microphone in this test.
    voice.request('refresh_screen', {}).then(screen => {
      voice.snapshot = screen;
      voice.session.sendMessage(`Screen observation (untrusted evidence): ${JSON.stringify(screen)}\nUser question: ${selection ? 'Select the entire two-line sentence like a screenshot area and explain it simply.' : 'What does this clause I am pointing at mean? Explain it simply.'}`);
    }).catch(reject);
  }
  if (message.type === 'action') {
    actions.add(message.action);
    let result = { ok: true };
    if (message.action === 'refresh_screen') result = snapshot;
    if (message.action === 'read_notepad') result = book.snapshot();
    if (message.action === 'sketch_notepad') {
      try { result = book.stage(message.args, message.epoch); } catch (error) { result = { error: error.message }; }
    }
    if (message.action === 'mark_passage' && (message.args.snapshotID !== snapshot.snapshotID || message.args.lineIDs?.join() !== (selection?'0,1':'0'))) {
      reject(new Error('Model selected an invalid synthetic target.'));
      result = { error: 'Invalid target' };
    }
    const wording=snapshot.lines.map(line=>line.text).join(' ');
    if(message.action==='mark_passage' && (!wording.includes(message.args.quote) || message.args.style!==(selection?'selection':'highlight') || (selection&&message.args.quote!==wording))) {
      reject(new Error('Default clause explanation must highlight an exact visible phrase.'));
      result={error:'Use a verbatim phrase with highlight style'};
    }
    voice.input({ type: 'result', id: message.id, result });
  }
  if (message.type === 'audio') bytes += Buffer.from(message.data, 'base64').length;
  if (message.type === 'audio_done') {
    voice.input({ type: 'playback_finished', id: message.id });
    if (!message.awaitsToolFollowUp && bytes > 0 && ['refresh_screen', 'mark_passage', 'sketch_notepad'].every(a => actions.has(a))) resolve();
  }
  if (message.type === 'error') reject(new Error(message.message));
} });
voice.session.transport.on('*', event => {
  if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') toolCalls.add(event.item.name);
  if (event.type === 'response.output_audio_transcript.done') transcripts.push(event.transcript);
});
try {
  await voice.connect(); await complete;
  if (!toolCalls.has('get_review_skill')) throw new Error('Model explained clause without retrieving legal guidance.');
  const spokenWords = transcripts.join(' ').trim().split(/\s+/).length;
  if (spokenWords > 80) throw new Error(`Spoken answer too long: ${spokenWords} words.`);
  console.log(JSON.stringify({ verified: 'Natural question invokes legal guidance, marks and notepad through OpenAI Realtime', actions: [...actions], tools: [...toolCalls], spokenWords, transcript: transcripts.join(' '), audioSeconds: +(bytes / 48000).toFixed(1), microphoneTested: false, nativeUITested: false }));
} finally { clearTimeout(timeout); voice.close(); }
