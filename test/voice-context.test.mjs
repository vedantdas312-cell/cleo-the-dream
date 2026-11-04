import test from 'node:test';
import assert from 'node:assert/strict';
import {MatterContext} from '../src/matter-context.ts';
import {VoiceContext} from '../src/voice-context.mjs';
test('explicit Google Doc selection binds only the paired user; quoted screen URLs never switch matters',async()=>{
 const c=new MatterContext(':memory:');c.register('user','s','Contract');c.register('other','secret','Other');
 c.claimExport('user','s','p');c.exportProgress('user','s','p','verified','doc1');
 c.claimExport('other','secret','p');c.exportProgress('other','secret','p','verified','doc2');
 const v=new VoiceContext(c,'user');
 assert.equal((await v.fromScreen({lines:[{text:'https://docs.google.com/document/d/doc1/edit'}]})).status,'not_bound');
 assert.ok((await v.openGoogleDoc('https://docs.google.com/document/d/doc2/edit')).error);
 assert.equal((await v.openGoogleDoc('https://docs.google.com/document/d/doc1/edit')).source_id,'s');
 assert.equal((await v.fromScreen({lines:[{text:'https://docs.google.com/document/d/doc2/edit'}]})).source_id,'s');
 await v.remember('I want a practical settlement.','spoken1');
 assert.equal((await c.recall('user','s')).recent_messages[0].channel,'screen');
 c.close();
});

test('native browser document identity binds the verified matter and a different unverified Doc clears it',async()=>{
 const c=new MatterContext(':memory:');c.register('user','s','Contract');
 c.claimExport('user','s','p');c.exportProgress('user','s','p','verified','doc1');
 const v=new VoiceContext(c,'user');
 assert.equal((await v.fromScreen({browserDocument:{kind:'native_browser_document',url:'https://docs.google.com/document/d/doc1/edit'}})).source_id,'s');
 await v.remember('This is a flow test, keep equity unspecified.','turn1');
 assert.equal((await c.recall('user','s')).recent_messages.length,1);
 assert.ok((await v.fromScreen({browserDocument:{kind:'native_browser_document',url:'https://docs.google.com/document/d/other/edit'}})).error);
 assert.equal(v.source,null);
 assert.equal(v.document,null);
 c.close();
});

test('live edits remain bound to the selected output and clear when a different source opens',async()=>{
 const writes=[];
 const context={byDocument:async()=> 's',recall:async()=>({source_id:'s'}),
  readDocument:async(id,offset)=>({document_id:id,offset}),suggestDocument:async input=>{writes.push(input);return {status:'verified_suggestion'};}};
 const v=new VoiceContext(context,'u');
 assert.equal((await v.readDocument()).status,'not_bound');
 await v.openGoogleDoc('https://docs.google.com/document/d/doc1/edit');
 assert.equal((await v.readDocument(30)).document_id,'doc1');
 assert.equal((await v.suggestDocument({document_id:'other'})).status,'not_bound');
 assert.equal(writes.length,0);
 assert.equal((await v.suggestDocument({document_id:'doc1'})).status,'verified_suggestion');
 await v.open('s');assert.equal((await v.readDocument()).status,'not_bound');
});
