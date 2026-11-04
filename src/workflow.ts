import { createHmac, timingSafeEqual } from 'node:crypto';
import { DocumentError, inspectDocx, MAX_FILE_BYTES, redlineDocx, sha256, type Replacement } from './docx.ts';
import type { Store, Source } from './store.ts';
import { importDocument, SUPPORTED_EXTENSIONS } from './import-document.ts';
import { extname } from 'node:path';
import { createDraftDocx, validateDraft } from './draft-docx.ts';
import { createReviewPdf } from './review-pdf.ts';
import { MatterContext, type ContextEvent } from './matter-context.ts';
import type { GoogleRedline } from './google-redline.ts';
import { GoogleEditing, type DocEdit } from './google-editing.ts';
import { type PublicDocument, type MeetingSessions, type OwnerMeetingEvent } from './meeting-session.ts';
import { preparePresentation, publicPresentationMetadata, reusablePresentation, verifiedGooglePresentation, type PreparedPresentation } from './meeting-presentation-model.ts';
import { verifiedKeikiSender, type KeikiIdentity } from './keiki-sender.ts';

export type ToolAttachment = { filename?: string | null; url?: string; sha256?: string; mime_type?: string };
const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/html': '.html', 'text/plain': '.txt', 'text/markdown': '.md',
};
export function attachmentFilename(file: ToolAttachment) {
  const filename = typeof file.filename === 'string' ? file.filename.trim() : '';
  const extension = extname(filename).toLowerCase();
  if (SUPPORTED_EXTENSIONS.includes(extension)) return filename;
  // Keiki explicitly allows a null filename. A declared MIME type can select a parser;
  // that parser still validates the actual bytes, and the download origin stays restricted.
  const mime = typeof file.mime_type === 'string' ? file.mime_type.split(';')[0].trim().toLowerCase() : '';
  const inferred = Object.hasOwn(MIME_EXTENSIONS, mime) ? MIME_EXTENSIONS[mime] : undefined;
  if (!extension && inferred) return (filename || 'attachment') + inferred;
  throw new DocumentError('The attachment format could not be identified. Supported files: DOCX, DOC, PDF, HTML, HTM, PPTX, PPT, TXT and MD.');
}
export type ToolRequest = {
  input: { draft_id?:string;meeting_url?: string; output_id?: string; session_id?: string; attachment_id?: string; source_id?: string; source_sha256?: string; offset?: number; changes?: Replacement[]; query?: string; skill_id?: string; draft?: unknown; events?: ContextEvent[]; before?: number; document_id?: string; request_id?: string;revision_id?:string;paragraph_id?:string;original?:string;replacement?:string };
  context: { phone?: string; agentId?: string; channel?: string | { channel?: string; isDirect?: boolean; provider?: string; teamId?: string; gateway?: string; userId?: string; messageId?: string; inboundText?: string }; internal?: boolean; attachments?: Record<string, ToolAttachment> };
};
export type Config = { webhookKey: string; downloadSecret: string; publicUrl: string; keikiIdentity?: KeikiIdentity; attachmentOrigins: string[]; localOnly?: boolean; desktopToken?: string; desktopSender?: string };
export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Workflow {
  store: Store; config: Config; fetch: typeof fetch; matter?: MatterContext; google?: GoogleRedline; editing?:GoogleEditing; meetings?:MeetingSessions;
  constructor(store: Store, config: Config, fetchImpl = fetch, matter?: MatterContext, google?: GoogleRedline) {
    if (config.webhookKey.length < 24 || config.downloadSecret.length < 32 || !config.attachmentOrigins.length) throw new Error('Configure webhook authentication, download secret and attachment origins before starting.');
    if (!config.localOnly && (!config.keikiIdentity?.agentId || !config.keikiIdentity.line)) throw new Error('Configure the Keiki agent and verified messaging line before starting.');
    const base = new URL(config.publicUrl);
    const loopback = config.localOnly === true && base.protocol === 'http:' && base.hostname === '127.0.0.1';
    if ((!loopback && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTPS origin.');
    for (const origin of config.attachmentOrigins) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Attachment origins must be exact HTTPS origins.');
    }
    if (config.desktopToken && (config.desktopToken.length < 32 || !config.desktopSender)) throw new Error('Desktop pairing requires a strong separate token and an explicit paired sender.');
    this.matter=matter; this.google=google;
    if(matter&&google&&typeof google.request==='function')this.editing=new GoogleEditing(google.request.bind(google),matter);
    this.store = store; this.config = config; this.fetch = fetchImpl;
  }
  private presentations = new Map<string,PreparedPresentation>();
  ownerForSender(phone: string) {
    if (typeof phone !== 'string' || !phone.trim() || phone.length > 200) throw new DocumentError('Invalid sender identity.');
    // Preserve existing owners and their documents across the open-access migration.
    return createHmac('sha256', this.config.downloadSecret).update(phone).digest('hex');
  }
  owner(request: ToolRequest) {
    if (this.config.keikiIdentity) return this.ownerForSender(verifiedKeikiSender(request,this.config.keikiIdentity));
    // Legacy synthetic context is allowed only in explicitly local development.
    const context = request?.context;
    // Keiki's current ChannelEnvelope nests its channel name; older webhooks used a string.
    const envelope = context?.channel;
    const channel = typeof envelope === 'string' ? envelope : envelope?.channel;
    if (context?.internal || !['imessage', 'sms'].includes(channel ?? '') || (typeof envelope === 'object' && envelope?.isDirect === false)
      || typeof context?.phone !== 'string' || !context.phone.trim()) throw new DocumentError('This tool is restricted to direct iMessage conversations.');
    return this.ownerForSender(context.phone);
  }
  async registerSender(request: ToolRequest) {
    const owner = this.owner(request);
    if (this.config.keikiIdentity) await this.store.saveSender({owner,phone:request.context.phone!,...this.config.keikiIdentity});
    return owner;
  }
  async meetingPresentation(owner:string,sourceId:string,outputId?:string):Promise<PreparedPresentation> {
    const source=await this.store.getSource(sourceId,owner);
    if(!source||source.owner!==owner||source.id!==sourceId)throw new DocumentError('Contract not found for this meeting owner.');
    const selected=await this.meetingOutputId(owner,sourceId,outputId);
    const output=selected?await this.store.getOutput(selected,owner):undefined;
    if(selected&&(!output||output.id!==selected))throw new DocumentError('Saved review not found for this owner and contract.');
    const key=JSON.stringify([owner,sourceId,selected??null]);
    const previous=this.matter?.presentation(owner,sourceId,selected)??this.presentations.get(key);
    if(reusablePresentation(previous,source,output))return structuredClone(previous);
    const prepared=await preparePresentation(source,output);
    this.matter?.savePresentation(prepared);this.presentations.set(key,prepared);
    return structuredClone(prepared);
  }
  async meetingDocument(owner: string, sourceId: string, outputId?: string): Promise<PublicDocument> {
    return (await this.meetingPresentation(owner,sourceId,outputId)).document;
  }
  async meetingSelection(owner:string,input:{source_id?:string;output_id?:string;draft_id?:string}) {
    if([input.source_id,input.draft_id].filter(v=>v!==undefined).length!==1)throw new DocumentError('Choose exactly one saved source or generated draft.');
    if(input.output_id!==undefined&&!input.source_id)throw new DocumentError('A review ID requires its saved source.');
    let sourceId=input.source_id,outputId=input.output_id;const draftId=input.draft_id;
    let document:PublicDocument;
    if(draftId){
      const draft=await this.store.getDraft(draftId,owner);
      if(!draft||draft.id!==draftId||draft.owner!==owner||sha256(draft.bytes)!==draft.outputSha256)throw new DocumentError('Saved draft not found for this meeting owner.');
      // Common source storage supports the existing private context and meeting controls.
      await this.store.saveSource({id:draft.id,owner,bytes:draft.bytes,filename:draft.filename});
      this.matter?.register(owner,draft.id,draft.input.title);
      sourceId=draft.id;
      const inspected=(await inspectDocx(draft.bytes)).paragraphs;
      document={title:'Draft for review · saved copy',paragraphs:inspected.map(p=>({id:p.id,text:p.text})),redlines:[],
        sections:inspected.filter(p=>p.text.trim()&&!/^(Title|DraftLabel|Heading[1-6])$/i.test(p.style)).map((p,i)=>({id:`s${i+1}`,paragraphId:p.id}))};
    }else{
      if(!sourceId)throw new DocumentError('Choose a saved document.');
      outputId=await this.meetingOutputId(owner,sourceId,outputId);
      document=await this.meetingDocument(owner,sourceId,outputId);
    }
    // Keep the actual editor out of the public view. The saved copy is frozen at join.
    return {sourceId:sourceId!,outputId,document};
  }
  async meetingOutputId(owner:string,sourceId:string,outputId?:string) {
    if(outputId!==undefined)return outputId;
    const ids=this.store.listOutputIds?await this.store.listOutputIds(owner,sourceId):
      [...new Set([...this.presentations.values()].filter(p=>p.owner===owner&&p.sourceId===sourceId&&p.outputId).map(p=>p.outputId!))];
    // Older stores without a list operation can still migrate their previously verified export.
    if(!this.store.listOutputIds){const known=this.matter?.meetingReview(owner,sourceId);if(known&&!ids.includes(known))ids.push(known);}
    if(ids.length>1)throw new DocumentError('This contract has multiple saved reviews. Choose the review to bring to the meeting.');
    return ids[0];
  }
  async meetingControl(owner: string, sourceId: string, sessionId: string, event: OwnerMeetingEvent, interpreted?:import('./meeting-session.ts').MeetingCommand) {
    if (!this.meetings) return {status:'not_configured'};
    if (event.owner!==owner || !await this.store.getSource(sourceId,owner)) throw new DocumentError('Meeting owner and contract do not match.');
    const result=this.meetings.control({owner,sourceId,sessionId},event,interpreted);
    if (result.status==='applied' && this.matter) {
      const source=await this.store.getSource(sourceId,owner);
      this.matter.register(owner,sourceId,source!.filename);
      this.matter.append(owner,sourceId,{id:`meeting:${sha256(JSON.stringify([sessionId,event.id]))}`,text:event.text,role:'user',channel:'imessage',at:event.at});
      // The durable local event is authoritative. Private memory failure must not undo stop/revocation.
      void this.matter.sync(owner,sourceId).catch(()=>{});
    }
    return result;
  }
  async meetingGoogleDocument(owner:string,sourceId:string,outputId?:string) {
    if(!outputId||!this.google||!this.matter)return undefined;
    const exported=this.matter.exportState(owner,sourceId,outputId);
    if(exported?.status!=='verified'||typeof exported.doc!=='string')return undefined;
    const presentation=await this.meetingPresentation(owner,sourceId,outputId);
    return await verifiedGooglePresentation(this.google,exported.doc,presentation.document)?exported.doc:undefined;
  }
  async read(request: ToolRequest) {
    const owner = this.owner(request);
    const input = request.input;
    if (!input || typeof input.attachment_id !== 'string') throw new DocumentError('Choose a current conversation attachment.');
    const attachments = request.context.attachments;
    const file = attachments && Object.hasOwn(attachments, input.attachment_id) ? attachments[input.attachment_id] : undefined;
    if (!file || typeof file !== 'object') throw new DocumentError('Keiki did not supply the selected attachment to the document reader. Use the attachment ID from this conversation; if it is unavailable, ask the user to reattach the file. This is not a PDF conversion failure.');
    if (typeof file.url !== 'string' || !file.url.trim()) throw new DocumentError('Keiki supplied no download link for this attachment. Ask the user to reattach the file.');
    const filename = attachmentFilename(file);
    let url: URL;
    try { url = new URL(file.url); } catch { throw new DocumentError('The attachment download link is invalid. Ask the user to reattach the file.'); }
    if (url.protocol !== 'https:' || url.username || url.password || !this.config.attachmentOrigins.includes(url.origin)) throw new DocumentError('Attachment storage origin is not configured.');
    const response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw new DocumentError('Attachment download failed; resend the file if its link expired.');
    const chunks: Uint8Array[] = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_FILE_BYTES) throw new DocumentError('Documents must be at most 10 MB.');
      chunks.push(chunk);
    }
    const originalBytes = Buffer.concat(chunks), originalSha256 = sha256(originalBytes);
    if (file.sha256 && file.sha256 !== originalSha256) throw new DocumentError('Attachment checksum mismatch.');
    const id = extname(filename).toLowerCase() === '.docx' ? originalSha256 : sha256(JSON.stringify(['text-import-v3', extname(filename).toLowerCase(), originalSha256]));
    let source = await this.store.getSource(id, owner);
    if (!source) {
      const imported = await importDocument(originalBytes, filename);
      await this.store.saveSource({ id, owner, bytes: imported.bytes, filename, originalBytes: imported.metadata.converted ? originalBytes : undefined, metadata: imported.metadata });
      source = await this.store.getSource(id, owner);
    }
    if (!source) throw new Error('Source persistence verification failed.');
    this.matter?.register(owner, source.id, source.filename);
    return this.sourcePage(source, input.offset);
  }
  async pageSource(request: ToolRequest) {
    const owner = this.owner(request);
    if (!request.input || typeof request.input.source_id !== 'string') throw new DocumentError('Provide the source_id returned by read_contract.');
    const source = await this.store.getSource(request.input.source_id ?? '', owner);
    if (!source) throw new DocumentError('Source not found in this conversation owner’s records.');
    return this.sourcePage(source, request.input.offset);
  }
  async sourcePage(source: Source, offset = 0) {
    const inspected = await inspectDocx(source.bytes);
    if (source.metadata?.converted) {
      inspected.coverage.scope = source.metadata.warnings.join(' ');
      inspected.paragraphs.slice(0, 3).forEach(p => { p.editable = false; });
    }
    return { ...this.page(source.id, inspected, offset), import: source.metadata ?? { format: 'docx', converted: false } };
  }
  page(id: string, inspected: Awaited<ReturnType<typeof inspectDocx>>, offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || offset > inspected.paragraphs.length) throw new DocumentError('Invalid paragraph offset.');
    const paragraphs = []; let count = 0, cursor = offset;
    while (cursor < inspected.paragraphs.length && paragraphs.length < 40) {
      const p = inspected.paragraphs[cursor];
      if (p.text.length > 16_000) throw new DocumentError('A paragraph is too long for this first slice.');
      if (count + p.text.length > 16_000) break;
      paragraphs.push(p); count += p.text.length; cursor++;
    }
    return { source_id: id, source_sha256: inspected.sourceSha256, coverage: inspected.coverage, paragraphs, total_paragraphs: inspected.paragraphs.length, next_offset: cursor < inspected.paragraphs.length ? cursor : null };
  }
  async revise(request: ToolRequest) {
    const owner = this.owner(request), input = request.input;
    if (!input || typeof input.source_id !== 'string') throw new DocumentError('Provide the source_id returned by read_contract.');
    const source = await this.store.getSource(input.source_id ?? '', owner);
    if (!source) throw new DocumentError('Source not found in this conversation owner’s records.');
    if (source.metadata?.converted && input.changes?.some(c => /^p[0-2]$/.test(c.paragraphId))) throw new DocumentError('Keep the conversion disclosure intact.');
    const plan = { sourceSha256: input.source_sha256 ?? '', changes: input.changes ?? [] };
    const id = sha256(JSON.stringify(['precise-redline-v4', source.id, plan]));
    let output = await this.store.getOutput(id, owner);
    if (!output) {
      const result = await redlineDocx(source.bytes, plan);
      const previewBytes = await createReviewPdf(result.bytes);
      await this.store.saveOutput({ id, owner, sourceId: source.id, filename: source.metadata?.converted ? 'Cleo-converted-redline.docx' : 'Cleo-redlined.docx', bytes: result.bytes, plan, outputSha256: result.outputSha256, previewBytes, previewSha256: sha256(previewBytes) });
      output = await this.store.getOutput(id, owner);
    }
    if (!output || sha256(output.bytes) !== output.outputSha256) throw new Error('Output persistence verification failed.');
    if (!output.previewBytes || sha256(output.previewBytes) !== output.previewSha256) throw new Error('Preview persistence verification failed.');
    this.matter?.register(owner, source.id, source.filename);
    // Preparation is local and automatic; it never publishes a copy or changes Drive access.
    // Its smaller public-view limits must not block delivery of an already verified Word/PDF review.
    let meeting_presentation:ReturnType<typeof publicPresentationMetadata>|{status:'unavailable';reason:'preparation_unavailable'};
    try { meeting_presentation=publicPresentationMetadata(await this.meetingPresentation(owner,source.id,id)); }
    catch { meeting_presentation={status:'unavailable',reason:'preparation_unavailable'}; }
    // Preserve the review tool's existing Google deliverable. Meeting preparation/join never invokes this export.
    let google_doc: Record<string, unknown> = { status: 'not_configured' };
    if (this.google) {
      try { google_doc = await this.google.publish(owner, source.id, id, source.bytes, plan); }
      catch { google_doc = { status: 'unavailable' }; }
    }
    const expires = Math.floor(Date.now() / 1000) + 900;
    const signature = this.sign(id, owner, expires);
    return { output_id: output.id, google_doc, meeting_presentation, status: 'verified_tracked_changes', verification_scope:'accepted_and_rejected_text_integrity', visual_review:'not_performed', professional_quality:'not_verified', import: source.metadata ?? { format: 'docx', converted: false }, filename: output.filename, output_sha256: output.outputSha256, change_count: output.plan.changes.length, comment_count: output.plan.changes.length,
      download_url: `${this.config.publicUrl.replace(/\/$/, '')}/files/${id}?owner=${owner}&expires=${expires}&signature=${signature}`,
      preview_filename: 'Cleo-redline-review.pdf', preview_sha256: output.previewSha256,
      preview_download_url: `${this.config.publicUrl.replace(/\/$/, '')}/previews/${id}?owner=${owner}&expires=${expires}&signature=${this.sign('preview:' + id, owner, expires)}`,
      delivery_status: 'not_sent', instruction: 'If google_doc.status is verified_suggestions and sharing is anyone_with_link_viewer, return its exact URL as a text-only Google Doc review copy. Restricted copies are not accessible to the recipient: deliver Word/PDF attachments and use the saved meeting view instead. Never invent a Google link or claim access. If meeting_presentation.status is unavailable, report that the meeting view is not ready; the saved review files remain available. Return BOTH files to this same conversation: Word for accepting/rejecting edits and comments; PDF for visibly marked text review on a phone. Use Keiki download_url to fetch each exact signed URL into its own relative sandbox file, then send_file to attach each original file to this conversation. These URLs are internal transfer inputs: do not paste them as the deliverable unless the user explicitly asks for links. Check the two send results separately; report failures or uncertain sends accurately and never blindly resend a successful attachment. Do not infer current upload support from an old failure. The PDF is a text comparison, not a format-preserving copy.' };
  }
  async desktopContext(action: string, input: ToolRequest['input']) {
    const sender = this.config.desktopSender;
    if (!sender || !this.config.desktopToken || !this.matter) throw new DocumentError('Desktop context is not configured.');
    const owner = this.ownerForSender(sender);
    if(action==='read_document'||action==='suggest_document') {
      if(!this.editing)return {status:'not_configured',instruction:'Live Google Doc editing is not connected to this backend.'};
      return action==='read_document'?this.editing.read(owner,input.document_id??'',input.offset??0):this.editing.suggest(owner,input as DocEdit);
    }
    if (action === 'list') return this.matter.list(owner);
    if (action === 'resolve') {
      if (typeof input?.document_id !== 'string' || !/^[\w-]{1,200}$/.test(input.document_id)) throw new DocumentError('Provide a Google document ID.');
      return {source_id:this.matter.byDocument(owner,input.document_id) ?? null};
    }
    if (typeof input?.source_id !== 'string' || !await this.store.getSource(input.source_id,owner)) throw new DocumentError('Contract not found for the paired user.');
    if (action === 'remember') {
      if (!Array.isArray(input.events) || input.events.length !== 1 || input.events[0]?.role !== 'user' || input.events[0]?.channel !== 'screen') throw new DocumentError('Provide one user speech transcript.');
      this.matter.append(owner,input.source_id,input.events[0]);
      return {saved:true,sync_status:await this.matter.sync(owner,input.source_id)};
    }
    return this.matter.recall(owner,input.source_id,input.query,input.before);
  }
  async contractContext(request: ToolRequest, write = false) {
    const owner = this.owner(request), input = request.input;
    if (!this.matter) throw new DocumentError('Shared contract context is not configured.');
    if (typeof input?.source_id !== 'string') throw new DocumentError('Choose an imported source_id.');
    const source = await this.store.getSource(input.source_id, owner);
    if (!source) throw new DocumentError('Contract not found for this user.');
    this.matter.register(owner,source.id,source.filename);
    if (write) {
      if (!Array.isArray(input.events) || !input.events.length || input.events.length > 10) throw new DocumentError('Provide 1–10 conversation events.');
      for (const e of input.events) {
        if (e.channel !== 'imessage') throw new DocumentError('This route records iMessage context only.');
        this.matter.append(owner,source.id,e);
      }
    }
    const sync_status = write ? await this.matter.sync(owner,source.id) : undefined;
    return { ...await this.matter.recall(owner,source.id,input.query,input.before), sync_status };
  }
  sign(id: string, owner: string, expires: number) { return createHmac('sha256', this.config.downloadSecret).update(JSON.stringify([id, owner, expires])).digest('hex'); }
  async draft(request: ToolRequest) {
    const owner = this.owner(request), input = validateDraft(request.input?.draft);
    const id = sha256(JSON.stringify(['draft-v1', input]));
    let output = await this.store.getDraft(id, owner);
    if (!output) {
      const result = await createDraftDocx(input);
      await this.store.saveDraft({ id, owner, input, bytes: result.bytes, filename: 'Cleo-draft.docx', outputSha256: result.outputSha256 });
      output = await this.store.getDraft(id, owner);
    }
    if (!output || sha256(output.bytes) !== output.outputSha256) throw new Error('Draft persistence verification failed.');
    const expires = Math.floor(Date.now() / 1000) + 900;
    return { status: 'generated_draft', draft_id:id,download_expires_in_seconds:900, filename: output.filename, output_sha256: output.outputSha256,
      download_url: `${this.config.publicUrl.replace(/\/$/, '')}/drafts/${id}?owner=${owner}&expires=${expires}&signature=${this.sign('draft:' + id, owner, expires)}`,
      checks: { text_roundtrip: true, persisted_checksum: true, legal_accuracy: 'not_verified', visual_layout: 'not_reviewed' },
      delivery_status: 'not_sent', instruction: 'Return download_url as the exact temporary download link for this new draft to the requesting conversation; it expires in 15 minutes. If the user requests an attachment, use Keiki download_url then send_file to attach these original bytes. Confirm an attachment only after send_file succeeds. This is a draft for review, not a redline, signed document or legal clearance. Keep draft_id in context: when the user asks to hop on a call or walk through this document, use it with join_meeting and their Google Meet invitation. If no Meet link is available, ask for the link, not a re-upload. The meeting shares this saved draft and pauses for questions after each passage. No Google Docs copy is needed.' };
  }
  async download(url: URL) {
    const id = url.pathname.split('/').at(-1) ?? '', owner = url.searchParams.get('owner') ?? '';
    const draft = url.pathname.startsWith('/drafts/');
    const preview = url.pathname.startsWith('/previews/');
    const expires = Number(url.searchParams.get('expires')), signature = url.searchParams.get('signature') ?? '';
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expires) || expires <= now || expires > now + 900 || !equalSecret(signature, this.sign(draft ? 'draft:' + id : preview ? 'preview:' + id : id, owner, expires))) throw new DocumentError('Download link is invalid or expired.');
    const output = draft ? await this.store.getDraft(id, owner) : await this.store.getOutput(id, owner);
    if (!output) throw new DocumentError('File not found.');
    if (preview) {
      const review = output as import('./store.ts').Output;
      if (!review.previewBytes || !review.previewSha256 || sha256(review.previewBytes) !== review.previewSha256) throw new Error('Saved preview checksum mismatch.');
      return { ...output, bytes: review.previewBytes, filename: 'Cleo-redline-review.pdf', outputSha256: review.previewSha256 };
    }
    if (sha256(output.bytes) !== output.outputSha256) throw new Error('Saved file checksum mismatch.');
    return output;
  }
}
