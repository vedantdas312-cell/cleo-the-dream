import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { RealtimeSession } from '@openai/agents/realtime';
import { Attendee, canonicalJson, verifyAttendeeWebhook } from '../src/attendee.ts';
import { MeetingRealtime } from '../src/meeting-realtime.ts';
import { MeetingTransport } from '../src/meeting-transport.ts';
import { MeetingSessions, type OwnerMeetingEvent } from '../src/meeting-session.ts';
import { MeetingRoutes } from '../src/meeting-routes.ts';
import { Workflow } from '../src/workflow.ts';
import { createApp } from '../src/server.ts';

const document = { title: 'Contract review', paragraphs: [{ id: 'p1', text: 'Payment in thirty days.' }],
  redlines: [{ id: 'r1', paragraphId: 'p1', original: 'thirty days', replacement: 'sixty days' }] };
const meetingUrl = 'https://meet.google.com/abc-defg-hij';
const tick = () => delay(10);

test('Attendee uses real bidirectional PCM and reserved live-browser share, with quiet creation', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = new Attendee('fixture-key', (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(calls.length === 1 ? JSON.stringify({ id: 'bot_fixture', state: 'joining' }) : null, { status: 200 });
  }) as typeof fetch);
  await provider.join({ meetingUrl, audioUrl: 'wss://cleo.example/audio/fixture', webhookUrl: 'https://cleo.example/events/fixture', deduplicationKey: 'fixture' });
  const create = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(create.voice_agent_settings, { reserve_resources: true });
  assert.deepEqual(create.automatic_leave_settings, {
    only_participant_in_meeting_timeout_seconds: 30,
    silence_activate_after_seconds: 300,
    silence_timeout_seconds: 600,
    waiting_room_timeout_seconds: 300,
    wait_for_host_to_start_meeting_timeout_seconds: 300,
    max_uptime_seconds: 7200,
  });
  assert.equal(create.websocket_settings.audio.sample_rate, 24000);
  assert.equal(create.recording_settings.format, 'none');
  assert.equal(create.bot_chat_message, undefined);
  assert.equal(create.bot_image, undefined);
  await provider.share('bot_fixture', 'https://cleo.example/meeting/presentation#fixture');
  assert.match(calls[1].url, /\/voice_agent_settings$/);
  assert.equal(calls[1].init.method, 'PATCH');
  await provider.share('bot_fixture', '');
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { url: '', screenshare_url: '' });
  await assert.rejects(provider.join({ meetingUrl: 'https://other.example/a', audioUrl: 'wss://cleo.example', webhookUrl: 'https://cleo.example', deduplicationKey: 'fixture' }));
  assert.equal(calls.length, 3);
});

test('Attendee canonical webhook signatures reject forgery and nested payload changes', () => {
  const secret = Buffer.from('fixture secret').toString('base64');
  const body = { z: { b: 2, a: 'é' }, a: [3, 2] };
  const signature = createHmac('sha256', Buffer.from(secret, 'base64')).update(canonicalJson(body)).digest('base64');
  assert.equal(verifyAttendeeWebhook(body, signature, secret), true);
  assert.equal(verifyAttendeeWebhook({ ...body, a: [4, 2] }, signature, secret), false);
  assert.equal(verifyAttendeeWebhook(body, 'x', secret), false);
});

class FakeSession extends EventEmitter {
  transport = Object.assign(new EventEmitter(), { sendEvent: (event: any) => { this.sent.push(event); } });
  sent: any[] = []; inputs: ArrayBuffer[] = []; interruptions = 0; closed = false;
  static latest: FakeSession;
  constructor(publicAgent: unknown, config: unknown) { super(); FakeSession.latest = this; this.agent = publicAgent; this.config = config; }
  agent: unknown; config: unknown;
  async connect() {}
  sendAudio(data: ArrayBuffer) { this.inputs.push(data); }
  interrupt() { this.interruptions++; }
  close() { this.closed = true; }
  complete(text: string, bytes = 1920) {
    const request = this.sent.findLast(e=>e.type==='response.create');
    this.transport.emit('*', { type: 'response.created', response: { id: 'resp1', metadata: request.response.metadata } });
    this.emit('audio', { responseId: 'resp1', data: new Uint8Array(bytes).buffer });
    this.transport.emit('*', { type: 'response.done', response: { id: 'resp1', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'audio', transcript: text }] }] } });
  }
}

test('public Realtime buffers audio until exact script validation and ignores meeting requests', async () => {
  const sent: unknown[] = [];
  const voice = new MeetingRealtime({ apiKey: 'fixture', valid: () => true, send: p => { sent.push(p); return true; }, Session: FakeSession as unknown as typeof RealtimeSession });
  await voice.connect();
  const session = FakeSession.latest;
  voice.receiveAudio(Buffer.alloc(960));
  assert.equal(session.inputs.length, 1);
  assert.equal(session.sent.length, 0, 'Inbound participants cannot trigger public responses');
  const refused = voice.speak('This is a proposal.', { revision: 1 });
  assert.equal(sent.length, 0);
  session.complete('We accept your offer.');
  assert.equal(await refused, false); assert.equal(sent.length, 0);
  const accepted = voice.speak('This is a proposal.', { revision: 1 });
  const request = session.sent.at(-1);
  assert.deepEqual(request.response.input, []); assert.equal(request.response.conversation, 'none');
  session.complete('This is a proposal.');
  assert.equal(sent.length, 1, 'Only the first 20ms frame is queued immediately');
  await delay(70);
  assert.equal(await accepted, true); assert.equal(sent.length, 2);
  voice.close();
});

