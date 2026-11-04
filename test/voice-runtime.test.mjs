import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CleoVoice } from '../src/voice-runtime.mjs';

class Session extends EventEmitter {
  transport = new EventEmitter(); sent = []; audio = [];
  constructor(agent) { super(); this.agent = agent; this.transport.sendEvent = e => this.sent.push(e); }
  async connect() {}
  sendAudio(data) { this.audio.push(data); }
  sendMessage(message) { this.sent.push({ message }); }
  close() {}
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a spoken preamble stays thinking through its tools and only listens after the final playback', () => {
  const events = [], voice = new CleoVoice({ apiKey: 'test-only', emit: e => events.push(e), Session });
  const state = () => events.filter(e => e.type === 'turn_state').at(-1)?.state;
  try {
    voice.event({ type: 'input_audio_buffer.speech_started', item_id: 'speech' });
    voice.event({ type: 'input_audio_buffer.speech_stopped' });
    voice.event({ type: 'response.created', response: { id: 'preamble' } });
    voice.turns.audioQueued('preamble'); voice.audio.add('preamble');
    voice.input({ type: 'playback_started', id: 'preamble' });
    voice.event({ type: 'response.done', response: { id: 'preamble', status: 'completed', output: [{ type: 'function_call' }] } });
    voice.input({ type: 'playback_finished', id: 'preamble' });
    assert.equal(state(), 'thinking');
    voice.event({ type: 'response.created', response: { id: 'answer' } });
    voice.turns.audioQueued('answer'); voice.audio.add('answer');
    voice.input({ type: 'playback_started', id: 'answer' });
    voice.event({ type: 'response.done', response: { id: 'answer', status: 'completed', output: [] } });
    voice.input({ type: 'playback_finished', id: 'answer' });
    assert.equal(state(), 'listening');
  } finally { voice.close(); }
});

test('native startup probes the actual renderer before connecting, without inventing availability on older apps', async () => {
  for (const [receipt, status] of [[{ protocolVersion: 1, sketch: 'ready', buildID: '0123456789abcdef' }, 'ready'],
    [{ protocolVersion: 1, sketch: 'unavailable' }, 'unavailable'], [{ error: 'Unknown action' }, 'unknown']]) {
    const events = [], reports = [];
    const voice = new CleoVoice({ apiKey: 'test-only', emit: e => events.push(e), diagnose: e => reports.push(e), Session });
    let connected = false;
    voice.session.connect = async () => { connected = true; };
    try {
      const connecting = voice.connect({ nativeHandshake: true });
      assert.equal(connected, false);
      assert.equal(events[0].action, 'native_capabilities');
      voice.input({ type: 'result', id: events[0].id, result: receipt });
      await connecting;
      assert.equal(connected, true);
      assert.match(voice.agent.instructions, new RegExp(`renderer is ${status}`));
      assert.equal(reports.at(-1).sketch, status);
      assert.ok(voice.agent.tools.some(t => t.name === 'sketch_notepad'));
    } finally { voice.close(); }
  }
});

test('native diagnostics distinguish drawing failures without retaining screen or sketch text', async () => {
  const events = [], reports = [];
  const voice = new CleoVoice({ apiKey: 'test-only', emit: e => events.push(e), diagnose: e => reports.push(e), Session });
  try {
    const request = voice.request('sketch_notepad', { title: 'private contract' });
    voice.input({ type: 'result', id: events.at(-1).id, result: { error: 'Invalid or duplicate sketch element.', text: 'private contract' } });
    await request;
    assert.equal(reports.at(-1).outcome, 'invalid_element');
    assert.equal(JSON.stringify(reports).includes('private contract'), false);
    const second = voice.request('read_notepad', {});
    voice.input({ type: 'result', id: events.at(-1).id, result: { revision: 2, elements: [{ text: 'private contract' }] } });
    await second;
    assert.equal(reports.at(-1).elements, 1);
    assert.equal(JSON.stringify(reports).includes('private contract'), false);
  } finally { voice.close(); }
});

