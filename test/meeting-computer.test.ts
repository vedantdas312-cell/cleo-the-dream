import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationLocation} from '../src/meeting-presentation-model.ts';
import {createPresentationSnapshot} from '../src/meeting-presentation-snapshot.ts';
import {MaritimeMeetingPresenter} from '../src/meeting-computer.ts';
const document={title:'Contract review',paragraphs:[{id:'p0',text:'A public clause applies.'}],redlines:[{id:'r1',paragraphId:'p0',original:'public clause',replacement:'updated clause'}]};
const location=presentationLocation(document,'r1')!,snapshot=createPresentationSnapshot(document);
const binding={owner:'owner-a',sourceId:'source-a',sessionId:'session-a'};
const commandInput=(init?:RequestInit)=>{const command=JSON.parse(String(init?.body)).command;return JSON.parse(command.slice(command.indexOf(" '{")+2,-1));};
const completion=(payload:any)=>({completed:true,nonce:payload.nonce,action:payload.action,session:payload.session});
test('Maritime presentation uses an owner-pinned computer and verified image files, never a viewer link or private context',async()=>{
 const calls:any[]=[];let valid=true;
 const request:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname;calls.push({url:String(url),method:init?.method,body:init?.body});
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-key');
  if(path.endsWith('/computers'))return Response.json({id:'computer-a'});
  if(init?.method==='PUT')return new Response(null,{status:204});
  if(path.endsWith('/exec')) {
   const payload=commandInput(init);
   if(payload.action==='blank')return Response.json({exitCode:0,stdout:JSON.stringify({...completion(payload),blanked:true})});
   return Response.json({exitCode:0,stdout:JSON.stringify({...completion(payload),ready:true,publicSnapshot:true,snapshotSha256:snapshot.sha256,located:'r1',contextVerified:true,path:'/data/cleo-frame-session-a.jpg',mimeType:'image/jpeg'})});
  }
  if(path.endsWith('/sessions/close'))return Response.json({closed:true});
  return new Response(new Uint8Array([255,216,255,217]));
 };
 const presenter=new MaritimeMeetingPresenter('fixture-key',request);
 await presenter.prepare(binding,'verified-google-doc',location.queries,()=>valid,location,document);
 const frame=await presenter.frame(binding,()=>valid);assert.equal(frame?.mimeType,'image/jpeg');
 const create=JSON.parse(calls[0].body);assert.match(create.externalUserId,/^cleo-presenter-[a-f0-9]{32}$/);assert.equal(create.os,'linux');
 assert.doesNotMatch(JSON.stringify(calls),/PRIVATE_SENTINEL|oauth|refresh_token/);
 valid=false;assert.equal(await presenter.frame(binding,()=>valid),undefined);await presenter.close(binding);
 assert.ok(calls.some(c=>c.url.endsWith('/sessions/close')));
});
test('unexpected browser response or non-image bytes cannot be exposed as a saved snapshot',async()=>{
 for(const bad of ['response','image']) {
  const presenter=new MaritimeMeetingPresenter('key',async(url,init)=>{
   const path=new URL(String(url)).pathname;
   if(path.endsWith('/computers'))return Response.json({id:'computer'});
   if(init?.method==='PUT')return new Response(null,{status:204});
   if(path.endsWith('/exec'))return Response.json({exitCode:0,stdout:JSON.stringify({...completion(commandInput(init)),ready:bad!=='response',publicSnapshot:true,snapshotSha256:snapshot.sha256,path:'/data/cleo-frame-session-a.jpg',mimeType:'image/jpeg'})});
   return new Response('<html>login</html>');
  });
  await assert.rejects(presenter.prepare(binding,'verified-google-doc',[],()=>true,undefined,document));
  assert.equal(await presenter.frame(binding,()=>true),undefined);
 }
});

test('later private changes cannot enter frozen snapshot frames and legacy live-browser results are rejected',async()=>{
 const publicInput:any=structuredClone(document);publicInput.reason='PRIVATE_SENTINEL';
 let uploadedHtml='',snapshotHash='',liveResponse=false,frameCaptures=0;
 const presenter=new MaritimeMeetingPresenter('fixture',async(url,init)=>{
  const target=new URL(String(url));assert.equal(target.origin,'https://api.maritime.sh');
  if(target.pathname.endsWith('/computers'))return Response.json({id:'computer'});
  if(init?.method==='PUT'){
   if(target.searchParams.get('path')?.endsWith('.html'))uploadedHtml=String(init.body);
   return new Response(null,{status:204});
  }
  if(target.pathname.endsWith('/exec')){
   const command=JSON.parse(String(init?.body)).command,payload=JSON.parse(command.slice(command.indexOf(" '{")+2,-1));
   snapshotHash=payload.snapshotSha256;
   assert.doesNotMatch(uploadedHtml,/PRIVATE_SENTINEL|<script|<iframe/);
   if(payload.action==='frame')frameCaptures++;
   return Response.json({exitCode:0,stdout:JSON.stringify({...completion(payload),ready:true,...(!liveResponse?{publicSnapshot:true,snapshotSha256:snapshotHash}:{}),path:'/data/cleo-frame-session-a.jpg',mimeType:'image/jpeg',located:payload.location?.redlineId,contextVerified:true})});
  }
  return new Response(new Uint8Array([255,216,255,217]));
 });
 await presenter.prepare(binding,'verified-google-doc',location.queries,()=>true,location,publicInput);
 const originalHtml=uploadedHtml,originalHash=snapshotHash;
 // Mutable caller/Google material changes after preparation. It is never consulted by frame capture.
 publicInput.title='PRIVATE_SENTINEL title';publicInput.paragraphs[0].text='PRIVATE_SENTINEL newly added comment';
 (presenter as any).states.get(binding.sessionId).at=0;
 assert.ok(await presenter.frame(binding,()=>true));assert.equal(frameCaptures,1);
 assert.equal(uploadedHtml,originalHtml);assert.equal(snapshotHash,originalHash);
 // An older remote script that still returns arbitrary live-page pixels cannot satisfy the snapshot proof.
 liveResponse=true;(presenter as any).states.get(binding.sessionId).at=0;
 await assert.rejects(presenter.frame(binding,()=>true),/snapshot unavailable/i);
 assert.equal(await presenter.frame(binding,()=>true),undefined);
});