test('stop invalidates delayed Realtime responses and every subsequent paced frame', async () => {
  let permitted = true; const sent: unknown[] = [];
  const voice = new MeetingRealtime({ apiKey: 'fixture', valid: () => permitted, send: p => { sent.push(p); return true; }, Session: FakeSession as unknown as typeof RealtimeSession });
  await voice.connect();
  const pending = voice.speak('A proposal.', { revision: 1 });
  permitted = false; voice.cancel();
  FakeSession.latest.complete('A proposal.');
  assert.equal(await pending, false); assert.equal(sent.length, 0);
  permitted = true;
  const playback = voice.speak('A proposal.', { revision: 2 });
  FakeSession.latest.complete('A proposal.', 9600);
  assert.equal(sent.length, 1);
  permitted = false; voice.cancel(); await delay(50);
  assert.equal(await playback, false); assert.equal(sent.length, 1);
  voice.close();
});

class IdleVoice {async connect(){}close(){}cancel(){}receiveAudio(){}async respond(){return false;}async speak(){return false;}}
function fixture(extra: Record<string, any> = {}) {
  let now = Date.now();
  const sessions = new MeetingSessions(':memory:', { now: () => now });
  const session = sessions.create({ owner: 'owner', sourceId: 'source', meetingUrl, publicDocument: document, requestId: 'join1' });
  const calls: any[] = []; const transcripts: any[] = [];
  const attendee = new Attendee('fixture', (async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method: init?.method, body });
    return new Response(String(url).endsWith('/bots') ? JSON.stringify({ id: 'bot_fixture', state: 'joining' }) : null);
  }) as typeof fetch);
  const transport = new MeetingTransport(sessions, { path: ':memory:', publicUrl: 'https://cleo.example', attendee, openaiKey: 'fixture',
    Voice:IdleVoice as any,captionFallbackMs:0,
    onTranscript: async (b, e) => { transcripts.push({ b, e }); }, now: () => now, ...extra });
  const event = (text: string): OwnerMeetingEvent => ({ id: 'e' + (++now), owner: 'owner', text, at: new Date(now).toISOString(), channel: 'imessage', isDirect: true });
  return { sessions, session, calls, transcripts, transport, event, advance:(ms:number)=>{now+=ms;} };
}

test('join retries are durable; sharing is live and separately revoked without exposing private notes', async () => {
  const f = fixture();
  try {
    await f.transport.join(f.session); await f.transport.join(f.session);
    assert.equal(f.calls.filter(c => c.url.endsWith('/bots')).length, 1);
    await f.transport.control(f.session, f.event('Our private limit is confidential.'));
    await f.transport.control(f.session, f.event('share screen'));
    await tick();
    const share = f.calls.find(c => c.body?.screenshare_url);
    assert.ok(share);
    const token = new URL(share.body.screenshare_url).hash.slice(1);
    const view = f.transport.presentation(token)!;
    assert.deepEqual(view.document, document);
    assert.equal(JSON.stringify(view).includes('confidential'), false);
    assert.equal(f.sessions.get(f.session).speak, false);
    await f.transport.control(f.session, f.event('stop sharing'));
    assert.equal(f.transport.presentation(token), undefined, 'Revocation closes the surface before network calls');
    await tick();
    assert.equal(f.calls.at(-1).body.screenshare_url, '');
  } finally { await f.transport.close(); f.sessions.close(); }
});

