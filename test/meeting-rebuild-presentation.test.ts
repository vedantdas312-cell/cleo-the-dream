import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Workflow,type Config} from '../src/workflow.ts';
import {LocalStore} from '../src/local-store.ts';
import {MatterContext} from '../src/matter-context.ts';
import {sha256,redlineDocx} from '../src/docx.ts';
import {presentationLocation,verifiedGooglePresentation} from '../src/meeting-presentation-model.ts';
import {MaritimeMeetingPresenter} from '../src/meeting-computer.ts';
import {presentationCsp,presentationScript} from '../src/meeting-presentation.ts';
import {createPresentationSnapshot} from '../src/meeting-presentation-snapshot.ts';
const config:Config={webhookKey:'test-webhook-key-123456789',downloadSecret:'test-download-secret-123456789123456789',publicUrl:'https://cleo.example',localOnly:true,attachmentOrigins:['https://media.example']};
const context={phone:'tester',channel:'imessage'};
async function contract(paragraphs:string[]) {
 const zip=new JSZip();zip.file('[Content_Types].xml','<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+paragraphs.map(p=>'<w:p><w:r><w:t>'+p+'</w:t></w:r></w:p>').join('')+'</w:body></w:document>');
 zip.file('word/comments.xml','<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="2"><w:p><w:r><w:t>PRIVATE_SENTINEL existing comment</w:t></w:r></w:p></w:comment></w:comments>');
 return zip.generateAsync({type:'nodebuffer'});
}
const changes=[{paragraphId:'p0',original:'sixty days',replacement:'thirty days',reason:'PRIVATE_SENTINEL strategy'},
 {paragraphId:'p1',original:'sixty days',replacement:'forty days',reason:'PRIVATE_SENTINEL minimum'},
 {paragraphId:'p2',original:'sixty days',replacement:'ninety days',reason:'PRIVATE_SENTINEL internal'}];

test('two contracts prepare automatically without Google, reuse exact versions across restart, and navigate 1→2→3→2',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cleo-presentation-'));
 const store=new LocalStore(join(dir,'store.sqlite'));let matter=new MatterContext(join(dir,'context.sqlite'));
 let workflow=new Workflow(store,config,fetch,matter);const owner=workflow.owner({input:{},context});
 try{
  const presentations=[];
  for(const title of ['Services','License']){
   const bytes=await contract([title+' notice is sixty days.','Payment is due in sixty days.','Renewal requires sixty days.']);const sourceId=sha256(bytes);
   await store.saveSource({id:sourceId,owner,bytes,filename:'PRIVATE_SENTINEL-file.docx'});
   const req={input:{source_id:sourceId,source_sha256:sourceId,changes},context};
   const result=await workflow.revise(req);
   assert.equal(result.meeting_presentation.status,'ready');assert.equal(result.meeting_presentation.change_count,3);
   const p=await workflow.meetingPresentation(owner,sourceId);
   assert.equal(p.id,result.meeting_presentation.id);assert.equal(p.sourceSha256,sourceId);assert.equal(p.outputSha256,result.output_sha256);
   assert.deepEqual(p.document.redlines.map(r=>r.id),['r1','r2','r3']);
   assert.doesNotMatch(JSON.stringify(p.document)+JSON.stringify(p.anchors),/PRIVATE_SENTINEL|filename|reason/);
   const repeated=await workflow.revise(req);assert.equal(repeated.meeting_presentation.status,'ready');
   assert.equal(repeated.meeting_presentation.id,p.id);
   const navigation=['r1','r2','r3','r2'].map(id=>presentationLocation(p.document,id)!);
   assert.deepEqual(navigation.map(n=>n.paragraphId),['p0','p1','p2','p1']);
   assert.equal(navigation[1].paragraphSha256,navigation[3].paragraphSha256);
   assert.notEqual(navigation[0].queries[0],navigation[1].queries[0]);
   presentations.push(p);
  }
  assert.notEqual(presentations[0].id,presentations[1].id);
  matter.close();matter=new MatterContext(join(dir,'context.sqlite'));workflow=new Workflow(store,config,fetch,matter);
  for(const p of presentations)assert.deepEqual(await workflow.meetingPresentation(owner,p.sourceId),p);
  await assert.rejects(workflow.meetingPresentation('other',presentations[0].sourceId));
 }finally{matter.close();store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('public-view size limits do not prevent valid Word/PDF downloads or the existing Google review export',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cleo-presentation-limits-')),store=new LocalStore(join(dir,'store.sqlite'));
 const workflow=new Workflow(store,config),owner=workflow.owner({input:{},context});let exports=0;
 workflow.google={publish:async()=>{exports++;return {status:'verified_suggestions',document_id:'fixture-review-document'};}} as any;
 const longOriginal='Term '+'word '.repeat(3100)+'end.';
 try{
  for(const fixture of [
   {paragraphs:[longOriginal],original:longOriginal,replacement:longOriginal+' additional'.repeat(60)},
   {paragraphs:['Notice is sixty days.',...Array(3000).fill('')],original:'sixty days',replacement:'thirty days'},
  ]){
   const bytes=await contract(fixture.paragraphs),sourceId=sha256(bytes);
   await store.saveSource({id:sourceId,owner,bytes,filename:'PRIVATE_SENTINEL.docx'});
   const request={input:{source_id:sourceId,source_sha256:sourceId,changes:[{paragraphId:'p0',original:fixture.original,replacement:fixture.replacement,reason:'PRIVATE_SENTINEL'}]},context};
   const result=await workflow.revise(request);
   assert.equal(result.status,'verified_tracked_changes');assert.equal(result.delivery_status,'not_sent');
   assert.deepEqual(result.meeting_presentation,{status:'unavailable',reason:'preparation_unavailable'});
   assert.equal(result.google_doc.status,'verified_suggestions');
   const word=await workflow.download(new URL(result.download_url)),pdf=await workflow.download(new URL(result.preview_download_url));
   assert.equal(sha256(word.bytes),result.output_sha256);assert.equal(sha256(pdf.bytes),result.preview_sha256);assert.equal(pdf.bytes.subarray(0,5).toString(),'%PDF-');
   const replay=await workflow.revise(request);assert.equal(replay.output_sha256,result.output_sha256);assert.equal(replay.meeting_presentation.status,'unavailable');
  }
  assert.equal(exports,4);assert.equal(store.db.prepare("SELECT count(*) AS n FROM files WHERE kind='output'").get()?.n,2);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('presentation storage outage reports unavailable without exposing its error, while review checksum failures still reject',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cleo-presentation-outage-')),store=new LocalStore(join(dir,'store.sqlite')),matter=new MatterContext(':memory:');
 const workflow=new Workflow(store,config,fetch,matter),owner=workflow.owner({input:{},context});
 try{
  const bytes=await contract(['Notice is sixty days.']),sourceId=sha256(bytes);
  await store.saveSource({id:sourceId,owner,bytes,filename:'PRIVATE_SENTINEL.docx'});
  matter.savePresentation=()=>{throw new Error('PRIVATE_SENTINEL storage details');};
  const request={input:{source_id:sourceId,source_sha256:sourceId,changes:[changes[0]]},context};
  const result=await workflow.revise(request);
  assert.deepEqual(result.meeting_presentation,{status:'unavailable',reason:'preparation_unavailable'});
  assert.doesNotMatch(JSON.stringify(result.meeting_presentation),/PRIVATE_SENTINEL/);
  assert.equal((await workflow.download(new URL(result.download_url))).outputSha256,result.output_sha256);
  store.db.prepare("UPDATE files SET data=json_set(data,'$.outputSha256','bad') WHERE kind='output' AND id=?").run(result.output_id);
  await assert.rejects(workflow.revise(request),/Output persistence verification failed/);
 }finally{matter.close();store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('lazy existing review migration strips private fields, rejects hash/wording mismatch, asks on multiple reviews, and preserves source-only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cleo-migrate-')),store=new LocalStore(join(dir,'store.sqlite')),matter=new MatterContext(':memory:');
 const workflow=new Workflow(store,config,fetch,matter),owner=workflow.owner({input:{},context});
 try{
  const bytes=await contract(['Notice is sixty days.']),sourceId=sha256(bytes);
  await store.saveSource({id:sourceId,owner,bytes,filename:'PRIVATE_SENTINEL.docx'});
  const source=await workflow.meetingPresentation(owner,sourceId);assert.equal(source.outputId,null);assert.equal(source.document.redlines.length,0);
  const plan={sourceSha256:sourceId,changes:[changes[0]]},result=await redlineDocx(bytes,plan);
  await store.saveOutput({id:'legacy-review',sourceId,owner,bytes:result.bytes,filename:'PRIVATE_SENTINEL.docx',plan,outputSha256:result.outputSha256});
  const migrated=await workflow.meetingPresentation(owner,sourceId);assert.equal(migrated.outputId,'legacy-review');
  const old:any=structuredClone(migrated);old.document.reason='PRIVATE_SENTINEL';old.document.redlines[0].reason='PRIVATE_SENTINEL';old.privacyReview='old';matter.savePresentation(old);
  assert.deepEqual(await workflow.meetingPresentation(owner,sourceId),migrated);
  const secondPlan={...plan,changes:[{...changes[0],replacement:'ten days'}]},second=await redlineDocx(bytes,secondPlan);
  await store.saveOutput({id:'second-review',sourceId,owner,bytes:second.bytes,filename:'review.docx',plan:secondPlan,outputSha256:second.outputSha256});
  await assert.rejects(workflow.meetingOutputId(owner,sourceId),/multiple saved reviews/);
  assert.equal((await workflow.meetingPresentation(owner,sourceId,'legacy-review')).id,migrated.id);
  store.db.prepare("UPDATE files SET data=json_set(data,'$.plan.changes[0].replacement','fabricated words') WHERE kind='output' AND id='legacy-review'").run();
  await assert.rejects(workflow.meetingPresentation(owner,sourceId,'legacy-review'),/wording does not match/);
  store.db.prepare("UPDATE files SET data=json_set(data,'$.outputSha256','bad') WHERE kind='output' AND id='second-review'").run();
  await assert.rejects(workflow.meetingPresentation(owner,sourceId,'second-review'),/does not match/);
 }finally{matter.close();store.db.close();rmSync(dir,{recursive:true,force:true});}
});

const publicDoc={title:'Contract review',paragraphs:[{id:'p0',text:'Notice requires sixty days.'},{id:'p1',text:'Payment requires sixty days.'},{id:'p2',text:'Renewal requires sixty days.'}],redlines:changes.map((r,i)=>({id:`r${i+1}`,paragraphId:r.paragraphId,original:r.original,replacement:r.replacement}))};
test('snapshot preserves repeated wording under distinct saved IDs and excludes private fields and executable markup',()=>{
 const dirty:any=structuredClone(publicDoc);dirty.reason='PRIVATE_SENTINEL';dirty.filename='PRIVATE_SENTINEL';dirty.redlines[0].reason='PRIVATE_SENTINEL';
 const snapshot=createPresentationSnapshot(dirty);
 assert.doesNotMatch(snapshot.html,/PRIVATE_SENTINEL|<script|<iframe|docs.google.com/);
 assert.equal(snapshot.sha256,sha256(snapshot.html));
 for(const id of ['r1','r2','r3'])assert.equal(snapshot.html.split('data-redline-id="'+id+'"').length-1,1);
 assert.deepEqual(['r1','r2','r3','r2'].map(id=>presentationLocation(snapshot.document,id)!.paragraphId),['p0','p1','p2','p1']);
 const hostile=createPresentationSnapshot({title:'<script>bad()</script>',paragraphs:[{id:'p0',text:'<img src="https://untrusted.example">'}],redlines:[]});
 assert.doesNotMatch(hostile.html,/<script|<img/);assert.match(hostile.html,/&lt;img/);
 assert.equal(presentationLocation(snapshot.document,'invented'),undefined);
});

test('Google eligibility reads exact known text and existing ACL only; comments, stale wording, public title changes and unsafe ACL cause fallback',async()=>{
 const disclosure='Cleo review copy — extracted main-body text. Original layout, tables, images, headers and signatures are not reproduced. Proposed changes require review.\n\n';
 const runs=[{textRun:{content:disclosure}}];
 for(const p of publicDoc.paragraphs){const r=publicDoc.redlines.find(r=>r.paragraphId===p.id)!;const at=p.text.indexOf(r.original);
  runs.push({textRun:{content:p.text.slice(0,at)}},{textRun:{content:r.original,suggestedDeletionIds:['s']} } as any,{textRun:{content:r.replacement,suggestedInsertionIds:['s']}} as any,{textRun:{content:p.text.slice(at+r.original.length)+'\n'}});}
 let safe=true,permissions=[{type:'anyone',role:'reader',allowFileDiscovery:false}],requests=0;
 const doc:any={documentId:'verified-google-doc',title:'Cleo — proposed contract redline',tabs:[{tabProperties:{tabId:'t'},documentTab:{body:{content:[{startIndex:1,paragraph:{elements:runs}}]}}}]};
 const google:any={token:async()=>'fixture',fetchImpl:async(_url:string,init:RequestInit)=>{requests++;assert.equal(init.method,'GET');return Response.json({permissions});},presentationAllowed:async()=>safe,request:async(_path:string,body?:unknown)=>{assert.equal(body,undefined);return doc;},publish:()=>assert.fail('must not publish')};
 assert.equal(await verifiedGooglePresentation(google,'verified-google-doc',publicDoc),true);
 safe=false;assert.equal(await verifiedGooglePresentation(google,'verified-google-doc',publicDoc),false);safe=true;
 doc.title='PRIVATE_SENTINEL filename';assert.equal(await verifiedGooglePresentation(google,'verified-google-doc',publicDoc),false);doc.title='Cleo — proposed contract redline';
 runs[0].textRun.content='changed';assert.equal(await verifiedGooglePresentation(google,'verified-google-doc',publicDoc),false);runs[0].textRun.content=disclosure;
 permissions=[];assert.equal(await verifiedGooglePresentation(google,'verified-google-doc',publicDoc),false);assert.equal(requests,5);
});

test('CSP grants only the provider local virtual-audio signaling endpoint beyond self, with hashed inline script',()=>{
 const connect=presentationCsp.split(';').find(p=>p.trim().startsWith('connect-src'))!.trim();
 assert.equal(connect,"connect-src 'self' http://localhost:8000/offer_meeting_audio");
 assert.ok(presentationCsp.includes("script-src 'sha256-"+Buffer.from(sha256(presentationScript),'hex').toString('base64')+"'"));
 assert.doesNotMatch(presentationScript,/attendee-audio-error|innerHTML|outerHTML|document\.write|eval\(/);
});

test('rapid queued snapshot navigation supersedes stale results; unavailable navigation never exposes the previous clause',async()=>{
 const binding={owner:'owner',sourceId:'source',sessionId:'session-a'};
 let release!:()=>void,started!:()=>void;const locating=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);let hold=false;
 const calls:string[]=[];
 const request:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/computers'))return Response.json({id:'computer'});
  if(init?.method==='PUT')return new Response(null,{status:204});
  if(path.endsWith('/exec')){
   const command=JSON.parse(String(init?.body)).command;const payload=JSON.parse(command.slice(command.indexOf(" '{")+2,-1));calls.push(payload.action+':'+(payload.location?.redlineId??''));
   if(hold&&payload.action==='locate'&&payload.location.redlineId==='r2'){started();await gate;}
   if(payload.location?.redlineId==='r3')return Response.json({exitCode:0,stdout:JSON.stringify({completed:true,nonce:payload.nonce,action:payload.action,session:payload.session,ready:false,unavailable:'passage_not_uniquely_verified'})});
   return Response.json({exitCode:0,stdout:JSON.stringify({completed:true,nonce:payload.nonce,action:payload.action,session:payload.session,ready:true,publicSnapshot:true,snapshotSha256:payload.snapshotSha256,path:'/data/cleo-frame-session-a.jpg',mimeType:'image/jpeg',located:payload.location?.redlineId,contextVerified:true})});
  }
  return new Response(new Uint8Array([255,216,255,217]));
 };
 const presenter=new MaritimeMeetingPresenter('fixture',request),loc=(id:string)=>presentationLocation(publicDoc,id)!;
 await presenter.prepare(binding,'verified-google-doc',loc('r1').queries,()=>true,loc('r1'),publicDoc);assert.ok(await presenter.frame(binding,()=>true));
 hold=true;const old=presenter.prepare(binding,'verified-google-doc',loc('r2').queries,()=>true,loc('r2'),publicDoc);
 const oldRejected=assert.rejects(old,/superseded/);await locating;
 const newer=presenter.prepare(binding,'verified-google-doc',loc('r3').queries,()=>true,loc('r3'),publicDoc);
 const newerRejected=assert.rejects(newer,/unavailable/);release();await Promise.all([oldRejected,newerRejected]);
 assert.equal(await presenter.frame(binding,()=>true),undefined);
 hold=false;await presenter.prepare(binding,'verified-google-doc',loc('r2').queries,()=>true,loc('r2'),publicDoc);assert.ok(await presenter.frame(binding,()=>true));
 assert.deepEqual(calls.filter(c=>c.startsWith('locate')),['locate:r1','locate:r2','locate:r3','locate:r2']);
});

test('superseded navigation cannot leave the browser on another clause when the latest request returns to the prior ID',async()=>{
 const binding={owner:'owner',sourceId:'source',sessionId:'session-a'};
 let release!:()=>void,started!:()=>void;const locating=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 const selected:string[]=[];
 const presenter=new MaritimeMeetingPresenter('fixture',async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/computers'))return Response.json({id:'computer'});
  if(init?.method==='PUT')return new Response(null,{status:204});
  if(path.endsWith('/exec')){
   const command=JSON.parse(String(init?.body)).command,payload=JSON.parse(command.slice(command.indexOf(" '{")+2,-1));
   if(payload.action==='locate'){selected.push(payload.location.redlineId);if(payload.location.redlineId==='r2'){started();await gate;}}
   return Response.json({exitCode:0,stdout:JSON.stringify({completed:true,nonce:payload.nonce,action:payload.action,session:payload.session,ready:true,publicSnapshot:true,snapshotSha256:payload.snapshotSha256,path:'/data/cleo-frame-session-a.jpg',mimeType:'image/jpeg',located:payload.location?.redlineId,contextVerified:true})});
  }
  return new Response(new Uint8Array([255,216,255,217]));
 });
 const locate=(id:string)=>{const location=presentationLocation(publicDoc,id)!;return presenter.prepare(binding,'verified-google-doc',location.queries,()=>true,location,publicDoc);};
 await locate('r1');const old=locate('r2'),rejected=assert.rejects(old,/superseded/);await locating;
 const latest=locate('r1');release();await rejected;await latest;
 assert.deepEqual(selected,['r1','r2','r1']);assert.ok(await presenter.frame(binding,()=>true));
});
