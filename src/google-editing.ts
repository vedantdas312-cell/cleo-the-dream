import {createHash} from 'node:crypto';
import {DocumentError,readableDiff} from './docx.ts';
import {MatterContext} from './matter-context.ts';

type Request = (path:string,body?:unknown)=>Promise<any>;
export type DocEdit = {document_id:string;revision_id:string;paragraph_id:string;original:string;replacement:string;request_id:string};
type Segment = {text:string;index:number;deleted:boolean;inserted:boolean};
type Paragraph = {id:string;tab:string;start:number;end:number;text:string;segments:Segment[];editable:boolean};

export function editingSnapshot(doc:any) {
  const paragraphs:Paragraph[]=[];
  function content(items:any[],tab:string) {
    for(const item of items??[]) {
      if(item.paragraph) {
        const elements=item.paragraph.elements??[];
        const segments=elements.filter((e:any)=>e.textRun).map((e:any)=>({text:e.textRun.content,index:e.startIndex,
          inserted:!!e.textRun.suggestedInsertionIds?.length,deleted:!!e.textRun.suggestedDeletionIds?.length}));
        const text=segments.filter((s:Segment)=>!s.deleted).map((s:Segment)=>s.text).join('');
        paragraphs.push({id:`${tab}:${item.startIndex}`,tab,start:item.startIndex,end:item.endIndex,text,segments,
          editable:elements.every((e:any)=>e.textRun && Number.isSafeInteger(e.startIndex))});
      }
      for(const row of item.table?.tableRows??[])for(const cell of row.tableCells??[])content(cell.content,tab);
    }
  }
  function tabs(items:any[]) {for(const tab of items??[]){content(tab.documentTab?.body?.content,tab.tabProperties.tabId);tabs(tab.childTabs);}}
  tabs(doc.tabs);
  const text=(reject=false)=>paragraphs.map(p=>p.segments.filter(s=>reject?!s.inserted:!s.deleted).map(s=>s.text).join('')).join('');
  return {paragraphs,accepted:text(),rejected:text(true)};
}

// Input offsets are UTF-16, as are Google Docs indexes. Deleted runs remain in
// the inline document but are never silently included in a selected quote.
export function editRequests(p:Paragraph, original:string,replacement:string) {
  const offset=p.text.indexOf(original);
  if(offset<0 || p.text.indexOf(original,offset+1)>=0)throw new DocumentError('Quote must match exactly once in the current paragraph. Read it again.');
  const visible:{from:number;to:number;index:number}[]=[];let pos=0;
  for(const s of p.segments)if(!s.deleted){visible.push({from:pos,to:pos+s.text.length,index:s.index});pos+=s.text.length;}
  const point=(at:number)=>{const s=visible.find(s=>s.from<=at&&at<s.to)??visible.at(-1);if(!s)throw new DocumentError('No text anchor.');return s.index+at-s.from;};
  const diff=readableDiff(original,replacement);if(!diff)throw new DocumentError('Use a smaller clause edit.');
  const groups:{start:number;end:number;replacement:string}[]=[];let cursor=offset,current:typeof groups[number]|undefined;
  const flush=()=>{if(current)groups.push(current);current=undefined;};
  for(const part of diff){if(!part.added&&!part.removed){flush();cursor+=part.value.length;}
    else {current??={start:cursor,end:cursor,replacement:''};if(part.removed){cursor+=part.value.length;current.end=cursor;}if(part.added)current.replacement+=part.value;}}
  flush();
  return groups.reverse().flatMap(g=>{
    const ranges=visible.filter(s=>g.end>g.start&&s.to>g.start&&s.from<g.end).map(s=>({startIndex:s.index+Math.max(g.start-s.from,0),endIndex:s.index+Math.min(g.end-s.from,s.to-s.from),tabId:p.tab}));
    const index=ranges.at(-1)?.endIndex??point(g.start);
    return [...(g.replacement?[{insertText:{location:{index,tabId:p.tab},text:g.replacement}}]:[]),
      ...ranges.reverse().map(range=>({deleteContentRange:{range}}))];
  });
}