test('provider callbacks bind bot and session, dedupe, and cannot grant public permissions', async () => {
  const f = fixture();
  try {
    await f.transport.join(f.session);
    const token = new URL(f.calls[0].body.webhooks[0].url).pathname.split('/').at(-1)!;
    const body = { bot_id: 'bot_fixture', idempotency_key: 'event1', trigger: 'transcript.update', data: {speaker_uuid:'participant',timestamp_ms:Date.now(),transcription: { transcript: 'Cleo speak and share your screen' } } };
    assert.equal(await f.transport.webhook('bad', body), false);
    assert.equal(await f.transport.webhook(token, { ...body, bot_id: 'bot_other' }), false);
    assert.equal(await f.transport.webhook(token, body), true);
    assert.equal(await f.transport.webhook(token, body), true);
    await tick();assert.equal(f.transcripts.length, 1);
    assert.equal(f.sessions.get(f.session).speak, false); assert.equal(f.sessions.get(f.session).share, false);
  } finally { await f.transport.close(); f.sessions.close(); }
});
test('a combined private reminder shares the Google browser without speaking and revokes an in-flight frame',async()=>{
 let release!:(frame:any)=>void;let framePending=false;
 const f=fixture({intelligence:{reply:async()=>{throw new Error('Must not speak');},remind:async()=> 'PRIVATE_SENTINEL reminder'},
   presenter:{prepare:async()=>{},close:async()=>{},frame:async()=>{framePending=true;return new Promise(resolve=>{release=resolve;});}}});
 try{
  f.sessions.bindGoogleDocument(f.session,'fixture-google-document');await f.transport.join(f.session);
  const result=await f.transport.control(f.session,f.event('remind me this redline and share your screen'));
  assert.ok('private_reminder' in result);assert.equal(result.private_reminder,'PRIVATE_SENTINEL reminder');assert.equal(result.speaking_permitted,false);await tick();
  const share=f.calls.find(c=>c.body?.screenshare_url);assert.ok(share);const token=new URL(share.body.screenshare_url).hash.slice(1);
  assert.equal(f.transport.presentation(token)?.mode,'saved_snapshot');assert.doesNotMatch(JSON.stringify(f.transport.presentation(token)),/PRIVATE_SENTINEL/);
  const pending=f.transport.presentationFrame(token);await tick();assert.equal(framePending,true);
  await f.transport.control(f.session,f.event('stop sharing'));release({imageB64:'/9j/',mimeType:'image/jpeg'});
  assert.equal(await pending,undefined);assert.equal(f.transport.presentation(token),undefined);
 }finally{await f.transport.close();f.sessions.close();}
});
test('waking the presentation computer can outlast an output lease without renewing a revoked grant',async()=>{
 let release!:()=>void,prepared=false;
 const f=fixture({presenter:{prepare:async(_b:any,_d:any,_q:any,valid:()=>boolean)=>{await new Promise<void>(r=>release=r);prepared=valid();},close:async()=>{},frame:async()=>undefined}});
 try{
  f.sessions.bindGoogleDocument(f.session,'fixture-google-document');await f.transport.join(f.session);
  await f.transport.control(f.session,f.event('share your screen'));await tick();f.advance(35000);release();await tick();
  assert.equal(prepared,true);assert.ok(f.calls.some(c=>c.body?.screenshare_url));
 }finally{await f.transport.close();f.sessions.close();}
});
test('walkthrough explains one redline and waits; only explicit navigation moves to another',async()=>{
 const spoken:string[]=[],located:string[]=[],modes:string[]=[];let finish!:(ok:boolean)=>void;
 class Voice {async connect(){}cancel(){finish?.(false);}close(){this.cancel();}receiveAudio(){}async respond(turn:any){const text=turn.document.redlines.find((r:any)=>r.id===turn.selectedRedlineId)?.original??turn.dialogue.at(-1);modes.push(turn.mode);spoken.push(text);return new Promise<boolean>(resolve=>{finish=resolve;});}}
 const f=fixture({Voice,intelligence:{reply:async(binding:any,_signal:any,mode:string)=>{modes.push(mode);return f.sessions.publicSpeech(binding);}},presenter:{prepare:async(_b:any,_d:any,q:string[])=>{located.push(q[0]);},close:async()=>{},frame:async()=>undefined}});
 const s=f.sessions.create({owner:'owner',sourceId:'source',meetingUrl,publicDocument:{...document,paragraphs:[...document.paragraphs,{id:'p2',text:'Notice is ten days.'}],redlines:[...document.redlines,{id:'r2',paragraphId:'p2',original:'ten days',replacement:'twenty days'}]},requestId:'walkthrough'});
 const server=createServer();f.transport.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  f.sessions.bindGoogleDocument(s,'fixture-google-document');await f.transport.join(s);
  const path=new URL(f.calls[0].body.websocket_settings.audio.url).pathname;
  const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}${path}`);await once(ws,'open');
  await f.transport.control(s,f.event('share your screen and walk us through the redlines'));await tick();
  assert.equal(spoken.length,1);assert.match(spoken[0],/thirty days/);assert.equal(located.at(-1),'thirty days');
  finish(true);await tick();assert.equal(spoken.length,1);assert.equal(f.sessions.get(s).selectedRedlineId,'r1');
  await f.transport.control(s,f.event('next redline'));await tick();assert.equal(spoken.length,1);assert.equal(located.at(-1),'ten days');
  await f.transport.control(s,f.event('let me speak'));await tick();assert.equal(f.sessions.get(s).speak,false);assert.equal(f.transport.status(s).walkthrough,'off');
  f.sessions.transcript(s,{id:'unrelated-turn',text:'What about a different payment term?',at:new Date().toISOString()});
  await f.transport.control(s,f.event('share your screen and explain this redline to everyone'));await tick();
  assert.equal(spoken.length,2);assert.match(spoken[1],/ten days/);assert.deepEqual(modes,['walkthrough','walkthrough']);finish(true);
 }finally{await f.transport.close();await new Promise<void>(r=>server.close(()=>r()));f.sessions.close();}
});

test('real websocket upgrade rejects unknown token and wrong bot binding', async () => {
  const f = fixture(); const server = createServer(); f.transport.attach(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    await f.transport.join(f.session);
    const path = new URL(f.calls[0].body.websocket_settings.audio.url).pathname;
    const denied = new WebSocket(`ws://127.0.0.1:${address.port}/meeting/audio/invalid`);
    const [error] = await once(denied, 'error'); assert.match(String(error), /401/);
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`); await once(ws, 'open');
    assert.equal(f.transport.status(f.session).audio_connected, true);
    ws.send(JSON.stringify({ bot_id: 'bot_other', trigger: 'realtime_audio.mixed', data: { sample_rate: 24000, timestamp_ms: Date.now(), chunk: Buffer.alloc(960).toString('base64') } }));
    const [code] = await once(ws, 'close'); assert.equal(code, 1008);
  } finally { await f.transport.close(); await new Promise<void>(r => server.close(() => r())); f.sessions.close(); }
});

test('an explanation requested before audio connects does not replay stale speech after connection',async()=>{
 let explained=0,spoken=0;
 class Voice {async connect(){}cancel(){}close(){}receiveAudio(){}async respond(){spoken++;return true;}}
 const f=fixture({Voice,intelligence:{reply:async(binding:any,_signal:any,mode:string)=>{assert.equal(mode,'walkthrough');explained++;return f.sessions.publicSpeech(binding);}}});
 const server=createServer();f.transport.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  await f.transport.join(f.session);await f.transport.control(f.session,f.event('explain this redline to everyone'));await tick();assert.equal(explained,0);
  const path=new URL(f.calls[0].body.websocket_settings.audio.url).pathname;
  const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}${path}`);await once(ws,'open');await tick();
  assert.equal(explained,0);assert.equal(spoken,0);
  await f.transport.control(f.session,f.event('explain this redline to everyone'));await tick();assert.equal(spoken,1);assert.equal(explained,0,'ordinary explanation bypasses private reasoning');
 }finally{await f.transport.close();await new Promise<void>(r=>server.close(()=>r()));f.sessions.close();}
});

