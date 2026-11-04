// Run only through CleoDesktop --notepad-live-check. Uses the actual native canvas
// and speaker with two synthetic spoken turns; no microphone or screen capture.
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { CleoVoice } from '../src/voice-runtime.mjs';
const { OPENAI_API_KEY: apiKey } = parseEnv(await readFile('.local/voice.env', 'utf8'));
const emit = message => process.stdout.write(JSON.stringify(message)+'\n');
const receipts = [], transcripts = [], diagnostics = [], finishedResponses = new Map();
let turn = 0, checking = false, initialIDs = [], input = '', finishing = false;
let injectedRejection = false;
const changingClauses = process.argv.includes('--multiclause') || await readFile('.local/notepad-multiclause-check', 'utf8').then(() => true, () => false);
function ask(question) {
  if (changingClauses) {
    voice.event({type:'input_audio_buffer.speech_started',item_id:`fixture-${turn}`});
    voice.event({type:'input_audio_buffer.speech_stopped'});
  }
  voice.session.sendMessage(question);
}
const voice = new CleoVoice({ apiKey, emit: message => {
  if (message.type === 'ready') {
    emit(message);
    ask('Use your sketchbook to explain a fictional agreement that either party can end on 30 days written notice. Draw a short timeline with arrows and labels while you explain. This is an example, not a review of my screen.');
    return;
  }
  if (message.type === 'audio_done') finishedResponses.set(message.id, message.awaitsToolFollowUp);
  // Acceptance only: force a genuine native validation failure on the new
  // clause, then verify the model repairs its next plan in the same session.
  if (changingClauses && turn === 2 && !injectedRejection && message.type === 'action' && message.action === 'sketch_notepad' && message.args.elements?.length) {
    message.args = structuredClone(message.args);
    message.args.elements[0].x = 1000; message.args.elements[0].width = 100;
    injectedRejection = true;
  }
  emit(message);
}, diagnose: event => diagnostics.push(event) });
const timeout = setTimeout(()=>finish({error:'Acceptance run timed out',receipts,transcripts}),changingClauses ? 240000 : 120000);
async function finish(result) {
  if(finishing)return;finishing=true;
  clearTimeout(timeout);
  await writeFile('.local/notepad-live-check.json',JSON.stringify({...result,injectedRejection,diagnostics},null,2),{mode:0o600});
  if (await readFile('.local/notepad-visual-check', 'utf8').then(() => true, () => false)) await new Promise(resolve=>setTimeout(resolve,30000));
  voice.close(); process.exit(0);
}
async function afterSpeech(id) {
  if (finishedResponses.get(id) !== false || checking) return;
  checking = true;
  try {
    // Drawing may finish just after a particularly short spoken answer.
    let snapshot;
    for(let i=0;i<20;i++) {
      snapshot = await voice.request('read_notepad',{});
      if(snapshot.status !== 'drawing') break;
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    receipts.push(snapshot);
    if(snapshot.error || !snapshot.elements?.length || snapshot.status !== 'idle' || snapshot.windowVisible !== true) {
      await finish({error:'Native canvas did not finish the spoken sketch',receipts,transcripts}); return;
    }
    if(turn++ === 0) {
      initialIDs=snapshot.elements.map(e=>e.id);
      await writeFile('.local/notepad-live-check.json',JSON.stringify({stage:'first-sketch-rendered',receipts,transcripts},null,2),{mode:0o600});
      // Leave the actual first drawing visible long enough for inspection.
      await new Promise(resolve=>setTimeout(resolve,5000));
      ask('Add to that same sketch: show in red that payment obligations might continue during those 30 days. Keep the timeline you already drew, and explain the added point briefly.');
    } else {
      const ids=snapshot.elements.map(e=>e.id);
      const preserved=initialIDs.every(id=>ids.includes(id));
      if(changingClauses && turn === 2) {
        if(!preserved || ids.length<=initialIDs.length) {await finish({error:'Follow-up lost the first sketch',receipts,transcripts});return;}
        ask('Now move to a different clause in the same fictional agreement: the recipient must keep confidential information secret for two years after termination, except information already public or required to be disclosed by law. Explain this new clause aloud and sketch how its obligations and exceptions work.');
        return;
      }
      await finish({passed:changingClauses ? snapshot.revision>receipts.at(-2).revision : preserved && ids.length>initialIDs.length,preservedPreviousDrawing:changingClauses ? undefined : preserved,changingClauses,receipts,transcripts,microphoneUsed:false,screenCaptured:false,nativeCanvas:true,nativeSpeaker:true});
    }
  } finally { checking=false; }
}
voice.session.transport.on('*',event=>{
  if(event.type==='response.output_audio_transcript.done')transcripts.push(event.transcript);
});
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  input+=chunk; let end;
  while((end=input.indexOf('\n'))>=0){
    const message=JSON.parse(input.slice(0,end));input=input.slice(end+1);voice.input(message);
    if(message.type==='playback_finished') afterSpeech(message.id).catch(()=>finish({error:'Acceptance run failed',receipts,transcripts}));
  }
});
process.on('SIGTERM',()=>{voice.close();process.exit(0);});
process.stdin.on('end',()=>{voice.close();process.exit(0);});
await voice.connect({ nativeHandshake: true });
