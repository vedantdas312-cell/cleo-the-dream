import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import JSZip from 'jszip';
import {LocalStore} from '../src/local-store.ts';
import {Workflow,type Config,type ToolRequest} from '../src/workflow.ts';
import {createApp} from '../src/server.ts';
import {MatterContext} from '../src/matter-context.ts';
import {MeetingSessions} from '../src/meeting-session.ts';
import {MeetingTransport} from '../src/meeting-transport.ts';
import {MeetingRoutes} from '../src/meeting-routes.ts';
import {MeetingIntelligence} from '../src/meeting-intelligence.ts';
import {KeikiPrivateMessenger} from '../src/keiki.mjs';
import {Attendee} from '../src/attendee.ts';
import {matterNamespace} from '../src/supermemory.ts';

const identity={agentId:'test-agent',line:'test-line',secret:'synthetic-identity-secret-long-enough-for-tests'};
const config:Config={webhookKey:'synthetic-webhook-key-long-enough',downloadSecret:'synthetic-download-secret-long-enough',
  publicUrl:'https://cleo.example',attachmentOrigins:['https://media.example'],keikiIdentity:identity};
const phones=['+15555550100','+15555550101'];
const context=(i:number):ToolRequest['context']=>({phone:phones[i],agentId:identity.agentId,
  channel:{provider:'blooio',gateway:identity.line,channel:'imessage',isDirect:true,userId:phones[i],messageId:'inbound',inboundText:''},
  attachments:{file:{filename:'Contract.docx',url:'https://media.example/contract'}}});