test('HTTP routes reject model-controlled grants and require signed direct Meet-link intent', async () => {
  const f = fixture();
  const workflow = { config: { publicUrl: 'https://cleo.example', webhookKey: 'fixture-webhook-key-123456', downloadSecret: 'fixture-secret-12345678901234567890' },
    owner: (body: any) => { if (body.context.phone !== '+15555550100') throw new Error('wrong owner'); return 'owner'; },
    async registerSender(body: any) { if (body.context.phone !== '+15555550100') throw new Error('wrong owner'); return 'owner'; },
    ownerForSender: () => 'owner',
    meetingDocument: async () => document,
  } as unknown as Workflow;
  const secret = 'fixture-identity-secret-12345678901234567890';
  const routes = new MeetingRoutes(f.transport, workflow, { secret, agentId: 'fixture-agent', line: 'fixture-line' });
  const server = createApp(workflow, undefined, routes); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    let response = await fetch(base + '/meeting/presentation-data'); assert.equal(response.status, 403);
    response = await fetch(base + '/meeting/presentation'); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.doesNotMatch(await response.text(), /getDisplayMedia|getUserMedia|innerHTML/);
    response = await fetch(base + '/tools/meeting_control', { method: 'POST' }); assert.equal(response.status, 401);
    const tool = { input: { source_id: 'source', meeting_url: meetingUrl, request_id: 'unverified' }, context: { phone: '+15555550100', channel: 'imessage' } };
    response = await fetch(base + '/tools/join_meeting', { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchid-api-key': workflow.config.webhookKey }, body: JSON.stringify(tool) });
    assert.equal(response.status, 422); assert.equal(f.calls.length, 0);
    const raw = JSON.stringify({ agent: { id: 'fixture-agent' }, sender: { channel: 'photon', teamId: 'fixture-line', userId: '+15555550100', addressing: { isDm: true } }, conversation: { id: 'fixture-conversation' }, messages: [{ id: 'speak1', text: 'Cleo, could you please take over?' }] });
    const timestamp = String(Date.now() + 5);
    const signature = 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + raw).digest('hex');
    response = await fetch(base + '/meeting/identity', { method: 'POST', headers: { 'content-type': 'application/json', 'x-keiki-timestamp': timestamp, 'x-keiki-signature': signature }, body: raw });
    assert.equal(response.status, 200); assert.equal(f.sessions.get(f.session).speak, true); assert.equal(f.sessions.get(f.session).share, false);
    const signedTool = JSON.stringify({ input: {}, context: { agentId:'fixture-agent', phone: '+15555550100', channel: { channel: 'sms', provider: 'photon', teamId: 'fixture-line', userId: '+15555550100', isDirect: true } } });
    const signedHeaders = { 'content-type': 'application/json', 'x-keiki-timestamp': timestamp, 'x-keiki-signature': 'sha256=' + createHmac('sha256',secret).update(timestamp + '.' + signedTool).digest('hex') };
    response = await fetch(base + '/tools/meeting_status', { method: 'POST', headers: signedHeaders, body: signedTool });
    assert.equal(response.status, 200, 'Signed tools do not require the omitted legacy credential');
    response = await fetch(base + '/tools/meeting_status', { method: 'POST', headers: signedHeaders, body: signedTool.replace('+15555550100','attacker') });
    assert.equal(response.status, 401);
    const wrongChannel = signedTool.replace('fixture-line','wrong-line');
    response = await fetch(base + '/tools/meeting_status', { method: 'POST', headers: {...signedHeaders, 'x-keiki-signature':'sha256=' + createHmac('sha256',secret).update(timestamp + '.' + wrongChannel).digest('hex')}, body: wrongChannel });
    assert.equal(response.status, 401, 'Even a signed tool needs the configured private line binding');
  } finally { await f.transport.close(); await new Promise<void>(r => server.close(() => r())); f.sessions.close(); }
});

