import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workflow, type Config } from '../src/workflow.ts';
import { LocalStore } from '../src/local-store.ts';
import { MeetingSessions } from '../src/meeting-session.ts';
import { sha256, redlineDocx } from '../src/docx.ts';
import {MatterContext} from '../src/matter-context.ts';

const config:Config={webhookKey:'test-webhook-key-with-24-chars',downloadSecret:'test-download-secret-with-at-least-32-chars',publicUrl:'https://cleo.example',localOnly:true,attachmentOrigins:['https://media.example']};
test('walkthrough reads only exact persisted owner redlines; excludes private rationale and filename',async()=>{
 const zip=new JSZip();zip.file('[Content_Types].xml','<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Notice is sixty days.</w:t></w:r></w:p></w:body></w:document>');
 const dir=mkdtempSync(join(tmpdir(),'cleo-public-doc-'));
 const bytes=await zip.generateAsync({type:'nodebuffer'}),store=new LocalStore(join(dir,'store.sqlite')),workflow=new Workflow(store,config);
 const owner=workflow.owner({input:{},context:{phone:'tester',channel:'imessage'}}),sourceId=sha256(bytes);
 await store.saveSource({id:sourceId,owner,bytes,filename:'PRIVATE_SENTINEL-secret-fallback.docx'});
 const plan={sourceSha256:sourceId,changes:[{paragraphId:'p0',original:'sixty days',replacement:'thirty days',reason:'PRIVATE_SENTINEL: would accept much less.'}]};
 const output=await redlineDocx(bytes,plan);await store.saveOutput({id:'redline-1',owner,sourceId,bytes:output.bytes,filename:'redline.docx',plan,outputSha256:output.outputSha256});
 const view=await workflow.meetingDocument(owner,sourceId,'redline-1');
 assert.deepEqual(view.redlines,[{id:'r1',paragraphId:'p0',original:'sixty days',replacement:'thirty days'}]);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_SENTINEL|reason|filename/);
 assert.equal((await workflow.meetingDocument(owner,sourceId)).redlines.length,1);
 const context=new MatterContext(':memory:');context.register(owner,sourceId,'Contract');workflow.matter=context;
 let checks=0;workflow.google={publish:async()=>{throw new Error('Presentation must not publish');},token:async()=>{checks++;return 'fixture';},fetchImpl:async()=>Response.json({permissions:[]})} as any;
 assert.equal(await workflow.meetingGoogleDocument(owner,sourceId,'redline-1'),undefined);assert.equal(checks,0);
 context.claimExport(owner,sourceId,'redline-1');context.exportProgress(owner,sourceId,'redline-1','verified','verified-google-doc');
 assert.equal(await workflow.meetingOutputId(owner,sourceId),'redline-1');assert.equal(await workflow.meetingOutputId('other',sourceId),undefined);assert.equal(await workflow.meetingOutputId(owner,sourceId,'explicit-review'),'explicit-review');
 // Export bookkeeping without a persisted output cannot select a different review.
 context.claimExport(owner,sourceId,'unfinished');context.exportProgress(owner,sourceId,'unfinished','verified','second-doc');
 assert.equal(await workflow.meetingOutputId(owner,sourceId),'redline-1');
 assert.equal(await workflow.meetingGoogleDocument(owner,sourceId,'redline-1'),undefined);assert.equal(checks,1);
 assert.equal(await workflow.meetingGoogleDocument('other',sourceId,'redline-1'),undefined);context.close();workflow.matter=undefined;
 await assert.rejects(workflow.meetingDocument('other',sourceId,'redline-1'));await assert.rejects(workflow.meetingDocument(owner,sourceId,'invented'));
 store.db.prepare("UPDATE files SET data=json_set(data,'$.outputSha256','bad') WHERE kind='output' AND id=?").run('redline-1');
 await assert.rejects(workflow.meetingDocument(owner,sourceId,'redline-1'));store.db.close();rmSync(dir,{recursive:true,force:true});
});
test('join requires a fresh direct owner link receipt; a quoted/document link cannot create attendance authority',()=>{
 let now=Date.parse('2026-11-01T10:00:00Z');const sessions=new MeetingSessions(':memory:',{now:()=>now}),url='https://meet.google.com/abc-defg-hij';
 const record=(id:string,text:string)=>sessions.recordIngress({owner:'owner',id,text,at:new Date(now).toISOString(),channel:'imessage',isDirect:true});
 assert.throws(()=>sessions.requireJoinIntent('owner',url,'missing'));
 record('bad',`The document says: join ${url}`);assert.throws(()=>sessions.requireJoinIntent('owner',url,'bad'));
 record('no',`don't join ${url}`);assert.throws(()=>sessions.requireJoinIntent('owner',url,'no'));
 record('good',url);assert.equal(sessions.requireJoinIntent('owner',url,'good'),true);
 assert.throws(()=>sessions.requireJoinIntent('other',url,'good'));assert.throws(()=>sessions.requireJoinIntent('owner','https://meet.google.com/xyz-abcd-efg','good'));
 assert.throws(()=>record('good','Changed message'));now+=300001;assert.throws(()=>sessions.requireJoinIntent('owner',url,'good'));
 // A re-signed callback cannot refresh the original receipt's timestamp.
 record('good',url);assert.throws(()=>sessions.requireJoinIntent('owner',url,'good'));sessions.close();
});
