import {randomUUID} from 'node:crypto';
import {RealtimeTurnState} from './realtime-turn-state.mjs';
export type MeetingTranscript = { id: string; text: string; at: string; traceId?:string; speakerId?:string };
type MeetingCaption = MeetingTranscript & {speakerId?:string;durationMs?:number};
type Turn = { id: string; traceId:string; speakers:Set<string>; startedAt: number; stoppedAt?:number; speakerAfter?:number; stopped: boolean; winner?: 'direct'|'caption'; direct?:MeetingTranscript; captions: MeetingCaption[]; timer?: ReturnType<typeof setTimeout> };
export type MeetingSpeakerUpdate={id:string;traceId:string;speakerId?:string};
const normalized=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');

// Captions and direct transcription describe the same room audio with different
// wording and segmentation. Choose one source per detected turn, not by text.
export class MeetingTranscriptGate {
  private turn?: Turn;
  private turns=new RealtimeTurnState({createVoiceTurnId:()=>randomUUID()});
  private emit: (event: MeetingTranscript, source:'direct'|'caption')=>void;
  private now: ()=>number;
  private fallbackMs:number;
  private enrich:(update:MeetingSpeakerUpdate)=>void;
  constructor(emit: (event: MeetingTranscript, source:'direct'|'caption')=>void,
    now: ()=>number = Date.now, fallbackMs = 1500,enrich:(update:MeetingSpeakerUpdate)=>void=()=>{}) {this.emit=emit;this.now=now;this.fallbackMs=fallbackMs;this.enrich=enrich;}
  start(id?:string,speakers:string[] = []) {
    if(!id)return;
    const speakerAfter=this.turn?(this.turn.stoppedAt??this.now()):undefined;
    if(this.turn)clearTimeout(this.turn.timer);
    const {context}=this.turns.beginVoice(id);this.turns.commit(context);
    this.turn={id,traceId:context!.turnId,speakers:new Set(speakers),speakerAfter,startedAt:this.now(),stopped:false,captions:[]};
    return context!.turnId;
  }
  speaker(id:string) { if(this.turn&&!this.turn.stopped&&!this.turn.winner)this.turn.speakers.add(id); }
  private speakerId(turn:Turn) { return turn.speakers.size===1?[...turn.speakers][0]:undefined; }
  stop(id?:string) {
    const turn=this.turn;if(!turn||(id&&turn.id!==id))return;
    this.turns.endSpeech();turn.stopped=true;turn.stoppedAt??=this.now();this.schedule(turn);return turn.traceId;
  }
  direct(id:string,event:MeetingTranscript) {
    const turn=this.turn;
    // A late transcription cannot reclaim a newer VAD turn.
    if(turn&&turn.id!==id)return;
    if(turn?.winner)return;
    if(!turn){const {context}=this.turns.beginVoice(id);this.turns.commit(context);this.turns.endSpeech();}
    const completed=this.turns.completeInput(id);
    if(completed.invalid||completed.duplicate||this.turns.isStale(completed.context))return;
    if(turn){turn.winner='direct';turn.direct=event;clearTimeout(turn.timer);turn.captions=[];}
    this.emit({...event,traceId:completed.context.turnId,...(turn?{speakerId:this.speakerId(turn)}:{})},'direct');
  }
  // False means no usable audio turn exists: retain the ordinary caption path.
  caption(event:MeetingCaption):boolean {
    const turn=this.turn;if(!turn||this.now()-turn.startedAt>30000)return false;
    // A delayed caption from before the current VAD turn must not start it over.
    if(Date.parse(event.at)<turn.startedAt-1000)return true;
    if(turn.winner){
      // Only enrich the winning turn. Never emit another transcript or infer
      // identity from text shared by a different/newer audio turn.
      const at=Date.parse(event.at),direct=turn.direct;
      if(direct&&event.speakerId&&at>=turn.startedAt-1000&&(turn.speakerAfter===undefined||at>turn.speakerAfter)&&at<=(turn.stoppedAt??Date.parse(direct.at))){
        turn.speakers.add(event.speakerId);
        if(turn.speakers.size>1||normalized(event.text)===normalized(direct.text))this.enrich({id:direct.id,traceId:turn.traceId,speakerId:this.speakerId(turn)});
      }
      return true;
    }
    if(turn.captions.some(c=>c.id===event.id))return true;
    if(event.speakerId)turn.speakers.add(event.speakerId);
    // Attendee upserts closed captions, then sends a fresh delivery ID. The
    // speaker and original start remain stable across cumulative/corrected text.
    // Different starts/speakers are separate utterances, even with equal words.
    const index=turn.captions.findIndex(c=>c.speakerId===event.speakerId&&c.at===event.at);
    if(index>=0){
      const previous=turn.captions[index];
      if(event.durationMs!==undefined&&previous.durationMs!==undefined&&event.durationMs<previous.durationMs)return true;
      turn.captions[index]=event;
    }else turn.captions.push(event);
    turn.captions.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    turn.captions=turn.captions.slice(-12);
    if(turn.stopped)this.schedule(turn);
    return true;
  }
  private schedule(turn:Turn) {
    if(turn.timer||turn.winner)return;
    turn.timer=setTimeout(()=>{
      turn.timer=undefined;
      if(this.turn!==turn||turn.winner||!turn.captions.length)return;
      turn.winner='caption';this.turns.completeInput(turn.id);
      const last=turn.captions.at(-1)!;
      this.emit({id:last.id,at:last.at,traceId:turn.traceId,speakerId:this.speakerId(turn),text:turn.captions.map(c=>c.text).join(' ').slice(-6000)},'caption');
      turn.captions=[];
    },this.fallbackMs);turn.timer.unref();
  }
  close(){clearTimeout(this.turn?.timer);this.turn=undefined;this.turns.close();}
}