test('first-contact users get isolated contracts, memory, meetings and private replies across restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cleo-users-')),path=join(dir,'store.sqlite');
  let store=new LocalStore(path);
  const matter=new MatterContext(join(dir,'context.sqlite')),sessions=new MeetingSessions(':memory:');
  const zip=new JSZip();zip.file('[Content_Types].xml','<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Notice is sixty days.</w:t></w:r></w:p></w:body></w:document>');
  const bytes=await zip.generateAsync({type:'nodebuffer'});
  const workflow=new Workflow(store,config,async()=>new Response(new Uint8Array(bytes)),matter);workflow.meetings=sessions;
  let bots=0;const shares:any[]=[];
  const attendee=new Attendee('synthetic',async(url,init)=>{
    const body=init?.body?JSON.parse(String(init.body)):undefined;
    if(String(url).endsWith('/bots'))return Response.json({id:'bot_'+(++bots),state:'joining'});
    if(body?.screenshare_url)shares.push(body.screenshare_url);
    return new Response(null);
  });
  const transport=new MeetingTransport(sessions,{path:':memory:',publicUrl:config.publicUrl,attendee,openaiKey:'synthetic',
    intent:{authorizeInvitation:async()=>true,resolve:async input=>({addressed:true,command:{action:input.text==='share'?'share':input.text==='quiet'?'quiet':'note'}})}});
  const routes=new MeetingRoutes(transport,workflow,identity),server=createApp(workflow,undefined,routes);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const post=async(path:string,i:number,input:any={},patch:any={},signed=false)=>{
    const body=JSON.stringify({input,context:{...context(i),...patch}}),timestamp=String(Date.now());
    return fetch(base+'/tools/'+path,{method:'POST',body,headers:{'content-type':'application/json',...(signed?{
      'x-keiki-timestamp':timestamp,'x-keiki-signature':'sha256='+createHmac('sha256',identity.secret).update(timestamp+'.'+body).digest('hex')
    }:{'x-orchid-api-key':config.webhookKey})}});
  };
  const ok=async(response:Response)=>{const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  let intelligence:MeetingIntelligence|undefined;
  try {
    const owners=phones.map(phone=>workflow.ownerForSender(phone));
    const raw=JSON.stringify({agent:{id:identity.agentId},sender:{channel:'photon',teamId:identity.line,
      userId:'+15555550102',addressing:{isDm:true}},conversation:{id:'new-conversation'}});
    const timestamp=String(Date.now());
    const signedHeaders={'content-type':'application/json','x-keiki-timestamp':timestamp,
      'x-keiki-signature':'sha256='+createHmac('sha256',identity.secret).update(timestamp+'.'+raw).digest('hex')};
    const principal=await ok(await fetch(base+'/meeting/identity',{method:'POST',headers:signedHeaders,body:raw}));
    assert.equal(principal.userId,workflow.ownerForSender('+15555550102'));
    assert.deepEqual(principal.scopes,['cleo:contracts']);
    assert.equal(await store.getSender(principal.userId,identity.agentId,identity.line),'+15555550102');
    const forged=raw.replace('+15555550102','+15555550103');
    assert.equal((await fetch(base+'/meeting/identity',{method:'POST',headers:signedHeaders,body:forged})).status,401);
    assert.equal(await store.getSender(workflow.ownerForSender('+15555550103'),identity.agentId,identity.line),undefined);
    assert.equal((await fetch(base+'/tools/read_contract',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({input:{attachment_id:'file'},context:context(0)})})).status,401);
    assert.equal(owners[0],createHmac('sha256',config.downloadSecret).update(phones[0]).digest('hex'),'existing ownership remains stable');
    assert.notEqual(owners[0],owners[1]);
    // No sender has ever been pre-registered or approved. Attachment-only inbound text is valid.
    const a=await ok(await post('read_contract',0,{attachment_id:'file'}));
    assert.equal((await post('read_contract_page',1,{source_id:a.source_id})).status,422);
    const b=await ok(await post('read_contract',1,{attachment_id:'file'}, {},true));
    assert.equal(a.source_id,b.source_id,'identical bytes may have the same hash but different owners');
    const outputs=[];
    for(let i=0;i<2;i++){
      const note={id:'same-message-id',at:new Date().toISOString(),role:'user',channel:'imessage',text:'PRIVATE_USER_'+i};
      await ok(await post('remember_contract_context',i,{source_id:a.source_id,events:[note]}));
      outputs.push(await ok(await post('redline_contract',i,{source_id:a.source_id,source_sha256:a.source_sha256,
        changes:[{paragraphId:'p0',original:'sixty',replacement:i?'forty':'thirty',reason:'Public drafting explanation'}]})));
    }
    for(let i=0;i<2;i++){
      const recalled=await ok(await post('recall_contract_context',i,{source_id:a.source_id,owner:owners[1-i]}));
      assert.match(JSON.stringify(recalled),new RegExp('PRIVATE_USER_'+i));
      assert.doesNotMatch(JSON.stringify(recalled),new RegExp('PRIVATE_USER_'+(1-i)));
      await assert.rejects(workflow.meetingDocument(owners[i],a.source_id,outputs[1-i].output_id),/not found/);
      const changed=new URL(outputs[i].download_url);changed.searchParams.set('owner',owners[1-i]);
      await assert.rejects(workflow.download(changed),/invalid or expired/);
      const file=await workflow.download(new URL(outputs[i].download_url));assert.equal(file.owner,owners[i]);
      assert.equal(file.outputSha256,outputs[i].output_sha256);
    }
    assert.notEqual(matterNamespace(owners[0],a.source_id),matterNamespace(owners[1],a.source_id));
    // Registry survives a process/store restart and cannot silently rebind an owner.
    store.db.close();store=new LocalStore(path);workflow.store=store;
    for(let i=0;i<2;i++)assert.equal(await store.getSender(owners[i],identity.agentId,identity.line),phones[i]);
    assert.equal(await store.getSender(owners[0],identity.agentId,'another-line'),undefined);
    await assert.rejects(store.saveSender({owner:owners[0],phone:phones[1],...identity}),/conflict/);
    for(let i=0;i<2;i++){
      const meeting_url=i?'https://meet.google.com/xyz-abcd-efg':'https://meet.google.com/abc-defg-hij';
      const channel={...context(i).channel as object,messageId:'same-join-id',inboundText:'Please join '+meeting_url};
      const joined=await ok(await post('join_meeting',i,{source_id:a.source_id,output_id:outputs[i].output_id,meeting_url,request_id:'model-id'},{channel}));
      assert.equal(joined.speaking,false);assert.equal(joined.sharing,false);
    }
    assert.equal(bots,2);const meetings=owners.map(owner=>sessions.active(owner)!);
    assert.notEqual(meetings[0].sessionId,meetings[1].sessionId);
    assert.throws(()=>sessions.get({...meetings[0],owner:owners[1]}),/not found/);
    assert.equal((await post('meeting_status',1,{session_id:meetings[0].sessionId})).status,422);
    for(let i=0;i<2;i++){
      await ok(await post('meeting_control',i,{}, {channel:{...context(i).channel as object,messageId:'share',inboundText:'share'}}));
    }
    assert.equal(shares.length,2);
    for(let i=0;i<2;i++){
      const view=transport.presentation(new URL(shares[i]).hash.slice(1));
      assert.equal(view?.document.redlines[0].replacement,i?'forty':'thirty');
      assert.doesNotMatch(JSON.stringify(view),/PRIVATE_USER/);
    }
    const deliveries:any[]=[];
    const messenger=new KeikiPrivateMessenger({apiKey:'synthetic',agentId:identity.agentId,
      resolveRecipient:owner=>store.getSender(owner,identity.agentId,identity.line),fetchImpl:async(_url,init)=>{
        const body=JSON.parse(String(init?.body));deliveries.push(body);
        return Response.json({ok:true,conversations:1,results:[{phone:body.phone,outcome:'queued'}]});
      }});
    intelligence=new MeetingIntelligence(sessions,async (_policy,input:any)=>{
      const text=JSON.stringify(input),i=text.includes('PRIVATE_USER_0')?0:1;
      assert.match(text,new RegExp('PRIVATE_USER_'+i));assert.doesNotMatch(text,new RegExp('PRIVATE_USER_'+(1-i)));
      return JSON.stringify({text:'PRIVATE_USER_'+i+' suggestion'});
    },matter);
    await Promise.all(meetings.map(async m=>{
      sessions.transcript(m,{id:'same-caption',text:'What notice period would you accept?',at:new Date().toISOString()});
      const text=await intelligence!.remind(m,new AbortController().signal);
      await messenger.send({owner:m.owner,text});
    }));
    assert.equal(deliveries.length,2);
    for(let i=0;i<2;i++)assert.match(deliveries.find(d=>d.phone===phones[i]).text,new RegExp('PRIVATE_USER_'+i));
    assert.equal((await messenger.send({owner:'unregistered',text:'private'})).status,'not_configured');
    assert.equal(deliveries.length,2);
    await ok(await post('meeting_control',0,{}, {channel:{...context(0).channel as object,messageId:'quiet',inboundText:'quiet'}}));
    assert.equal(sessions.get(meetings[1]).share,true,'another user’s controls do not revoke this share');
  } finally {
    intelligence?.close();await transport.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    sessions.close();matter.close();store.db.close();rmSync(dir,{recursive:true,force:true});
  }
});

