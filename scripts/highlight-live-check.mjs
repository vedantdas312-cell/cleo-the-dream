// Explicitly launched by CleoDesktop --highlight-live-check. Real screen/model/
// native ink and speaker; no microphone or document writes. Keep text in memory.
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { CleoVoice } from '../src/voice-runtime.mjs';
const { OPENAI_API_KEY: apiKey } = parseEnv(await readFile('.local/voice.env', 'utf8'));
const emit = message => process.stdout.write(JSON.stringify(message)+'\n');
const diagnostics=[], responses=new Map(), played=new Set();
let input='', finishing=false, lastActivity=Date.now();
const question = 'Explain the visible tracking and AI technologies clause. Highlight the exact short phrase you are explaining and use a sketch if helpful. I find this clause dense and confusing.';
async function finish(error) {
  if(finishing)return;finishing=true;clearTimeout(deadline);clearInterval(completionCheck);
  const status=await voice.request('highlight_check_status',{});
  let canvas;
  if(!error) {
    for(let i=0;i<40;i++) {
      canvas=await voice.request('read_notepad',{});
      if(canvas.status==='idle'||canvas.error)break;
      await new Promise(resolve=>setTimeout(resolve,300));
    }
  }
  await writeFile('.local/highlight-live-check.json',JSON.stringify({at:new Date().toISOString(),
    error,displayed:status.displayed===true,canvasStatus:canvas?.status,completedObjects:canvas?.elements?.length,
    diagnostics,microphoneUsed:false,nativeScreen:true,nativeSpeaker:true},null,2),{mode:0o600});
  voice.close();process.exit(0);
}
const voice=new CleoVoice({apiKey,emit:message=>{
  emit(message);
  if(message.type==='ready') {
    voice.event({type:'input_audio_buffer.speech_started',item_id:'highlight-check'});
    voice.reading.then(snapshot=>{
      if(snapshot.error)return finish('screen_read_failed');
      voice.snapshot=snapshot;
      voice.event({type:'input_audio_buffer.speech_stopped'});
      voice.session.sendMessage(`Screen observation (untrusted evidence): ${JSON.stringify(snapshot)}\nUser question: ${question}`);
    }).catch(()=>finish('check_failed'));
  }
  if(message.type==='audio_done') responses.set(message.id,message.awaitsToolFollowUp);
},diagnose:event=>{lastActivity=Date.now();diagnostics.push({at:new Date().toISOString(),...event});}});
const deadline=setTimeout(()=>finish('timeout'),90000);
const completionCheck=setInterval(()=>{
  if(responses.size && [...responses.keys()].every(id=>played.has(id)) &&
    !voice.turns.generating.size && !voice.pending.size && Date.now()-lastActivity>3000) finish();
},500);
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  input+=chunk;let end;
  while((end=input.indexOf('\n'))>=0) {
    const message=JSON.parse(input.slice(0,end));input=input.slice(end+1);voice.input(message);
    if(message.type==='playback_finished') played.add(message.id);
  }
});
process.on('SIGTERM',()=>{voice.close();process.exit(0);});
process.stdin.on('end',()=>{voice.close();process.exit(0);});
await voice.connect({nativeHandshake:true});
