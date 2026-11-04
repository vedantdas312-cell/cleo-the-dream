import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {MeetingBinding,PublicDocument} from './meeting-session.ts';
import type {PresentationLocation} from './meeting-presentation-model.ts';
import {presentationLocation} from './meeting-presentation-model.ts';
import {createPresentationSnapshot} from './meeting-presentation-snapshot.ts';

export type DocumentFrame={imageB64:string;mimeType:'image/jpeg'};
export interface MeetingPresenter {
  prepare(binding:MeetingBinding,documentId:string,queries:string[],valid:()=>boolean,location?:PresentationLocation,document?:PublicDocument):Promise<void>;
  frame(binding:MeetingBinding,valid:()=>boolean):Promise<DocumentFrame|undefined>;
  close(binding:MeetingBinding):Promise<void>;
}
export class PresentationUnavailable extends Error {
  constructor(message='Saved snapshot unavailable; use the saved comparison.') {super(message);this.name='PresentationUnavailable';}
}
type BrowserState={computer:string;owner:string;source:string;document:string;snapshotSha256:string;documentSha256:string;setup:boolean;query:string;ready:boolean;frame?:DocumentFrame;at:number};
const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
// A separate anonymous read-only browser. No private notes, Google credentials or arbitrary URLs enter it.
export class MaritimeMeetingPresenter implements MeetingPresenter {
  private states=new Map<string,BrowserState>();
  private queues=new Map<string,Promise<unknown>>();
  private generations=new Map<string,number>();
  private key:string;private request:typeof fetch;
  constructor(key:string,request:typeof fetch=fetch) {this.key=key;this.request=request;}
  private async api(path:string,body?:unknown,method=body===undefined?'GET':'POST') {
    const r=await this.request('https://api.maritime.sh/api/v1/computers'+path,{method,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!r.ok)throw new PresentationUnavailable('Presentation computer unavailable.');return r.json();
  }
  private serial<T>(owner:string,fn:()=>Promise<T>):Promise<T> {
    const pending=(this.queues.get(owner)??Promise.resolve()).catch(()=>{}).then(fn);
    this.queues.set(owner,pending);void pending.finally(()=>{if(this.queues.get(owner)===pending)this.queues.delete(owner);}).catch(()=>{});return pending;
  }
  private async run(binding:MeetingBinding,state:BrowserState,action:string,location?:PresentationLocation):Promise<DocumentFrame|undefined> {
    const nonce=randomUUID();
    const payload={action,nonce,session:binding.sessionId,snapshotSha256:state.snapshotSha256,documentSha256:state.documentSha256,...(location?{location}: {})};
    const r=await this.api('/'+state.computer+'/exec',{command:'node --experimental-websocket /data/cleo-presenter.mjs '+quote(JSON.stringify(payload)),timeoutS:30});
    // Maritime currently returns null even for both exit(0) and exit(7). Null is not success:
    // require a fresh completion receipt emitted only after this exact operation finishes.
    if(r.exitCode!==0&&r.exitCode!==null)throw new PresentationUnavailable('Saved snapshot browser unavailable.');
    let result;try{result=JSON.parse(r.stdout);}catch{throw new PresentationUnavailable('Saved snapshot browser did not confirm the view.');}
    if(!result||result.completed!==true||result.nonce!==nonce||result.action!==action||result.session!==binding.sessionId)
      throw new PresentationUnavailable('Saved snapshot operation completion was not confirmed.');
    if(action==='blank'){
      if(result.blanked!==true)throw new PresentationUnavailable('Presentation clearing was not confirmed.');
      return;
    }
    const path='/data/cleo-frame-'+binding.sessionId+'.jpg';
    if(result.ready!==true||result.publicSnapshot!==true||result.snapshotSha256!==state.snapshotSha256||result.mimeType!=='image/jpeg'||result.path!==path
      ||(action==='locate'&&(result.located!==location?.redlineId||result.contextVerified!==true)))throw new PresentationUnavailable();
    const image=await this.request('https://api.maritime.sh/api/v1/computers/'+state.computer+'/files?path='+encodeURIComponent(path),{redirect:'error',headers:{Authorization:'Bearer '+this.key},signal:AbortSignal.timeout(10000)});
    if(!image.ok)throw new PresentationUnavailable('Public document frame unavailable.');const bytes=Buffer.from(await image.arrayBuffer());
    if(bytes.length>3000000||bytes[0]!==0xff||bytes[1]!==0xd8)throw new PresentationUnavailable('Invalid public document image.');
    return {imageB64:bytes.toString('base64'),mimeType:'image/jpeg'};
  }
  async prepare(binding:MeetingBinding,documentId:string,queries:string[],valid:()=>boolean,location?:PresentationLocation,document?:PublicDocument) {
    if(!/^[\w-]{10,200}$/.test(documentId)||!/^[-\w]{1,100}$/.test(binding.sessionId))throw new PresentationUnavailable();
    const generation=(this.generations.get(binding.sessionId)??0)+1;this.generations.set(binding.sessionId,generation);
    const current=this.states.get(binding.sessionId);if(current)current.ready=false;
    // Fail closed for legacy callers. A live Google URL is never sufficient material for a frame.
    if(!document)throw new PresentationUnavailable('A sanitized saved document is required for snapshot presentation.');
    const snapshot=createPresentationSnapshot(document);
    const selected=location?presentationLocation(snapshot.document,location.redlineId):undefined;
    if(location&&!selected)throw new PresentationUnavailable('Choose a saved redline in this snapshot.');
    const latest=()=>valid()&&this.generations.get(binding.sessionId)===generation;
    const assertCurrent=()=>{if(!latest())throw new PresentationUnavailable('Presentation request superseded or sharing stopped.');};
    return this.serial(binding.owner,async()=>{
      assertCurrent();
      if(queries.length&&!location)throw new PresentationUnavailable('Saved passage context is required to select a snapshot change.');
      let state=this.states.get(binding.sessionId);
      if(state&&(state.owner!==binding.owner||state.source!==binding.sourceId))throw new PresentationUnavailable('Presentation binding changed.');
      if(!state) {
        const created=await this.api('',{externalUserId:'cleo-presenter-'+createHash('sha256').update(binding.owner).digest('hex').slice(0,32),name:'Cleo document presenter',os:'linux'});
        if(!/^[\w-]{1,100}$/.test(created.id??''))throw new PresentationUnavailable('Invalid presentation computer.');
        state={computer:created.id,owner:binding.owner,source:binding.sourceId,document:'',snapshotSha256:'',documentSha256:'',setup:false,query:'',ready:false,at:0};this.states.set(binding.sessionId,state);
        for(const other of this.states.values())if(other!==state&&other.computer===state.computer)other.ready=false;
      }
      if(!state.setup){
        const r=await this.request('https://api.maritime.sh/api/v1/computers/'+state.computer+'/files?path=/data/cleo-presenter.mjs',{method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/octet-stream'},body:await readFile(new URL('./meeting-browser.mjs',import.meta.url),'utf8')});
        if(!r.ok)throw new PresentationUnavailable('Presentation browser setup failed.');state.setup=true;
      }
      assertCurrent();
      let frame=state.frame;
      let captured=false;
      if(state.document!==documentId||state.snapshotSha256!==snapshot.sha256) {
        state.query='';state.document=documentId;state.snapshotSha256=snapshot.sha256;state.documentSha256=snapshot.documentSha256;
        try{
          const uploaded=await this.request('https://api.maritime.sh/api/v1/computers/'+state.computer+'/files?path='+encodeURIComponent('/data/cleo-review-'+binding.sessionId+'.html'),
            {method:'PUT',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/octet-stream'},body:snapshot.html});
          if(!uploaded.ok)throw new PresentationUnavailable('Public snapshot upload failed.');assertCurrent();
          frame=await this.run(binding,state,'open');captured=true;
        }catch(error){state.document='';state.snapshotSha256='';throw error;}
        assertCurrent();
      }
      const query=JSON.stringify(selected??null);
      if(selected&&state.query!==query) {
        // A superseded command may still move the remote browser. Invalidate the old anchor before running it.
        state.query='';frame=await this.run(binding,state,'locate',selected);captured=true;assertCurrent();state.query=query;
      }
      assertCurrent();state.frame=frame;if(captured)state.at=Date.now();state.ready=true;
    });
  }
  async frame(binding:MeetingBinding,valid:()=>boolean) {
    const generation=this.generations.get(binding.sessionId);
    const latest=()=>valid()&&generation===this.generations.get(binding.sessionId);
    return this.serial(binding.owner,async()=>{
      const state=this.states.get(binding.sessionId);
      if(!state?.ready||state.owner!==binding.owner||state.source!==binding.sourceId||!latest())return undefined;
      if(Date.now()-state.at>1200){
        let frame:DocumentFrame|undefined;
        try{frame=await this.run(binding,state,'frame');}catch(error){state.ready=false;throw error;}
        if(!latest()||!state.ready)return undefined;state.frame=frame;state.at=Date.now();
      }
      return latest()&&state.ready?state.frame:undefined;
    });
  }
  async close(binding:MeetingBinding) {
    const current=this.states.get(binding.sessionId);
    if(current&&(current.owner!==binding.owner||current.source!==binding.sourceId))throw new PresentationUnavailable('Presentation binding changed.');
    this.generations.set(binding.sessionId,(this.generations.get(binding.sessionId)??0)+1);
    if(current)current.ready=false;
    await this.serial(binding.owner,async()=>{
      const state=this.states.get(binding.sessionId);if(!state)return;
      this.states.delete(binding.sessionId);
      if([...this.states.values()].some(other=>other.computer===state.computer))return;
      try{await this.run(binding,state,'blank');}finally{await this.api('/'+state.computer+'/sessions/close',{});}
    });
  }
}
