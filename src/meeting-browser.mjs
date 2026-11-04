// Runs in the dedicated presentation computer. Only a frozen, escaped public snapshot is rendered.
// No Google page, comments, external assets, account UI or live document updates can enter a frame.
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

export async function runPresentationBrowser(input) {
 if(!['open','locate','frame','blank'].includes(input.action)||!/^[-\w]{1,100}$/.test(input.session??'')
   ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.nonce??''))throw new Error('Invalid presentation operation');
 const stateFile='/data/cleo-presentation-state.json',endpoint='http://127.0.0.1:9223';
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 let targets;
 for(let i=0;i<40;i++) {
  try {targets=await fetch(endpoint+'/json/list').then(r=>r.json());break;}catch{}
  if(i===0) {
   const child=spawn('/usr/bin/chromium',['--user-data-dir=/data/cleo-public-browser','--incognito','--no-first-run','--no-default-browser-check','--disable-sync','--disable-extensions','--lang=en-US','--remote-debugging-port=9223','--remote-debugging-address=127.0.0.1','--window-size=1280,720','--app=about:blank'],{detached:true,stdio:'ignore'});child.unref();
  }
  await pause(200);
 }
 const target=targets?.find(t=>t.type==='page');if(!target)throw new Error('Presentation browser unavailable');
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 let seq=0;const pending=new Map();
 ws.addEventListener('message',event=>{const d=JSON.parse(event.data);if(!d.id)return;const p=pending.get(d.id);if(!p)return;pending.delete(d.id);clearTimeout(p.timer);d.error?p.reject(new Error('Browser command failed')):p.resolve(d.result);});
 function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Browser command timeout'));},8000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
 const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true})).result?.value;
 try {
  await call('Page.enable');
  let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch{}
  if(input.action==='blank') {await call('Page.navigate',{url:'about:blank'});await writeFile(stateFile,'{}');return {blanked:true};}
  if(!/^[a-f0-9]{64}$/.test(input.snapshotSha256??'')||!/^[a-f0-9]{64}$/.test(input.documentSha256??''))throw new Error('Verified public snapshot required');
  if(input.action==='open') {
   const html=await readFile('/data/cleo-review-'+input.session+'.html','utf8');
   if(html.length>3000000||createHash('sha256').update(html).digest('hex')!==input.snapshotSha256)throw new Error('Public snapshot changed');
   // Destroy any old live page and its network activity before inserting the fixed public document.
   await call('Page.navigate',{url:'about:blank'});
   // Navigation can acknowledge before the replacement page is active. Wait for its frame,
   // rather than stopping a still-committing navigation and retaining the old live document.
   let frameTree;
   for(let attempt=0;attempt<10;attempt++) {
    await pause(100);
    try{const result=await call('Page.getFrameTree');if(result.frameTree?.frame?.url==='about:blank'){frameTree=result.frameTree;break;}}catch{}
   }
   if(!frameTree)throw new Error('Blank snapshot page did not become ready');
   await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
   state={session:input.session,snapshotSha256:input.snapshotSha256,documentSha256:input.documentSha256};
   await writeFile(stateFile,JSON.stringify(state),{mode:0o600});
  } else if(state?.session!==input.session||state?.snapshotSha256!==input.snapshotSha256||state?.documentSha256!==input.documentSha256)throw new Error('Presentation snapshot changed');
  const ready=await evaluate(`location.href==='about:blank' && document.body?.dataset.publicSnapshot===${JSON.stringify(state.documentSha256)} && !document.querySelector('script,iframe,object,embed,img,video,audio,link')`);
  if(!ready)throw new Error('Public snapshot is not ready');
  let located;
  if(input.action==='locate') {
   if(!input.location||!/^r[1-9]\d*$/.test(input.location.redlineId??''))throw new Error('Invalid saved passage');
   const result=await evaluate(`(()=>{
    const nodes=[...document.querySelectorAll('[data-redline-id]')].filter(el=>el.dataset.redlineId===${JSON.stringify(input.location.redlineId)});
    if(nodes.length!==1)return false;const node=nodes[0],paragraph=node.closest('p');
    if(!paragraph||paragraph.id!==${JSON.stringify('paragraph-'+input.location.paragraphId)}||node.querySelector('del')?.textContent!==${JSON.stringify(input.location.original)}||node.querySelector('ins')?.textContent!==${JSON.stringify(input.location.replacement)})return false;
    for(const old of document.querySelectorAll('.selected'))old.classList.remove('selected');paragraph.classList.add('selected');
    paragraph.scrollIntoView({behavior:'instant',block:'center'});return true;
   })()`);
   if(!result)return {ready:false,unavailable:'saved_passage_not_verified'};
   located=input.location.redlineId;state.located=located;await writeFile(stateFile,JSON.stringify(state),{mode:0o600});
  }
  await pause(50);
  const image=await call('Page.captureScreenshot',{format:'jpeg',quality:80,captureBeyondViewport:false});
  const path='/data/cleo-frame-'+input.session+'.jpg';await writeFile(path,Buffer.from(image.data,'base64'),{mode:0o600});
  return {ready:true,publicSnapshot:true,snapshotSha256:state.snapshotSha256,path,mimeType:'image/jpeg',...(located?{located,contextVerified:true}:{})};
 }finally{ws.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const input=JSON.parse(process.argv[2]??'{}');
  const result=await runPresentationBrowser(input);
  // A CDP WebSocket close handshake may retain an event-loop handle after capture finishes.
  // Flush the completed operation receipt before terminating the short-lived exec process.
  process.stdout.write(JSON.stringify({...result,completed:true,nonce:input.nonce,action:input.action,session:input.session})+'\n',()=>process.exit(0));
 }catch{
  process.stdout.write(JSON.stringify({ready:false,completed:false,unavailable:'public_snapshot_unavailable'})+'\n',()=>process.exit(1));
 }
}
