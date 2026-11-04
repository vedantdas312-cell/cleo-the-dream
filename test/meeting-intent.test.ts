import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {RealtimeSession} from '@openai/agents/realtime';
import {RealtimeMeetingIntent,validateMeetingIntent,type MeetingIntentInput} from '../src/meeting-intent.ts';
const input:MeetingIntentInput={text:'Could you put the wording in front of everyone and explain the second change?',channel:'meeting',speaking:false,sharing:false,selectedRedlineId:'r1',redlines:[{id:'r1',paragraphId:'p1',original:'thirty',replacement:'sixty'},{id:'r2',paragraphId:'p2',original:'ten',replacement:'twenty'}],recentPublicTurns:['Discussing payment.']};
test('Realtime interpretation constrains tool results to saved actions and edits',()=>{
 const result=validateMeetingIntent({addressed:true,actions:[{action:'select',redline_id:'r2'},{action:'share',redline_id:''},{action:'explain',redline_id:''}]},input);
 assert.deepEqual(result.command,{action:'combined',actions:[{action:'select',redlineId:'r2'},{action:'share'},{action:'explain'}]});
 for(const actions of [[{action:'select',redline_id:'r99'}],[{action:'approve',redline_id:'r1'}],[{action:'send_private_notes',redline_id:''}],[{action:'speak',redline_id:'r1'}],[]])assert.throws(()=>validateMeetingIntent({addressed:true,actions},input));
 assert.equal(validateMeetingIntent({addressed:false,actions:[{action:'speak',redline_id:''}]},input).command.action,'note');
});
test('Realtime interpretation isolates private and room turns and never has an audio output sink',async()=>{
 const created:any[]=[],messages:any[]=[];
 class Session extends EventEmitter {
  agent:any;config:any;closed=false;
  constructor(agent:any,config:any){super();this.agent=agent;this.config=config;created.push(this);}
  async connect(){}
  sendMessage(message:string){messages.push(JSON.parse(message));void this.agent.tools[0].invoke({context:{}},JSON.stringify({request_id:JSON.parse(message).request_id,addressed:true,actions:[{action:'quiet',redline_id:''}]}));}
  close(){this.closed=true;}
 }
 const intent=new RealtimeMeetingIntent('fixture',Session as unknown as typeof RealtimeSession);
 assert.equal((await intent.resolve({...input,text:'PRIVATE_SENTINEL',channel:'imessage'},new AbortController().signal)).command.action,'quiet');
 await intent.resolve(input,new AbortController().signal);
 assert.equal(created.length,2);assert.ok(created.every(s=>!s.closed));await intent.resolve(input,new AbortController().signal);assert.equal(created.length,2,'room interpretation reuses its persistent lane');intent.close();assert.ok(created.every(s=>s.closed));assert.deepEqual(created[0].config.config.outputModalities,['text']);
 assert.deepEqual(messages[0].recentPublicTurns,[]);assert.doesNotMatch(JSON.stringify(messages[1]),/PRIVATE_SENTINEL/);
 assert.deepEqual(created[1].agent.tools.map((t:any)=>t.name),['interpret_request']);
});
test('aborting an in-flight interpretation rejects and closes its connection',async()=>{
 class Session extends EventEmitter {static closed=false;async connect(){}sendMessage(){}close(){Session.closed=true;}}
 const controller=new AbortController(),intent=new RealtimeMeetingIntent('fixture',Session as unknown as typeof RealtimeSession);
 const pending=intent.resolve(input,controller.signal);controller.abort();await assert.rejects(pending,/interrupted/);assert.equal(Session.closed,true);
});

test('natural invitations use an isolated text-only decision tool with strict boolean results',async()=>{
 const created:any[]=[],messages:any[]=[];let decision:any={join_now:true};
 class Session extends EventEmitter {
  agent:any;config:any;closed=false;
  constructor(agent:any,config:any){super();this.agent=agent;this.config=config;created.push(this);}
  async connect(){}sendMessage(text:string){messages.push(JSON.parse(text));void this.agent.tools[0].invoke({context:{}},JSON.stringify(decision));}close(){this.closed=true;}
 }
 const intent=new RealtimeMeetingIntent('fixture',Session as unknown as typeof RealtimeSession),url='https://meet.google.com/abc-defg-hij';
 assert.equal(await intent.authorizeInvitation('Come discuss the privacy doc with us. '+url,url,new AbortController().signal),true);
 decision={join_now:false};assert.equal(await intent.authorizeInvitation('Do not join. '+url,url,new AbortController().signal),false);
 assert.deepEqual(created[0].agent.tools.map((t:any)=>t.name),['authorize_invitation']);assert.deepEqual(created[0].config.config.outputModalities,['text']);assert.ok(created.every(s=>s.closed));assert.deepEqual(Object.keys(messages[0]),['text','meetingUrl']);
 decision={join_now:'yes'};await assert.rejects(intent.authorizeInvitation(url,url,new AbortController().signal));
});

test('prewarming sends no utterance, reuses the room lane, and stale tool results cannot settle a newer request',async()=>{
 const created:any[]=[],messages:any[]=[];
 class Session extends EventEmitter {
  agent:any;closed=false;
  constructor(agent:any){super();this.agent=agent;created.push(this);}
  async connect(){}sendMessage(message:string){messages.push(JSON.parse(message));}close(){this.closed=true;}
 }
 const intent=new RealtimeMeetingIntent('fixture',Session as unknown as typeof RealtimeSession);
 await intent.prepare('meeting-one');assert.equal(created.length,1);assert.equal(messages.length,0);
 const first=intent.resolve({...input,sessionId:'meeting-one'},new AbortController().signal);
 await new Promise<void>(r=>setImmediate(r));
 const invoke=(request_id:string,action:string)=>created[0].agent.tools[0].invoke({context:{}},JSON.stringify({request_id,addressed:true,actions:[{action,redline_id:''}]}));
 await invoke(messages[0].request_id,'greet');assert.equal((await first).command.action,'greet');
 let finished=false;const second=intent.resolve({...input,sessionId:'meeting-one',text:'Wait please'},new AbortController().signal).then(value=>{finished=true;return value;});
 await new Promise<void>(r=>setImmediate(r));await invoke(messages[0].request_id,'share');assert.equal(finished,false);
 await invoke(messages[1].request_id,'quiet');assert.equal((await second).command.action,'quiet');assert.equal(created.length,1);intent.close();
});

test('an explicit redline selection scopes a model walkthrough decision to one explanation',()=>{
 const result=validateMeetingIntent({addressed:true,actions:[{action:'select',redline_id:'r2'},{action:'walkthrough',redline_id:''}]},input);
 assert.deepEqual(result.command,{action:'combined',actions:[{action:'select',redlineId:'r2'},{action:'explain'}]});
});
