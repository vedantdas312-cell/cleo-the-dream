import { newContextEvent } from './matter-context.ts';
export class VoiceContext {
  constructor(context, owner) { this.context=context; this.owner=owner; this.source=null; this.document=null; this.pending=[]; }
  list() { return this.context.list(this.owner); }
  async open(source, query='') {
    this.document=null;
    const result = await this.context.recall(this.owner,source,query);
    this.source=source;
    // Unbound speech is deliberately not assigned to a contract retroactively.
    return result;
  }
  async fromScreen(snapshot) {
    // Produced by the native accessibility reader for the actual browser window,
    // never extracted from OCR, model arguments, contract text or page links.
    if (snapshot?.browserDocument?.kind === 'native_browser_document') {
      try { return await this.openGoogleDoc(snapshot.browserDocument.url); }
      catch { this.source=null;this.document=null; return {status:'unavailable',instruction:'Could not resolve the visible document. Do not use the previous contract context.'}; }
    }
    // OCR can contain a quoted URL or malicious link inside a contract. It is not
    // authenticated browser-location metadata and must never silently bind a matter.
    if (this.source) return this.recall('');
    return {status:'not_bound',instruction:'Use list_contracts and confirm the contract with the user before open_contract_context, or resolve a Google Doc link the user explicitly identifies. Screen OCR is not proof of document identity.'};
  }
  async openGoogleDoc(url, query='') {
    this.source=null;this.document=null;
    const parsed=new URL(url);
    const match=parsed.pathname.match(/^\/document\/d\/([\w-]+)(?:\/|$)/);
    if(parsed.protocol!=='https:' || parsed.hostname!=='docs.google.com' || parsed.username || parsed.password || !match) return {error:'Use the exact Google Doc link you want to discuss.'};
    const source=await this.context.byDocument(this.owner,match[1]);
    if(!source) { this.source=null; return {error:'This Google Doc is not a verified export for the paired user.'}; }
    const result=await this.open(source,query);this.document=match[1];
    return {...result,document_id:this.document};
  }
  async readDocument(offset=0) {
    if(!this.document)return {status:'not_bound',instruction:'Identify the exact Google review copy first. A source contract alone does not select its output Doc.'};
    return this.context.readDocument?this.context.readDocument(this.document,offset):{status:'not_configured'};
  }
  async suggestDocument(input) {
    if(!this.document||input.document_id!==this.document)return {status:'not_bound',instruction:'This edit does not target the selected Google Doc. Read the current document first.'};
    return this.context.suggestDocument?this.context.suggestDocument(input):{status:'not_configured'};
  }
  async recall(query, before) {
    if (!this.source) return {error:'Select the same contract first.'};
    return this.context.recall(this.owner,this.source,query,before);
  }
  async remember(text, id) {
    if (!this.source) return;
    const source=this.source;
    const event=newContextEvent(text);
    if (id) event.id=id;
    await this.context.append(this.owner,source,event);
    // Persistence is immediate. Indexing never blocks speech or local recall.
    this.pending.push(this.context.sync(this.owner,source).catch(()=>{}));
    this.pending=this.pending.slice(-8);
  }
}