test('missing canonical saved document never falls back to opening a live Google page',async()=>{
 let requests=0;const presenter=new MaritimeMeetingPresenter('fixture',async()=>{requests++;throw new Error('unexpected request');});
 await assert.rejects(presenter.prepare(binding,'verified-google-doc',location.queries,()=>true,location),/sanitized saved document/);
 assert.equal(requests,0);
});

test('null provider exit code succeeds only with fresh per-command completion and verified snapshot receipts',async()=>{
 const commands:any[]=[];let closed=false;
 const presenter=new MaritimeMeetingPresenter('fixture',async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/computers'))return Response.json({id:'computer'});
  if(init?.method==='PUT')return new Response(null,{status:204});
  if(path.endsWith('/exec')){
   const payload=commandInput(init);commands.push(payload);
   const result=payload.action==='blank'?{blanked:true}:{ready:true,publicSnapshot:true,snapshotSha256:payload.snapshotSha256,path:'/data/cleo-frame-session-a.jpg',mimeType:'image/jpeg',located:payload.location?.redlineId,contextVerified:true};
   return Response.json({exitCode:null,stdout:JSON.stringify({...result,...completion(payload)}),stderr:''});
  }
  if(path.endsWith('/sessions/close')){closed=true;return Response.json({closed:true});}
  return new Response(new Uint8Array([255,216,255,217]));
 });
 await presenter.prepare(binding,'verified-google-doc',location.queries,()=>true,location,document);
 (presenter as any).states.get(binding.sessionId).at=0;
 assert.ok(await presenter.frame(binding,()=>true));await presenter.close(binding);
 assert.deepEqual(commands.map(c=>c.action),['open','locate','frame','blank']);
 assert.equal(new Set(commands.map(c=>c.nonce)).size,4);assert.equal(closed,true);
});

test('null exit is not success for missing, stale, truncated, mismatched or failed completion evidence',async()=>{
 for(const failure of ['missing_marker','wrong_nonce','wrong_session','wrong_action','incomplete','truncated','wrong_snapshot','explicit_exit_failure','missing_exit']){
  let imageFetches=0;
  const presenter=new MaritimeMeetingPresenter('fixture',async(url,init)=>{
   const path=new URL(String(url)).pathname;
   if(path.endsWith('/computers'))return Response.json({id:'computer'});
   if(init?.method==='PUT')return new Response(null,{status:204});
   if(path.endsWith('/exec')){
    const payload=commandInput(init),result:any={...completion(payload),ready:true,publicSnapshot:true,snapshotSha256:payload.snapshotSha256,path:'/data/cleo-frame-session-a.jpg',mimeType:'image/jpeg'};
    if(failure==='missing_marker')delete result.completed;
    if(failure==='wrong_nonce')result.nonce='00000000-0000-0000-0000-000000000000';
    if(failure==='wrong_session')result.session='other-session';
    if(failure==='wrong_action')result.action='frame';
    if(failure==='incomplete')result.completed=false;
    if(failure==='wrong_snapshot')result.snapshotSha256='0'.repeat(64);
    return Response.json({...(failure==='missing_exit'?{}:{exitCode:failure==='explicit_exit_failure'?7:null}),stdout:failure==='truncated'?'{"completed":true':JSON.stringify(result),stderr:''});
   }
   imageFetches++;return new Response(new Uint8Array([255,216,255,217]));
  });
  await assert.rejects(presenter.prepare(binding,'verified-google-doc',[],()=>true,undefined,document),{name:'PresentationUnavailable'},failure);
  assert.equal(await presenter.frame(binding,()=>true),undefined);assert.equal(imageFetches,0,failure);
 }
});

test('close requires positive blanking proof even when a null-exit operation has a valid completion nonce',async()=>{
 let closed=false;
 const presenter=new MaritimeMeetingPresenter('fixture',async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/computers'))return Response.json({id:'computer'});
  if(init?.method==='PUT')return new Response(null,{status:204});
  if(path.endsWith('/exec')){
   const payload=commandInput(init);
   return Response.json({exitCode:null,stdout:JSON.stringify({...completion(payload),...(payload.action==='blank'?{blanked:false}:{ready:true,publicSnapshot:true,snapshotSha256:payload.snapshotSha256,path:'/data/cleo-frame-session-a.jpg',mimeType:'image/jpeg'})})});
  }
  if(path.endsWith('/sessions/close')){closed=true;return Response.json({closed:true});}
  return new Response(new Uint8Array([255,216,255,217]));
 });
 await presenter.prepare(binding,'verified-google-doc',[],()=>true,undefined,document);
 await assert.rejects(presenter.close(binding),/clearing was not confirmed/);assert.equal(closed,true);
});
