export const vadProfiles = ['semantic_medium','semantic_low','semantic_high','server_300','server_500'] as const;
export type MeetingVadProfile = typeof vadProfiles[number];
export function meetingVadProfile(value?: string): MeetingVadProfile {
  if (value === undefined || value === '') return 'semantic_medium';
  if (!(vadProfiles as readonly string[]).includes(value)) throw new Error('Invalid CLEO_MEETING_VAD_PROFILE.');
  return value as MeetingVadProfile;
}
export function meetingTurnDetection(profile: MeetingVadProfile) {
  const controls = {createResponse:false, interruptResponse:false};
  return profile.startsWith('server_')
    ? {type:'server_vad' as const,threshold:0.5,prefixPaddingMs:300,silenceDurationMs:profile==='server_300'?300:500,...controls}
    : {type:'semantic_vad' as const,eagerness:profile.slice(9) as 'low'|'medium'|'high',...controls};
}
export type MeetingTraceContext = {turnId:string;spanId?:string;profile?:MeetingVadProfile;operation?:'intent'|'steering'|'proposal'|'reminder'|'presentation'};
export type MeetingTimingRow = {session:string;event:string;at:number;turnId:string;spanId:string;profile:string;operation:string};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function safeTimingContext(value?:MeetingTraceContext):MeetingTraceContext|undefined {
  if(!value||!uuid.test(value.turnId))return;
  return {turnId:value.turnId,...(value.spanId&&uuid.test(value.spanId)?{spanId:value.spanId}:{}),
    ...(vadProfiles.includes(value.profile!)?{profile:value.profile}:{}),
    ...(['intent','steering','proposal','reminder','presentation'].includes(value.operation??'')?{operation:value.operation}:{})};
}

// Pair by turn AND response/tool span, never adjacent timestamps: concurrent
// tools, late responses and interrupted turns must not contaminate percentiles.
export function summarizeMeetingLatency(rows:MeetingTimingRow[]) {
  const turns=new Map<string,MeetingTimingRow[]>(),samples=new Map<string,number[]>();
  const add=(profile:string,route:string,metric:string,a?:number,b?:number)=>{
    if(a===undefined||b===undefined||b<a)return;
    const key=profile+':'+route+':'+metric;const values=samples.get(key)??[];values.push(b-a);samples.set(key,values);
  };
  for(const row of rows){const key=row.session+':'+row.turnId;const group=turns.get(key)??[];group.push(row);turns.set(key,group);}
  let interrupted=0,noAudio=0;
  for(const group of turns.values()){
    group.sort((a,b)=>a.at-b.at);
    const first=(event:string)=>group.find(r=>r.event===event)?.at;
    const profile=group.find(r=>r.profile)?.profile??'unknown';
    const route=group.some(r=>r.event==='meeting_direct_fast_path')?'direct':group.some(r=>r.event==='meeting_followup_fast_path')?'fast_followup':group.some(r=>r.event==='meeting_intent_started')?'interpreted':'other';
    add(profile,route,'speech_stop_to_transcript_ms',first('meeting_room_speech_stopped'),first('meeting_transcript_direct')??first('meeting_transcript_caption_fallback'));
    add(profile,route,'speech_stop_to_response_created_ms',first('meeting_room_speech_stopped'),first('meeting_voice_response_created'));
    add(profile,route,'speech_stop_to_first_audio_sent_ms',first('meeting_room_speech_stopped'),first('meeting_voice_first_frame_sent')??first('meeting_script_first_frame_sent'));
    const spans=new Map<string,MeetingTimingRow[]>();
    for(const row of group)if(row.spanId){const span=spans.get(row.spanId)??[];span.push(row);spans.set(row.spanId,span);}
    for(const span of spans.values()){
      const at=(event:string)=>span.find(r=>r.event===event)?.at;
      const request=at('meeting_voice_response_requested')??at('meeting_script_audio_requested');
      add(profile,route,'request_to_response_created_ms',request,at('meeting_voice_response_created'));
      add(profile,route,'response_created_to_first_audio_received_ms',at('meeting_voice_response_created'),at('meeting_voice_first_audio_received'));
      add(profile,route,'request_to_first_text_delta_ms',request,at('meeting_voice_first_text_delta'));
      add(profile,route,'first_audio_received_to_sent_ms',at('meeting_voice_first_audio_received'),at('meeting_voice_first_frame_sent')??at('meeting_script_first_frame_sent'));
      add(profile,route,'request_to_first_audio_sent_ms',request,at('meeting_voice_first_frame_sent')??at('meeting_script_first_frame_sent'));
      const outcome=['meeting_tool_completed','meeting_tool_failed','meeting_tool_cancelled'].find(e=>at(e)!==undefined);
      if(outcome)add(profile,route,`${span.find(r=>r.operation)?.operation??'tool'}_${outcome.slice(13)}_ms`,at('meeting_tool_started'),at(outcome));
      if(at('meeting_voice_cancelled')!==undefined)interrupted++;
      if(request!==undefined&&at('meeting_voice_first_frame_sent')===undefined&&at('meeting_script_first_frame_sent')===undefined)noAudio++;
    }
  }
  return {playbackObserved:false,firstAudioMeaning:'first PCM frame sent to the meeting provider; remote playback is not acknowledged',turns:turns.size,interruptedResponses:interrupted,responsesWithoutAudio:noAudio,
    metrics:[...samples].map(([key,values])=>{values.sort((a,b)=>a-b);const [profile,route,metric]=key.split(':');return {profile,route,metric,count:values.length,p50:values[Math.ceil(values.length*.5)-1],p95:values[Math.ceil(values.length*.95)-1]};})};
}