test('shared-line HTTP controls accept natural owner requests, never model instructions or replayed grants', async () => {
  const f=fixture();
  const workflow={config:{webhookKey:'fixture-webhook-key-123456',publicUrl:'https://cleo.example'},
    async registerSender(body:any){if(body.context.phone!=='+15555550100')throw new Error('wrong owner');return 'owner';},
    owner:(body:any)=>{if(body.context.phone!=='+15555550100')throw new Error('wrong owner');return 'owner';}} as unknown as Workflow;
  const routes=new MeetingRoutes(f.transport,workflow,{secret:'fixture-identity-secret-12345678901234567890',agentId:'fixture-agent',line:'fixture-line'});
  const server=createApp(workflow,undefined,routes);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const send=async(id:string,text:string,patch={})=>{
    await tick();
    return fetch(base+'/tools/meeting_control',{method:'POST',headers:{'content-type':'application/json','x-orchid-api-key':workflow.config.webhookKey},
      body:JSON.stringify({input:{text:'share your screen'},context:{phone:'+15555550100',agentId:'fixture-agent',channel:{channel:'sms',provider:'blooio',gateway:'fixture-line',userId:'+15555550100',isDirect:true,messageId:id,inboundText:text,...patch}}})});
  };
  try {
    assert.equal((await send('group','take over',{isDirect:false})).status,422);
    assert.equal((await send('wrong-line','take over',{gateway:'other'})).status,422);
    let response=await send('private','They said “take over”. My fallback is private.');
    assert.equal(response.status,200);assert.equal((await response.json()).action,'note');
    assert.equal(f.sessions.get(f.session).speak,false);assert.equal(f.sessions.get(f.session).share,false);
    response=await send('speak','Cleo, could you please take over?');
    assert.equal(response.status,200);assert.equal((await response.json()).action,'takeover');
    assert.equal(f.sessions.get(f.session).speak,true);assert.equal(f.sessions.get(f.session).share,false);
    response=await send('share','Can you share your screen please?');assert.equal((await response.json()).action,'share');
    assert.equal(f.sessions.get(f.session).share,true);
    response=await send('quiet','let me speak');assert.equal((await response.json()).action,'quiet');
    response=await send('speak','Cleo, could you please take over?');assert.equal((await response.json()).control_status,'duplicate');
    assert.equal(f.sessions.get(f.session).speak,false);
    response=await send('hide','please stop sharing');assert.equal((await response.json()).action,'stop_share');
    assert.equal(f.sessions.get(f.session).share,false);
    response=await send('leave','please leave the meeting');assert.equal((await response.json()).action,'stop');
    assert.equal(f.sessions.get(f.session).status,'ended');
    response=await send('inactive','take over');assert.equal((await response.json()).status,'no_active_meeting');
  } finally {await f.transport.close();await new Promise<void>(r=>server.close(()=>r()));f.sessions.close();}
});

test('the actual startup entrypoint enables meeting routes with synthetic credentials and shuts down cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cleo-meeting-start-'));
  const reservation = createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
  const port = (reservation.address() as {port:number}).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath,['scripts/start.ts'], { env: {
    PATH: process.env.PATH, PORT: String(port), PUBLIC_URL: 'https://cleo.example',
    KEIKI_WEBHOOK_KEY: 'fixture-webhook-key-123456', DOWNLOAD_SIGNING_SECRET: 'fixture-secret-12345678901234567890',
    KEIKI_ATTACHMENT_ORIGINS: 'https://media.example',
    CLEO_LOCAL_DB: join(dir,'documents.sqlite'), CLEO_MEETINGS_ENABLED: 'true', CLEO_MEETING_DB: join(dir,'meetings.sqlite'),
    ATTENDEE_API_KEY: 'fixture-not-a-real-key', OPENAI_API_KEY: 'fixture-not-a-real-key',
    KEIKI_AGENT_ID: 'fixture-agent', KEIKI_IDENTITY_SECRET: 'fixture-identity-secret-12345678901234567890', KEIKI_IMESSAGE_LINE: 'fixture-line',
  }, stdio: ['ignore','pipe','pipe'] });
  let logs = ''; child.stdout.on('data',chunk=>{logs+=chunk.toString();}); child.stderr.on('data',chunk=>{logs+=chunk.toString();});
  const exited = once(child,'exit');
  try {
    let ready = false;
    for(let attempt=0;attempt<80;attempt++) {
      if(child.exitCode!==null) break;
      try { const response=await fetch(`http://127.0.0.1:${port}/health`); ready=response.ok; } catch { /* Startup only. */ }
      if(ready)break;await delay(50);
    }
    assert.equal(ready,true,logs);
    const response=await fetch(`http://127.0.0.1:${port}/meeting/presentation-data`); assert.equal(response.status,403);
    child.kill('SIGTERM'); const [code]=await exited; assert.equal(code,0,logs);
  } finally { if(child.exitCode===null){child.kill('SIGTERM');await exited;} await rm(dir,{recursive:true,force:true}); }
});


