import { inspectDocx, readableDiff, type RedlinePlan } from './docx.ts';
import { MatterContext } from './matter-context.ts';

const API = 'https://docs.googleapis.com/v1/documents';
export type GooglePublishResult = {status: 'verified_suggestions'|'needs_inspection'; document_id?: string|null; url?: string; coverage?: string; sharing?: string};
export class GoogleRedline {
  token: () => Promise<string>; context: MatterContext; fetchImpl: typeof fetch;
  private allowPublicReview: (owner: string) => boolean;
  constructor(token: () => Promise<string>, context: MatterContext, fetchImpl: typeof fetch = fetch,
    allowPublicReview: (owner: string) => boolean = () => false) {
    this.token=token; this.context=context; this.fetchImpl=fetchImpl;
    this.allowPublicReview=allowPublicReview;
  }
  async request(path: string, body?: unknown) {
    const response = await this.fetchImpl(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Google Docs HTTP ${response.status}; write outcome must be checked before retrying.`);
    return response.json();
  }
  async publish(owner: string, source: string, planId: string, bytes: Buffer, plan: RedlinePlan): Promise<GooglePublishResult> {
    const previous = this.context.exportState(owner,source,planId);
    if (previous && previous.status !== 'verified') return { status: 'needs_inspection', document_id: previous.doc ? String(previous.doc) : null };
    const inspected = await inspectDocx(bytes);
    if (inspected.sourceSha256 !== plan.sourceSha256) throw new Error('Source changed before Docs export.');
    // Separate readable review copy. DOCX remains the layout-preserving artifact.
    const disclosure = inspected.paragraphs[2]?.text.startsWith('Converted text-only review copy.') ? ''
      : 'Cleo review copy — extracted main-body text. Original layout, tables, images, headers and signatures are not reproduced. Proposed changes require review.\n\n';
    const baseline = disclosure + inspected.paragraphs.map(p => p.text).join('\n');
    if (baseline.length > 300000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(baseline)) throw new Error('Unsupported Google Docs text baseline.');
    const edits: {start: number; original: string; replacement: string}[] = [];
    let index = 1 + disclosure.length;
    for (const p of inspected.paragraphs) {
      const change = plan.changes.find(c => c.paragraphId === p.id);
      if (change) {
        const offset = p.text.indexOf(change.original);
        if (offset < 0 || p.text.indexOf(change.original,offset+1) >= 0) throw new Error('Ambiguous export replacement.');
        const diff = readableDiff(change.original,change.replacement);
        if (!diff) throw new Error('Diff too complex.');
        let cursor = index + offset;
        let current: typeof edits[number] | undefined;
        const flush = () => { if (current) edits.push(current); current = undefined; };
        for (const part of diff) {
          if (!part.added && !part.removed) { flush(); cursor += part.value.length; }
          else {
            current ??= {start:cursor,original:'',replacement:''};
            if (part.removed) { current.original += part.value; cursor += part.value.length; }
            if (part.added) current.replacement += part.value;
          }
        }
        flush();
      }
      index += p.text.length + 1;
    }
    let expected = baseline + '\n';
    for (const e of [...edits].sort((a,b) => b.start-a.start)) expected = expected.slice(0,e.start-1)+e.replacement+expected.slice(e.start-1+e.original.length);
    if (previous?.status === 'verified') {
      try {
        const doc = await this.request(`/${String(previous.doc)}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`);
        const runs = doc.tabs?.[0]?.documentTab?.body?.content?.flatMap((p: any) => (p.paragraph?.elements??[]).map((e: any)=>e.textRun).filter(Boolean)) ?? [];
        if (doc.documentId !== previous.doc || runs.filter((r:any)=>!r.suggestedInsertionIds?.length).map((r:any)=>r.content).join('') !== baseline+'\n'
          || runs.filter((r:any)=>!r.suggestedDeletionIds?.length).map((r:any)=>r.content).join('') !== expected) throw new Error('Doc changed.');
        return this.sharedResult(String(previous.doc),owner);
      } catch { return {status:'needs_inspection',document_id:String(previous.doc)}; }
    }
    // Resolve OAuth before recording a possibly-started external operation.
    await this.token();
    if (!this.context.claimExport(owner,source,planId)) return { status: 'needs_inspection' };
    let docId = '';
    try {
      const created = await this.request('', {title:'Cleo — proposed contract redline'});
      if (!/^[\w-]+$/.test(created.documentId ?? '')) throw new Error('Missing document ID.');
      docId = created.documentId;
      this.context.exportProgress(owner,source,planId,'created',docId);
      const read = () => this.request(`/${docId}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`);
      let doc = await read();
      const tabId = doc.tabs?.[0]?.tabProperties?.tabId;
      if (!tabId || !doc.revisionId) throw new Error('Missing Google tab or revision.');
      await this.request(`/${docId}:batchUpdate`, { writeControl:{requiredRevisionId:doc.revisionId},
        requests:[{insertText:{location:{index:1,tabId},text:baseline}},
          ...googleBaselineStyles(inspected.paragraphs, disclosure.length, baseline.length, tabId)] });
      doc = await read();
      const runs = (d: any) => d.tabs.find((t: any)=>t.tabProperties?.tabId===tabId)?.documentTab?.body?.content
        ?.flatMap((p: any)=>(p.paragraph?.elements??[]).map((e: any)=>e.textRun).filter(Boolean)) ?? [];
      if (runs(doc).map((r: any)=>r.content).join('') !== baseline+'\n') throw new Error('Baseline readback mismatch.');
      const requests = [...edits].sort((a,b)=>b.start-a.start).flatMap(e=>[
        ...(e.replacement ? [{insertText:{location:{index:e.start+e.original.length,tabId},text:e.replacement}}] : []),
        ...(e.original ? [{deleteContentRange:{range:{startIndex:e.start,endIndex:e.start+e.original.length,tabId}}}] : []),
      ]);
      const receipt = await this.request(`/${docId}:batchUpdate`, {writeControl:{writeMode:'SUGGEST',requiredRevisionId:doc.revisionId},requests});
      if (receipt.commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON') throw new Error('Google reported failed suggestion/comment updates.');
      const ids = (receipt.suggestionResponses??[]).flatMap((r: any)=>r.createdSuggestionIds??[]);
      const after = runs(await read());
      const rejected = after.filter((r: any)=>!r.suggestedInsertionIds?.length).map((r: any)=>r.content).join('');
      const accepted = after.filter((r: any)=>!r.suggestedDeletionIds?.length).map((r: any)=>r.content).join('');
      const marked = after.filter((r: any)=>r.suggestedInsertionIds?.length||r.suggestedDeletionIds?.length);
      if (!ids.length || !marked.length || rejected !== baseline+'\n' || accepted !== expected
        || marked.some((r: any)=>[...(r.suggestedInsertionIds??[]),...(r.suggestedDeletionIds??[])].some((id: string)=>!ids.includes(id)))) throw new Error('Suggestions failed readback.');
      this.context.exportProgress(owner,source,planId,'verified',docId);
      return this.sharedResult(docId,owner);
    } catch {
      this.context.exportProgress(owner,source,planId,'needs_inspection',docId);
      return {status:'needs_inspection',document_id:docId||null};
    }
  }
  async sharedResult(id: string, owner: string): Promise<GooglePublishResult> {
    // Only verified, generated review copies reach this point. The user requested
    // anyone-with-link viewing; originals and private conversation are untouched.
    const endpoint = `https://www.googleapis.com/drive/v3/files/${id}/permissions`;
    const request = async (body?: unknown) => {
      const response = await this.fetchImpl(endpoint+(body ? '?fields=id,type,role,allowFileDiscovery' : '?fields=permissions(id,type,role,allowFileDiscovery),nextPageToken&pageSize=100'), {
        method:body ? 'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{Authorization:`Bearer ${await this.token()}`,'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
      if (!response.ok) throw new Error('Sharing not verified.');
      return response.json();
    };
    if (!this.allowPublicReview(owner)) {
      // Never assume that a previously generated copy or an account's default
      // permissions are private, and never widen permissions for a new user.
      try {
        const acl=await request();
        const restricted=!acl.nextPageToken&&Array.isArray(acl.permissions)&&acl.permissions.every((p:any)=>p.type==='user'&&p.role==='owner');
        return {...this.result(id),sharing:restricted?'restricted':'not_verified'};
      } catch {return {...this.result(id),sharing:'not_verified'};}
    }
    try {
      const before = await request();
      const anyone = before.permissions?.find((p:any)=>p.type==='anyone');
      if (!anyone) await request({type:'anyone',role:'reader',allowFileDiscovery:false});
      const after = await request();
      if (!after.permissions?.some((p:any)=>p.type==='anyone' && p.role==='reader' && p.allowFileDiscovery===false)) throw new Error('Unexpected sharing permissions.');
      return {...this.result(id),sharing:'anyone_with_link_viewer'};
    } catch { return {...this.result(id),sharing:'not_verified'}; }
  }
  result(id: string): GooglePublishResult { return {status:'verified_suggestions',document_id:id,url:`https://docs.google.com/document/d/${id}/edit`,
    coverage:'Separate extracted-text review copy with headings and clause spacing; original layout not preserved. Word contains the full explanatory comments. Text integrity checked; professional quality still requires review.',sharing:'not_verified'}; }
  async presentationAllowed(id:string) {
    if(!/^[\w-]{10,200}$/.test(id))return false;
    try {
      const response=await this.fetchImpl(`https://www.googleapis.com/drive/v3/files/${id}/comments?fields=comments(id),nextPageToken&pageSize=1&includeDeleted=false`,
        {redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${await this.token()}`}});
      if(!response.ok)return false;const result=await response.json();
      // Comments may contain private rationale. Only the comment-free generated
      // review copy can be opened on the public presentation browser.
      return Array.isArray(result.comments)&&result.comments.length===0&&!result.nextPageToken;
    }catch{return false;}
  }
}

export function googleBaselineStyles(paragraphs: {text:string;style:string}[], prefix: number, length: number, tabId: string) {
  const range = {startIndex:1,endIndex:length+1,tabId};
  const requests: any[] = [
    {updateTextStyle:{range,textStyle:{weightedFontFamily:{fontFamily:'Times New Roman'},fontSize:{magnitude:11,unit:'PT'}},fields:'weightedFontFamily,fontSize'}},
    {updateParagraphStyle:{range,paragraphStyle:{spaceAbove:{magnitude:0,unit:'PT'},spaceBelow:{magnitude:6,unit:'PT'},lineSpacing:115},fields:'spaceAbove,spaceBelow,lineSpacing'}},
  ];
  let index=prefix+1;
  for(const paragraph of paragraphs) {
    const range={startIndex:index,endIndex:index+paragraph.text.length,tabId};
    const heading=/^Heading[1-6]$/i.test(paragraph.style);
    const title=paragraph.style==='Title';
    if(paragraph.text.length && (heading || title)) {
      requests.push({updateParagraphStyle:{range,paragraphStyle:{namedStyleType:title?'TITLE':'HEADING_2',keepWithNext:true},fields:'namedStyleType,keepWithNext'}});
      requests.push({updateTextStyle:{range,textStyle:{fontSize:{magnitude:title?18:13,unit:'PT'}},fields:'fontSize'}});
    }
    index+=paragraph.text.length+1;
  }
  return requests;
}
