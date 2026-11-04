import { DOMParser, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { boundedEntry, DocumentError, inspectDocx, redlineDocx, sha256 } from './docx.ts';
import { publicDocument, type PublicDocument } from './meeting-session.ts';
import type { Source, Output } from './store.ts';
import type { GoogleRedline } from './google-redline.ts';
import { editingSnapshot } from './google-editing.ts';

export const PRESENTATION_VERSION = 1;
export type PublicAnchor = {
  redlineId: string; number: number; paragraphId: string; paragraphSha256: string;
  start: number; end: number; before: string; after: string; previous: string; next: string;
};
// This record is private storage metadata. Only `document` is sent to participants.
export type PreparedPresentation = {
  version: 1; id: string; owner: string; sourceId: string; sourceSha256: string;
  outputId: string | null; outputSha256: string | null; planSha256: string | null;
  documentSha256: string; privacyReview: 'public-fields-only-v1';
  document: PublicDocument; anchors: PublicAnchor[];
};
export function publicPresentationMetadata(value:PreparedPresentation) {
  return {status:'ready' as const,id:value.id,version:value.version,
    mode:value.outputId?'saved_comparison' as const:'source_only' as const,
    source_sha256:value.sourceSha256,output_sha256:value.outputSha256,
    change_count:value.document.redlines.length};
}

export function presentationAnchors(document: PublicDocument): PublicAnchor[] {
  return document.redlines.map((r, index) => {
    const paragraphIndex = document.paragraphs.findIndex(p => p.id === r.paragraphId);
    const paragraph = document.paragraphs[paragraphIndex], start = paragraph.text.indexOf(r.original);
    return {redlineId:r.id,number:index+1,paragraphId:paragraph.id,paragraphSha256:sha256(paragraph.text),
      start,end:start+r.original.length,before:paragraph.text.slice(Math.max(0,start-160),start),
      after:paragraph.text.slice(start+r.original.length,start+r.original.length+160),
      previous:document.paragraphs[paragraphIndex-1]?.text.slice(-160)??'',next:document.paragraphs[paragraphIndex+1]?.text.slice(0,160)??''};
  });
}
async function revisionText(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes), file = zip.file('word/document.xml');
  if (!file) throw new DocumentError('Saved review has no document body.');
  const source = (await boundedEntry(file,10*1024*1024)).toString();
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new DocumentError('Invalid saved review XML.');
  const doc = new DOMParser({onError:()=>{throw new DocumentError('Invalid saved review XML.');}}).parseFromString(source,'application/xml');
  const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  function text(node:Element,accepted:boolean):string {
    if(node.namespaceURI===ns) {
      if(node.localName===(accepted?'del':'ins'))return '';
      if(node.localName==='t'||node.localName==='delText')return node.textContent??'';
      if(node.localName==='br')return '\n';
    }
    return Array.from(node.childNodes).filter(n=>n.nodeType===1).map(n=>text(n as Element,accepted)).join('');
  }
  const paragraphs=Array.from(doc.getElementsByTagNameNS(ns,'p'));
  return {accepted:paragraphs.map(p=>text(p,true)),rejected:paragraphs.map(p=>text(p,false))};
}
export async function preparePresentation(source: Source, output?: Output): Promise<PreparedPresentation> {
  const inspected=await inspectDocx(source.bytes);
  if(output&&(output.owner!==source.owner||output.sourceId!==source.id||output.plan.sourceSha256!==inspected.sourceSha256
    ||sha256(output.bytes)!==output.outputSha256))throw new DocumentError('Saved redline does not match this owner and contract.');
  if(output) {
    const regenerated=await redlineDocx(source.bytes,output.plan);
    const [expected,actual]=await Promise.all([revisionText(regenerated.bytes),revisionText(output.bytes)]);
    if(JSON.stringify(expected)!==JSON.stringify(actual))throw new DocumentError('Saved review wording does not match its recorded changes.');
  }
  const document=publicDocument({title:output?'Contract review':'Contract · source only',
    paragraphs:inspected.paragraphs.map(p=>({id:p.id,text:p.text})),
    redlines:output?.plan.changes.map((r,i)=>({id:`r${i+1}`,paragraphId:r.paragraphId,original:r.original,replacement:r.replacement}))??[]});
  const binding={version:PRESENTATION_VERSION as 1,owner:source.owner,sourceId:source.id,sourceSha256:inspected.sourceSha256,
    outputId:output?.id??null,outputSha256:output?.outputSha256??null,planSha256:output?sha256(JSON.stringify(output.plan)):null,
    documentSha256:sha256(JSON.stringify(document)),privacyReview:'public-fields-only-v1' as const};
  return {...binding,id:sha256(JSON.stringify(binding)),document,anchors:presentationAnchors(document)};
}
export function reusablePresentation(value:PreparedPresentation|undefined,source:Source,output?:Output):value is PreparedPresentation {
  if(!value||value.version!==PRESENTATION_VERSION||value.privacyReview!=='public-fields-only-v1'
    ||value.owner!==source.owner||value.sourceId!==source.id||value.sourceSha256!==sha256(source.bytes)
    ||value.outputId!==(output?.id??null)||value.outputSha256!==(output?.outputSha256??null)
    ||value.planSha256!==(output?sha256(JSON.stringify(output.plan)):null)
    ||(output&&(output.owner!==source.owner||output.sourceId!==source.id||sha256(output.bytes)!==output.outputSha256)))return false;
  try {
    // Reconstruct even cached content. Old records with extra/private fields are migrated, never emitted.
    const safe=publicDocument(value.document);
    const binding={version:value.version,owner:value.owner,sourceId:value.sourceId,sourceSha256:value.sourceSha256,
      outputId:value.outputId,outputSha256:value.outputSha256,planSha256:value.planSha256,
      documentSha256:value.documentSha256,privacyReview:value.privacyReview};
    return value.id===sha256(JSON.stringify(binding))&&JSON.stringify(safe)===JSON.stringify(value.document)&&sha256(JSON.stringify(safe))===value.documentSha256
      &&JSON.stringify(presentationAnchors(safe))===JSON.stringify(value.anchors);
  }catch{return false;}
}

