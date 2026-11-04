import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {GoogleRedline} from '../src/google-redline.ts';
import {MatterContext} from '../src/matter-context.ts';
import {sha256, type RedlinePlan} from '../src/docx.ts';
async function fixture(){
 const zip=new JSZip();zip.file('[Content_Types].xml','<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Notice is sixty days.</w:t></w:r></w:p><w:p><w:r><w:t>Payment is sixty days.</w:t></w:r></w:p></w:body></w:document>');
 return zip.generateAsync({type:'nodebuffer'});
}
function provider({failWrite=false, corrupt=false, failShare=false}={}){
 let permission:any;const shares:any[]=[];
 let runs:any[]=[{content:'\n'}],writes=0;const batches:any[]=[];
 const fetchImpl:typeof fetch=async(url,options)=>{
  const body=options?.body?JSON.parse(String(options.body)):null;
  if(String(url).includes('/permissions')) {
   if(failShare)return new Response('',{status:403});
   if(body){permission={id:'anyone',...body};shares.push(body);return Response.json(permission);}
   return Response.json({permissions:permission?[permission]:[]});
  }
  if(String(url).endsWith('/documents')) return Response.json({documentId:'doc1'});
  if(body){
   writes++;batches.push(body);
   if(failWrite&&writes===2)throw new Error('connection lost after write');
   if(writes===1)runs=[{content:body.requests[0].insertText.text+'\n'}];
   else {
    const original=runs.map(r=>r.content).join('');
    // Fixture represents actual inline suggestions at two independent paragraph locations.
    const chunks=original.split('sixty');
    runs=[{content:chunks[0]},{content:'sixty',suggestedDeletionIds:['d1']},{content:'thirty',suggestedInsertionIds:['i1']},
      {content:chunks[1]},{content:'sixty',suggestedDeletionIds:['d2']},{content:corrupt?'wrong':'forty',suggestedInsertionIds:['i2']},{content:chunks[2]}];
   }
   return Response.json({suggestionResponses:writes===2?[{createdSuggestionIds:['d1','i1','d2','i2']}]:[]});
  }
  let index=1;
  return Response.json({documentId:'doc1',revisionId:'r'+writes,tabs:[{tabProperties:{tabId:'t1'},documentTab:{body:{content:[{startIndex:1,paragraph:{elements:runs.map(textRun=>{const startIndex=index;index+=textRun.content.length;return {startIndex,endIndex:index,textRun};})}}]}}}]});
 };
 return {fetchImpl,batches,shares,writes:()=>writes};
}
const planFor=(bytes:Buffer):RedlinePlan=>({sourceSha256:sha256(bytes),changes:[
 {paragraphId:'p0',original:'sixty days',replacement:'thirty days',reason:'Notice objective'},
 {paragraphId:'p1',original:'sixty days',replacement:'forty days',reason:'Payment objective'}]});
