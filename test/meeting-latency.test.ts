import test from 'node:test';
import assert from 'node:assert/strict';
import {meetingVadProfile,meetingTurnDetection,safeTimingContext,summarizeMeetingLatency,type MeetingTimingRow} from '../src/meeting-latency.ts';

test('VAD experiments are explicit and never enable automatic public responses',()=>{
 assert.equal(meetingVadProfile(),'semantic_medium');
 for(const profile of ['server_300','server_500','semantic_low','semantic_high','semantic_medium']){
  const config=meetingTurnDetection(meetingVadProfile(profile));
  assert.equal(config.createResponse,false);assert.equal(config.interruptResponse,false);
  if(config.type==='server_vad')assert.equal(config.silenceDurationMs,Number(profile.slice(7)));
  else assert.equal(config.eagerness,profile.slice(9));
 }
 assert.throws(()=>meetingVadProfile('SECRET'));
});

test('timing context strictly excludes payloads, private IDs and arbitrary labels',()=>{
 const turnId='12345678-1234-1234-1234-123456789012';
 assert.deepEqual(safeTimingContext({turnId,spanId:'PRIVATE',profile:'PRIVATE',operation:'PRIVATE',text:'PRIVATE'} as any),{turnId});
 assert.equal(safeTimingContext({turnId:'PRIVATE'}),undefined);
});

test('percentiles pair concurrent spans and profiles, include interruptions and leave missing timings absent',()=>{
 const rows:MeetingTimingRow[]=[];
 const row=(turnId:string,spanId:string,event:string,at:number,profile='server_300',operation='')=>rows.push({session:'session',turnId,spanId,event,at,profile,operation});
 row('one','','meeting_room_speech_stopped',100);
 row('one','a','meeting_voice_response_requested',200);
 row('one','tool','meeting_tool_started',220,'server_300','intent');
 row('two','','meeting_room_speech_stopped',230,'server_500');
 row('two','b','meeting_voice_response_requested',250,'server_500');
 row('one','a','meeting_voice_response_created',300);
 row('two','b','meeting_voice_cancelled',350,'server_500');
 row('one','tool','meeting_tool_completed',420,'server_300','intent');
 row('one','a','meeting_voice_first_audio_received',450);
 row('one','a','meeting_voice_first_frame_sent',500);
 row('one','continuation','meeting_voice_response_requested',600);
 row('one','continuation','meeting_voice_first_frame_sent',700);
 const summary=summarizeMeetingLatency(rows),metric=(name:string)=>summary.metrics.find(m=>m.metric===name)!;
 assert.equal(summary.playbackObserved,false);assert.equal(summary.interruptedResponses,1);assert.equal(summary.responsesWithoutAudio,1);
 assert.equal(metric('speech_stop_to_first_audio_sent_ms').count,1);assert.equal(metric('speech_stop_to_first_audio_sent_ms').p50,400);
 assert.equal(metric('request_to_response_created_ms').p95,100);
 assert.equal(metric('first_audio_received_to_sent_ms').p50,50);
 assert.equal(metric('intent_completed_ms').p50,200);
 assert.equal(metric('request_to_first_audio_sent_ms').p50,100);assert.equal(metric('request_to_first_audio_sent_ms').p95,300);
 assert.ok(summary.metrics.every(m=>m.profile==='server_300'));
});

test('direct conversation is measured separately from interpreted and follow-up routes',()=>{
 const rows:MeetingTimingRow[]=[
  {session:'session',turnId:'direct',spanId:'a',event:'meeting_direct_fast_path',at:10,profile:'semantic_medium',operation:''},
  {session:'session',turnId:'direct',spanId:'a',event:'meeting_voice_response_requested',at:20,profile:'semantic_medium',operation:''},
  {session:'session',turnId:'direct',spanId:'a',event:'meeting_voice_first_frame_sent',at:30,profile:'semantic_medium',operation:''},
 ];
 const metric=summarizeMeetingLatency(rows).metrics.find(m=>m.metric==='request_to_first_audio_sent_ms');
 assert.deepEqual(metric,{profile:'semantic_medium',route:'direct',metric:'request_to_first_audio_sent_ms',count:1,p50:10,p95:10});
});