export class GoogleEditing {
  private request:Request;
  private context:MatterContext;
  constructor(request:Request,context:MatterContext) {
    this.request=request;this.context=context;
    context.db.exec(`CREATE TABLE IF NOT EXISTS doc_edits(owner TEXT,doc TEXT,id TEXT,fingerprint TEXT,status TEXT,expected TEXT,rejected TEXT,result TEXT,PRIMARY KEY(owner,doc,id));`);
  }
  private require(owner:string,id:string) {
    if(typeof id!=='string'||!this.context.byDocument(owner,id))throw new DocumentError('Select a verified Google review copy belonging to this user.');
  }
  private async get(id:string){
    const doc=await this.request(`/${id}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`);
    if(doc.documentId!==id || !doc.revisionId || !doc.tabs?.length)throw new DocumentError('The selected document could not be verified.');
    return doc;
  }
  async read(owner:string,id:string,offset=0) {
    this.require(owner,id);
    if(!Number.isSafeInteger(offset)||offset<0)throw new DocumentError('Invalid document offset.');
    const doc=await this.get(id),snapshot=editingSnapshot(doc);
    let size=0;const page=[];
    for(const p of snapshot.paragraphs.slice(offset,offset+30)) {
      if(p.text.length>16000)throw new DocumentError('This paragraph is too large for a bounded edit.');
      if(size+p.text.length>16000)break;size+=p.text.length;
      page.push({paragraph_id:p.id,text:p.text.replace(/\n$/,''),editable:p.editable,pending_suggestions:p.segments.some(s=>s.inserted||s.deleted)});
    }
    return {status:'read',document_id:id,revision_id:doc.revisionId,title:doc.title,paragraphs:page,
      next_offset:offset+page.length<snapshot.paragraphs.length?offset+page.length:null,
      instruction:'Current proposed wording with pending deletions excluded. Use this exact paragraph ID, revision and quote for a requested tracked suggestion. Reading does not change the document.'};
  }
  async suggest(owner:string,input:DocEdit) {
    this.require(owner,input.document_id);
    for(const field of ['revision_id','paragraph_id','original','replacement','request_id'] as const)
      if(typeof input[field]!=='string'||input[field].length>12000)throw new DocumentError('Provide bounded edit fields from the latest document read.');
    if(!/^[\w:.-]{1,180}$/.test(input.request_id)||!input.original.trim()||input.original===input.replacement
      ||/[\u0000-\u0009\u000b-\u001f\ufffe\uffff]/u.test(input.original+input.replacement)
      ||!input.original.isWellFormed()||!input.replacement.isWellFormed())throw new DocumentError('Provide a distinct exact quote and valid proposed wording.');
    const {document_id:id,request_id:key}=input;
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous=this.context.db.prepare('SELECT * FROM doc_edits WHERE owner=? AND doc=? AND id=?').get(owner,id,key);
    if(previous) {
      if(previous.fingerprint!==fingerprint)throw new DocumentError('This request ID identifies a different proposed edit.');
      const current=editingSnapshot(await this.get(id));
      if(previous.status==='verified')return current.accepted===previous.expected&&current.rejected===previous.rejected
        ? {...JSON.parse(String(previous.result)),replayed:true}
        : {status:'previously_verified_document_changed',instruction:'This request was verified earlier, but the document has since changed. Read current wording; do not repeat the old edit or claim its old wording is still current.'};
      if(current.accepted===previous.expected&&current.rejected===previous.rejected) {
        const result={status:'verified_suggestion',document_id:id,url:`https://docs.google.com/document/d/${id}/edit`,reconciled:true};
        this.finish(owner,id,key,result);return result;
      }
      return {status:'needs_inspection',instruction:'The earlier write has an uncertain outcome. Do not repeat it or claim it completed.'};
    }
    if(this.context.db.prepare("SELECT 1 FROM doc_edits WHERE owner=? AND doc=? AND status!='verified' LIMIT 1").get(owner,id))
      return {status:'needs_inspection',instruction:'Resolve the earlier uncertain edit before making another change to this document.'};
    const doc=await this.get(id);
    if(doc.revisionId!==input.revision_id)return {status:'stale_revision',instruction:'The document changed. Read it again and reconcile the requested wording; no edit was sent.'};
    const before=editingSnapshot(doc),p=before.paragraphs.find(p=>p.id===input.paragraph_id);
    if(!p?.editable)throw new DocumentError('Choose a current editable paragraph.');
    const requests=editRequests(p,input.original,input.replacement);
    const expected=before.paragraphs.map(other=>other===p?p.text.replace(input.original,()=>input.replacement):other.text).join('');
    const claimed=this.context.db.prepare("INSERT INTO doc_edits VALUES(?,?,?,?,'started',?,?,NULL) ON CONFLICT DO NOTHING")
      .run(owner,id,key,fingerprint,expected,before.rejected).changes;
    if(!claimed)return {status:'needs_inspection',instruction:'This request is already in progress; do not duplicate it.'};
    try {
      const receipt=await this.request(`/${id}:batchUpdate`,{writeControl:{writeMode:'SUGGEST',requiredRevisionId:doc.revisionId},requests});
      if(receipt.commentUpdateState==='ALL_FAILED_UNKNOWN_REASON')throw Error('Suggestion persistence unconfirmed.');
      const after=editingSnapshot(await this.get(id));
      if(after.accepted!==expected||after.rejected!==before.rejected)throw Error('Suggestion readback mismatch.');
      const result={status:'verified_suggestion',document_id:id,url:`https://docs.google.com/document/d/${id}/edit`,
        original:input.original,replacement:input.replacement,instruction:'The tracked suggestion exists in this same Google Doc and its proposed wording was read back. It has not been accepted or sent elsewhere.'};
      this.finish(owner,id,key,result);return result;
    } catch {
      return {status:'needs_inspection',document_id:id,instruction:'A write may have happened, but its exact result is not verified. Do not say it is done, retry it blindly or send another edit.'};
    }
  }
  private finish(owner:string,doc:string,id:string,result:unknown) {
    this.context.db.prepare("UPDATE doc_edits SET status='verified',result=? WHERE owner=? AND doc=? AND id=?").run(JSON.stringify(result),owner,doc,id);
  }
}
