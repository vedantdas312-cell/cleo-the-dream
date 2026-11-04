import {performance} from 'node:perf_hooks';

export type MeetingAudioClock = {
  now:()=>number;
  schedule:(callback:()=>void,delayMs:number)=>{cancel:()=>void};
};
const monotonicClock:MeetingAudioClock={
  now:()=>performance.now(),
  schedule:(callback,delayMs)=>{
    const timer=setTimeout(callback,Math.ceil(delayMs));timer.unref();
    return {cancel:()=>clearTimeout(timer)};
  },
};

// Both generated speech and reviewed scripts use this cadence. Normal timer and
// send overhead consume the current frame's interval instead of adding to it.
export class MeetingAudioPacer {
  private clock:MeetingAudioClock;
  private nextAt:number;
  private timer?:{cancel:()=>void};
  constructor(clock:MeetingAudioClock=monotonicClock){this.clock=clock;this.nextAt=clock.now();}
  ready(resume:()=>void){
    if(this.timer)return false;
    const remaining=this.nextAt-this.clock.now();
    if(remaining<=0)return true;
    this.timer=this.clock.schedule(()=>{this.timer=undefined;resume();},remaining);
    return false;
  }
  advance(durationMs:number){
    this.nextAt+=durationMs;
    // If an entire interval was missed, start a new phase. Never send multiple
    // frames immediately to catch up with a stalled event loop or empty stream.
    const now=this.clock.now();
    if(this.nextAt<=now)this.nextAt=now+durationMs;
  }
  cancel(){this.timer?.cancel();this.timer=undefined;}
}