test('caption speech requires semantic addressing and pending proposals are cancelled by quiet', async () => {
  const spoken:string[]=[];let resolveReply!:((x:any)=>void);
  class Voice {async connect(){}async respond(turn:any){spoken.push(turn.dialogue.at(-1));return true;}async speak(text:string){spoken.push(text);return true;}receiveAudio(){}cancel(){}close(){}}
  let f:ReturnType<typeof fixture>;
  f=fixture({Voice,intent:{resolve:async(input:any)=>({addressed:input.text.includes('Cleo'),command:{action:input.text.includes('counteroffer')?'propose':'speak'}})},intelligence:{reply:async()=>new Promise(resolve=>{resolveReply=resolve;})}});
  const server=createServer();f.transport.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    await f.transport.join(f.session);const body=f.calls[0].body,path=new URL(body.websocket_settings.audio.url).pathname;
    const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}${path}`);await once(ws,'open');
    const token=new URL(body.webhooks[0].url).pathname.split('/').at(-1)!;
    const caption=(id:string,text:string)=>({bot_id:'bot_fixture',idempotency_key:id,trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:Date.parse(f.event('clock').at),transcription:{transcript:text}}});
    await f.transport.webhook(token,caption('background','The payment clause is interesting.'));await tick();assert.equal(spoken.length,0);
    await f.transport.webhook(token,caption('direct','Cleo, explain the payment clause?'));await tick();assert.equal(spoken.length,1);
    await f.transport.webhook(token,caption('proposal','Cleo, suggest a counteroffer?'));await tick();
    const oldLease=f.sessions.lease(f.session,'speak');await f.transport.control(f.session,f.event('quiet'));resolveReply({text:'This stale proposal must never play.',lease:oldLease});await tick();assert.equal(spoken.length,1);
  }finally{await f.transport.close();await new Promise<void>(resolve=>server.close(()=>resolve()));f.sessions.close();}
});

test('any room participant can address Cleo naturally and interrupt her before caption interpretation finishes',async()=>{
 let handoff!:(v:any)=>void,cancelled=0;const spoken:string[]=[],inputs:any[]=[];
 class Voice {async connect(){}cancel(){cancelled++;finish?.(false);}close(){this.cancel();}receiveAudio(){}async respond(turn:any){const text=turn.document.redlines.find((r:any)=>r.id===turn.selectedRedlineId)?.original??turn.dialogue.at(-1);spoken.push(text);return new Promise<boolean>(r=>finish=r);}}
 let finish!:(v:boolean)=>void;
 const f=fixture({Voice,intent:{resolve:async(input:any)=>{
   inputs.push(input);if(input.channel==='imessage')return {addressed:true,command:{action:'note'}};
   if(input.text.includes('from here'))return new Promise(r=>handoff=r);
   return {addressed:true,command:{action:'combined',actions:[{action:'share'},{action:'explain'}]}};
 }},intelligence:{reply:async(b:any)=>f.sessions.publicSpeech(b)}});
 const server=createServer();f.transport.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 try {
  await f.transport.join(f.session);await f.transport.control(f.session,f.event('PRIVATE_SENTINEL keep our limit hidden.'));
  const body=f.calls[0].body,token=new URL(body.webhooks[0].url).pathname.split('/').at(-1)!;
  const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}${new URL(body.websocket_settings.audio.url).pathname}`);await once(ws,'open');
  const stamp=()=>Date.parse(f.event('clock').at);
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'room-open',trigger:'transcript.update',data:{speaker_uuid:'other-attendee',speaker_name:'Another attendee',timestamp_ms:stamp(),transcription:{transcript:'Could you put that wording up and unpack the change for us?'}}});await tick();
  assert.equal(f.sessions.get(f.session).share,true);assert.equal(spoken.length,1);
  assert.doesNotMatch(JSON.stringify(inputs.filter(i=>i.channel==='meeting')),/PRIVATE_SENTINEL/);
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'room-start',trigger:'participant_events.speech_start_stop',data:{participant_uuid:'other-attendee',event_type:'speech_start',timestamp_ms:stamp()}});
  assert.ok(cancelled>0);assert.equal(f.transport.status(f.session).walkthrough,'off');
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'room-handoff',trigger:'transcript.update',data:{speaker_uuid:'other-attendee',timestamp_ms:stamp(),transcription:{transcript:"Okay Cleo, I'll take it from here."}}});await tick();
  handoff({addressed:true,command:{action:'quiet'}});await tick();
  assert.equal(f.sessions.get(f.session).speak,false);assert.equal(f.sessions.get(f.session).share,true);assert.equal(spoken.length,1);
  assert.doesNotMatch(JSON.stringify(f.sessions.privateNotes(f.session)),/take it from here|wording up/);
 }finally{await f.transport.close();await new Promise<void>(r=>server.close(()=>r()));f.sessions.close();}
});

test('a new private message defeats a delayed room grant and a later handoff defeats delayed private interpretation',async()=>{
 let room!:(v:any)=>void,privateTurn!:(v:any)=>void;
 const f=fixture({intent:{resolve:async(input:any)=>{
   if(input.channel==='meeting')return new Promise(r=>room=r);
   if(input.text==='Long private request')return new Promise(r=>privateTurn=r);
   return {addressed:true,command:{action:'note'}};
 }}});
 try{
  await f.transport.join(f.session);const token=new URL(f.calls[0].body.webhooks[0].url).pathname.split('/').at(-1)!;
  const payload={bot_id:'bot_fixture',idempotency_key:'late-room',trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:Date.parse(f.event('clock').at),transcription:{transcript:'Please present that to us.'}}};
  await f.transport.webhook(token,payload);await tick();
  await f.transport.control(f.session,f.event('Keep the fallback private.'));
  room({addressed:true,command:{action:'combined',actions:[{action:'share'},{action:'speak'}]}});await tick();
  assert.equal(f.sessions.get(f.session).speak,false);assert.equal(f.sessions.get(f.session).share,false);
  const pending=f.transport.control(f.session,f.event('Long private request'));await tick();
  await f.transport.control(f.session,f.event('stop speaking'));
  privateTurn({addressed:true,command:{action:'speak'}});await pending;
  assert.equal(f.sessions.get(f.session).speak,false);
  // Provider retries, stale timestamps and missing speaker evidence cannot start new grants.
  await f.transport.webhook(token,payload);
  await f.transport.webhook(token,{...payload,idempotency_key:'stale',data:{...payload.data,timestamp_ms:Date.now()-60000}});
  assert.equal(f.sessions.get(f.session).share,false);
 }finally{await f.transport.close();f.sessions.close();}
});