test('older native builds receive one line only; modern builds get requested bounded drawing style', async () => {
  const events = [], voice = new CleoVoice({ apiKey: 'test-only', emit: e => events.push(e), Session });
  try {
    voice.snapshot = { snapshotID: 's', lines: [{ id: '0' }, { id: '9' }] };
    const old = voice.mark({ snapshotID: 's', lineIDs: ['0', '9'], style: 'underline' });
    const action = events.at(-1);
    assert.deepEqual(action.args.lineIDs, ['0']);
    assert.equal(action.args.style, 'circle');
    voice.input({ type: 'result', id: action.id, result: { ok: true } });
    assert.equal((await old).style, 'circle');
    voice.snapshot.markStyles = ['circle', 'underline'];
    const before=events.length;
    assert.match((await voice.mark({snapshotID:'s',lineIDs:['0'],quote:'sixty days',style:'circle'})).error,/cannot mark exact words/);
    assert.equal(events.length,before,'Older native builds must not broaden an exact phrase into a full line');
    voice.snapshot.exactPhraseMarks = true;
    assert.match((await voice.mark({snapshotID:'s',lineIDs:['0'],quote:'sixty days',style:'highlight'})).error,/does not support/);
    voice.snapshot.markStyles.push('highlight');
    const highlighted=voice.mark({snapshotID:'s',lineIDs:['0'],quote:'sixty days',style:'highlight'});
    const highlight=events.at(-1);
    assert.equal(highlight.args.quote,'sixty days');assert.equal(highlight.args.style,'highlight');
    voice.input({type:'result',id:highlight.id,result:{ok:true,quote:'sixty days',style:'highlight'}});
    assert.equal((await highlighted).style,'highlight');
    const modern = voice.mark({ snapshotID: 's', lineIDs: ['0', '9'], style: 'underline' });
    const next = events.at(-1);
    assert.deepEqual(next.args.lineIDs, ['0', '9']);
    assert.equal(next.args.style, 'underline');
    voice.input({ type: 'result', id: next.id, result: { error: 'Disjoint lines' } });
    assert.deepEqual(await modern, { error: 'Disjoint lines' });
    assert.ok((await voice.mark({ snapshotID: 'old', lineIDs: ['0'], style: 'circle' })).error);
  } finally { voice.close(); }
});

test('highlight diagnostics preserve precise native reasons without recording private text', async () => {
  const events=[], reports=[];
  const voice=new CleoVoice({apiKey:'test-only',emit:e=>events.push(e),diagnose:e=>reports.push(e),Session});
  try {
    for(const code of ['mark_snapshot_mismatch','mark_invalid_line_count','mark_no_snapshot',
      'mark_invalid_line_ids','mark_invalid_quote','mark_geometry_rejected','mark_unknown_style',
      'mark_window_changed','mark_page_changed','mark_interrupted','mark_wording_moved',
      'mark_quote_unresolved','mark_pending_limit','mark_capture_failed','private arbitrary code']) {
      const request=voice.request('mark_passage',{quote:'private contract wording'});
      voice.input({type:'result',id:events.at(-1).id,result:{error:'private contract wording',code}});
      await request;
      assert.equal(reports.at(-1).outcome,code.startsWith('mark_')?code:'error');
    }
    assert.ok(!JSON.stringify(reports).includes('private'));
  } finally {voice.close();}
});

test('voice can retrieve the real shared legal library with voice-specific capability boundaries', async () => {
  const voice = new CleoVoice({ apiKey: 'test-only', emit: () => {}, Session });
  try {
    voice.calls.set('skill', voice.epoch);
    const tool = voice.session.agent.tools.find(t => t.name === 'get_review_skill');
    const result = await tool.invoke({}, JSON.stringify({ skill_id: 'cleo-clause-explainer' }), { toolCall: { callId: 'skill' } });
    assert.equal(result.id, 'cleo-clause-explainer');
    assert.ok(result.references[0].content.length > 100);
    assert.ok(result.boundaries.some(text => text.includes('scrolling and delivery are not connected')));
    assert.ok(result.boundaries.some(text => text.includes('sketch tools draw separately')));
    assert.ok(result.boundaries.some(text => text.includes('verified_suggestion')));
    assert.match(result.references[0].content, /read_notepad then sketch_diagram/);
    assert.doesNotMatch(result.references[0].content, /visual-capable future client/);
    assert.ok(!result.boundaries.some(text => text.startsWith('Return a checked copy')));
    const rejected = await tool.invoke({}, JSON.stringify({ skill_id: '../../.env' }), { toolCall: { callId: 'skill' } });
    assert.ok(rejected.error);
  } finally { voice.close(); }
});

