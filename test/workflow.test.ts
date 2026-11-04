import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import JSZip from 'jszip';
import { Workflow, attachmentFilename, type Config, type ToolRequest } from '../src/workflow.ts';
import { createApp } from '../src/server.ts';
import type { Store, Source, Output, Draft } from '../src/store.ts';

class TestStore implements Store {
  async saveSender() {}
  async getSender() { return undefined; }
  sources = new Map<string, Source>(); outputs = new Map<string, Output>();
  drafts = new Map<string, Draft>();
  async saveSource(s: Source) { this.sources.set(s.owner + s.id, s); }
  async getSource(id: string, owner: string) { return this.sources.get(owner + id); }
  async saveOutput(o: Output) { if (!this.outputs.has(o.owner + o.id)) this.outputs.set(o.owner + o.id, o); }
  async getOutput(id: string, owner: string) { return this.outputs.get(owner + id); }
  async saveDraft(d: Draft) { if (!this.drafts.has(d.owner + d.id)) this.drafts.set(d.owner + d.id, d); }
  async getDraft(id: string, owner: string) { return this.drafts.get(owner + id); }
}
const config: Config = { webhookKey: 'test-only-webhook-key-123456', downloadSecret: 'test-only-signing-secret-123456789012', publicUrl: 'https://cleo.example', localOnly: true, attachmentOrigins: ['https://media.example'] };
const request: ToolRequest = { input: { attachment_id: 'a1' }, context: { phone: 'tester', channel: 'imessage', attachments: { a1: { filename: 'Contract.docx', url: 'https://media.example/file' } } } };
async function setup() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Notice is sixty days.</w:t></w:r></w:p></w:body></w:document>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const store = new TestStore(); let fetches = 0;
  const workflow = new Workflow(store, config, (async (_url: unknown, init: RequestInit) => { fetches++; assert.equal(init.redirect, 'error'); return new Response(new Uint8Array(bytes)); }) as typeof fetch);
  return { workflow, store, fetches: () => fetches };
}

