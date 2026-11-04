import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {RealtimeSession} from '@openai/agents/realtime';
import {MeetingRealtime} from '../src/meeting-realtime.ts';
import {MeetingSessions,type PublicDocument,type OwnerMeetingEvent} from '../src/meeting-session.ts';
import {MeetingIntelligence} from '../src/meeting-intelligence.ts';
import {MeetingTransport} from '../src/meeting-transport.ts';
import {Attendee} from '../src/attendee.ts';

const doc={title:'Saved agreement',paragraphs:[{id:'p1',text:'Payment is due in thirty days.'},{id:'p2',text:'Notice is ten days.'}],redlines:[{id:'r1',paragraphId:'p1',original:'thirty days',replacement:'sixty days'},{id:'r2',paragraphId:'p2',original:'ten days',replacement:'twenty days'}]};
class Session extends EventEmitter {
  static latest:Session; sent:any[]=[];inputs:ArrayBuffer[]=[];config:any;agent:any;
  transport=Object.assign(new EventEmitter(),{sendEvent:(event:any)=>this.sent.push(event)});
  constructor(agent:any,config:any){super();this.agent=agent;this.config=config;Session.latest=this;}
  async connect(){} close(){} interrupt(){} sendAudio(bytes:ArrayBuffer){this.inputs.push(bytes);}
  start(){const request=this.sent.findLast(e=>e.type==='response.create');this.transport.emit('*',{type:'response.created',response:{id:'resp',metadata:request.response.metadata}});this.transport.emit('*',{type:'response.output_item.added',response_id:'resp',item:{id:'item'}});}
  audio(bytes=9600){this.emit('audio',{responseId:'resp',data:new Uint8Array(bytes).buffer});}
  done(){this.transport.emit('*',{type:'response.done',response:{id:'resp',status:'completed',output:[{type:'message',content:[{type:'audio',transcript:'Hello! How can I help?'}]}]}});}
}
test('conversation streams before completion, at bounded cadence; interruption truncates only sent PCM and never replays',async()=>{
 const packets:any[]=[],diagnostics:string[]=[];let transcript='';
 const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,send:p=>(packets.push(p),true),Session:Session as unknown as typeof RealtimeSession,diagnose:e=>diagnostics.push(e),onPublicTranscript:t=>{transcript=t;}});
 await voice.connect();const session=Session.latest;
 const result=voice.respond({document:doc,dialogue:['Hello Cleo!']},{revision:1});session.start();session.audio();
 assert.equal(packets.length,1,'first audio is sent before response.done');assert.equal(packets[0].data.sample_rate,24000);
 await delay(25);assert.ok(packets.length>=2&&packets.length<=3);
 const count=packets.length;voice.cancel();assert.equal(await result,false);
 const truncate=session.sent.find(e=>e.type==='conversation.item.truncate');assert.equal(truncate.audio_end_ms,count*20);assert.equal(truncate.item_id,'item');
 session.audio();session.done();await delay(50);assert.equal(packets.length,count);assert.equal(transcript,'');assert.ok(diagnostics.includes('meeting_voice_first_frame_sent'));voice.close();
});
test('public request reconstructs document and bounded steering, never forwards unknown private fields',async()=>{
 const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,send:()=>true,Session:Session as unknown as typeof RealtimeSession});await voice.connect();
 const request=voice.respond({document:{...doc,privateNotes:'PRIVATE_SENTINEL'} as any,dialogue:['Hello'],steering:{direction:'clarify',privateText:'PRIVATE_SENTINEL'} as any},{revision:1});
 const session=Session.latest,config=session.config;assert.equal(config.model,'gpt-realtime-2.1');assert.equal(config.config.audio.output.voice,'marin');
 const sent=JSON.stringify(session.sent);assert.doesNotMatch(sent,/PRIVATE_SENTINEL|SCRIPT/);assert.match(session.agent.instructions,/Internal boundaries, not a speech script/);assert.ok(session.sent.at(-1).response.instructions.startsWith(session.agent.instructions));assert.equal(session.sent.at(-1).response.conversation,undefined);
 session.start();session.audio(960);session.done();await delay(25);assert.equal(await request,true);voice.close();
});
test('voice evidence uses chronological public turns once instead of duplicate dialogue copies',async()=>{
 const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,send:()=>true,Session:Session as unknown as typeof RealtimeSession});await voice.connect();
 const publicTurns=[{role:'participant' as const,text:'What does this mean?'},{role:'cleo' as const,text:'It sets the notice period.'}];
 const request=voice.respond({document:doc,dialogue:publicTurns.map(turn=>turn.text),previousSpeech:['It sets the notice period.'],publicTurns},{revision:1});
 const instructions=Session.latest.sent.at(-1).response.instructions,evidence=JSON.parse(instructions.split('PUBLIC EVIDENCE:\n')[1]);
 assert.deepEqual(evidence.publicTurns,publicTurns);assert.equal('dialogue' in evidence,false);assert.equal('previousPublicSpeech' in evidence,false);
 Session.latest.start();Session.latest.audio(960);Session.latest.done();await delay(25);assert.equal(await request,true);voice.close();
});
test('voice reports direct transcription, cancels on human VAD and caps queued audio',async()=>{
 const transcripts:any[]=[],diagnostics:string[]=[];let starts=0;
 const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,send:()=>true,Session:Session as unknown as typeof RealtimeSession,onTranscript:e=>transcripts.push(e),onSpeechStart:()=>starts++,diagnose:e=>diagnostics.push(e)});await voice.connect();
 const pending=voice.respond({document:doc,dialogue:['Hi']},{revision:1});Session.latest.start();Session.latest.audio(48000*31);assert.equal(await pending,false);assert.ok(diagnostics.includes('meeting_voice_backlog_limit'));
 Session.latest.transport.emit('*',{type:'input_audio_buffer.speech_started'});Session.latest.transport.emit('*',{type:'conversation.item.input_audio_transcription.completed',item_id:'turn',transcript:'Hello Cleo'});
 assert.equal(starts,1);assert.deepEqual(transcripts,[{id:'turn',text:'Hello Cleo'}]);voice.close();
});
function store(document:PublicDocument=doc){let now=Date.now();const sessions=new MeetingSessions(':memory:',{now:()=>now});const binding=sessions.create({owner:'owner',sourceId:'saved',meetingUrl:'https://meet.google.com/abc-defg-hij',publicDocument:document});const event=(text:string):OwnerMeetingEvent=>({id:'event-'+(++now),owner:'owner',text,at:new Date(now).toISOString(),channel:'imessage',isDirect:true});return {sessions,binding,event,now:()=>now,advance:(n:number)=>{now+=n;}};}
test('speech, sharing and private guidance have independent revisions; screen leases last five seconds',()=>{
 const f=store(),{sessions:s,binding:b}=f;s.control(b,f.event('take over and share your screen'));const speech=s.lease(b,'speak'),share=s.lease(b,'share'),rev=s.get(b);
 assert.equal(share.expiresAt-f.now(),5000);s.control(b,f.event('Keep this private.'));assert.equal(s.assertLease(speech),true);assert.equal(s.assertLease(share),true);assert.equal(s.get(b).guidanceRevision,rev.guidanceRevision+1);
 s.interruptSpeech(b);assert.throws(()=>s.assertLease(speech));assert.equal(s.assertLease(share),true);assert.equal(s.get(b).takeover,true);assert.equal(s.get(b).guidanceRevision,rev.guidanceRevision+1);
 s.control(b,f.event('wait'));assert.equal(s.get(b).paused,true);assert.equal(s.get(b).takeover,false);assert.equal(s.assertLease(share),true);
 s.control(b,f.event('speak'));const next=s.lease(b,'speak');s.control(b,f.event('stop sharing'));assert.equal(s.assertLease(next),true);assert.throws(()=>s.assertLease(share));s.close();
});
async function transportFixture(options:Record<string,any>={}){
 const f=store(options.document??doc),calls:any[]=[],turns:any[]=[],inputs:any[]=[],scripts:string[]=[];let voiceOptions:any;
 class Voice {constructor(opts:any){voiceOptions=opts;}async connect(){}receiveAudio(){}cancel(){options.onCancel?.();}close(){}async respond(turn:any){turns.push(turn);if(options.onRespond)return options.onRespond(turn);return true;}async speak(text:string){scripts.push(text);if(options.onSpeak)return options.onSpeak(text);return true;}}
 const attendee=new Attendee('fixture',(async(url:any,init:any)=>{const body=init?.body?JSON.parse(init.body):undefined;calls.push(body);if(body?.screenshare_url&&options.beforeShareResponse)await options.beforeShareResponse();return new Response(String(url).endsWith('/bots')?JSON.stringify({id:'bot_fixture',state:'joining'}):null);}) as typeof fetch);
 const transport=new MeetingTransport(f.sessions,{path:':memory:',publicUrl:'https://cleo.example',attendee,openaiKey:'fixture',Voice:Voice as any,now:f.now,captionFallbackMs:30,intent:{resolve:async(input:any)=>{inputs.push(input);return {addressed:!input.text.includes('weather'),command:{action:input.text.includes('take over')?'takeover':'speak'}};}},...options,...(options.intelligenceFactory?{intelligence:options.intelligenceFactory(f.sessions)}:{})});
 const server=createServer();transport.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');await transport.join(f.binding);
 const body=calls[0],token=new URL(body.webhooks[0].url).pathname.split('/').at(-1)!;
 const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}${new URL(body.websocket_settings.audio.url).pathname}`);await once(ws,'open');await delay(5);
 return {...f,transport,calls,turns,inputs,scripts,voice:()=>voiceOptions,token,close:async()=>{await transport.close();await new Promise<void>(r=>server.close(()=>r()));f.sessions.close();}};
}
test('direct greeting and followup bypass private intelligence; captions dedupe, chatter stays silent, takeover persists',async()=>{
 const f=await transportFixture({intelligence:{reply:async()=>{throw new Error('No private gate in conversation');}},steering:()=>({direction:'clarify',allowProposals:false})});
 try{
  f.sessions.control(f.binding,f.event('PRIVATE_SENTINEL'));f.voice().onTranscript({id:'one',text:'Hello Cleo!'});await delay(10);assert.equal(f.turns.length,1);assert.deepEqual(f.turns[0].dialogue,['Hello Cleo!']);assert.doesNotMatch(JSON.stringify(f.turns),/PRIVATE_SENTINEL/);
  await f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:'caption',trigger:'transcript.update',data:{speaker_uuid:'any-participant',timestamp_ms:f.now(),transcription:{transcript:'Hello, Cleo.'}}});await delay(45);assert.equal(f.turns.length,1);
  f.voice().onTranscript({id:'two',text:'And what does the payment change mean?'});await delay(10);assert.equal(f.turns.length,2);
  f.voice().onTranscript({id:'three',text:'Nice weather today.'});await delay(10);assert.equal(f.turns.length,2);
  f.voice().onTranscript({id:'four',text:'Could you take over the discussion?'});await delay(10);assert.equal(f.sessions.get(f.binding).takeover,true);
  f.voice().onSpeechStart();f.voice().onSpeechStop();assert.equal(f.sessions.get(f.binding).takeover,true);
  f.voice().onTranscript({id:'five',text:'wait'});await delay(10);assert.equal(f.sessions.get(f.binding).paused,true);
 }finally{await f.close();}
});
test('explicit ordinary questions reach voice without the intent wait; proposals retain model routing and review',async()=>{
 const events:string[]=[];
 const f=await transportFixture({diagnose:(_b:any,event:string)=>events.push(event),intent:{resolve:async(input:any)=>{f.inputs.push(input);await delay(40);return {addressed:true,command:{action:'propose'}};}}});
 try{
  f.voice().onTranscript({id:'fast-question',text:'Cleo, what does the saved payment change mean?'});await delay(10);
  assert.equal(f.turns.length,1);assert.equal(f.inputs.length,0);assert.ok(events.includes('meeting_direct_fast_path'));
  const proposals=['Cleo, could you offer forty-five days?','Cleo, what wording would you suggest for a new liability cap?','Cleo, why don’t we settle at forty-five days?','Cleo, explain this clause and draft a replacement.'];
  for(const [index,text] of proposals.entries()){
   f.voice().onTranscript({id:'proposal-'+index,text});await delay(10);
   assert.equal(f.inputs.length,index+1);assert.equal(f.turns.length,1,'proposal must wait for interpretation');
   await delay(40);assert.equal(f.turns.length,1);assert.equal(f.scripts.length,0,'no unreviewed proposal can become public audio');
  }
  assert.equal(f.sessions.get(f.binding).share,false);assert.equal(f.sessions.get(f.binding).takeover,false);
 }finally{await f.close();}
});
test('caption fragments do not start and cancel a reply before the matching direct audio turn arrives',async()=>{
 const f=await transportFixture({captionFallbackMs:0,directTranscriptFallbackMs:100});
 try{
  f.voice().onSpeechStart('audio-turn');
  await f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:'fragment',trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:f.now(),transcription:{transcript:'Cleo, explain payment'}}});
  await delay(10);assert.equal(f.inputs.length,0,'caption must not occupy the routing lane during direct speech');
  f.voice().onSpeechStop('audio-turn');f.voice().onTranscript({id:'audio-turn',text:'Cleo, what does the saved payment change mean?'});
  await delay(10);assert.equal(f.turns.length,1);
  await f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:'late-caption',trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:f.now(),transcription:{transcript:'What does that payment change mean, Cleo?'}}});
  await delay(120);assert.equal(f.turns.length,1);assert.equal(f.inputs.length,0,'the addressed question uses the direct route without replay');
 }finally{await f.close();}
});
test('sharing token survives notes, human interruption and navigation; stop revokes immediately',async()=>{
 const f=await transportFixture();try{
  f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
  const links=f.calls.filter(c=>c?.screenshare_url),token=new URL(links[0].screenshare_url).hash.slice(1);assert.equal(f.transport.presentation(token)?.selectedRedlineId,'r1');
  f.sessions.control(f.binding,f.event('Private guidance'));f.sessions.interruptSpeech(f.binding);f.sessions.control(f.binding,f.event('next redline'));await delay(10);
  assert.equal(f.calls.filter(c=>c?.screenshare_url).length,1);assert.equal(f.transport.presentation(token)?.selectedRedlineId,'r2');
  f.sessions.control(f.binding,f.event('stop sharing'));assert.equal(f.transport.presentation(token),undefined);
 }finally{await f.close();}
});
test('caption fallback routes the latest cumulative utterance once and keeps separate fragments',async()=>{
 const f=await transportFixture({directTranscriptFallbackMs:30,fastFollowups:false});
 try{
  f.voice().onSpeechStart('audio-turn');const at=f.now();
  const caption=async(id:string,text:string,start:number,duration:number)=>f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:id,trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:start,duration_ms:duration,transcription:{transcript:text}}});
  await caption('snapshot-1','Cleo, explain',at,100);
  await caption('snapshot-2','Cleo, explain the payment change.',at,300);
  await caption('fragment-2','And the notice period.',at+400,100);
  await caption('reordered-snapshot','Cleo, explain',at,100);
  f.voice().onSpeechStop('audio-turn');await delay(60);
  assert.equal(f.inputs.length,1);assert.equal(f.inputs[0].text,'Cleo, explain the payment change. And the notice period.');
 }finally{await f.close();}
});
test('slow presentation and failed navigation do not block a public greeting or blank saved comparison',async()=>{
 let release!:()=>void;const f=await transportFixture({presenter:{prepare:async()=>{await new Promise<void>(r=>release=r);throw new Error('unavailable');},close:async()=>{},frame:async()=>undefined}});
 try{
  f.sessions.bindGoogleDocument(f.binding,'fixture-google-doc');f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
  f.voice().onTranscript({id:'hello',text:'Hello Cleo'});await delay(10);assert.equal(f.turns.length,1,'greeting does not await presenter');
  release();await delay(10);const token=new URL(f.calls.find(c=>c?.screenshare_url).screenshare_url).hash.slice(1);const view=f.transport.presentation(token);assert.equal(view?.mode,'contract');assert.equal(view?.document.title,doc.title);
 }finally{await f.close();}
});

test('wired private planner applies only bounded steering on the next turn and public greeting carries safe purpose',async()=>{
 const f=await transportFixture({intelligenceFactory:(sessions:MeetingSessions)=>new MeetingIntelligence(sessions,async(policy)=>{assert.match(policy,/Privately direct/);return '{"action":"push_back"}';}),intent:{resolve:async(input:any)=>({addressed:true,command:{action:input.channel==='imessage'&&input.text.includes('say hello')?'greet':input.channel==='imessage'?'note':'speak'}})}});
 try{
  await f.transport.control(f.binding,f.event('PRIVATE_SENTINEL hold firm'));await delay(10);
  await f.transport.control(f.binding,f.event('Please say hello to everyone; PRIVATE_SENTINEL stays private.'));await delay(10);
  assert.equal(f.turns.at(-1).mode,'greeting');assert.equal(f.scripts.length,0);assert.doesNotMatch(JSON.stringify(f.turns),/PRIVATE_SENTINEL/);
  f.voice().onTranscript({id:'question',text:'What does the saved payment wording mean?'});await delay(10);assert.equal(f.turns.at(-1).steering.direction,'explain','old guidance waits for context revalidation');await f.transport.respond(f.binding);assert.equal(f.turns.at(-1).steering.direction,'push_back');
 }finally{await f.close();}
});
test('wired substantive proposal generates only from public context and waits for private approval before script playback',async()=>{
 let release!:(value:string)=>void;const publicInputs:any[]=[];
 const f=await transportFixture({intelligenceFactory:(sessions:MeetingSessions)=>new MeetingIntelligence(sessions,async(policy,input)=>{
   if(policy.startsWith('Privately direct'))return '{"action":"clarify"}';
   if(policy.startsWith('Privately check'))return new Promise<string>(r=>release=r);
   publicInputs.push(input);return '{"respond":true,"text":"For discussion, could we consider forty-five days?"}';
 }),intent:{resolve:async()=>({addressed:true,command:{action:'propose'}})}});
 try{
  f.sessions.control(f.binding,f.event('PRIVATE_SENTINEL confidential constraint'));
  f.voice().onTranscript({id:'proposal-one',text:'Cleo, could you suggest a payment counteroffer?'});await delay(10);
  assert.equal(f.scripts.length,0);assert.equal(f.turns.length,0);assert.doesNotMatch(JSON.stringify(publicInputs),/PRIVATE_SENTINEL/);
  release('{"allow":true}');await delay(10);assert.equal(f.scripts.length,1);assert.match(f.scripts[0],/forty-five/);assert.deepEqual(f.sessions.publicUtterances(f.binding),[f.scripts[0]]);
  f.voice().onTranscript({id:'proposal-two',text:'Could you offer another compromise for payment?'});await delay(10);release('{"allow":false}');await delay(10);assert.equal(f.scripts.length,1);
 }finally{await f.close();}
});

test('human speech cancels an unfinished proposal without revoking sharing or private work; late candidates never replay',async()=>{
 for(const source of ['vad','provider'] as const){
  let release!:(value:any)=>void,signal!:AbortSignal;
  const f=await transportFixture({intent:{resolve:async()=>({addressed:true,command:{action:'propose'}})},intelligence:{reply:async(_binding:any,current:AbortSignal)=>{signal=current;return new Promise(r=>release=r);}}});
  try{
   f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
   const token=new URL(f.calls.find(c=>c?.screenshare_url).screenshare_url).hash.slice(1);
   f.voice().onTranscript({id:'pending-proposal',text:'Cleo, could you suggest a counteroffer?'});await delay(10);
   assert.ok(signal);assert.equal(signal.aborted,false);const previous=f.sessions.get(f.binding);
   if(source==='vad')f.voice().onSpeechStart();
   else await f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:'person-start',trigger:'participant_events.speech_start_stop',data:{participant_uuid:'participant',event_type:'speech_start',timestamp_ms:f.now()}});
   assert.equal(signal.aborted,true,`${source} must cancel proposal generation before audio exists`);
   assert.equal(f.sessions.get(f.binding).guidanceRevision,previous.guidanceRevision);
   assert.equal(f.sessions.get(f.binding).shareRevision,previous.shareRevision);assert.ok(f.transport.presentation(token));
   if(source==='vad')f.voice().onSpeechStop();
   else await f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:'person-stop',trigger:'participant_events.speech_start_stop',data:{participant_uuid:'participant',event_type:'speech_stop',timestamp_ms:f.now()}});
   // Even a cancellation-ignoring planner returning a fresh lease cannot revive it.
   release({text:'For discussion, consider forty-five days.',lease:f.sessions.lease(f.binding,'speak')});await delay(10);
   assert.equal(f.scripts.length,0);assert.equal(f.sessions.publicUtterances(f.binding).length,0);
  }finally{await f.close();}
 }
});

test('prepared playback rechecks human speech after asynchronous voice acquisition',async()=>{
 const f=await transportFixture();try{
  f.sessions.control(f.binding,f.event('speak'));const lease=f.sessions.lease(f.binding,'speak');
  const pending=f.transport.speak(f.binding,{text:'A reviewed proposal.',lease});
  f.voice().onSpeechStart();
  assert.equal(await pending,false);assert.equal(f.scripts.length,0);
  f.voice().onSpeechStop();await delay(10);assert.equal(f.scripts.length,0,'discarded playback is not queued for later');
 }finally{await f.close();}
});

class AudioClock {
 time=0;nextId=0;tasks=new Map<number,{at:number;callback:()=>void}>();
 now=()=>this.time;
 schedule=(callback:()=>void,delayMs:number)=>{const id=++this.nextId;this.tasks.set(id,{at:this.time+delayMs,callback});return {cancel:()=>{this.tasks.delete(id);}};};
 step(lateMs=0){
  const next=[...this.tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!next)return false;
  this.tasks.delete(next[0]);this.time=Math.max(this.time,next[1].at)+lateMs;next[1].callback();return true;
 }
}

test('streamed and reviewed audio keep their phase through repeated timer and send overhead',async()=>{
 for(const mode of ['stream','script'] as const){
  const clock=new AudioClock(),sent:number[]=[];
  const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,audioClock:clock,send:()=>{sent.push(clock.time);clock.time+=3;return true;},Session:Session as unknown as typeof RealtimeSession});await voice.connect();
  const result=mode==='stream'?voice.respond({document:doc,dialogue:['Hi']},{revision:1}):voice.speak('Hello! How can I help?',{revision:1});
  Session.latest.start();Session.latest.audio(960*100);Session.latest.done();
  for(let i=0;i<110&&clock.step(2);i++){}
  assert.equal(await result,true);assert.equal(sent.length,100);
  assert.equal(sent[0],0);assert.equal(sent.at(-1),1982,`${mode}: overhead must not accumulate across 100 frames`);
  assert.ok(sent.every((at,i)=>i===0||Math.abs(at-i*20)<=2));assert.equal(clock.tasks.size,0);voice.close();
 }
});

test('both audio paths rebase after a missed frame without catch-up bursts and cancel the next scheduled frame',async()=>{
 for(const mode of ['stream','script'] as const){
  const clock=new AudioClock(),sent:number[]=[];
  const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,audioClock:clock,send:()=>{sent.push(clock.time);clock.time+=3;return true;},Session:Session as unknown as typeof RealtimeSession});await voice.connect();
  const result=mode==='stream'?voice.respond({document:doc,dialogue:['Hi']},{revision:1}):voice.speak('Hello! How can I help?',{revision:1});
  Session.latest.start();Session.latest.audio(960*100);Session.latest.done();
  assert.equal(sent.length,1);clock.step(80);assert.equal(sent.length,2,'one frame only after a long event-loop stall');
  const resumed=sent[1];clock.step();assert.equal(sent.length,3);assert.ok(sent[2]-resumed>=20,'the stall must not cause an immediate catch-up frame');
  voice.cancel();assert.equal(await result,false);assert.equal(clock.tasks.size,0);assert.equal(clock.step(),false);assert.equal(sent.length,3);voice.close();
 }
});

test('a greeting requests one friendly acknowledgement without an agenda or negotiation steering',async()=>{
 const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,send:()=>true,Session:Session as unknown as typeof RealtimeSession});await voice.connect();
 const result=voice.respond({document:doc,dialogue:['Hello Cleo'],mode:'greeting',steering:{direction:'defer'}},{revision:1});
 const instructions=Session.latest.sent.at(-1).response.instructions;
 assert.match(instructions,/one short, warm acknowledgement/);assert.match(instructions,/No agenda/);assert.doesNotMatch(instructions,/at most three short sentences|Generic approach:|ask a neutral clarifying question/);
 voice.cancel();assert.equal(await result,false);voice.close();
});

test('stop, share, stop with new utterance IDs revokes the second share in both ingress paths',async()=>{
 for(const source of ['direct','caption'] as const){
  const f=await transportFixture({captionFallbackMs:0,intent:{resolve:async()=>({addressed:true,command:{action:'share'}})}});
  try{
   const utterance=async(id:string,text:string)=>{
    f.advance(10);
    if(source==='direct')f.voice().onTranscript({id,text});
    else await f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:id,trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:f.now(),transcription:{transcript:text}}});
    await delay(10);
   };
   f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
   await utterance('first-stop','stop sharing');assert.equal(f.sessions.get(f.binding).share,false);
   await utterance('share-again','share your screen');assert.equal(f.sessions.get(f.binding).share,true);
   const token=new URL(f.calls.filter(c=>c?.screenshare_url).at(-1).screenshare_url).hash.slice(1);
   await utterance('second-stop','stop sharing');assert.equal(f.sessions.get(f.binding).share,false);assert.equal(f.transport.presentation(token),undefined);
  }finally{await f.close();}
 }
});

test('fresh repeated greetings and followups are retained while only one direct-caption counterpart is deduplicated',async()=>{
 const f=await transportFixture({captionFallbackMs:0});try{
  const direct=async(id:string,text:string)=>{f.advance(10);f.voice().onTranscript({id,text});await delay(10);};
  const caption=async(id:string,text:string)=>{f.advance(10);await f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:id,trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:f.now(),transcription:{transcript:text}}});await delay(10);};
  await direct('hello-one','Hello Cleo');await caption('hello-one-caption','Hello, Cleo!');assert.equal(f.turns.length,1);
  await direct('hello-two','Hello Cleo');assert.equal(f.turns.length,2);
  await direct('followup-one','Could you explain that again?');await direct('followup-two','Could you explain that again?');assert.equal(f.turns.length,4);
  // A fresh same-source caption is also an utterance, not a global text duplicate.
  await caption('caption-question-one','Which clause is that?');await caption('caption-question-two','Which clause is that?');assert.equal(f.turns.length,6);
  await direct('hello-two','Hello Cleo');assert.equal(f.turns.length,6,'an actual repeated event ID remains idempotent');
  await direct('revised-question','Could you explain that again with the payment change?');assert.equal(f.turns.length,7,'a substring is not an utterance identity');
 }finally{await f.close();}
});

test('private focus selects the same saved redline for speech and the existing shared view once',async()=>{
 const f=await transportFixture({intelligenceFactory:(sessions:MeetingSessions)=>new MeetingIntelligence(sessions,async()=>'{"action":"focus","redlineId":"r2"}')});
 try{
  f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
  const token=new URL(f.calls.find(c=>c?.screenshare_url).screenshare_url).hash.slice(1);
  f.voice().onTranscript({id:'focus-question',text:'What should we discuss next?'});await delay(10);
  await f.transport.respond(f.binding);
  assert.equal(f.turns.at(-1).selectedRedlineId,'r2');assert.equal(f.transport.presentation(token)?.selectedRedlineId,'r2');assert.equal(f.calls.filter(c=>c?.screenshare_url).length,1);
  // Once applied, the same private directive cannot drag a later selection back.
  f.sessions.control(f.binding,f.event('previous redline'));
  f.voice().onTranscript({id:'focus-followup',text:'What does this clause mean?'});await delay(10);
  assert.equal(f.turns.at(-1).selectedRedlineId,'r1');assert.equal(f.transport.presentation(token)?.selectedRedlineId,'r1');
 }finally{await f.close();}
});

test('an existing private focus does not override explicit walkthrough progression or later navigation',async()=>{
 const f=await transportFixture({intelligenceFactory:(sessions:MeetingSessions)=>new MeetingIntelligence(sessions,async()=>'{"action":"focus","redlineId":"r2"}'),intent:{resolve:async(input:any)=>({addressed:true,command:{action:input.text.includes('walk us')?'walkthrough':input.text.includes('previous')?'previous':'speak'}})}});
 try{
  f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
  const token=new URL(f.calls.find(c=>c?.screenshare_url).screenshare_url).hash.slice(1);
  await f.transport.control(f.binding,f.event('walk us through the redlines'));await delay(10);
  assert.deepEqual(f.turns.map(t=>t.selectedRedlineId),['r1']);assert.equal(f.transport.presentation(token)?.selectedRedlineId,'r1');
  f.sessions.control(f.binding,f.event('next redline'));await delay(10);
  await f.transport.control(f.binding,f.event('previous redline'));await delay(10);
  f.voice().onTranscript({id:'explicit-followup',text:'Could you explain where we are now?'});await delay(10);
  assert.equal(f.turns.at(-1).selectedRedlineId,'r1');assert.equal(f.transport.presentation(token)?.selectedRedlineId,'r1');
 }finally{await f.close();}
});

test('a provider share taking longer than five seconds keeps the same live grant and token',async()=>{
 let release!:()=>void;
 const f=await transportFixture({beforeShareResponse:()=>new Promise<void>(resolve=>release=resolve)});
 try{
  f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
  const started=f.calls.find(c=>c?.screenshare_url),token=new URL(started.screenshare_url).hash.slice(1),generation=f.sessions.get(f.binding).shareRevision;
  f.advance(6000);release();await delay(10);
  assert.equal(f.transport.presentation(token)?.generation,generation);assert.equal(f.transport.presentation(token)?.leaseMs,5000);
  assert.equal(f.calls.filter(c=>c?.screenshare_url==='').length,0,'network delay does not revoke an unchanged sharing grant');
 }finally{await f.close();}
});

test('presentation frames reject mismatched expected selection both before and after frame retrieval',async()=>{
 let release!:(frame:any)=>void,calls=0;
 const f=await transportFixture({presenter:{prepare:async()=>{},close:async()=>{},frame:async()=>{calls++;return new Promise(resolve=>release=resolve);}}});
 try{
  f.sessions.bindGoogleDocument(f.binding,'fixture-google-doc');f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
  const token=new URL(f.calls.find(c=>c?.screenshare_url).screenshare_url).hash.slice(1);
  assert.equal(await f.transport.presentationFrame(token,'r2'),undefined);assert.equal(await f.transport.presentationFrame(token,null),undefined);assert.equal(calls,0);
  const pending=f.transport.presentationFrame(token,'r1');assert.equal(calls,1);
  f.sessions.control(f.binding,f.event('next redline'));await delay(10);release({imageB64:'/9j/',mimeType:'image/jpeg'});
  assert.equal(await pending,undefined,'r1 request must not receive a later r2 image');
  const current=f.transport.presentationFrame(token,'r2');release({imageB64:'/9j/',mimeType:'image/jpeg'});assert.ok(await current);
 }finally{await f.close();}
});


test('owner steering waits for the current sentence, then continues without cancellation or private words',async()=>{
 let finish!:(ok:boolean)=>void,cancels=0;
 const f=await transportFixture({onCancel:()=>{cancels++;},onRespond:async(turn:any)=>turn.continuation?true:new Promise<boolean>(r=>finish=r),
  intelligenceFactory:(sessions:MeetingSessions)=>new MeetingIntelligence(sessions,async()=>'{"action":"push_back"}'),
  intent:{resolve:async(input:any)=>({addressed:true,command:{action:input.channel==='imessage'?'note':'speak'}})}});
 try{
  f.voice().onTranscript({id:'public-question',text:'Cleo, what does the payment change mean?'});await delay(10);
  assert.equal(f.turns.length,1);const before=cancels;
  await f.transport.control(f.binding,f.event('PRIVATE_SENTINEL push harder on this'));await delay(10);
  assert.equal(cancels,before);assert.equal(f.turns.length,1,'no restart during the current sentence');
  finish(true);await delay(10);
  assert.equal(f.turns.length,2);assert.equal(f.turns[1].continuation,true);assert.equal(f.turns[1].steering.direction,'push_back');
  assert.equal(cancels,before);assert.doesNotMatch(JSON.stringify(f.turns),/PRIVATE_SENTINEL/);
 }finally{await f.close();}
});

test('private text question answers from call context without cancelling or extending public speech',async()=>{
 let finish!:(ok:boolean)=>void,cancels=0,privateInput:any;
 const f=await transportFixture({onCancel:()=>{cancels++;},onRespond:async()=>new Promise<boolean>(r=>finish=r),
  intelligenceFactory:(sessions:MeetingSessions)=>new MeetingIntelligence(sessions,async(policy,input)=>{
   if(policy.startsWith('Privately direct'))return '{"action":"none"}';privateInput=input;return '{"text":"Ask why they need sixty days."}';
  }),intent:{resolve:async(input:any)=>({addressed:true,command:{action:input.channel==='imessage'?'remind':'speak'}})}});
 try{
  f.voice().onTranscript({id:'public-context',text:'We need sixty days for payment, Cleo.'});await delay(10);const before=cancels;
  const reply=await f.transport.control(f.binding,f.event('What should I say next?'));
  assert.ok('private_reminder' in reply);assert.equal(reply.private_reminder,'Ask why they need sixty days.');assert.equal(reply.reminder_audience,'owner_imessage_only');
  assert.deepEqual(privateInput.public_transcript,['We need sixty days for payment, Cleo.']);assert.match(JSON.stringify(privateInput.latest_owner_notes),/What should I say next/);
  assert.equal(cancels,before);finish(true);await delay(10);assert.equal(f.turns.length,1);
 }finally{await f.close();}
});

test('explicit stop cancels immediately and prevents sentence continuation',async()=>{
 let finish!:(ok:boolean)=>void,cancels=0;
 const f=await transportFixture({onCancel:()=>{cancels++;},onRespond:async()=>new Promise<boolean>(r=>finish=r)});
 try{
  f.voice().onTranscript({id:'q',text:'Cleo, explain payment.'});await delay(10);const before=cancels;
  await f.transport.control(f.binding,f.event('stop speaking'));assert.ok(cancels>before);finish(true);await delay(10);
  assert.equal(f.turns.length,1);assert.equal(f.sessions.get(f.binding).speak,false);
 }finally{await f.close();}
});

test('caption context alone never generates unsolicited private messages',async()=>{
 let sends=0;const f=await transportFixture({messenger:{send:async()=>{sends++;return {status:'queued'};}},intent:{resolve:async()=>({addressed:false,command:{action:'note'}})}});
 try{f.voice().onTranscript({id:'context',text:'Would sixty days work for payment?'});await delay(10);assert.equal(sends,0);assert.deepEqual(f.sessions.recentTranscript(f.binding),['Would sixty days work for payment?']);}
 finally{await f.close();}
});


test('reviewed proposal finishes its sentence before adopting new guidance',async()=>{
 let finish!:(ok:boolean)=>void,cancels=0;
 const f=await transportFixture({onCancel:()=>{cancels++;},onSpeak:async()=>new Promise<boolean>(r=>finish=r),
  intelligenceFactory:(sessions:MeetingSessions)=>({steer:async()=>({action:'push_back'}),reply:async()=>({text:'Consider forty-five days. This is a provisional suggestion.',lease:sessions.lease(sessions.active('owner')!,'speak')})}),
  intent:{resolve:async(input:any)=>({addressed:true,command:{action:input.channel==='imessage'?'note':'propose'}})}});
 try{
  f.voice().onTranscript({id:'proposal',text:'Cleo, could you suggest a counteroffer?'});await delay(10);assert.equal(f.scripts.length,1);const before=cancels;
  await f.transport.control(f.binding,f.event('Push harder on this'));await delay(10);assert.equal(cancels,before);
  finish(true);await delay(10);assert.equal(f.scripts.length,1);assert.equal(f.turns.length,1);assert.equal(f.turns[0].continuation,true);assert.equal(f.turns[0].steering.direction,'push_back');
 }finally{await f.close();}
});

test('late steering for an old topic is discarded after the room moves on',async()=>{
 let release!:(value:any)=>void,calls=0;
 const f=await transportFixture({intelligence:{reply:async()=>undefined,steer:async()=>{
  calls++;if(calls===2)return new Promise(r=>release=r);return {action:'none'};
 }},intent:{resolve:async(input:any)=>({addressed:input.channel==='imessage',command:{action:'note'}})}});
 try{
  f.sessions.control(f.binding,f.event('Push harder on payment'));await delay(10);assert.ok(release);
  f.voice().onTranscript({id:'new-topic',text:'Payment is settled for now; let us discuss notice.'});await delay(10);
  release({action:'push_back'});await delay(10);f.sessions.control(f.binding,f.event('speak'));
  await f.transport.respond(f.binding);assert.equal(f.turns.at(-1).steering.direction,'explain');
 }finally{await f.close();}
});

test('follow-up context remains chronological after six Cleo replies and expires after quiet',async()=>{
 const f=await transportFixture();
 try{
  for(let i=0;i<7;i++){
   f.sessions.transcript(f.binding,{id:'earlier-'+i,text:'Question '+i,at:new Date(f.now()).toISOString()});
   f.advance(1);f.sessions.recordPublicSpeech(f.binding,'Answer '+i);f.advance(1);
  }
  f.voice().onTranscript({id:'followup',text:'Could you make that simpler?'});await delay(10);
  const input=f.inputs.at(-1);
  assert.equal(input.conversationActive,true);
  assert.deepEqual(input.recentPublicTurns.slice(-3),['Participant: Question 6','Cleo: Answer 6','Participant: Could you make that simpler?']);
  f.sessions.control(f.binding,f.event('wait'));
  assert.equal((f.transport as any).intentInput(f.binding,'Side conversation','meeting').conversationActive,false);
  f.sessions.control(f.binding,f.event('speak'));f.advance(91000);
  assert.equal((f.transport as any).intentInput(f.binding,'Unrelated topic','meeting').conversationActive,false);
 }finally{await f.close();}
});

test('VAD, interpretation and response carry the same opaque turn ID without content in diagnostics',async()=>{
 const events:any[]=[];const f=await transportFixture({vadProfile:'server_300',diagnose:(_b:any,event:string,context:any)=>events.push({event,context})});
 try{
  f.voice().onSpeechStart('provider-secret-id');f.voice().onSpeechStop('provider-secret-id');
  f.voice().onTranscript({id:'provider-secret-id',text:'Hello Cleo, PRIVATE_CONTENT'});await delay(10);
  const stop=events.find(e=>e.event==='meeting_room_speech_stopped');
  const start=events.find(e=>e.event==='meeting_tool_started'&&e.context.operation==='intent');
  const end=events.find(e=>e.event==='meeting_tool_completed'&&e.context.operation==='intent');
  assert.ok(stop.context.turnId);assert.equal(start.context.turnId,stop.context.turnId);
  assert.equal(start.context.spanId,end.context.spanId);assert.equal(f.turns[0].traceContext.turnId,stop.context.turnId);
  assert.equal(stop.context.profile,'server_300');assert.doesNotMatch(JSON.stringify(events),/PRIVATE_CONTENT|provider-secret-id/);
 }finally{await f.close();}
});

test('voice records response creation and first generated audio separately from paced send',async()=>{
 const events:any[]=[];const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,send:()=>true,Session:Session as unknown as typeof RealtimeSession,vadProfile:'server_500',diagnose:(event,context)=>events.push({event,context})});
 await voice.connect();
 try{
  assert.equal(Session.latest.config.config.audio.input.turnDetection.silenceDurationMs,500);
  const result=voice.respond({document:doc,dialogue:['Talk to me like a friend'],traceContext:{turnId:'12345678-1234-1234-1234-123456789012'}},{revision:1});
  Session.latest.start();Session.latest.audio(960);Session.latest.done();assert.equal(await result,true);
  const stages=events.filter(e=>['meeting_voice_response_requested','meeting_voice_response_created','meeting_voice_first_audio_received','meeting_voice_first_frame_sent'].includes(e.event));
  assert.equal(stages.length,4);assert.equal(new Set(stages.map(e=>e.context.spanId)).size,1);
  assert.ok(stages.every(e=>e.context.turnId==='12345678-1234-1234-1234-123456789012'));
  assert.doesNotMatch(JSON.stringify(events),/friend|Payment/);
 }finally{voice.close();}
});

test('known-speaker clarification skips interpretation, waits for questions and never skips controls or unknown speakers',async()=>{
 const events:string[]=[];
 const f=await transportFixture({diagnose:(_b:any,event:string)=>events.push(event),intent:{resolve:async(input:any)=>{f.inputs.push(input);return {addressed:true,command:{action:'explain'}};}}});
 const room=async(id:string,text:string,speaker?:string)=>{
  f.advance(2);f.voice().onSpeechStart(id);
  if(speaker)await f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:'caption-'+id,trigger:'transcript.update',data:{speaker_uuid:speaker,timestamp_ms:f.now(),transcription:{transcript:text}}});
  f.voice().onSpeechStop(id);f.voice().onTranscript({id,text});await delay(15);
 };
 try{
  await room('start','Please discuss this edit with me.','alice-provider-id');assert.equal(f.inputs.length,1);
  assert.equal(f.transport.status(f.binding).walkthrough,'waiting_for_questions');
  const speaker=f.inputs[0].speakerId;assert.match(speaker,/^speaker-[a-f0-9]{16}$/);
  await room('follow','Can you make that simpler?','alice-provider-id');assert.equal(f.inputs.length,1);assert.equal(f.turns.length,2);
  assert.equal(f.sessions.get(f.binding).selectedRedlineId,'r1');assert.ok(events.includes('meeting_followup_fast_path'));
  const dialogue=f.sessions.publicDialogue(f.binding);assert.equal(dialogue.at(-1)?.speakerId,speaker);assert.ok(dialogue.at(-1)?.traceId);
  assert.doesNotMatch(JSON.stringify(f.turns),/alice-provider-id/);
  await room('control','Can you explain that and share your screen?','alice-provider-id');assert.equal(f.inputs.length,2);
  await room('other','Can you make that simpler?','bob-provider-id');assert.equal(f.inputs.length,3);
  await room('unknown','Can you make that simpler?');assert.equal(f.inputs.length,4);
  f.sessions.control(f.binding,f.event('wait'));assert.equal(f.transport.status(f.binding).walkthrough,'off');
  await room('paused','Can you make that simpler?','bob-provider-id');assert.equal(f.inputs.length,5);
 }finally{await f.close();}
});

test('generated draft shares saved passages, waits after each explanation and follows explicit navigation',async()=>{
 const document:PublicDocument={title:'Draft for review',paragraphs:[{id:'p1',text:'Each party must protect confidential information.'},{id:'p2',text:'The duties last two years.'}],redlines:[],sections:[{id:'s1',paragraphId:'p1'},{id:'s2',paragraphId:'p2'}]};
 const f=await transportFixture({document,intent:{resolve:async(input:any)=>{f.inputs.push(input);return {addressed:true,command:input.text.includes('next')?{action:'combined',actions:[{action:'next'},{action:'explain'}]}:{action:'explain'}};}}});
 try{
  f.sessions.control(f.binding,f.event('share your screen'));await delay(10);
  const token=new URL(f.calls.find(c=>c?.screenshare_url).screenshare_url).hash.slice(1);
  assert.equal(f.transport.presentation(token)?.selectedSectionId,'s1');assert.equal(f.transport.presentation(token)?.mode,'contract');
  assert.deepEqual(f.transport.presentation(token)?.document.sections,document.sections);
  f.voice().onTranscript({id:'draft-start',text:'Walk me through this document.'});await delay(20);
  assert.equal(f.turns.length,1);assert.equal(f.turns[0].selectedSectionId,'s1');assert.equal(f.turns[0].mode,'walkthrough');
  assert.equal(f.transport.status(f.binding).walkthrough,'waiting_for_questions');
  await delay(30);assert.equal(f.turns.length,1);assert.equal(f.sessions.get(f.binding).selectedSectionId,'s1');
  f.voice().onTranscript({id:'draft-question',text:'What does that mean in practice?'});await delay(20);
  assert.equal(f.turns.length,2);assert.equal(f.turns.at(-1).selectedSectionId,'s1');
  assert.deepEqual(f.inputs.at(-1).sections,[{id:'s1',text:document.paragraphs[0].text},{id:'s2',text:document.paragraphs[1].text}]);
  f.voice().onTranscript({id:'draft-next',text:'Explain the next passage.'});await delay(20);
  assert.equal(f.turns.length,3);assert.equal(f.turns.at(-1).selectedSectionId,'s2');assert.equal(f.transport.presentation(token)?.selectedSectionId,'s2');
  assert.equal(f.calls.filter(c=>c?.screenshare_url).length,1);
  f.sessions.control(f.binding,f.event('stop sharing'));await delay(10);assert.equal(f.transport.presentation(token),undefined);
 }finally{await f.close();}
});

for(const vad of [false,true])test(`direct-first caption-second enriches stored dialogue and enables the next identified followup (VAD=${vad})`,async()=>{
 const f=await transportFixture({intent:{resolve:async(input:any)=>{f.inputs.push(input);return {addressed:true,command:{action:'explain'}};}}});
 const caption=async(id:string,text:string,at:number,speaker='alice')=>f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:id,trigger:'transcript.update',data:{speaker_uuid:speaker,timestamp_ms:at,transcription:{transcript:text}}});
 try{
  const at=f.now();if(vad){f.voice().onSpeechStart('first');f.advance(300);f.voice().onSpeechStop('first');}
  f.voice().onTranscript({id:'first',text:'Please discuss this edit with me.'});await delay(15);
  assert.equal(f.sessions.publicDialogue(f.binding).at(-1)?.speakerId,undefined);assert.equal(f.turns.length,1);
  await caption('late-first','Please discuss this edit with me.',at);await delay(45);
  const speaker=f.sessions.publicDialogue(f.binding).at(-1)?.speakerId;assert.match(speaker??'',/^speaker-[a-f0-9]{16}$/);
  assert.equal(f.turns.length,1,'metadata must not replay speech');assert.equal(f.inputs.length,1);
  f.advance(500);f.voice().onSpeechStart('follow');await caption('follow-caption','Can you make that simpler?',f.now());
  f.voice().onSpeechStop('follow');f.voice().onTranscript({id:'follow',text:'Can you make that simpler?'});await delay(15);
  assert.equal(f.turns.length,2);assert.equal(f.inputs.length,1,'identified followup skips interpretation');
  assert.equal(f.sessions.publicDialogue(f.binding).at(-1)?.speakerId,speaker);
  assert.doesNotMatch(JSON.stringify(f.sessions.publicDialogue(f.binding)),/alice/);
 }finally{await f.close();}
});

test('caption metadata arriving during response reaches completed dialogue state without restarting audio',async()=>{
 let finish!:(v:boolean)=>void;
 const f=await transportFixture({onRespond:()=>new Promise<boolean>(resolve=>{finish=resolve;}),intent:{resolve:async(input:any)=>{f.inputs.push(input);return {addressed:true,command:{action:'explain'}};}}});
 const caption=async(id:string,text:string,at:number)=>f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:id,trigger:'transcript.update',data:{speaker_uuid:'alice',timestamp_ms:at,transcription:{transcript:text}}});
 try{
  const at=f.now();f.voice().onSpeechStart('first');f.advance(300);f.voice().onSpeechStop('first');f.voice().onTranscript({id:'first',text:'Explain this edit.'});await delay(10);
  await caption('late','Explain this edit.',at);finish(true);await delay(10);
  f.advance(500);f.voice().onSpeechStart('follow');await caption('follow','Can you make that simpler?',f.now());f.voice().onSpeechStop('follow');f.voice().onTranscript({id:'follow',text:'Can you make that simpler?'});await delay(10);
  assert.equal(f.inputs.length,1);assert.equal(f.turns.length,2);finish(true);await delay(5);
 }finally{await f.close();}
});

test('speaker enrichment is bound to the original event and trace; conflicting identity cannot be restored',()=>{
 const f=store(),s=f.sessions,b=f.binding,trace='12345678-1234-1234-1234-123456789012';
 try{
  s.transcript(b,{id:'turn',text:'Question',at:new Date(f.now()).toISOString(),traceId:trace});
  s.enrichTranscriptSpeaker(b,{id:'turn',traceId:'wrong',speakerId:'speaker-aaaaaaaaaaaaaaaa'});assert.equal(s.speakerForTurn(b,trace),undefined);
  s.enrichTranscriptSpeaker(b,{id:'wrong',traceId:trace,speakerId:'speaker-aaaaaaaaaaaaaaaa'});assert.equal(s.speakerForTurn(b,trace),undefined);
  s.enrichTranscriptSpeaker(b,{id:'turn',traceId:trace,speakerId:'unvalidated'});assert.equal(s.speakerForTurn(b,trace),undefined);
  s.enrichTranscriptSpeaker(b,{id:'turn',traceId:trace,speakerId:'speaker-aaaaaaaaaaaaaaaa'});assert.equal(s.speakerForTurn(b,trace),'speaker-aaaaaaaaaaaaaaaa');
  s.enrichTranscriptSpeaker(b,{id:'turn',traceId:trace,speakerId:'speaker-bbbbbbbbbbbbbbbb'});assert.equal(s.speakerForTurn(b,trace),undefined);
  s.enrichTranscriptSpeaker(b,{id:'turn',traceId:trace,speakerId:'speaker-aaaaaaaaaaaaaaaa'});assert.equal(s.speakerForTurn(b,trace),undefined);
  assert.equal(s.publicDialogue(b).length,1);assert.equal(s.publicDialogue(b)[0].speakerId,undefined);
 }finally{s.close();}
});

test('a late caption for an older turn never assigns its speaker to the current conversation',async()=>{
 const f=await transportFixture({intent:{resolve:async(input:any)=>{f.inputs.push(input);return {addressed:true,command:{action:'explain'}};}}});
 const caption=async(id:string,text:string,at:number)=>f.transport.webhook(f.token,{bot_id:'bot_fixture',idempotency_key:id,trigger:'transcript.update',data:{speaker_uuid:'alice',timestamp_ms:at,transcription:{transcript:text}}});
 try{
  const oldAt=f.now();f.voice().onTranscript({id:'old',text:'Explain payment.'});await delay(10);
  f.advance(1000);f.voice().onTranscript({id:'new',text:'Explain notice.'});await delay(10);
  await caption('old-caption','Explain payment.',oldAt);await delay(45);
  const dialogue=f.sessions.publicDialogue(f.binding);assert.ok(dialogue[0].speakerId);assert.equal(dialogue[1].speakerId,undefined);assert.equal(f.turns.length,2);
  f.advance(1000);f.voice().onSpeechStart('follow');await caption('follow-caption','Can you make that simpler?',f.now());f.voice().onSpeechStop('follow');f.voice().onTranscript({id:'follow',text:'Can you make that simpler?'});await delay(10);
  assert.equal(f.inputs.length,3,'old turn metadata cannot authorize a same-speaker shortcut for the newer turn');
 }finally{await f.close();}
});

test('empty chronological evidence falls back to supplied dialogue without dropping the current request',async()=>{
 const voice=new MeetingRealtime({apiKey:'fixture',valid:()=>true,send:()=>true,Session:Session as unknown as typeof RealtimeSession});await voice.connect();
 try{
  const result=voice.respond({document:doc,dialogue:['What does this clause mean?'],previousSpeech:['We were discussing payment.'],publicTurns:[]},{revision:1});
  const request=Session.latest.sent.at(-1).response;
  const evidence=JSON.parse(request.instructions.split('PUBLIC EVIDENCE:\n')[1]);
  assert.deepEqual(evidence.dialogue,['What does this clause mean?']);assert.deepEqual(evidence.previousPublicSpeech,['We were discussing payment.']);
  assert.ok(request.instructions.startsWith(Session.latest.agent.instructions),'response override retains standing policy');
  Session.latest.start();Session.latest.audio(960);Session.latest.done();await delay(25);assert.equal(await result,true);
 }finally{voice.close();}
});
