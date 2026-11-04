import test from 'node:test';
import assert from 'node:assert/strict';
import { KeikiPrivateMessenger, Keiki } from '../src/keiki.mjs';
const phone='+15555550123';
const setup=(fetchImpl,resolveRecipient=owner=>owner==='owner-a'?phone:undefined)=>new KeikiPrivateMessenger({apiKey:'synthetic-key',agentId:'agent-a',resolveRecipient,fetchImpl});
test('private notices use official owner-specific API and never claim delivery',async()=>{
 let calls=0;
 const messenger=setup(async(url,options)=>{calls++;assert.equal(url,'https://onkeiki.com/api/v1/developer/agents/agent-a/notice');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{phone,text:'Private suggestion'});return Response.json({ok:true,conversations:1,results:[{phone,outcome:'ran'}]});});
 assert.equal((await messenger.send({owner:'owner-a',text:'Private suggestion'})).status,'accepted_for_agent');
 assert.equal((await messenger.send({owner:'other',text:'Private suggestion'})).status,'not_configured');assert.equal(calls,1);
});
test('provider denial, malformed receipt and ambiguous network failure never report a successful fake send',async()=>{
 for(const [fetchImpl,status] of [
  [async()=>new Response('{}',{status:403}),'not_configured'],
  [async()=>new Response('{}',{status:502}),'unknown'],
  [async()=>Response.json({ok:true,conversations:200,results:[]}),'unknown'],
  [async()=>Response.json({ok:true,conversations:1,results:[{phone:'+15555550124',outcome:'ran'}]}),'unknown'],
  [async()=>Response.json({ok:true,conversations:1,results:[{phone,outcome:'queued'}]}),'queued'],
  [async()=>{throw new Error('SECRET_PROVIDER_BODY');},'unknown'],
 ])assert.deepEqual(await setup(fetchImpl).send({owner:'owner-a',text:'Advice'}),{status});
});
test('public audience never enters private Keiki automatic memory and cancelled notices never dispatch',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw new Error('should not dispatch');};
 await assert.rejects(new Keiki({apiKey:'test',agentId:'test',fetchImpl}).ask({text:'Meeting transcript',scope:{userId:'a',matterId:'b',sessionId:'c',audience:'meeting'}}),/isolation/);
 const controller=new AbortController();controller.abort();assert.equal((await setup(fetchImpl).send({owner:'owner-a',text:'advice',signal:controller.signal})).status,'cancelled');assert.equal(calls,0);
});