test('a room request for a private reminder delivers only to the owner and never grants speech',async()=>{
 const sent:any[]=[];
 const f=fixture({intent:{resolve:async()=>({addressed:true,command:{action:'combined',actions:[{action:'remind'},{action:'share'}]}})},
  intelligence:{reply:async()=>{throw new Error('Must remain quiet');},remind:async()=> 'PRIVATE_SENTINEL reminder'},messenger:{send:async(value:any)=>{sent.push(value);return {status:'queued'};}}});
 try{
  await f.transport.join(f.session);const token=new URL(f.calls[0].body.webhooks[0].url).pathname.split('/').at(-1)!;
  const payload={bot_id:'bot_fixture',idempotency_key:'private-room-reminder',trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:Date.parse(f.event('clock').at),transcription:{transcript:'Cleo, remind me what we changed, and show the document.'}}};
  await f.transport.webhook(token,payload);await tick();await f.transport.webhook(token,payload);await tick();
  assert.equal(sent.length,1);assert.equal(sent[0].owner,f.session.owner);assert.match(sent[0].text,/PRIVATE_SENTINEL/);assert.equal(f.sessions.get(f.session).speak,false);assert.equal(f.sessions.get(f.session).share,true);
  assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE_SENTINEL/);
 }finally{await f.transport.close();f.sessions.close();}
});

test('room speech during a private reminder does not cancel it, and understanding failures cannot grant output',async()=>{
 let finishReminder!:(text:string)=>void;const sent:any[]=[];let fail=false;
 const f=fixture({intent:{resolve:async()=>{if(fail)throw new Error('offline');return {addressed:true,command:{action:'remind'}};}},
  intelligence:{reply:async()=>undefined,remind:async()=>new Promise<string>(r=>finishReminder=r)},messenger:{send:async(value:any)=>{sent.push(value);return {status:'queued'};}}});
 try{
  await f.transport.join(f.session);const token=new URL(f.calls[0].body.webhooks[0].url).pathname.split('/').at(-1)!;
  const stamp=()=>Date.parse(f.event('clock').at);
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'reminder-slow',trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:stamp(),transcription:{transcript:'Could you text me a reminder?'}}});await tick();
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'background-start',trigger:'participant_events.speech_start_stop',data:{participant_uuid:'another',timestamp_ms:stamp(),event_type:'speech_start'}});
  finishReminder('PRIVATE_SENTINEL');await tick();assert.equal(sent.length,1);
  fail=true;await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'understanding-failed',trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:stamp(),transcription:{transcript:'Can you join in?'}}});await tick();
  assert.equal(f.sessions.get(f.session).speak,false);assert.equal(f.transport.status(f.session).request_understanding,'unavailable');
  const result=await f.transport.control(f.session,f.event('be quiet'));assert.equal(result.speaking_permitted,false);
 }finally{await f.transport.close();f.sessions.close();}
});

