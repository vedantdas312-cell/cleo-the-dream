import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {presentationScript} from '../src/meeting-presentation.ts';

// Execute the shipped script, including real fetch response/stream handling, with a small deterministic DOM and clock.
// This catches races and lease behavior without a live meeting, browser service or Google credentials.
class Element {
 tag:string;children:Element[]=[];parent?:Element;id='';className='';textContent='';hidden=false;attributes=new Map<string,string>();scrolls:any[]=[];
 constructor(tag:string){this.tag=tag;}
 append(el:Element){el.parent=this;this.children.push(el);}
 replaceChildren(...children:Element[]){this.children=children;for(const c of children)c.parent=this;}
 setAttribute(k:string,v:string){this.attributes.set(k,v);}
 get classList(){return {add:(s:string)=>{this.className=[...new Set([...this.className.split(' '),s])].join(' ').trim();},remove:(s:string)=>{this.className=this.className.split(' ').filter(c=>c!==s).join(' ');}};}
 querySelectorAll(query:string):Element[]{return this.children.flatMap(c=>[...(query.startsWith('.')?c.className.split(' ').includes(query.slice(1)):c.tag===query)?[c]:[],...c.querySelectorAll(query)]);}
 scrollIntoView(options:any){this.scrolls.push(options);}
 get text():string{return this.textContent+this.children.map(c=>c.text).join('');}
}
const doc={title:'Contract review',paragraphs:[{id:'p0',text:'Notice is sixty days.'},{id:'p1',text:'Payment is sixty days.'},{id:'p2',text:'Renewal is sixty days.'}],redlines:[1,2,3].map((n)=>({id:'r'+n,paragraphId:'p'+(n-1),original:'sixty days',replacement:n+' days'}))};
async function harness(mode='contract') {
 let time=0,frame:any={active:true,document:doc,selectedRedlineId:'r1',mode},responseStatus=200,fail=false,imageStatus=503;
 let backendSelection:string|null|undefined;const frameSelections:string[]=[];
 let dataWait:Promise<any>|undefined,imageWait:Promise<any>|undefined;
 const root=new Element('main'),status=new Element('footer');root.id='document';status.id='status';
 const all=()=>[root,status,...root.querySelectorAll('p'),...root.querySelectorAll('article'),...root.querySelectorAll('img')];
 const intervals:{fn:()=>void;ms:number}[]=[],timeouts=new Map<number,{fn:()=>void;at:number}>();let timer=0;
 const revoked:string[]=[],urls:string[]=[],events:any[]=[];let streamController!:ReadableStreamDefaultController<Uint8Array>;
 const stream=new ReadableStream<Uint8Array>({start(c){streamController=c;}});
 const pendingAbort=(wait:Promise<any>,signal?:AbortSignal)=>new Promise<any>((resolve,reject)=>{wait.then(resolve,reject);signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
 const fetchImpl=async(url:string,init:any)=>{
  assert.equal(init.headers.Authorization,'Bearer fixture-token');assert.equal(init.cache,'no-store');
  if(url.endsWith('events'))return new Response(stream,{headers:{'content-type':'text/event-stream'}});
  if(url.endsWith('frame')){
   frameSelections.push(init.headers['X-Cleo-Redline']);
   if(backendSelection!==undefined&&init.headers['X-Cleo-Redline']!==(backendSelection??'none'))return new Response(null,{status:403});
   if(imageWait)return pendingAbort(imageWait,init.signal);
   return new Response(new Uint8Array([255,216,255,217]),{status:imageStatus,headers:{'content-type':'image/jpeg'}});
  }
  if(dataWait)return pendingAbort(dataWait,init.signal);
  if(fail)throw new Error('temporary network failure');
  return Response.json(frame,{status:responseStatus});
 };
 class FakeImage {onload?:()=>void;onerror?:()=>void;set src(_v:string){queueMicrotask(()=>this.onload?.());}}
 const sandbox=vm.createContext({document:{getElementById:(id:string)=>all().find(e=>e.id===id),createElement:(tag:string)=>new Element(tag)},
  location:{hash:'#fixture-token',pathname:'/meeting/presentation'},history:{replaceState:()=>{}},performance:{now:()=>time},
  fetch:fetchImpl,AbortController,TextDecoder,Image:FakeImage,URL:{createObjectURL:()=>{const url='blob:'+urls.length;urls.push(url);return url;},revokeObjectURL:(url:string)=>revoked.push(url)},
  setInterval:(fn:()=>void,ms:number)=>intervals.push({fn,ms}),setTimeout:(fn:()=>void,ms:number)=>{timeouts.set(++timer,{fn,at:time+ms});return timer;},clearTimeout:(id:number)=>timeouts.delete(id),
  addEventListener:(name:string,fn:()=>void)=>events.push({name,fn})});
 vm.runInContext(presentationScript,sandbox);
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};await flush();
 const pulse=async(ms:number)=>{for(const item of intervals)if(item.ms===ms)item.fn();await flush();};
 return {root,status,revoked,urls,flush,pulse,frameSelections,backendSelect:(id:string|null)=>backendSelection=id,
  frame:(value:any)=>{frame=value;},select:(id:string)=>{frame={...frame,selectedRedlineId:id};},fail:(v:boolean)=>fail=v,
  statusCode:(v:number)=>responseStatus=v,imageStatus:(v:number)=>imageStatus=v,
  waitData:(p:Promise<any>|undefined)=>dataWait=p,waitImage:(p:Promise<any>|undefined)=>imageWait=p,
  advance:async(ms:number)=>{time+=ms;for(const [id,t] of [...timeouts])if(t.at<=time){timeouts.delete(id);t.fn();}await pulse(50);},
  event:async(name:string)=>{streamController.enqueue(new TextEncoder().encode('event: '+name+'\ndata: {}\n\n'));await flush();},
  close:()=>{events.find(e=>e.name==='pagehide')!.fn();streamController.close();}};
}

test('viewer navigates 1→2→3→2 in the same saved DOM, shows numbered before/after text, and uses smooth scroll',async()=>{
 const h=await harness();try{
  const article=h.root.querySelectorAll('article')[0],paragraphs=h.root.querySelectorAll('p');
  assert.match(h.root.text,/Change 1 of 3/);assert.match(h.root.text,/Before.*sixty days.*Proposed.*1 days/);
  for(const id of ['r2','r3','r2']){h.select(id);await h.pulse(500);assert.equal(h.root.querySelectorAll('article')[0],article);}
  assert.match(h.root.text,/Change 2 of 3/);assert.equal(paragraphs[1].scrolls.length,2);assert.equal(paragraphs[1].scrolls[1].behavior,'smooth');
  assert.equal(paragraphs.filter(p=>p.className.includes('selected')).length,1);
 }finally{h.close();}
});

test('frame request retains the viewer selection when the server advances before presentation-data arrives',async()=>{
 const h=await harness('saved_snapshot');try{
  h.imageStatus(200);h.backendSelect('r1');await h.pulse(1500);
  assert.equal(h.root.querySelectorAll('img')[0].hidden,false);assert.equal(h.frameSelections.at(-1),'r1');
  const previousImages=h.urls.length;
  // The server already navigated to r2, but the viewer still has the authorized r1 data snapshot.
  h.backendSelect('r2');await h.pulse(1500);
  assert.equal(h.frameSelections.at(-1),'r1');assert.equal(h.urls.length,previousImages);
  assert.equal(h.root.querySelectorAll('img')[0].hidden,true);assert.match(h.root.text,/Change 1 of 3/);
  assert.match(h.status.textContent,/saved comparison/);
  h.select('r2');await h.pulse(500);
  assert.equal(h.frameSelections.at(-1),'r2');assert.equal(h.root.querySelectorAll('img')[0].hidden,false);
  assert.match(h.root.text,/Change 2 of 3/);
  h.backendSelect(null);h.frame({active:true,document:{...doc,redlines:[]},selectedRedlineId:null,mode:'saved_snapshot'});await h.pulse(500);
  assert.equal(h.frameSelections.at(-1),'none');assert.match(h.root.text,/Source document/);
 }finally{h.close();}
});

test('viewer retains last authorized content through timeouts, renews for five seconds, then clears at lease expiry',async()=>{
 const h=await harness();try{
  const article=h.root.querySelectorAll('article')[0];h.fail(true);await h.advance(3000);await h.pulse(500);
  assert.equal(h.root.querySelectorAll('article')[0],article);
  h.fail(false);await h.pulse(500);h.fail(true);await h.advance(4999);assert.equal(h.root.querySelectorAll('article')[0],article);
  await h.advance(1);assert.equal(h.root.children.length,0);assert.equal(h.status.textContent,'Presentation paused');
 }finally{h.close();}
});

test('SSE revocation clears immediately and a delayed successful data response cannot restore public output',async()=>{
 const h=await harness();try{
  let resolve!:(r:Response)=>void;h.waitData(new Promise(r=>resolve=r));await h.pulse(500);
  await h.event('revoked');assert.equal(h.root.children.length,0);
  resolve(Response.json({active:true,document:doc,selectedRedlineId:'r2',mode:'contract'}));await h.flush();
  h.waitData(undefined);await h.pulse(500);assert.equal(h.root.children.length,0);
 }finally{h.close();}
});

test('unauthorized response and explicit inactive frame clear immediately; source-only shows no invented changes',async()=>{
 for(const invalid of ['unauthorized','inactive']){
  const h=await harness();try{
   if(invalid==='unauthorized')h.statusCode(403);else h.frame({active:false});
   await h.pulse(500);assert.equal(h.root.children.length,0);
  }finally{h.close();}
 }
 const h=await harness();try{
  h.frame({active:true,document:{...doc,redlines:[]},selectedRedlineId:null,mode:'contract'});await h.pulse(500);
  assert.match(h.root.text,/Source document · no saved changes/);assert.match(h.status.textContent,/source only/);assert.equal(h.root.querySelectorAll('del').length,0);
 }finally{h.close();}
});

test('failed snapshot frames show labeled saved comparison, and stale image response cannot overwrite a later clause',async()=>{
 const h=await harness('saved_snapshot');try{
  assert.match(h.status.textContent,/saved comparison · Snapshot unavailable/);assert.equal(h.root.querySelectorAll('article')[0].hidden,false);
  let resolve!:(r:Response)=>void;h.waitImage(new Promise(r=>resolve=r));await h.pulse(1500);
  h.select('r2');await h.pulse(500);h.waitImage(undefined);
  resolve(new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}}));await h.flush();
  assert.equal(h.root.querySelectorAll('img')[0].hidden,true);assert.match(h.root.text,/Change 2 of 3/);
  h.imageStatus(200);await h.pulse(1500);assert.equal(h.root.querySelectorAll('img')[0].hidden,false);
  await h.event('revoked');assert.equal(h.root.children.length,0);assert.ok(h.revoked.length>0);
 }finally{h.close();}
});

test('saved draft viewer highlights the selected passage without redline labels or remote frames',async()=>{
 const h=await harness();
 const document={title:'Draft for review',paragraphs:[{id:'p0',text:'First clause.'},{id:'p1',text:'Second clause.'}],redlines:[],sections:[{id:'s1',paragraphId:'p0'},{id:'s2',paragraphId:'p1'}]};
 const frame=(selectedSectionId:string)=>({active:true,document,selectedRedlineId:null,selectedSectionId,mode:'contract'});
 h.frame(frame('s1'));await h.pulse(500);
 assert.match(h.root.text,/Passage 1 of 2/);assert.match(h.status.text,/saved draft/);
 assert.doesNotMatch(h.root.text,/Before|Proposed|no saved changes/);
 const paragraphs=h.root.querySelectorAll('p');assert.equal(paragraphs[0].className.includes('selected'),true);
 h.frame(frame('s2'));await h.event('refresh');
 assert.match(h.root.text,/Passage 2 of 2/);assert.equal(paragraphs[1].className.includes('selected'),true);assert.equal(paragraphs[0].className.includes('selected'),false);
 assert.equal(h.frameSelections.length,0);
 await h.event('revoked');assert.equal(h.root.children.length,0);h.close();
});
