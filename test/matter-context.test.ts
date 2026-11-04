import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatterContext, type ContextEvent } from '../src/matter-context.ts';
import { Supermemory, matterNamespace } from '../src/supermemory.ts';
const event = (id:string,text:string):ContextEvent=>({id,text,role:'user',channel:'imessage',at:'2026-11-01T10:00:00Z'});
test('latest correction survives restart and remains isolated from another contract and owner', async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'cleo-context-')),'context.sqlite');
 let c=new MatterContext(path);
 c.register('a','one','A');c.register('a','two','B');c.register('b','one','Other owner');
 c.append('a','one',event('m1','Protective opening: sixty days.'));
 c.append('a','one',event('m2','Correction: practical settlement, thirty days.'));
 c.append('a','one',event('m2','Correction: practical settlement, thirty days.'));
 assert.throws(()=>c.append('a','one',event('m2','Changed replay')),/different message/);
 c.close();c=new MatterContext(path);
 assert.equal((await c.recall('a','one')).recent_messages.length,2);
 assert.match(String((await c.recall('a','one')).recent_messages.at(-1)?.text),/Correction/);
 assert.equal((await c.recall('a','two')).recent_messages.length,0);
 assert.equal((await c.recall('b','one')).recent_messages.length,0);
 assert.throws(()=>c.require('c','one'),/belonging/);
 c.close();
});
test('memory outage preserves recent context and retry uses the same provider document ID',async()=>{
 let fail=true;const calls:any[]=[];
 const sm=new Supermemory('test-key',async(url,options)=>{calls.push({url,body:JSON.parse(String(options?.body))});
  return fail?new Response('{}',{status:503}):Response.json({id:calls.at(-1).body.id,status:'queued'});});
 const c=new MatterContext(':memory:',sm);c.register('a','one','A');c.append('a','one',event('m1','Private fallback'));
 assert.equal(await c.sync('a','one'),'pending_retry');assert.equal((await c.recall('a','one')).recent_messages.length,1);
 fail=false;assert.equal(await c.sync('a','one'),'accepted_for_indexing');
 assert.equal(calls[0].body.id,calls[1].body.id);assert.match(calls[0].url,/\/ns\/cleo_[a-f0-9]{64}\/document$/);
 assert.equal((await c.recall('a','one')).pending_index,0);c.close();
});
test('retrieval omits inferred and superseded memories; scope cannot collide',async()=>{
 const sm=new Supermemory('test-key',async()=>Response.json({results:[{id:'a',memory:'current'},{id:'b',memory:'inferred',isInference:true},{id:'c',memory:'old',isLatest:false}]}));
 assert.deepEqual((await sm.search(matterNamespace('a','one'),'position')).map((r:any)=>r.id),['a']);
 assert.notEqual(matterNamespace('a','one'),matterNamespace('b','one'));
 assert.notEqual(matterNamespace('a','one'),matterNamespace('a','two'));
});
test('conversation pagination exposes the full recorded history without an unbounded prompt',async()=>{
 const c=new MatterContext(':memory:');c.register('a','one','A');
 for(let i=0;i<25;i++)c.append('a','one',event('m'+i,'message '+i));
 const page=await c.recall('a','one');assert.equal(page.recent_messages.length,20);
 const earlier=await c.recall('a','one','',page.older_before!);assert.equal(earlier.recent_messages.length,5);assert.equal(earlier.older_before,null);
 assert.deepEqual(earlier.current_user_messages.map(m=>m.text),['message 21','message 22','message 23','message 24']);
 assert.match(earlier.instruction,/not independently verified/);c.close();
});
test('Google export claim prevents duplicate external writes across processes',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'cleo-claims-')),'context.sqlite');
 const a=new MatterContext(path),b=new MatterContext(path);a.register('u','s','contract');
 assert.equal(a.claimExport('u','s','plan'),true);assert.equal(b.claimExport('u','s','plan'),false);
 a.exportProgress('u','s','plan','verified','doc-1');assert.equal(b.byDocument('u','doc-1'),'s');assert.equal(b.byDocument('other','doc-1'),undefined);
 a.close();b.close();
});