test('Cleo waits for the room to finish speaking before answering a natural request',async()=>{
 let spoken=0;
 class Voice {async connect(){}cancel(){}close(){}receiveAudio(){}async respond(){spoken++;return true;}}
 const f=fixture({Voice,intent:{resolve:async()=>({addressed:true,command:{action:'explain'}})},intelligence:{reply:async(b:any)=>f.sessions.publicSpeech(b)}});
 const server=createServer();f.transport.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  await f.transport.join(f.session);const body=f.calls[0].body,token=new URL(body.webhooks[0].url).pathname.split('/').at(-1)!;
  const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}${new URL(body.websocket_settings.audio.url).pathname}`);await once(ws,'open');
  const start=Date.parse(f.event('clock').at);
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'person-start',trigger:'participant_events.speech_start_stop',data:{participant_uuid:'attendee',event_type:'speech_start',timestamp_ms:start+1}});
  // Caption and activity streams can have slightly different start timestamps.
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'person-request',trigger:'transcript.update',data:{speaker_uuid:'attendee',timestamp_ms:start,transcription:{transcript:'Could you unpack the change here for us?'}}});await tick();assert.equal(spoken,0);
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'person-stop',trigger:'participant_events.speech_start_stop',data:{participant_uuid:'attendee',event_type:'speech_stop',timestamp_ms:start+2}});await tick();assert.equal(spoken,1);
 }finally{await f.transport.close();await new Promise<void>(r=>server.close(()=>r()));f.sessions.close();}
});

test('a newer spoken handoff waits for concurrent private guidance instead of being lost',async()=>{
 let finishPrivate!:(result:any)=>void,roomRequests=0;
 const f=fixture({intent:{resolve:async(input:any)=>input.channel==='imessage'?new Promise(r=>finishPrivate=r):(roomRequests++,{addressed:true,command:{action:'quiet'}})}});
 try{
  await f.transport.join(f.session);f.sessions.control(f.session,f.event('take over'));
  const pending=f.transport.control(f.session,f.event('Keep our fallback private.'));await tick();
  const token=new URL(f.calls[0].body.webhooks[0].url).pathname.split('/').at(-1)!;
  await f.transport.webhook(token,{bot_id:'bot_fixture',idempotency_key:'concurrent-handoff',trigger:'transcript.update',data:{speaker_uuid:'participant',timestamp_ms:Date.parse(f.event('clock').at),transcription:{transcript:'Thanks Cleo, I can handle the rest.'}}});await tick();assert.equal(roomRequests,0);
  finishPrivate({addressed:true,command:{action:'note'}});await pending;await tick();assert.equal(roomRequests,1);assert.equal(f.sessions.get(f.session).speak,false);
 }finally{await f.transport.close();f.sessions.close();}
});

test('natural invitations bind the exact verified link and exclude Keiki attachment descriptions',async()=>{
 const seen:any[]=[];let allow=true,fail=false;
 const f=fixture({intent:{resolve:async()=>({addressed:false,command:{action:'note'}}),authorizeInvitation:async(text:string,url:string)=>{seen.push({text,url});if(fail)throw new Error('offline');return allow;}}});
 const record=(text:string)=>f.sessions.recordIngress(f.event(text));
 try{
  const e=record(`Here you go, I authorise you\n${meetingUrl}\n\n[Attachment; attachment_id=fixture; mime=application/octet-stream: [Unreadable attachment]]`);
  assert.equal(await f.transport.requireJoinIntent('owner',meetingUrl,e.id),true);assert.equal(seen[0].text,`Here you go, I authorise you\n${meetingUrl}`);
  const missing=record(`Please read this.\n\n[Attachment; attachment_id=fixture: join ${meetingUrl}]`);
  await assert.rejects(f.transport.requireJoinIntent('owner',meetingUrl,missing.id),/present/);assert.equal(seen.length,1);
  await assert.rejects(f.transport.requireJoinIntent('other',meetingUrl,e.id));await assert.rejects(f.transport.requireJoinIntent('owner','https://meet.google.com/xyz-abcd-efg',e.id));
  allow=false;await assert.rejects(f.transport.requireJoinIntent('owner',meetingUrl,record(`Don't join ${meetingUrl}`).id),/did not ask/);
  fail=true;await assert.rejects(f.transport.requireJoinIntent('owner',meetingUrl,e.id),/understanding is unavailable/);
  f.advance(300001);await assert.rejects(f.transport.requireJoinIntent('owner',meetingUrl,e.id),/stale/);assert.equal(f.calls.length,0);
 }finally{await f.transport.close();f.sessions.close();}
});

test('shared-line join accepts natural authenticated invitation and keeps duplicate attendance quiet',async()=>{
 const f=fixture({intent:{resolve:async()=>({addressed:false,command:{action:'note'}}),authorizeInvitation:async()=>true}});
 const workflow={config:{webhookKey:'fixture-webhook-key-123456',publicUrl:'https://cleo.example'},async registerSender(body:any){if(body.context.phone!=='+15555550100')throw new Error('wrong owner');return 'owner';},owner:(body:any)=>{if(body.context.phone!=='+15555550100')throw new Error('wrong owner');return 'owner';},meetingSelection:Workflow.prototype.meetingSelection,meetingOutputId:(_o:string,_s:string,id?:string)=>{assert.equal(id,undefined);return 'saved-review';},meetingDocument:async(_o:string,_s:string,id?:string)=>{assert.equal(id,'saved-review');return document;},meetingGoogleDocument:async(_o:string,_s:string,id?:string)=>{assert.equal(id,'saved-review');return 'verified-google-doc';}} as unknown as Workflow;
 const routes=new MeetingRoutes(f.transport,workflow,{secret:'fixture-identity-secret-12345678901234567890',agentId:'fixture-agent',line:'fixture-line'});
 const server=createApp(workflow,undefined,routes);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/tools/join_meeting`;
  const body={input:{source_id:'source',meeting_url:meetingUrl,request_id:'model-id'},context:{phone:'+15555550100',agentId:'fixture-agent',channel:{channel:'sms',provider:'blooio',gateway:'fixture-line',userId:'+15555550100',isDirect:true,messageId:'natural-invitation',inboundText:`Join this meeting\n${meetingUrl}\n\n[Attachment; attachment_id=fixture: [Unreadable attachment]]`}}};
  const send=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-orchid-api-key':workflow.config.webhookKey},body:JSON.stringify(body)});
  let response=await send();assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,'joining');assert.equal(result.output_id,'saved-review');assert.equal(result.saved_redlines,1);assert.equal(result.presentation,'saved_contract_view');assert.equal(result.speaking,false);assert.equal(result.sharing,false);
  response=await send();assert.equal(response.status,200);assert.equal(f.calls.filter(c=>c.url.endsWith('/bots')).length,1);
  body.context.channel.inboundText='The model invented the meeting link.';body.context.channel.messageId='no-link';response=await send();assert.equal(response.status,422);assert.equal(f.calls.filter(c=>c.url.endsWith('/bots')).length,1);
 }finally{await f.transport.close();await new Promise<void>(r=>server.close(()=>r()));f.sessions.close();}
});