test('new users never inherit another user’s public-link permission',async()=>{
 const bytes=await fixture(),c=new MatterContext(':memory:');c.register('new-user','s','Contract');
 const p=provider(),g=new GoogleRedline(async()=>'fake',c,p.fetchImpl,owner=>owner==='original-user');
 try {
  const result=await g.publish('new-user','s','plan',bytes,planFor(bytes));
  assert.equal(result.status,'verified_suggestions');assert.equal(result.sharing,'restricted');
  assert.deepEqual(p.shares,[]);
  assert.equal((await g.publish('new-user','s','plan',bytes,planFor(bytes))).sharing,'restricted');
  assert.equal(c.byDocument('original-user','doc1'),undefined);
 } finally {c.close();}
});
test('restricted review status requires checking actual permissions without changing them',async()=>{
 const context=new MatterContext(':memory:');
 try {
  for(const [permissions,expected] of [[[{type:'user',role:'owner'}],'restricted'],[[{type:'anyone',role:'reader'}],'not_verified'],
    [[{type:'domain',role:'reader'}],'not_verified'],[undefined,'not_verified']] as const){
    const google=new GoogleRedline(async()=>'fake',context,async(_url,init)=>{
      assert.equal(init?.method,'GET');return Response.json({permissions});
    });
    assert.equal((await google.sharedResult('saved-doc','new-user')).sharing,expected);
  }
 } finally {context.close();}
});
test('Docs export targets repeated phrases by paragraph, changes only differing words and verifies both views',async()=>{
 const bytes=await fixture(),c=new MatterContext(':memory:');c.register('u','s','Contract');
 const p=provider(),g=new GoogleRedline(async()=>'fake',c,p.fetchImpl,owner=>owner==='u');
 const result=await g.publish('u','s','plan',bytes,planFor(bytes));
 assert.equal(result.status,'verified_suggestions');assert.equal(result.url,'https://docs.google.com/document/d/doc1/edit');
 assert.equal(result.sharing,'anyone_with_link_viewer');
 assert.deepEqual(p.shares,[{type:'anyone',role:'reader',allowFileDiscovery:false}]);
 assert.equal(c.byDocument('u','doc1'),'s');
 assert.equal(p.batches[1].writeControl.writeMode,'SUGGEST');
 const deletes=p.batches[1].requests.filter((r:any)=>r.deleteContentRange).map((r:any)=>r.deleteContentRange.range);
 assert.ok(deletes[0].startIndex>deletes[1].startIndex);
 assert.ok(deletes.every((r:any)=>r.endIndex-r.startIndex===5),'unchanged days must not be redlined');
 assert.equal((await g.publish('u','s','plan',bytes,planFor(bytes))).status,'verified_suggestions');assert.equal(p.writes(),2);c.close();
});
test('lost acknowledgement and incorrect readback never return a verified URL or retry writes',async()=>{
 for(const options of [{failWrite:true},{corrupt:true}]){
  const bytes=await fixture(),c=new MatterContext(':memory:');c.register('u','s','Contract');
  const p=provider(options),g=new GoogleRedline(async()=>'fake',c,p.fetchImpl,owner=>owner==='u');
  const result=await g.publish('u','s','plan',bytes,planFor(bytes));assert.equal(result.status,'needs_inspection');assert.equal(result.url,undefined);
  assert.equal((await g.publish('u','s','plan',bytes,planFor(bytes))).status,'needs_inspection');assert.equal(p.writes(),2);assert.equal(c.byDocument('u','doc1'),undefined);c.close();
 }
});
test('missing OAuth never claims or creates a Google Doc',async()=>{
 const bytes=await fixture(),c=new MatterContext(':memory:');c.register('u','s','Contract');
 const g=new GoogleRedline(async()=>{throw new Error('no OAuth');},c,async()=>{throw new Error('must not call');});
 await assert.rejects(()=>g.publish('u','s','p',bytes,planFor(bytes)),/no OAuth/);
 assert.equal(c.exportState('u','s','p'),undefined);c.close();
});

test('failed sharing never claims anyone-with-link access and can retry without rewriting the Doc',async()=>{
 const bytes=await fixture(),c=new MatterContext(':memory:');c.register('u','s','Contract');
 const p=provider({failShare:true}),g=new GoogleRedline(async()=>'fake',c,p.fetchImpl,owner=>owner==='u');
 const result=await g.publish('u','s','plan',bytes,planFor(bytes));
 assert.equal(result.status,'verified_suggestions');assert.equal(result.sharing,'not_verified');
 assert.equal((await g.publish('u','s','plan',bytes,planFor(bytes))).sharing,'not_verified');assert.equal(p.writes(),2);c.close();
});

test('public browser requires a successful empty comment check, including pagination',async()=>{
 const context=new MatterContext(':memory:');
 try{
  for(const [body,status,allowed] of [[{comments:[]},200,true],[{comments:[{id:'private-comment'}]},200,false],[{comments:[],nextPageToken:'more'},200,false],[{},200,false],[{comments:[]},403,false]] as const){
   const google=new GoogleRedline(async()=>'fixture-token',context,async(url,init)=>{
    assert.match(String(url),/\/comments\?fields=comments\(id\),nextPageToken/);
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-token');
    return Response.json(body,{status});
   });
   assert.equal(await google.presentationAllowed('verified-review-document'),allowed);
   assert.equal(await google.presentationAllowed('../invalid'),false);
  }
 }finally{context.close();}
});
