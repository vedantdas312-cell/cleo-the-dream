import test from 'node:test';
import assert from 'node:assert/strict';
import {MeetingTranscriptGate, type MeetingTranscript} from '../src/meeting-transcript-gate.ts';

test('direct turn wins over differently segmented captions without waiting for the fallback timer',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const emitted:any[]=[];
  const gate=new MeetingTranscriptGate((event,source)=>emitted.push({event,source}));
  const caption=(id:string,text:string):MeetingTranscript=>({id,text,at:new Date().toISOString()});
  gate.start('turn-one');gate.caption(caption('c1','Cleo, explain'));t.mock.timers.tick(1000);
  gate.caption(caption('c2','the payment change.'));assert.equal(emitted.length,0);
  gate.stop('turn-one');t.mock.timers.tick(600);
  gate.direct('turn-one',caption('d1','Cleo, can you explain the change to payment?'));
  assert.equal(emitted.length,1);assert.equal(emitted[0].source,'direct');
  gate.caption(caption('c3','Explain the payment change'));t.mock.timers.tick(2000);
  assert.equal(emitted.length,1,'late caption wording cannot restart the answer');
  gate.start('turn-two');gate.stop('turn-two');gate.direct('turn-two',caption('d2','Cleo, can you explain the change to payment?'));
  assert.equal(emitted.length,2,'a genuinely repeated question is still a new turn');gate.close();
});

test('missing direct transcription uses captions once; late transcription cannot restart it',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const emitted:any[]=[];const gate=new MeetingTranscriptGate((event,source)=>emitted.push({event,source}));
  const event=(id:string,text:string)=>({id,text,at:new Date().toISOString()});
  gate.start('one');gate.caption(event('c1','Cleo, explain'));t.mock.timers.tick(1);gate.caption(event('c2','the saved change.'));gate.stop('one');
  t.mock.timers.tick(1499);assert.equal(emitted.length,0);t.mock.timers.tick(1);
  assert.equal(emitted.length,1);assert.equal(emitted[0].source,'caption');assert.equal(emitted[0].event.text,'Cleo, explain the saved change.');
  gate.direct('one',event('d1','Cleo, explain the saved edit.'));assert.equal(emitted.length,1);gate.close();
});

test('cumulative caption updates replace the same utterance instead of repeating its prefix',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const emitted:any[]=[];const gate=new MeetingTranscriptGate((event,source)=>emitted.push({event,source}));
  const at=new Date().toISOString();gate.start('one');
  gate.caption({id:'update-1',text:'Cleo, explain',at,speakerId:'person',durationMs:200});
  gate.caption({id:'update-2',text:'Cleo, explain the payment change',at,speakerId:'person',durationMs:600});
  gate.stop('one');t.mock.timers.tick(1500);
  assert.equal(emitted.length,1);assert.equal(emitted[0].event.text,'Cleo, explain the payment change');gate.close();
});

test('caption corrections replace old words and reordered older snapshots cannot overwrite them',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const emitted:any[]=[];const gate=new MeetingTranscriptGate((event)=>emitted.push(event));
  const at=new Date().toISOString();gate.start('one');
  gate.caption({id:'update-1',text:'The term is thirty days.',at,speakerId:'person',durationMs:200});
  gate.caption({id:'update-2',text:'The term is sixty days.',at,speakerId:'person',durationMs:600});
  gate.caption({id:'late-update',text:'The term is thirty days.',at,speakerId:'person',durationMs:200});
  gate.stop('one');t.mock.timers.tick(1500);
  assert.equal(emitted[0].text,'The term is sixty days.');gate.close();
});

test('separate utterances keep chronological order and repeated words, including different speakers',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const emitted:any[]=[];const gate=new MeetingTranscriptGate((event)=>emitted.push(event));
  gate.start('one');
  gate.caption({id:'later',text:'Cleo, explain the payment change.',at:new Date(10200).toISOString(),speakerId:'person'});
  gate.caption({id:'earlier',text:'Cleo, explain',at:new Date(10000).toISOString(),speakerId:'person'});
  gate.caption({id:'other-speaker',text:'Cleo, explain',at:new Date(10000).toISOString(),speakerId:'other-person'});
  gate.stop('one');t.mock.timers.tick(1500);
  assert.equal(emitted[0].text,'Cleo, explain Cleo, explain Cleo, explain the payment change.');gate.close();
});

