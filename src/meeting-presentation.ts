import { createHash } from 'node:crypto';

// No desktop capture, microphone, private context, remote assets or HTML from the document.
// Only a short-lived server-authorized public document can enter this page.
export const presentationScript = String.raw`
const token=location.hash.slice(1);
history.replaceState(null,'',location.pathname);
const root=document.getElementById('document'),status=document.getElementById('status');
let expires=0,closed=false,busy=false,epoch=0,frameBusy=false,frameGeneration=0;
let content='',selection='',mode='',lastFrame=0,frameUrl='',snapshot=null;
let saved=null,google=null,caption=null,heading=null,dataAbort=null,frameAbort=null,eventAbort=null;
const now=()=>performance.now();
const snapshotMode=()=>mode==='saved_snapshot'||mode==='google_doc';
function text(tag,value,parent,className){const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;parent.append(el);return el;}
function releaseImage(){if(frameUrl)URL.revokeObjectURL(frameUrl);frameUrl='';lastFrame=0;}
function blank(permanent=false){
 if(permanent)closed=true;expires=0;epoch++;frameGeneration++;dataAbort?.abort();frameAbort?.abort();
 if(permanent)eventAbort?.abort();
 root.replaceChildren();content='';selection='';mode='';snapshot=null;saved=null;google=null;caption=null;heading=null;
 releaseImage();status.textContent='Presentation paused';
}
function authorized(){return !closed&&expires>now();}
function fallback(reason){
 if(!authorized()||!saved)return;
 saved.hidden=false;if(google)google.hidden=true;
 status.textContent=snapshot?.document.sections?.length?'Cleo · saved draft · for review':snapshot?.document.redlines.length?'Cleo · saved comparison'+(reason?' · '+reason:''):'Cleo · source only — no saved changes';
}
function render(frame){
 const doc=frame.document,next=JSON.stringify(doc),changed=selection!==(frame.selectedSectionId||frame.selectedRedlineId)||content!==next||mode!==frame.mode;
 if(content!==next){
  frameGeneration++;frameAbort?.abort();releaseImage();root.replaceChildren();
  heading=text('h1',doc.title,root);
  caption=text('aside','',root,'change-caption');caption.setAttribute('aria-live','polite');
  const stage=text('section','',root,'stage');
  saved=text('article','',stage,'saved-document');saved.setAttribute('aria-label',doc.sections?'Saved draft document':'Saved contract comparison');
  google=text('img','',stage,'google-document');google.alt='Frozen saved review snapshot — extracted contract text';google.hidden=true;
  for(const p of doc.paragraphs){
   const paragraph=text('p','',saved,'paragraph');paragraph.id='paragraph-'+p.id;
   const changes=doc.redlines.filter(r=>r.paragraphId===p.id).sort((a,b)=>p.text.indexOf(a.original)-p.text.indexOf(b.original));
   let cursor=0;
   for(const change of changes){const index=p.text.indexOf(change.original);if(index<cursor)continue;
    text('span',p.text.slice(cursor,index),paragraph);text('del',change.original,paragraph);text('ins',change.replacement,paragraph);cursor=index+change.original.length;}
   text('span',p.text.slice(cursor),paragraph);
  }
  content=next;
 }
 if(changed){
  frameGeneration++;frameAbort?.abort();releaseImage();
  const section=doc.sections?.find(s=>s.id===frame.selectedSectionId);
  const redline=doc.redlines.find(r=>r.id===frame.selectedRedlineId),number=doc.redlines.findIndex(r=>r.id===frame.selectedRedlineId)+1;
  caption.replaceChildren();
  if(section){
   text('strong','Passage '+(doc.sections.findIndex(s=>s.id===section.id)+1)+' of '+doc.sections.length+' · draft for review',caption);
  }else if(redline){
   text('strong','Change '+number+' of '+doc.redlines.length+' · '+redline.id,caption);
   const comparison=text('div','',caption,'comparison');
   const before=text('div','',comparison);text('b','Before',before);text('del',redline.original,before);
   const after=text('div','',comparison);text('b','Proposed',after);text('ins',redline.replacement,after);
  }else text('strong',doc.redlines.length?'Saved contract comparison':'Source document · no saved changes',caption);
  for(const el of saved.querySelectorAll('.selected'))el.classList.remove('selected');
  const paragraph=(section||redline)&&document.getElementById('paragraph-'+(section||redline).paragraphId);
  if(paragraph){paragraph.classList.add('selected');paragraph.scrollIntoView({behavior:'smooth',block:'center'});}
  selection=frame.selectedSectionId||frame.selectedRedlineId;mode=frame.mode;
  fallback(snapshotMode()?'Saved snapshot loading':frame.fallbackReason?'Snapshot unavailable':'');
 }
 if(snapshotMode())void imageFrame();else fallback(frame.fallbackReason?'Snapshot unavailable':'');
}
async function imageFrame(){
 if(frameBusy||!snapshotMode()||!authorized())return;
 frameBusy=true;const generation=frameGeneration,requestEpoch=epoch;
 const controller=new AbortController();frameAbort=controller;const timeout=setTimeout(()=>controller.abort(),4000);
 try{
  const response=await fetch('/meeting/presentation-frame',{headers:{Authorization:'Bearer '+token,'X-Cleo-Redline':selection||'none'},cache:'no-store',signal:controller.signal});
  if(!response.ok||!response.headers.get('content-type')?.startsWith('image/jpeg'))throw new Error('unavailable');
  const blob=await response.blob();
  if(blob.size>3000000)throw new Error('unavailable');
  if(generation!==frameGeneration||requestEpoch!==epoch||!authorized()||!snapshotMode())return;
  const url=URL.createObjectURL(blob),candidate=new Image();
  try{await new Promise((resolve,reject)=>{candidate.onload=resolve;candidate.onerror=reject;controller.signal.addEventListener('abort',()=>reject(new Error('expired')),{once:true});candidate.src=url;});}
  catch(error){URL.revokeObjectURL(url);throw error;}
  if(generation!==frameGeneration||requestEpoch!==epoch||!authorized()||!snapshotMode()){URL.revokeObjectURL(url);return;}
  releaseImage();frameUrl=url;google.src=url;google.hidden=false;saved.hidden=true;lastFrame=now();
  status.textContent='Cleo · saved review snapshot · saved wording above';
 }catch{
  if(generation===frameGeneration&&requestEpoch===epoch&&authorized())fallback('Snapshot unavailable');
 }finally{clearTimeout(timeout);if(frameAbort===controller)frameAbort=null;frameBusy=false;}
}
async function refresh(){
 if(busy||closed)return;busy=true;
 const requestEpoch=epoch,started=now(),controller=new AbortController();dataAbort=controller;
 const timeout=setTimeout(()=>controller.abort(),1800);
 try{
  const response=await fetch('/meeting/presentation-data',{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:controller.signal});
  if(requestEpoch!==epoch||closed)return;
  if([401,403,404,410].includes(response.status)){blank(true);return;}
  if(!response.ok)throw new Error('temporary');
  const frame=await response.json();
  if(requestEpoch!==epoch||closed)return;
  if(!frame.active||!frame.document){blank(true);return;}
  if(!Array.isArray(frame.document.paragraphs)||!Array.isArray(frame.document.redlines)){blank(true);return;}
  // Network latency consumes the lease. A delayed response cannot extend old authorization.
  expires=started+Math.min(5000,Number.isFinite(frame.leaseMs)?Math.max(0,frame.leaseMs):5000);
  if(!authorized()){blank();return;}
  snapshot=frame;render(frame);
 }catch{
  // Keep the last authorized view through a transient timeout, only until its lease expires.
  if(requestEpoch===epoch&&!authorized()&&content)blank();
 }finally{clearTimeout(timeout);if(dataAbort===controller)dataAbort=null;busy=false;}
}
async function events(){
 if(closed)return;const controller=new AbortController();eventAbort=controller;
 try{
  const response=await fetch('/meeting/presentation-events',{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:controller.signal});
  if([401,403,410].includes(response.status)){blank(true);return;}
  if(!response.ok||!response.body)throw new Error('unavailable');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  while(!closed){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true}).replace(/\r\n/g,'\n');
   if(buffer.length>16384)throw new Error('invalid stream');let at;
   while((at=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,at);buffer=buffer.slice(at+2);
    if(/^event:\s*revoked\s*$/m.test(event)){blank(true);return;}
    if(/^event:\s*refresh\s*$/m.test(event))void refresh();
   }
  }
 }catch{}finally{controller.abort();if(eventAbort===controller)eventAbort=null;if(!closed)setTimeout(events,1500);}
}
setInterval(()=>{if(expires&&now()>=expires)blank();else if(authorized()&&snapshotMode()&&lastFrame&&now()-lastFrame>6000)fallback('Snapshot unavailable');},50);
setInterval(refresh,500);setInterval(imageFrame,1500);void refresh();void events();
addEventListener('pagehide',()=>blank(true));
`;
export const presentationCsp = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(presentationScript).digest('base64')}'; style-src 'unsafe-inline'; connect-src 'self' http://localhost:8000/offer_meeting_audio; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export const presentationHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Cleo public contract view</title><style>
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#f6f4ef;color:#222;font:21px/1.5 Georgia,serif;padding:18px 32px;width:100vw;height:100vh;overflow:hidden}header{font:14px system-ui,sans-serif;color:#6b655b;height:24px}h1{font-size:25px;font-weight:500;margin:0 0 10px}#document{height:calc(100vh - 78px);display:flex;flex-direction:column;gap:10px}.stage{position:relative;min-height:0;flex:1}.saved-document{height:100%;overflow:auto;scroll-behavior:smooth;background:#fff}.paragraph{white-space:pre-wrap;padding:12px 18px;margin:0}.selected{background:#fff4d6;border-left:4px solid #a58230}del{color:#953d35;text-decoration:line-through}ins{color:#185a43;text-decoration:underline;margin-left:4px}.google-document{width:100%;height:100%;object-fit:contain;background:white}.change-caption{flex:none;font:18px/1.45 system-ui,sans-serif;background:#fff;padding:12px 18px;max-height:230px;overflow:auto;border:1px solid #e7dfce}.change-caption strong{display:block;margin-bottom:8px;font-size:17px}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:24px}.comparison b{display:block;color:#625a4c;font-size:13px;text-transform:uppercase;margin-bottom:4px}.comparison del,.comparison ins{display:block;white-space:pre-wrap;margin:0}footer{position:fixed;bottom:10px;font:13px system-ui,sans-serif;color:#655d50}
</style><header>Cleo / Contract discussion</header><main id="document"></main><footer id="status">Presentation paused</footer><script>${presentationScript}</script></html>`;