test('microphone diagnostics expose sample counts and levels, never audio or text', () => {
  const reports = [], voice = new CleoVoice({ apiKey: 'test-only', emit: () => {}, diagnose: e => reports.push(e), Session });
  try {
    voice.event({ type: 'session.updated' });
    const pcm = Buffer.alloc(4800);
    pcm.writeInt16LE(-5000, 10);
    voice.input({ type: 'audio', data: pcm.toString('base64') });
    assert.equal(voice.session.audio.length, 1);
    assert.deepEqual(reports.at(-1), { event: 'microphone_forwarded', seconds: 0.1, peak: 5000 });
    assert.equal(JSON.stringify(reports).includes(pcm.toString('base64')), false);
  } finally { voice.close(); }
});

test('waits for configured connection and fresh screen context; abandoned turn cannot respond', async () => {
  const events = [], voice = new CleoVoice({ apiKey: 'test-only', emit: e => events.push(e), Session });
  try {
    await voice.connect();
    voice.input({ type: 'audio', data: 'AAAA' });
    assert.equal(voice.session.audio.length, 0);
    voice.event({ type: 'session.updated' });
    voice.event({ type: 'input_audio_buffer.speech_started', item_id: 'one' });
    const first = events.find(e => e.type === 'action');
    voice.event({ type: 'input_audio_buffer.speech_stopped' });
    voice.event({ type: 'input_audio_buffer.committed' });
    assert.deepEqual(voice.session.sent, []);
    voice.event({ type: 'input_audio_buffer.speech_started', item_id: 'two' });
    voice.input({ type: 'result', id: first.id, result: { snapshotID: 'stale' } });
    await tick();
    assert.deepEqual(voice.session.sent, []);
    voice.event({ type: 'input_audio_buffer.speech_stopped' });
    voice.event({ type: 'input_audio_buffer.committed' });
    const second = events.filter(e => e.type === 'action').at(-1);
    voice.input({ type: 'result', id: second.id, result: { snapshotID: 'fresh', lines: [] } });
    await tick();
    assert.equal(voice.session.sent[0].type, 'conversation.item.create');
    assert.match(voice.session.sent[0].item.content[0].text, /fresh/);
    assert.equal(voice.session.sent[1].type, 'response.create');
  } finally { voice.close(); }
});

test('native tool outputs from an interrupted turn do not trigger another reply', async () => {
  const events = [], voice = new CleoVoice({ apiKey: 'test-only', emit: e => events.push(e), Session });
  try {
    voice.event({ type: 'input_audio_buffer.speech_started', item_id: 'one' });
    voice.event({ type: 'response.created', response: { id: 'r1' } });
    voice.event({ type: 'response.output_item.added', response_id: 'r1', item: { type: 'function_call', call_id: 'c1' } });
    const mark = voice.session.agent.tools.find(t => t.name === 'mark_passage');
    voice.snapshot = { snapshotID: 's1', lines: [{ id: '0', text: 'Clause' }] };
    const promise = mark.invoke({}, JSON.stringify({ snapshotID: 's1', lineIDs: ['0'], style: 'circle' }), { toolCall: { callId: 'c1' } });
    await tick();
    const action = events.find(e => e.action === 'mark_passage');
    assert.ok(action);
    voice.event({ type: 'input_audio_buffer.speech_started', item_id: 'two' });
    voice.input({ type: 'result', id: action.id, result: { ok: true } });
    const result = await promise;
    assert.equal(result.content.error, 'Turn interrupted.');
  } finally { voice.close(); }
});

test('speech waits for document binding and does not save a new contract question into the previous contract',async()=>{
 const saved=[],events=[];
 const context={source:'old',list:()=>[],open:()=>{},recall:()=>{},fromScreen:async()=>{context.source=null;return {status:'not_bound'};},remember:async text=>saved.push(text)};
 const voice=new CleoVoice({apiKey:'test',emit:e=>events.push(e),Session,context});
 try {
  voice.event({type:'input_audio_buffer.speech_started',item_id:'speech1'});
  voice.event({type:'conversation.item.input_audio_transcription.completed',item_id:'speech1',transcript:'New confidential matter'});
  voice.input({type:'result',id:events.find(e=>e.action==='refresh_screen').id,result:{lines:[{id:'1',text:'different document'}]}});
  await tick();assert.deepEqual(saved,[]);
 }finally{voice.close();}
});

test('voice has no meeting-link creation tool even with connected context',()=>{
 const voice=new CleoVoice({apiKey:'test',emit:()=>{},Session,context:{}});
 try {
  assert.equal(voice.agent.tools.some(t=>t.name==='create_meeting_link'),false);
  assert.match(voice.agent.instructions,/cant generate one myself, send over the link and ill hop on/);
 }finally{voice.close();}
});