// Read-only eligibility check. Never call publish/sharedResult or create Drive permissions here.
export async function verifiedGooglePresentation(google:GoogleRedline,id:string,document:PublicDocument):Promise<boolean> {
  if(!/^[\w-]{10,200}$/.test(id))return false;
  try {
    const token=await google.token();
    const permissions=await google.fetchImpl(`https://www.googleapis.com/drive/v3/files/${id}/permissions?fields=permissions(type,role,allowFileDiscovery),nextPageToken&pageSize=100`,
      {method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${token}`}});
    if(!permissions.ok)return false;
    const acl=await permissions.json();
    if(acl.nextPageToken||!Array.isArray(acl.permissions)||!acl.permissions.some((p:any)=>p.type==='anyone'&&p.role==='reader'&&p.allowFileDiscovery===false)
      ||acl.permissions.some((p:any)=>p.type==='anyone'&&p.role!=='reader'))return false;
    if(!await google.presentationAllowed(id))return false;
    const doc=await google.request(`/${id}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`);
    // Only the known generated copy, with its fixed public title and one text-only tab, is safe to screenshot.
    if(doc.documentId!==id||doc.title!=='Cleo — proposed contract redline'||doc.tabs?.length!==1||doc.tabs[0].childTabs?.length)return false;
    const tab=doc.tabs[0].documentTab;
    if(!tab?.body?.content||tab.headers&&Object.keys(tab.headers).length||tab.footers&&Object.keys(tab.footers).length
      ||tab.footnotes&&Object.keys(tab.footnotes).length||tab.inlineObjects&&Object.keys(tab.inlineObjects).length)return false;
    if(tab.body.content.some((p:any)=>!p.paragraph&&!p.sectionBreak||p.paragraph?.elements?.some((e:any)=>!e.textRun)))return false;
    const disclosure=document.paragraphs[2]?.text.startsWith('Converted text-only review copy.')?'':
      'Cleo review copy — extracted main-body text. Original layout, tables, images, headers and signatures are not reproduced. Proposed changes require review.\n\n';
    const rejected=disclosure+document.paragraphs.map(p=>p.text).join('\n')+'\n';
    const accepted=disclosure+document.paragraphs.map(p=>{
      const changes=document.redlines.filter(r=>r.paragraphId===p.id).sort((a,b)=>p.text.indexOf(b.original)-p.text.indexOf(a.original));
      let text=p.text;for(const r of changes){const at=p.text.indexOf(r.original);text=text.slice(0,at)+r.replacement+text.slice(at+r.original.length);}return text;
    }).join('\n')+'\n';
    const snapshot=editingSnapshot(doc);
    return snapshot.rejected===rejected&&snapshot.accepted===accepted;
  }catch{return false;}
}

export type PresentationLocation = {
  redlineId:string; paragraphId:string; paragraphSha256:string;
  original:string; replacement:string; before:string; after:string; previous:string; next:string;
  queries:string[];
};
// Transport supplies a saved ID, never an arbitrary model quote. The browser receives only public contract wording.
export function presentationLocation(document:PublicDocument,redlineId:string):PresentationLocation|undefined {
  const safe=publicDocument(document),r=safe.redlines.find(r=>r.id===redlineId);
  if(!r)return undefined;
  const anchor=presentationAnchors(safe).find(a=>a.redlineId===r.id)!;
  const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
  const candidates=[anchor.before+r.original+anchor.after,anchor.before+r.replacement+anchor.after,r.original,r.replacement]
    .map(normalize).filter(q=>q.length>0&&q.length<=600);
  // Bound search strings and verify any short quote against surrounding rendered context in the browser.
  return {redlineId:r.id,paragraphId:r.paragraphId,paragraphSha256:anchor.paragraphSha256,
    original:r.original,replacement:r.replacement,before:anchor.before,after:anchor.after,previous:anchor.previous,next:anchor.next,
    queries:[...new Set(candidates)].slice(0,4)};
}
