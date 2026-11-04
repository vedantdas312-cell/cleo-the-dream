import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Workflow,type Config} from '../src/workflow.ts';
import {LocalStore} from '../src/local-store.ts';
import {MatterContext} from '../src/matter-context.ts';
import {MeetingSessions,publicDocument} from '../src/meeting-session.ts';
import {validateMeetingIntent} from '../src/meeting-intent.ts';
import {MeetingTransport} from '../src/meeting-transport.ts';
import {MeetingRoutes} from '../src/meeting-routes.ts';
import {Attendee} from '../src/attendee.ts';

const config:Config={webhookKey:'test-webhook-key-with-24-chars',downloadSecret:'test-download-secret-with-at-least-32-chars',publicUrl:'https://cleo.example',localOnly:true,attachmentOrigins:['https://media.example']};
const draft={title:'Mutual NDA',blocks:[{kind:'heading',text:'Confidentiality'},{kind:'paragraph',text:'Each party must protect confidential information.'},{kind:'heading',text:'Duration'},{kind:'paragraph',text:'The duties last two years.'}]};
function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'cleo-draft-meeting-')),store=new LocalStore(join(dir,'store.sqlite')),matter=new MatterContext(':memory:');
  const workflow=new Workflow(store,config,fetch,matter),request={input:{draft},context:{phone:'+15555550100',channel:'imessage'}};
  const owner=workflow.owner(request);
  t.after(()=>{store.db.close();matter.close();rmSync(dir,{recursive:true,force:true});});
  return {workflow,store,matter,owner,request};
}

test('generated draft downloads exact saved bytes and resolves only for its owner without an upload',async t=>{
  const f=fixture(t),result=await f.workflow.draft(f.request),again=await f.workflow.draft(f.request);
  assert.equal(again.draft_id,result.draft_id);assert.equal(result.download_expires_in_seconds,900);
  assert.equal('google_doc' in result,false);
  const downloaded=await f.workflow.download(new URL(result.download_url));
  const saved=await f.store.getDraft(result.draft_id,f.owner);
  assert.ok(saved);assert.deepEqual(downloaded.bytes,saved.bytes);
  const selected=await f.workflow.meetingSelection(f.owner,{draft_id:result.draft_id});
  assert.deepEqual(selected.document.redlines,[]);assert.equal(selected.document.sections?.length,2);
  const first=selected.document.sections![0];assert.equal(selected.document.paragraphs.find(p=>p.id===first.paragraphId)?.text,draft.blocks[1].text);
  assert.doesNotMatch(JSON.stringify(selected.document),/fixture-owner|token|private/i);
  await assert.rejects(f.workflow.meetingSelection('other',{draft_id:result.draft_id}),/owner/);
  await assert.rejects(f.workflow.meetingSelection(f.owner,{draft_id:result.draft_id,source_id:'another'}),/exactly one/);
  await assert.rejects(f.workflow.meetingSelection(f.owner,{draft_id:result.draft_id,output_id:'other'}));
  await assert.rejects(f.workflow.meetingSelection(f.owner,{draft_id:'missing'}));
  f.store.db.prepare("UPDATE files SET data=json_set(data,'$.outputSha256','corrupted') WHERE kind='draft' AND owner=? AND id=?").run(f.owner,result.draft_id);
  await assert.rejects(f.workflow.meetingSelection(f.owner,{draft_id:result.draft_id}),/owner/);
});

