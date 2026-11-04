import test from 'node:test';
import assert from 'node:assert/strict';
import { MeetingSessions } from '../src/meeting-session.ts';
import { MeetingIntelligence, openAIMeetingReasoner } from '../src/meeting-intelligence.ts';
import { verifiedKeikiToolEvent } from '../src/meeting-keiki.ts';

function fixture() {
  let now=Date.now();
  const sessions=new MeetingSessions(':memory:',{now:()=>now});
  const binding=sessions.create({owner:'owner',sourceId:'source',meetingUrl:'https://meet.google.com/abc-defg-hij',
    publicDocument:{title:'Contract',paragraphs:[{id:'p1',text:'Payment is due in thirty days.'}],redlines:[{id:'r1',paragraphId:'p1',original:'thirty days',replacement:'sixty days'}]}});
  const control=(text:string)=>sessions.control(binding,{owner:'owner',id:'event-'+(++now),text,at:new Date(now).toISOString(),channel:'imessage',isDirect:true});
  control('PRIVATE_SENTINEL: do not disclose the internal budget or fallback.');
  sessions.transcript(binding,{id:'t1',text:'Why are you asking for sixty days? Could we discuss forty-five?',at:new Date(now).toISOString()});
  return {sessions,binding,control};
}
test('freeform reply uses public evidence only; private decisions cannot supply public words',async()=>{
  const f=fixture();f.control('speak');const calls:any[]=[];
  const replies=[{respond:true,text:'Could we explore forty-five days as a provisional alternative, subject to approval?'},{allow:true}];
  const engine=new MeetingIntelligence(f.sessions,async(instructions,input)=>{calls.push({instructions,input});return JSON.stringify(replies.shift());});
  const speech=await engine.reply(f.binding,new AbortController().signal);
  assert.ok(speech);assert.match(speech.text,/forty-five/);assert.doesNotMatch(speech.text,/PRIVATE_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(calls[0].input),/PRIVATE_SENTINEL|owner|source|sessionId/);
  assert.match(JSON.stringify(calls[1].input),/PRIVATE_SENTINEL/);
  assert.equal(calls.length,2);
  assert.equal(f.sessions.get(f.binding).share,false);f.sessions.close();
});
test('no model calls while quiet; private rejection, commitments and malformed answers fail closed',async()=>{
  const f=fixture();let calls=0;const engine=new MeetingIntelligence(f.sessions,async()=>{calls++;return '{}';});
  await assert.rejects(engine.reply(f.binding,new AbortController().signal));assert.equal(calls,0);
  f.control('speak');assert.equal(await engine.reply(f.binding,new AbortController().signal),undefined);assert.equal(calls,1);
  for (const [candidate,allow] of [['We agree to forty-five days.',true],['Could we discuss forty-five days?',false]] as const) {
    const values=[{respond:true,text:candidate},{allow}];
    const e=new MeetingIntelligence(f.sessions,async()=>JSON.stringify(values.shift()));
    assert.equal(await e.reply(f.binding,new AbortController().signal),undefined);
  }
  f.sessions.close();
});
test('stop revokes a reply already being generated',async()=>{
  for (const command of ['quiet']) {
    const f=fixture();f.control('speak');let release!:(s:string)=>void;
    const engine=new MeetingIntelligence(f.sessions,()=>new Promise(resolve=>{release=resolve;}));
    const pending=engine.reply(f.binding,new AbortController().signal);
    f.control(command);release('{"respond":true,"text":"Hello."}');
    await assert.rejects(pending,/revoked|authorized/);f.sessions.close();
  }
});
test('authenticated tool ingress ignores model commands and refuses internal, group, wrong-agent and missing-provider evidence',()=>{
  const context={agentId:'agent',phone:'owner-phone',channel:{channel:'sms',provider:'photon',isDirect:true,teamId:'line',userId:'owner-phone',messageId:'provider-id',inboundText:'quiet'}};
  const body={context,input:{text:'speak',owner:'someone-else'}};
  const event=verifiedKeikiToolEvent(body,'agent','line','owner');assert.equal(event.text,'quiet');assert.equal(event.id,'provider-id');
  // Sanitized shape of the actual shared-line status turn: gateway, no teamId.
  const shared={...body,context:{...context,channel:{...context.channel,provider:'blooio',teamId:undefined,gateway:'line'}}};
  assert.equal(verifiedKeikiToolEvent(shared,'agent','line','owner').text,'quiet');
  assert.throws(()=>verifiedKeikiToolEvent({...shared,context:{...shared.context,channel:{...shared.context.channel,gateway:'other',teamId:'line'}}},'agent','line','owner'));
  assert.throws(()=>verifiedKeikiToolEvent({...shared,context:{...shared.context,channel:{...shared.context.channel,gateway:undefined,teamId:'line'}}},'agent','line','owner'));
  for(const patch of [{internal:true},{agentId:'other'},{channel:{...context.channel,isDirect:false}},
    {channel:{...context.channel,userId:'other'}},{channel:{...context.channel,messageId:undefined}},
    {channel:{...context.channel,provider:undefined}}])assert.throws(()=>verifiedKeikiToolEvent({...body,context:{...context,...patch}},'agent','line','owner'));
});
test('reasoner is stateless, requests JSON and never exposes provider errors',async()=>{
  let sent:any;
  const reason=openAIMeetingReasoner('fixture',async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:'{"allow":true}'}]}]}));});
  assert.equal(await reason('Return JSON.',{public:'test'},new AbortController().signal),'{"allow":true}');
  assert.equal(sent.store,false);assert.equal(sent.previous_response_id,undefined);assert.equal(sent.tools,undefined);
  const failed=openAIMeetingReasoner('fixture',async()=>new Response('PRIVATE_SENTINEL',{status:503}));
  await assert.rejects(failed('test',{},new AbortController().signal),e=>!/PRIVATE_SENTINEL/.test(String(e)));
});
test('private reminders can use private context while quiet and never produce a public speech lease',async()=>{
 const f=fixture();const calls:any[]=[];
 const engine=new MeetingIntelligence(f.sessions,async(instructions,input)=>{calls.push({instructions,input});return JSON.stringify({text:'Private reminder: PRIVATE_SENTINEL. The proposal changes thirty to sixty days.'});});
 const reminder=await engine.remind(f.binding,new AbortController().signal);
 assert.match(reminder,/PRIVATE_SENTINEL/);assert.equal(calls.length,1);assert.match(calls[0].instructions,/privately/);
 assert.equal(f.sessions.get(f.binding).speak,false);assert.equal(f.sessions.get(f.binding).share,false);
 assert.doesNotMatch(JSON.stringify(f.sessions.publicView(f.binding)),/PRIVATE_SENTINEL/);f.sessions.close();
});
test('an interrupted private reminder is never returned for the new meeting state',async()=>{
 const f=fixture();let release!:(text:string)=>void;
 const engine=new MeetingIntelligence(f.sessions,()=>new Promise(resolve=>{release=resolve;}));
 const pending=engine.remind(f.binding,new AbortController().signal);f.control('leave the meeting');release('{"text":"old advice"}');
 await assert.rejects(pending,/interrupted/);f.sessions.close();
});