test('authenticated tool context still rejects forged senders, groups, internal turns and wrong agents/lines',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cleo-senders-'));
  const store=new LocalStore(join(dir,'store.sqlite')),workflow=new Workflow(store,config);
  const request={input:{},context:context(0)};
  try {
    for(const patch of [
      {phone:phones[1]}, {phone:undefined}, {internal:true}, {agentId:'different-agent'}, {channel:'imessage'},
      {channel:{...context(0).channel as object,isDirect:false}}, {channel:{...context(0).channel as object,isDirect:undefined}},
      {channel:{...context(0).channel as object,gateway:'wrong-line'}}, {channel:{...context(0).channel as object,channel:'api'}},
      {phone:'not-a-phone',channel:{...context(0).channel as object,userId:'not-a-phone'}},
    ])await assert.rejects(workflow.registerSender({...request,context:{...request.context,...patch}}),/verified direct/);
    assert.equal(await store.getSender(workflow.ownerForSender(phones[0]),identity.agentId,identity.line),undefined);
    const phone=phones[1];const photon={phone,agentId:identity.agentId,channel:{provider:'photon',teamId:identity.line,channel:'sms',userId:phone,isDirect:true}};
    assert.equal(await workflow.registerSender({input:{},context:photon}),workflow.ownerForSender(phone));
    assert.throws(()=>new Workflow(store,{...config,keikiIdentity:undefined}),/Keiki agent/);
  } finally {store.db.close();rmSync(dir,{recursive:true,force:true});}
});
