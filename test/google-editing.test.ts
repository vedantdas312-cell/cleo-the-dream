import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleEditing,editingSnapshot,editRequests} from '../src/google-editing.ts';
import {MatterContext} from '../src/matter-context.ts';

const doc=(runs:any[],revision='r1')=>{let index=1;return {documentId:'doc1',revisionId:revision,title:'Review',tabs:[{tabProperties:{tabId:'t1'},documentTab:{body:{content:[{startIndex:1,paragraph:{elements:runs.map(textRun=>{const startIndex=index;index+=textRun.content.length;return {startIndex,endIndex:index,textRun};})}}]}}}]};};
const before=()=>doc([{content:'Notice: sixty days.\n'}]);
const after=()=>doc([{content:'Notice: '},{content:'sixty',suggestedDeletionIds:['d']},{content:'thirty',suggestedInsertionIds:['i']},{content:' days.\n'}],'r2');
const edit={document_id:'doc1',revision_id:'r1',paragraph_id:'t1:1',original:'sixty days',replacement:'thirty days',request_id:'change1'};
function setup(){const c=new MatterContext(':memory:');c.register('u','s','Contract');c.claimExport('u','s','p');c.exportProgress('u','s','p','verified','doc1');return c;}

test('exact indexes preserve pending deletions and use UTF-16 across emoji',()=>{
 const snapshot=editingSnapshot(doc([{content:'😀 '},{content:'obsolete ',suggestedDeletionIds:['old']},{content:'sixty',suggestedInsertionIds:['prior']},{content:' days.\n'}]));
 assert.equal(snapshot.accepted,'😀 sixty days.\n');
 assert.equal(snapshot.rejected,'😀 obsolete  days.\n');
 assert.deepEqual(editRequests(snapshot.paragraphs[0],'sixty days','thirty days'),[
  {insertText:{location:{index:18,tabId:'t1'},text:'thirty'}},
  {deleteContentRange:{range:{startIndex:13,endIndex:18,tabId:'t1'}}}
 ]);
 assert.throws(()=>editRequests(snapshot.paragraphs[0],'missing','new'),/exactly once/);
 const repeated=editingSnapshot(doc([{content:'days days\n'}]));
 assert.throws(()=>editRequests(repeated.paragraphs[0],'days','weeks'),/exactly once/);
 assert.deepEqual(editRequests(snapshot.paragraphs[0],'sixty days.','sixty days.\nPayment survives.'),[
  {insertText:{location:{index:24,tabId:'t1'},text:'\nPayment survives.'}}
 ]);
});

test('only the mapped owner can read or write; a stale revision sends no write',async()=>{
 const c=setup();let writes=0;
 const g=new GoogleEditing(async(_path,body)=>{if(body)writes++;return before();},c);
 await assert.rejects(()=>g.read('other','doc1'),/belonging/);
 await assert.rejects(()=>g.suggest('other',edit),/belonging/);
 const read=await g.read('u','doc1');assert.equal(read.paragraphs[0].text,'Notice: sixty days.');
 assert.equal((await g.suggest('u',{...edit,revision_id:'old'})).status,'stale_revision');
 assert.equal(writes,0);c.close();
});

test('tracked write verifies accepted and rejected views; replay never duplicates it',async()=>{
 const c=setup();let current=before(),writes=0;
 const g=new GoogleEditing(async(_path,body:any)=>{if(body){writes++;assert.deepEqual(body.writeControl,{writeMode:'SUGGEST',requiredRevisionId:'r1'});current=after();return {};}return current;},c);
 assert.equal((await g.suggest('u',edit)).status,'verified_suggestion');
 assert.equal((await g.suggest('u',edit)).replayed,true);assert.equal(writes,1);
 await assert.rejects(()=>g.suggest('u',{...edit,replacement:'five days'}),/different proposed edit/);
 current=doc([{content:'Someone changed this.\n'}],'r3');
 assert.equal((await g.suggest('u',edit)).status,'previously_verified_document_changed');
 assert.equal(writes,1);c.close();
});

test('lost receipt reconciles without a duplicate; an incorrect readback blocks further edits',async()=>{
 for(const corrupted of [false,true]){
  const c=setup();let current=before(),writes=0;
  const g=new GoogleEditing(async(_path,body)=>{if(body){writes++;current=corrupted?doc([{content:'wrong\n'}],'r2'):after();throw Error('connection lost');}return current;},c);
  assert.equal((await g.suggest('u',edit)).status,'needs_inspection');
  assert.equal((await g.suggest('u',{...edit,request_id:'different'})).status,'needs_inspection');
  assert.equal((await g.suggest('u',edit)).status,corrupted?'needs_inspection':'verified_suggestion');
  assert.equal(writes,1);c.close();
 }
});

test('direct untracked replacement fails verification even when proposed wording is correct',async()=>{
 const c=setup();let current=before();
 const g=new GoogleEditing(async(_path,body)=>{if(body){current=doc([{content:'Notice: thirty days.\n'}],'r2');return {};}return current;},c);
 assert.equal((await g.suggest('u',edit)).status,'needs_inspection');c.close();
});