test('read, revise, persisted readback and signed download form one workflow', async () => {
  const { workflow, store } = await setup();
  const source = await workflow.read(request);
  const draft = { input: { source_id: source.source_id, source_sha256: source.source_sha256, changes: [{ paragraphId: 'p0', original: 'sixty days', replacement: 'thirty days', reason: 'User requested thirty days.' }] }, context: request.context };
  const result = await workflow.revise(draft);
  assert.equal(result.delivery_status, 'not_sent');
  assert.equal(result.status, 'verified_tracked_changes');
  const output = await workflow.download(new URL(result.download_url));
  assert.equal(output.outputSha256, result.output_sha256);
  assert.equal((await workflow.revise(draft)).output_sha256, result.output_sha256);
  assert.equal(store.outputs.size, 1);
  const preview = await workflow.download(new URL(result.preview_download_url));
  assert.equal(preview.filename, 'Cleo-redline-review.pdf');
  assert.equal(preview.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(preview.outputSha256, result.preview_sha256);
  assert.equal(result.comment_count, 1);
  const crossed = new URL(result.download_url); crossed.pathname = crossed.pathname.replace('/files/', '/previews/');
  await assert.rejects(workflow.download(crossed), /invalid or expired/);
  const wrongPreviewOwner = new URL(result.preview_download_url); wrongPreviewOwner.searchParams.set('owner', 'other');
  await assert.rejects(workflow.download(wrongPreviewOwner), /invalid or expired/);
  const tampered = new URL(result.download_url); tampered.searchParams.set('owner', 'other');
  await assert.rejects(workflow.download(tampered), /invalid or expired/);
  const expired = new URL(result.download_url); expired.searchParams.set('expires', '1');
  await assert.rejects(workflow.download(expired), /invalid or expired/);
});

test('missing senders, internal turns and untrusted attachment URLs never download', async () => {
  const { workflow, fetches } = await setup();
  for (const patch of [{ phone: '' }, { internal: true }, { channel: 'slack' }]) {
    await assert.rejects(workflow.read({ ...request, context: { ...request.context, ...patch } }), /restricted/);
  }
  await assert.rejects(workflow.read({ ...request, context: { ...request.context, attachments: { a1: { filename: 'Contract.docx', url: 'https://other.example/file' } } } }), /origin/);
  assert.equal(fetches(), 0);
});

test('local ChannelEnvelope preserves sender identity and rejects invalid channels and groups', async () => {
  const { workflow } = await setup();
  const context = { ...request.context, channel: { channel: 'sms', isDirect: true } };
  const source = await workflow.read({ ...request, context });
  assert.equal(source.paragraphs[0].text, 'Notice is sixty days.');
  assert.equal(workflow.owner({ ...request, context }), workflow.owner(request));
  for (const patch of [
    { phone: '' }, { internal: true },
    { channel: { channel: 'slack', isDirect: true } },
    { channel: { channel: 'sms', isDirect: false } },
    { channel: {} }, { channel: undefined },
  ]) await assert.rejects(workflow.read({ ...request, context: { ...context, ...patch } }), /restricted/);
});

test('Keiki null filenames resolve by MIME without bypassing parsing, origin or checksum checks', async () => {
  const { workflow, fetches } = await setup();
  const file = { filename: null, mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', url: 'https://media.example/file' };
  const req = { ...request, context: { ...request.context, attachments: { a1: file } } };
  const result = await workflow.read(req);
  assert.equal(result.paragraphs[0].text, 'Notice is sixty days.');
  assert.equal(result.source_id, (await workflow.read(request)).source_id);
  await assert.rejects(workflow.read({ ...req, context: { ...req.context, attachments: { a1: { ...file, sha256: 'wrong' } } } }), /checksum mismatch/);
  await assert.rejects(workflow.read({ ...req, context: { ...req.context, attachments: { a1: { ...file, mime_type: 'application/pdf' } } } }), /content does not match/);
  const before = fetches();
  await assert.rejects(workflow.read({ ...req, context: { ...req.context, attachments: { a1: { ...file, url: 'https://untrusted.example/file' } } } }), /origin/);
  assert.equal(fetches(), before);
  assert.equal(attachmentFilename({ filename: null, mime_type: 'application/pdf' }), 'attachment.pdf');
  assert.equal(attachmentFilename({ filename: 'contract', mime_type: 'text/html; charset=utf-8' }), 'contract.html');
  assert.equal(attachmentFilename({ filename: ' Contract.PDF ', mime_type: 'application/octet-stream' }), 'Contract.PDF');
  for (const meta of [{ filename: null }, { filename: 'contract.exe', mime_type: 'application/pdf' }, { mime_type: 'application/octet-stream' }])
    assert.throws(() => attachmentFilename(meta), /format could not be identified/);
});

test('missing attachment metadata and links produce distinct errors without downloading', async () => {
  const { workflow, fetches } = await setup();
  for (const [attachments, error] of [
    [undefined, /did not supply the selected attachment/],
    [{ other: request.context.attachments!.a1 }, /did not supply the selected attachment/],
    [{ a1: { filename: 'test.pdf' } }, /no download link/],
    [{ a1: { filename: 'test.pdf', url: 'not-a-url' } }, /link is invalid/],
  ] as const) await assert.rejects(workflow.read({ ...request, context: { ...request.context, attachments } }), error);
  assert.equal(fetches(), 0);
});

test('HTTP endpoints authenticate before processing and do not expose documents publicly', async t => {
  const { workflow, fetches } = await setup();
  const warnings = t.mock.method(console, 'warn', () => {});
  const server = createApp(workflow); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/tools/read_contract`, { method: 'POST', body: JSON.stringify(request) })).status, 401);
  const wrongKey = 'incorrect-credential-never-log-this';
  assert.equal((await fetch(`${base}/tools/read_contract`, { method: 'POST', headers: { 'X-Orchid-Api-Key': wrongKey }, body: JSON.stringify(request) })).status, 401);
  const diagnostic = JSON.parse(warnings.mock.calls.at(-1)!.arguments[0]);
  assert.equal(diagnostic.event, 'webhook_auth_denied');
  assert.equal(diagnostic.headerPresent, true);
  assert.match(diagnostic.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(warnings.mock.calls).includes(wrongKey));
  assert.equal(fetches(), 0);
  const response = await fetch(`${base}/tools/read_contract`, { method: 'POST', body: JSON.stringify(request), headers: { 'Content-Type': 'application/json', 'X-Orchid-Api-Key': config.webhookKey } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).paragraphs[0].text, 'Notice is sixty days.');
  assert.equal((await fetch(`${base}/files/anything`)).status, 422);
});

test('new drafts persist once, remain owner-scoped and cannot reuse redline download signatures', async () => {
  const { workflow, store } = await setup();
  const draft = { input: { draft: { title: 'Draft memo', blocks: [{ kind: 'paragraph', text: 'User-supplied facts.' }] } }, context: request.context };
  const result = await workflow.draft(draft);
  assert.equal(result.status, 'generated_draft');
  assert.equal(result.delivery_status, 'not_sent');
  assert.equal(result.checks.legal_accuracy, 'not_verified');
  assert.equal((await workflow.draft(draft)).output_sha256, result.output_sha256);
  assert.equal(store.drafts.size, 1);
  const url = new URL(result.download_url);
  const output = await workflow.download(url);
  assert.equal(output.filename, 'Cleo-draft.docx');
  assert.equal(await store.getDraft(output.id, 'other-owner'), undefined);
  const wrongRoute = new URL(url); wrongRoute.pathname = wrongRoute.pathname.replace('/drafts/', '/files/');
  await assert.rejects(workflow.download(wrongRoute), /invalid or expired/);
  const wrongOwner = new URL(url); wrongOwner.searchParams.set('owner', 'other-owner');
  await assert.rejects(workflow.download(wrongOwner), /invalid or expired/);
  for (const context of [{ phone: '', channel: 'imessage' }, { ...request.context, internal: true }]) {
    await assert.rejects(workflow.draft({ ...draft, context }), /restricted/);
  }
  output.bytes = Buffer.from('Corrupted draft');
  await assert.rejects(workflow.download(url), /checksum mismatch/);
});

test('draft creation HTTP route authenticates and returns a downloadable Word draft', async t => {
  const { workflow } = await setup();
  const server = createApp(workflow); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ input: { draft: { title: 'Draft', blocks: [{ kind: 'paragraph', text: 'Body' }] } }, context: request.context });
  assert.equal((await fetch(base + '/tools/create_legal_draft', { method: 'POST', body })).status, 401);
  const response = await fetch(base + '/tools/create_legal_draft', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Orchid-Api-Key': config.webhookKey } });
  assert.equal(response.status, 200);
  const result = await response.json(), url = new URL(result.download_url);
  const download = await fetch(base + url.pathname + url.search);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="Cleo-draft.docx"');
  assert.ok((await download.arrayBuffer()).byteLength > 0);
});

test('converted uploads preserve originals, persist stable baselines and protect disclosure', async () => {
  const original = Buffer.from('<p>Notice is sixty days.</p>');
  const store = new TestStore();
  const workflow = new Workflow(store, config, (async () => new Response(new Uint8Array(original))) as typeof fetch);
  const req: ToolRequest = { input: { attachment_id: 'a1' }, context: { ...request.context, channel: 'sms', attachments: { a1: { filename: 'terms.html', url: 'https://media.example/file' } } } };
  const a = await workflow.read(req), b = await workflow.read(req);
  assert.equal(a.source_sha256, b.source_sha256);
  assert.equal(a.import.converted, true);
  const saved = await store.getSource(a.source_id, workflow.owner(req));
  assert.deepEqual(saved?.originalBytes, original);
  assert.equal(a.paragraphs[2].editable, false);
  await assert.rejects(workflow.revise({ input: { source_id: a.source_id, source_sha256: a.source_sha256, changes: [{ paragraphId: 'p2', original: a.paragraphs[2].text, replacement: 'Hidden', reason: 'Test' }] }, context: req.context }), /disclosure/);
  const clause = a.paragraphs.find(p => p.text === 'Notice is sixty days.'); assert.ok(clause);
  const result = await workflow.revise({ input: { source_id: a.source_id, source_sha256: a.source_sha256, changes: [{ paragraphId: clause.id, original: 'sixty', replacement: 'thirty', reason: 'Test' }] }, context: req.context });
  assert.equal(result.filename, 'Cleo-converted-redline.docx');
  assert.equal(result.import.converted, true);
  assert.equal((await workflow.pageSource({ input: { source_id: a.source_id }, context: req.context })).import.converted, true);
});

test('authenticated iMessage context is immediately visible to the paired desktop and excludes other owners',async()=>{
 const {MatterContext}=await import('../src/matter-context.ts');
 const {workflow}=await setup();const matter=new MatterContext(':memory:');workflow.matter=matter;
 const source=await workflow.read(request);
 const remembered=await workflow.contractContext({context:request.context,input:{source_id:source.source_id,events:[
  {id:'user-message-1',role:'user',channel:'imessage',at:'2026-11-01T10:00:00Z',text:'I am a senior associate. I represent the supplier and want a practical settlement.'}
 ]}},true);
 assert.equal(remembered.recent_messages.length,1);
 assert.match(String((await matter.recall(workflow.owner(request),source.source_id)).recent_messages[0].text),/supplier/);
 await assert.rejects(()=>workflow.contractContext({context:{phone:'outsider',channel:'imessage'},input:{source_id:source.source_id}}),/not found/);
 await assert.rejects(()=>workflow.contractContext({context:request.context,input:{source_id:'unknown'}}),/not found/);
 matter.close();
});

test('desktop bridge accepts only its separate credential and ignores caller-supplied identities',async()=>{
 const {MatterContext}=await import('../src/matter-context.ts');
 const {workflow}=await setup();const matter=new MatterContext(':memory:');workflow.matter=matter;
 workflow.config={...workflow.config,desktopToken:'desktop-test-token-1234567890123456',desktopSender:'tester'};
 const source=await workflow.read(request);
 matter.register('someone-else','secret','Private other contract');
 const server=createApp(workflow);server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
 try {
  const call=(path:string,input:unknown,key=workflow.config.desktopToken)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-cleo-desktop-key':key!},body:JSON.stringify({input,context:{phone:'someone-else'},owner:'someone-else'})});
  assert.equal((await call('/desktop/list',{},workflow.config.webhookKey)).status,401);
  for(const action of ['read_document','suggest_document'])
    assert.equal((await call('/desktop/'+action,{},workflow.config.webhookKey)).status,401);
  const edits:any[]=[];
  workflow.editing={read:async(owner:string,id:string)=>{edits.push({owner,id});return {status:'read'};},
    suggest:async(owner:string,input:any)=>{edits.push({owner,input});return {status:'verified_suggestion'};}} as any;
  assert.equal((await call('/desktop/read_document',{document_id:'selected'})).status,200);
  assert.equal((await call('/desktop/suggest_document',{document_id:'selected'})).status,200);
  assert.ok(edits.every(e=>e.owner===workflow.owner(request)),'document routes use the paired identity, never the supplied owner');
  const listed=await (await call('/desktop/list',{})).json();assert.equal(listed.length,1);assert.equal(listed[0].source_id,source.source_id);
  assert.equal((await call('/desktop/recall',{source_id:'secret'})).status,422);
  const event={id:'spoken-bridge',role:'user',channel:'screen',at:'2026-11-01T10:00:00Z',text:'Keep the commercial position practical.'};
  assert.equal((await call('/desktop/remember',{source_id:source.source_id,events:[event]})).status,200);
  assert.equal((await workflow.contractContext({input:{source_id:source.source_id},context:request.context})).recent_messages[0].text,event.text);
  assert.equal((await call('/tools/redline_contract',{source_id:source.source_id})).status,401,'desktop token cannot create redlines');
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));matter.close();}
});

test('retired meeting-link creation endpoints stay unavailable with valid credentials', async t => {
  const {workflow}=await setup();
  const {MatterContext}=await import('../src/matter-context.ts');
  workflow.matter=new MatterContext(':memory:');
  workflow.config={...workflow.config,desktopToken:'dedicated-desktop-token-for-test-123456',desktopSender:'tester'};
  const server=createApp(workflow);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();workflow.matter?.close();});
  const addr=server.address();assert.ok(addr&&typeof addr==='object');const base=`http://127.0.0.1:${addr.port}`;
  const post=(path:string,key:string,value:string)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',[key]:value},body:JSON.stringify({input:{request_id:'retired'},context:request.context})});
  assert.equal((await post('/tools/create_meeting_link','x-orchid-api-key',config.webhookKey)).status,404);
  assert.equal((await post('/desktop/meeting','x-cleo-desktop-key',workflow.config.desktopToken!)).status,404);
});