test('new room speech supersedes old work, and a lost audio stream retains caption fallback',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const emitted:any[]=[];const gate=new MeetingTranscriptGate((event,source)=>emitted.push({event,source}));
  const event={id:'c1',text:'Old question',at:new Date().toISOString()};
  assert.equal(gate.caption(event),false,'caption-only connection has its normal path');
  gate.start('one');gate.caption(event);gate.stop('one');gate.start('two');
  gate.direct('one',{...event,id:'d1'});t.mock.timers.tick(2000);assert.equal(emitted.length,0);
  assert.equal(gate.caption(event),true,'delayed old caption cannot become the new turn');
  t.mock.timers.tick(30000);assert.equal(gate.caption({...event,at:new Date().toISOString()}),false);
  gate.close();assert.equal(gate.caption(event),false);
});

test('Qwen turn correlation and known speaker survive direct and caption paths without guessing mixed voices',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
 const emitted:MeetingTranscript[]=[];const gate=new MeetingTranscriptGate(event=>emitted.push(event));
 const first=gate.start('a',['speaker-one']);gate.stop('a');gate.direct('a',{id:'a',text:'Question',at:new Date().toISOString()});
 assert.equal(emitted[0].traceId,first);assert.equal(emitted[0].speakerId,'speaker-one');
 const second=gate.start('b');gate.caption({id:'b1',text:'Follow-up',at:new Date().toISOString(),speakerId:'speaker-two'});gate.stop('b');t.mock.timers.tick(1500);
 assert.equal(emitted[1].traceId,second);assert.equal(emitted[1].speakerId,'speaker-two');assert.notEqual(first,second);
 gate.start('c',['speaker-one']);gate.speaker('speaker-two');gate.stop('c');gate.direct('c',{id:'c',text:'Overlapping speech',at:new Date().toISOString()});
 assert.equal(emitted[2].speakerId,undefined);
 gate.start('d');gate.direct('b',{id:'late-b',text:'Stale result',at:new Date().toISOString()});assert.equal(emitted.length,3);
 gate.stop('d');gate.direct('d',{id:'d',text:'Unidentified voice',at:new Date().toISOString()});assert.equal(emitted[3].speakerId,undefined);gate.close();
});

test('late caption enriches only its winning direct turn and mixed speakers remain unidentified',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
 const emitted:MeetingTranscript[]=[],updates:any[]=[];
 const gate=new MeetingTranscriptGate(event=>emitted.push(event),Date.now,1500,update=>updates.push(update));
 const at=new Date().toISOString();t.mock.timers.tick(200);
 const traceId=gate.start('one');t.mock.timers.tick(400);gate.stop('one');
 gate.direct('one',{id:'direct-one',text:'Explain the clause.',at:new Date().toISOString()});
 gate.caption({id:'late-one',text:'Explain the clause!',at,speakerId:'speaker-a'});
 assert.deepEqual(updates,[{id:'direct-one',traceId,speakerId:'speaker-a'}]);assert.equal(emitted.length,1);
 gate.caption({id:'mixed',text:'Explain the clause.',at,speakerId:'speaker-b'});
 assert.equal(updates.at(-1)!.speakerId,undefined);
 gate.caption({id:'again',text:'Explain the clause.',at,speakerId:'speaker-a'});assert.equal(updates.at(-1)!.speakerId,undefined);
 const count=updates.length;t.mock.timers.tick(100);gate.start('two');gate.stop('two');
 gate.direct('two',{id:'direct-two',text:'Explain the clause.',at:new Date().toISOString()});
 gate.caption({id:'old',text:'Explain the clause.',at,speakerId:'speaker-a'});
 assert.equal(updates.length,count,'repeated words cannot assign an old speaker to a newer turn');assert.equal(emitted.length,2);gate.close();
});