test('draft passage selection cannot grant sharing or approve terms',async t=>{
  const f=fixture(t),result=await f.workflow.draft({...f.request,input:{draft}});
  const selected=await f.workflow.meetingSelection(f.owner,{draft_id:result.draft_id});
  const sessions=new MeetingSessions(':memory:');t.after(()=>sessions.close());
  const s=sessions.create({owner:f.owner,sourceId:selected.sourceId,meetingUrl:'https://meet.google.com/abc-defg-hij',requestId:'invite',publicDocument:selected.document});
  assert.equal(s.speak,false);assert.equal(s.share,false);assert.equal(s.selectedSectionId,'s1');assert.equal(s.selectedRedlineId,null);
  const command=(action:any)=>sessions.resolveControl(s,sessions.get(s).revision,action);
  command({action:'walkthrough'});assert.equal(sessions.get(s).share,false);assert.equal(sessions.get(s).selectedSectionId,'s1');
  const speech=sessions.lease(s,'speak');
  command({action:'next'});assert.throws(()=>sessions.assertLease(speech));assert.equal(sessions.get(s).selectedSectionId,'s2');assert.throws(()=>command({action:'next'}),/no further/);
  command({action:'previous'});assert.equal(sessions.get(s).selectedSectionId,'s1');
  assert.throws(()=>command({action:'select_section',sectionId:'s99'}));assert.throws(()=>command({action:'approve',redlineId:'s1'}));
  command({action:'share'});const lease=sessions.lease(s,'share');command({action:'quiet'});assert.equal(sessions.assertLease(lease),true);command({action:'stop_share'});assert.throws(()=>sessions.assertLease(lease));
  const input={text:'Explain the duration',channel:'meeting' as const,speaking:false,sharing:false,selectedRedlineId:null,redlines:[],recentPublicTurns:[],sections:[{id:'s1',text:draft.blocks[1].text},{id:'s2',text:draft.blocks[3].text}]};
  assert.deepEqual(validateMeetingIntent({addressed:true,actions:[{action:'select_section',section_id:'s2',redline_id:''},{action:'walkthrough',section_id:'',redline_id:''}]},input).command,{action:'combined',actions:[{action:'select_section',sectionId:'s2'},{action:'explain'}]});
  assert.throws(()=>validateMeetingIntent({addressed:true,actions:[{action:'select_section',section_id:'invented',redline_id:''}]},input));
  assert.throws(()=>publicDocument({...selected.document,sections:[{id:'s1',paragraphId:'invented'}]}));
});

test('a direct call invitation joins with the generated draft ID, quietly and idempotently',async t=>{
  const f=fixture(t),draftResult=await f.workflow.draft(f.request),sessions=new MeetingSessions(':memory:');
  let joins=0;
  const attendee=new Attendee('fixture',(async(url:any)=>{if(String(url).endsWith('/bots')){joins++;return Response.json({id:'bot_draft',state:'joining'});}return new Response(null);}) as typeof fetch);
  const transport=new MeetingTransport(sessions,{path:':memory:',publicUrl:config.publicUrl,attendee,openaiKey:''});
  const routes=new MeetingRoutes(transport,f.workflow,{secret:'s'.repeat(32),agentId:'fixture-agent',line:'fixture-line'});
  const meetingUrl='https://meet.google.com/abc-defg-hij';
  const request={input:{draft_id:draftResult.draft_id,meeting_url:meetingUrl,request_id:'model-id'},context:{phone:f.request.context.phone,agentId:'fixture-agent',channel:{channel:'sms',provider:'blooio',gateway:'fixture-line',userId:f.request.context.phone,isDirect:true,messageId:'draft-call',inboundText:meetingUrl}}};
  try{
    const joined=await routes.tool('/tools/join_meeting',request) as any;
    assert.equal(joined.status,'joining');assert.equal(joined.source_id,draftResult.draft_id);assert.equal(joined.saved_passages,2);assert.equal(joined.presentation,'saved_document_view');
    const active=sessions.active(f.owner)!;assert.equal(active.speak,false);assert.equal(active.share,false);assert.equal(active.googleDocumentId,undefined);
    assert.equal(sessions.publicView(active).paragraphs.find(p=>p.id==='p3')?.text,draft.blocks[1].text);
    await routes.tool('/tools/join_meeting',request);assert.equal(joins,1);
    await assert.rejects(routes.tool('/tools/join_meeting',{...request,input:{...request.input,draft_id:'missing'},context:{...request.context,channel:{...request.context.channel,messageId:'another-call'}}}));
    assert.equal(joins,1);
  }finally{await transport.close();sessions.close();}
});
