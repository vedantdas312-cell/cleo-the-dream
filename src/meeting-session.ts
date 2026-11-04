import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DocumentError } from './docx.ts';

export type MeetingBinding = { owner: string; sourceId: string; sessionId: string };
export type PublicDocument = {
  title: string;
  sections?: {id:string;paragraphId:string}[];
  paragraphs: { id: string; text: string }[];
  redlines: { id: string; paragraphId: string; original: string; replacement: string }[];
};
export type MeetingSession = MeetingBinding & {
  meetingUrl: string; providerBotId?: string; status: 'active' | 'ended';
  speak: boolean; share: boolean; revision: number; speechRevision: number; shareRevision: number; guidanceRevision: number; takeover: boolean; paused: boolean; createdAt: number; expiresAt: number;
  selectedRedlineId: string | null; selectedSectionId?:string|null; approvedRedlineIds: string[];
  googleDocumentId?: string;
};
export type OwnerMeetingEvent = { id: string; owner: string; text: string; at: string; channel: 'imessage'; isDirect: true };
export type MeetingLease = MeetingBinding & { capability: 'speak' | 'share'; revision: number; expiresAt: number };
export type MeetingScope = 'speech' | 'share' | 'guidance' | 'presentation' | 'end';
export type MeetingAction = 'greet' | 'propose' | 'takeover' | 'speak' | 'quiet' | 'share' | 'stop_share' | 'stop' | 'select' | 'select_section' | 'approve' | 'note' | 'remind' | 'explain' | 'walkthrough' | 'next' | 'previous' | 'combined';
export type MeetingCommand = { action: MeetingAction; redlineId?: string; sectionId?:string; actions?: MeetingCommand[] };
export const meetingFocus = (s:Pick<MeetingSession,'selectedRedlineId'|'selectedSectionId'>) => s.selectedSectionId??s.selectedRedlineId;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = (s: unknown, max: number): s is string => typeof s === 'string' && !!s.trim() && s.length <= max;
const idOK = (s: unknown): s is string => typeof s === 'string' && /^[\w:.-]{1,200}$/.test(s);

// Explicit reconstruction: unknown keys (including comments and private rationale) never survive.
export function publicDocument(input: PublicDocument): PublicDocument {
  if (!input || !bounded(input.title, 300) || !Array.isArray(input.paragraphs) || !input.paragraphs.length
    || input.paragraphs.length > 3000 || !Array.isArray(input.redlines) || input.redlines.length > 200) throw new DocumentError('Invalid public contract material.');
  const ids = new Set<string>();
  const paragraphs = input.paragraphs.map(p => {
    if (!p || !idOK(p.id) || ids.has(p.id) || typeof p.text !== 'string' || p.text.length > 16000) throw new DocumentError('Invalid public paragraph.');
    ids.add(p.id); return { id: p.id, text: p.text };
  });
  if (paragraphs.reduce((n,p)=>n+p.text.length,0) > 300000) throw new DocumentError('Public contract is too large.');
  const redlineIds = new Set<string>();
  const redlines = input.redlines.map(r => {
    const p = paragraphs.find(p=>p.id===r.paragraphId);
    if (!r || !idOK(r.id) || redlineIds.has(r.id) || !p || !bounded(r.original,16000)
      || typeof r.replacement !== 'string' || r.replacement.length > 16000 || r.original === r.replacement
      || !p.text.includes(r.original) || p.text.indexOf(r.original) !== p.text.lastIndexOf(r.original)) throw new DocumentError('Public redline must match one exact passage in the saved contract.');
    redlineIds.add(r.id);
    return { id: r.id, paragraphId: r.paragraphId, original: r.original, replacement: r.replacement };
  });
  let sections:PublicDocument['sections'];
  if(input.sections!==undefined){
    if(!Array.isArray(input.sections)||!input.sections.length||input.sections.length>3000)throw new DocumentError('Invalid document passages.');
    const seen=new Set<string>();
    sections=input.sections.map((s,i)=>{
      if(s.id!==`s${i+1}`||!ids.has(s.paragraphId)||seen.has(s.paragraphId))throw new DocumentError('Invalid document passage.');
      seen.add(s.paragraphId);return {id:s.id,paragraphId:s.paragraphId};
    });
  }
  return { title: input.title, paragraphs, redlines,...(sections?{sections}:{}) };
}
export function parseMeetingCommand(text: string): MeetingCommand {
  const single=parseSingleMeetingCommand(text);
  if(single.action!=='note')return single;
  const parts=text.trim().split(/\s+(?:and then|and|then|also)\s+|;\s*/i);
  if(parts.length>1) {
    if(parts.length>5)return {action:'note'};
    const actions=parts.map(parseSingleMeetingCommand);
    // Do not extract an apparent permission from quoted or conditional guidance.
    if(actions.some(c=>c.action==='note'))return {action:'note'};
    return {action:'combined',actions};
  }
  return single;
}
function parseSingleMeetingCommand(text: string): MeetingCommand {
  // Match a direct request as a whole, never a command quoted inside private
  // guidance. Politeness and common phrasing do not require a model to grant access.
  const command = text.trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '').replace(/^(?:hey\s+)?cleo(?:[, :]\s*|\s+)/, '')
    .replace(/^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/, '')
    .replace(/(?:,?\s+please|,?\s+thanks|,?\s+thank you)$/, '')
    .replace(/\s+(?:now|for me)$/, '').trim();
  if (/^(?:remind me(?: about| of)?|explain to me|privately explain) (?:this|that|the|the current) (?:redline|change|clause)$/.test(command)
    || /^(?:explain|summarize) (?:this|that|the current) (?:redline|change|clause)(?: to me| privately| to me privately)$/.test(command)) return {action:'remind'};
  if (/^(?:walk (?:us|everyone) through|go through|present|explain) (?:all (?:of )?)?(?:the |your )?redlines(?: to (?:everyone|the meeting))?$/.test(command)) return {action:'walkthrough'};
  if (/^(?:explain|present|discuss) (?:this|that|the current) (?:redline|change|clause) to (?:everyone|the meeting|them)$/.test(command)||command==='walk us through the redline') return {action:'explain'};
  if (/^(?:(?:go|move|glide|scroll) to (?:the )?|show (?:us )?(?:the )?)?next (?:redline|change|clause)$/.test(command)) return {action:'next'};
  if (/^(?:(?:go|move|glide|scroll) (?:back )?to (?:the )?|show (?:us )?(?:the )?)?previous (?:redline|change|clause)$/.test(command)) return {action:'previous'};
  if (['take over','take over the conversation','take over the negotiation','negotiate with them'].includes(command)) return {action:'takeover'};
  if (['speak', 'start speaking', 'take over', 'take over the conversation', 'take over the negotiation', 'jump in', 'go ahead and speak', 'you can speak', 'you can take over', 'negotiate with them'].includes(command)) return { action:'speak' };
  if (['wait','wait a moment','hold on','pause','pause please','hold that thought','quiet', 'be quiet', 'stay quiet', 'stop speaking', 'stop talking', 'stop the walkthrough', 'pause the walkthrough', 'mute', 'mute yourself', "don't speak", 'do not speak', "don't talk", 'let me speak', 'let me take over', "i'll take over"].includes(command)) return { action:'quiet' };
  if (['share screen', 'share your screen', 'share the screen', 'share the google doc', 'show the google doc', 'show the contract', 'show us the contract', 'start sharing', 'start sharing your screen', 'you can share your screen'].includes(command)) return { action:'share' };
  if (['stop sharing', 'stop sharing your screen', 'stop screen share', 'hide the contract', "don't share your screen", 'do not share your screen'].includes(command)) return { action:'stop_share' };
  if (['stop', 'stop everything', 'leave meeting', 'leave the meeting', 'leave the call', 'end meeting', 'end the meeting'].includes(command)) return { action:'stop' };
  const select = /^(?:select|show|walk through) (r[1-9]\d{0,2})$/.exec(command);
  if (select) return {action:'select',redlineId:select[1]};
  const approve = /^approve proposal (r[1-9]\d{0,2})$/.exec(command);
  if (approve) return {action:'approve',redlineId:approve[1]};
  if(/^(?:walk (?:me|us|everyone) through|present|explain) (?:the |this |your )?(?:document|google doc|draft)$/.test(command))return {action:'walkthrough'};
  if(/^(?:go to |show )?(?:the )?next (?:section|passage|paragraph)$/.test(command))return {action:'next'};
  if(/^(?:go to |show )?(?:the )?previous (?:section|passage|paragraph)$/.test(command))return {action:'previous'};
  const section=/^(?:select|show|walk through) (s[1-9]\d{0,3})$/.exec(command);
  if(section)return {action:'select_section',sectionId:section[1]};
  return {action:'note'};
}

export class MeetingSessions {
  db: DatabaseSync; now: () => number;
  private listeners = new Set<(binding: MeetingBinding, scopes: MeetingScope[]) => void>();
  constructor(path: string, options: {now?:()=>number} = {}) {
    this.now=options.now ?? Date.now;
    if (path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if (path!==':memory:') chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meeting_sessions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,source TEXT NOT NULL,request TEXT,
        data TEXT NOT NULL,document TEXT NOT NULL,last_control INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,request));
      CREATE TABLE IF NOT EXISTS meeting_events(owner TEXT,event TEXT,session TEXT,fingerprint TEXT,text TEXT,at INTEGER,PRIMARY KEY(owner,event));
      CREATE TABLE IF NOT EXISTS meeting_ingress(owner TEXT,event TEXT,text TEXT,at INTEGER,PRIMARY KEY(owner,event));
      CREATE TABLE IF NOT EXISTS meeting_deliveries(session TEXT,event TEXT,status TEXT,PRIMARY KEY(session,event));
      CREATE TABLE IF NOT EXISTS meeting_transcripts(session TEXT,event TEXT,text TEXT,at INTEGER,PRIMARY KEY(session,event));
      CREATE TABLE IF NOT EXISTS meeting_transcript_context(session TEXT,event TEXT,speaker TEXT,trace TEXT,PRIMARY KEY(session,event));
      CREATE TABLE IF NOT EXISTS meeting_public_speech(session TEXT,text TEXT,at INTEGER);`);
    // Never resume a public output grant after process restart or reconstruct queued audio.
    for (const row of this.db.prepare('SELECT id,data FROM meeting_sessions').all()) {
      const s = JSON.parse(String(row.data)) as MeetingSession;
      s.speechRevision ??= s.revision;s.shareRevision ??= s.revision;s.guidanceRevision ??= (s as MeetingSession & {coachingRevision?:number}).coachingRevision ?? s.revision;delete (s as MeetingSession & {coachingRevision?:number}).coachingRevision;s.takeover=false;s.paused=false;
      if (s.speak || s.share) { s.speak=false;s.share=false;s.revision++;s.speechRevision++;s.shareRevision++; }this.save(s);
    }
  }
  recordIngress(event:OwnerMeetingEvent) {
    const at=Date.parse(event.at);
    if(!idOK(event.owner)||!idOK(event.id)||!bounded(event.text,6000)||event.channel!=='imessage'||event.isDirect!==true||!Number.isFinite(at)||Math.abs(this.now()-at)>300000)throw new DocumentError('Invalid verified owner ingress.');
    const old=this.db.prepare('SELECT text,at FROM meeting_ingress WHERE owner=? AND event=?').get(event.owner,event.id);
    if(old&&old.text!==event.text)throw new DocumentError('Conflicting owner message ID.');
    this.db.prepare('INSERT INTO meeting_ingress VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(event.owner,event.id,event.text,at);
    // A retried webhook must not turn a pre-meeting message into fresh consent.
    return {...event,at:new Date(old ? Number(old.at) : at).toISOString()};
  }
  requireJoinIntent(owner:string,meetingUrl:string,eventId:string) {
    const text=this.joinInvitation(owner,meetingUrl,eventId);
    const match=/^(?:cleo[, :]\s*)?(?:join(?: me)?(?: quietly)?\s+)?(https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3})[.!]?$/i.exec(text);
    if(!match||match[1]!==meetingUrl)throw new DocumentError('A verified direct user meeting link is required before joining.');
    return true;
  }
  joinInvitation(owner:string,meetingUrl:string,eventId:string) {
    const row=this.db.prepare('SELECT text,at FROM meeting_ingress WHERE owner=? AND event=?').get(owner,eventId);
    // Keiki appends attachment descriptions to the authenticated user text.
    // They are not an invitation and must never supply the meeting URL.
    const text=String(row?.text??'').split(/\n\s*\[Attachment;/)[0].trim();
    const links:string[]=text.match(/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?![\w/-])/g)??[];
    if(!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingUrl)||!links.includes(meetingUrl))throw new DocumentError('The requested Meet link must be present in the verified owner message.');
    const existing=this.db.prepare('SELECT 1 FROM meeting_sessions WHERE owner=? AND request=?').get(owner,eventId);
    if(!existing&&Number(row!.at)<this.now()-300000)throw new DocumentError('The meeting invitation is stale; send the link again.');
    return text;
  }
  private save(s: MeetingSession) { this.db.prepare('UPDATE meeting_sessions SET data=? WHERE id=?').run(JSON.stringify(s),s.sessionId); }
  private revoke(b: MeetingBinding, scopes: MeetingScope[] = ['speech','share','guidance','end']) { for (const fn of this.listeners) { try { fn({owner:b.owner,sourceId:b.sourceId,sessionId:b.sessionId},scopes); } catch { /* Gates are already revoked even if a transport cancellation fails. */ } } }
  onRevoke(fn: (binding: MeetingBinding, scopes: MeetingScope[])=>void) { this.listeners.add(fn);return ()=>{this.listeners.delete(fn);}; }
  create(input: {owner:string;sourceId:string;meetingUrl:string;publicDocument:PublicDocument;requestId?:string}): MeetingSession {
    if (!idOK(input.owner)||!idOK(input.sourceId)||(input.requestId!==undefined&&!idOK(input.requestId))) throw new DocumentError('Bind the meeting to an authenticated owner and imported contract.');
    let url: URL;
    try { url=new URL(input.meetingUrl); } catch { throw new DocumentError('Provide a Google Meet link.'); }
    if (url.origin!=='https://meet.google.com'||!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname)||url.username||url.password||url.search||url.hash) throw new DocumentError('Provide a plain Google Meet link.');
    const doc=publicDocument(input.publicDocument);
    if (input.requestId) {
      const old=this.db.prepare('SELECT data,document FROM meeting_sessions WHERE owner=? AND request=?').get(input.owner,input.requestId);
      if (old) {
        const s=JSON.parse(String(old.data)) as MeetingSession;
        if (s.sourceId!==input.sourceId||s.meetingUrl!==url.href||digest(JSON.parse(String(old.document)))!==digest(doc)) throw new DocumentError('Meeting request ID was already used for different material.');
        return s;
      }
    }
    const previous=this.db.prepare('SELECT data FROM meeting_sessions WHERE owner=?').all(input.owner).map(r=>JSON.parse(String(r.data)) as MeetingSession).filter(s=>s.status==='active');
    const now=this.now();
    const s:MeetingSession={owner:input.owner,sourceId:input.sourceId,sessionId:randomUUID(),meetingUrl:url.href,status:'active',speak:false,share:false,revision:1,speechRevision:1,shareRevision:1,guidanceRevision:1,takeover:false,paused:false,createdAt:now,expiresAt:now+6*60*60*1000,selectedRedlineId:doc.sections?null:doc.redlines[0]?.id??null,...(doc.sections?{selectedSectionId:doc.sections[0].id}:{}),approvedRedlineIds:[]};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of previous) {p.speak=false;p.share=false;p.status='ended';p.revision++;this.save(p);}
      this.db.prepare('INSERT INTO meeting_sessions(id,owner,source,request,data,document) VALUES(?,?,?,?,?,?)').run(s.sessionId,s.owner,s.sourceId,input.requestId??null,JSON.stringify(s),JSON.stringify(doc));
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK');throw e; }
    previous.forEach(p=>this.revoke(p));return s;
  }
  get(b: MeetingBinding): MeetingSession {
    const row=this.db.prepare('SELECT data FROM meeting_sessions WHERE id=? AND owner=? AND source=?').get(b.sessionId,b.owner,b.sourceId);
    if (!row) throw new DocumentError('Meeting not found for this owner and contract.');
    return JSON.parse(String(row.data));
  }
  active(owner:string): MeetingSession | undefined {
    return this.db.prepare('SELECT data FROM meeting_sessions WHERE owner=? ORDER BY rowid DESC').all(owner).map(r=>JSON.parse(String(r.data)) as MeetingSession).find(s=>s.status==='active'&&s.expiresAt>this.now());
  }
  private requireActive(b:MeetingBinding) { const s=this.get(b);if(s.status!=='active'||s.expiresAt<=this.now())throw new DocumentError('Meeting is ended or expired.');return s; }
  bindProvider(b: MeetingBinding, providerBotId: string) {
    const s=this.requireActive(b);
    if (!idOK(providerBotId)) throw new DocumentError('Invalid provider bot ID.');
    const existing=this.byProvider(providerBotId);
    if ((existing&&existing.sessionId!==s.sessionId)||(s.providerBotId&&s.providerBotId!==providerBotId)) throw new DocumentError('Provider bot is already bound.');
    s.providerBotId=providerBotId;this.save(s);return s;
  }
  bindGoogleDocument(b:MeetingBinding,id:string) {
    if(!/^[\w-]{10,200}$/.test(id))throw new DocumentError('Invalid Google review document.');
    const s=this.requireActive(b);s.googleDocumentId=id;this.save(s);
  }
  byProvider(id:string): MeetingSession | undefined {
    return this.db.prepare('SELECT data FROM meeting_sessions').all().map(r=>JSON.parse(String(r.data)) as MeetingSession).find(s=>s.providerBotId===id);
  }
  publicView(b: MeetingBinding) {
    const s=this.requireActive(b);
    const row=this.db.prepare('SELECT document FROM meeting_sessions WHERE id=? AND owner=? AND source=?').get(b.sessionId,b.owner,b.sourceId)!;
    const doc=publicDocument(JSON.parse(String(row.document)));
    return { ...doc, selectedRedlineId:s.selectedRedlineId,selectedSectionId:s.selectedSectionId,
      annotations:doc.redlines.filter(r=>r.id===s.selectedRedlineId).map(r=>({redlineId:r.id,status:s.approvedRedlineIds.includes(r.id)?'approved_proposal' as const:'proposed' as const})) };
  }
  control(b: MeetingBinding, event: OwnerMeetingEvent, interpreted?:MeetingCommand) {
    this.db.exec('BEGIN IMMEDIATE');
    let result: ReturnType<MeetingSessions['applyControl']>;
    try {result=this.applyControl(b,event,interpreted);this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
    if(result.status==='applied')this.revoke(result.session,result.scopes);
    return result;
  }
  private applyControl(b: MeetingBinding, event: OwnerMeetingEvent, interpreted?:MeetingCommand) {
    const s=this.get(b),at=Date.parse(event.at);
    if (event.owner!==s.owner||event.channel!=='imessage'||event.isDirect!==true||!idOK(event.id)||!bounded(event.text,6000)||!Number.isFinite(at)) throw new DocumentError('Only a verified direct owner message can control this meeting.');
    const fingerprint=digest([event.owner,event.text,event.channel,event.isDirect]);
    const old=this.db.prepare('SELECT session,fingerprint FROM meeting_events WHERE owner=? AND event=?').get(s.owner,event.id);
    if (old) {
      if (old.session!==s.sessionId||old.fingerprint!==fingerprint) throw new DocumentError('Message replay or conflicting event ID.');
      return {status:'duplicate' as const,session:s,action:'note' as MeetingAction,actions:[] as MeetingAction[]};
    }
    const last=Number(this.db.prepare('SELECT last_control FROM meeting_sessions WHERE id=?').get(s.sessionId)?.last_control);
    if (at<s.createdAt||at<this.now()-300000||at>this.now()+30000||at<=last) throw new DocumentError('Meeting control message is stale or out of order.');
    this.requireActive(b);
    // Honor previously issued commands without allowing an old code to name a new meeting.
    const suffix=/\s+#([a-f0-9]{12})\s*$/i.exec(event.text);
    if(suffix&&suffix[1].toLowerCase()!==createHash('sha256').update(s.sessionId).digest('hex').slice(0,12))throw new DocumentError('This command names a different meeting.');
    const command=interpreted??parseMeetingCommand(suffix?event.text.slice(0,suffix.index):event.text);
    const result=this.applyCommand(b,s,command);
    this.db.prepare('INSERT INTO meeting_events VALUES(?,?,?,?,?,?)').run(s.owner,event.id,s.sessionId,fingerprint,event.text,at);
    this.db.prepare('UPDATE meeting_sessions SET last_control=? WHERE id=?').run(at,s.sessionId);
    return result;
  }
  private applyCommand(b:MeetingBinding,s:MeetingSession,command:MeetingCommand) {
    const actions=command.actions??[command],view=this.publicView(b),redlines=view.redlines,sections=view.sections;
    const scopes=new Set<MeetingScope>();
    for(const {action} of actions){
      if(['greet','propose','speak','takeover','quiet','explain','walkthrough','stop'].includes(action))scopes.add('speech');
      if(sections&&['select_section','next','previous'].includes(action))scopes.add('speech');
      if(action==='stop'||action==='stop_share'||(action==='share'&&!s.share))scopes.add('share');
      if(['select','select_section','next','previous','approve'].includes(action)||(action==='share'&&s.share))scopes.add('presentation');
      if(['note','remind','stop'].includes(action))scopes.add('guidance');
      if(action==='stop')scopes.add('end');
    }
    for(const action of actions) {
    if (action.redlineId&&!redlines.some(r=>r.id===action.redlineId)) throw new DocumentError('Choose an existing saved redline ID.');
    if(action.action==='select_section'&&!sections?.some(s=>s.id===action.sectionId))throw new DocumentError('Choose a saved document passage.');
    if(action.action==='select'&&sections)throw new DocumentError('Use a document passage in this walkthrough.');
    switch(action.action) {
      case 'takeover': s.takeover=true;s.speak=true;s.paused=false;break;
      case 'greet': case 'propose': case 'speak': case 'explain': case 'walkthrough': s.speak=true;s.paused=false;break;
      case 'quiet': s.speak=false;s.takeover=false;s.paused=true;break;
      case 'share': s.share=true;break;
      case 'stop_share': s.share=false;break;
      case 'stop': s.speak=false;s.share=false;s.status='ended';break;
      case 'select': s.selectedRedlineId=action.redlineId!;break;
      case 'select_section': s.selectedSectionId=action.sectionId!;break;
      case 'next': case 'previous': {
        if(sections){
          const index=sections.findIndex(p=>p.id===s.selectedSectionId),next=index+(action.action==='next'?1:-1);
          if(next<0||next>=sections.length)throw new DocumentError('There is no further document passage in that direction.');
          s.selectedSectionId=sections[next].id;break;
        }
        const index=redlines.findIndex(r=>r.id===s.selectedRedlineId),next=index+(action.action==='next'?1:-1);
        if(next<0||next>=redlines.length)throw new DocumentError('There is no further saved redline in that direction.');
        s.selectedRedlineId=redlines[next].id;break;
      }
      case 'approve': if(!s.approvedRedlineIds.includes(action.redlineId!))s.approvedRedlineIds.push(action.redlineId!);break;
    }
    }
    // Revocations and a request for private advice take precedence over grants.
    if(actions.some(a=>['quiet','stop'].includes(a.action)))s.speak=false;
    if(actions.some(a=>['stop_share','stop'].includes(a.action)))s.share=false;
    // Independent grants: a note or speech interruption never revokes the screen.
    s.revision++;
    if(scopes.has('speech'))s.speechRevision++;
    if(scopes.has('share'))s.shareRevision++;
    if(scopes.has('guidance'))s.guidanceRevision++;
    this.save(s);
    return {status:'applied' as const,session:s,action:command.action,actions:actions.map(a=>a.action),scopes:[...scopes]};
  }
  resolveControl(b:MeetingBinding,revision:number,command:MeetingCommand) {
    const s=this.requireActive(b);if(s.revision!==revision)throw new DocumentError('Meeting request was superseded.');
    const result=this.applyCommand(b,s,command);this.revoke(s,result.scopes);return result;
  }
  lastOwnerControlAt(b:MeetingBinding) {
    this.get(b);return Number(this.db.prepare('SELECT last_control FROM meeting_sessions WHERE id=?').get(b.sessionId)?.last_control??0);
  }
  interruptSpeech(b:MeetingBinding) {
    const s=this.requireActive(b);s.speechRevision++;this.save(s);this.revoke(s,['speech']);return s;
  }
  end(b:MeetingBinding) {const s=this.get(b);s.speak=false;s.share=false;s.status='ended';s.revision++;s.speechRevision++;s.shareRevision++;s.guidanceRevision++;this.save(s);this.revoke(s);return s;}
  lease(b:MeetingBinding,capability:'speak'|'share'):MeetingLease {
    const s=this.requireActive(b);
    if (!['speak','share'].includes(capability)||!s[capability]) throw new DocumentError('The owner has not authorized this public output.');
    return {owner:s.owner,sourceId:s.sourceId,sessionId:s.sessionId,capability,revision:capability==='speak'?s.speechRevision:s.shareRevision,expiresAt:Math.min(this.now()+(capability==='share'?5000:30000),s.expiresAt)};
  }
  assertLease(lease:MeetingLease) {
    const s=this.requireActive(lease);
    if (!['speak','share'].includes(lease.capability)||!s[lease.capability]||(lease.capability==='speak'?s.speechRevision:s.shareRevision)!==lease.revision||lease.expiresAt<=this.now()||lease.expiresAt>this.now()+(lease.capability==='share'?5000:30000)) throw new DocumentError('Public output permission was revoked or expired.');
    return true;
  }
  publicSpeech(b:MeetingBinding) {
    const lease=this.lease(b,'speak'),view=this.publicView(b);
    const r=view.redlines.find(r=>r.id===view.selectedRedlineId);
    if(!r)throw new DocumentError('No saved redline is selected for walkthrough.');
    // Only source-backed wording; neither a transcript nor private model output can supply speech.
    const text=`For redline ${r.id}, the current wording is: “${r.original}”. The proposed wording is: “${r.replacement}”. This is a proposal for discussion, not an acceptance or commitment. Shall we review this wording?`;
    return {lease,text,redlineId:r.id};
  }
  privateNotes(b:MeetingBinding) {
    this.requireActive(b);
    return this.db.prepare('SELECT event AS id,text,at FROM meeting_events WHERE session=? AND owner=? ORDER BY at DESC LIMIT 12').all(b.sessionId,b.owner).reverse();
  }
  recentTranscript(b:MeetingBinding) {
    this.requireActive(b);
    return this.db.prepare('SELECT text FROM meeting_transcripts WHERE session=? ORDER BY at DESC,rowid DESC LIMIT 10')
      .all(b.sessionId).reverse().map(row => String(row.text).slice(0,2000));
  }
  publicDialogue(b:MeetingBinding) {
    this.requireActive(b);
    // Keep both sides in time order. Appending all Cleo replies after all human
    // turns made the latest follow-up disappear when the interpreter took six.
    return this.db.prepare(`SELECT role,text,at,speakerId,traceId FROM (
      SELECT 'participant' AS role,t.text,t.at,t.rowid AS sequence,c.speaker AS speakerId,c.trace AS traceId FROM meeting_transcripts t LEFT JOIN meeting_transcript_context c ON c.session=t.session AND c.event=t.event WHERE t.session=?
      UNION ALL SELECT 'cleo' AS role,text,at,rowid AS sequence,NULL AS speakerId,NULL AS traceId FROM meeting_public_speech WHERE session=?
    ) ORDER BY at DESC,sequence DESC LIMIT 12`).all(b.sessionId,b.sessionId).reverse()
      .map(row=>({role:row.role as 'participant'|'cleo',text:String(row.text).slice(0,2000),at:Number(row.at),speakerId:row.speakerId?String(row.speakerId):undefined,traceId:row.traceId?String(row.traceId):undefined}));
  }
  recordPublicSpeech(b:MeetingBinding,text:string) {
    this.requireActive(b);
    if(!bounded(text,6000))throw new DocumentError('Invalid public speech.');
    this.db.prepare('INSERT INTO meeting_public_speech VALUES(?,?,?)').run(b.sessionId,text,this.now());
  }
  publicUtterances(b:MeetingBinding) {
    this.requireActive(b);
    return this.db.prepare('SELECT text FROM meeting_public_speech WHERE session=? ORDER BY rowid DESC LIMIT 6')
      .all(b.sessionId).reverse().map(row=>String(row.text));
  }
  transcript(b:MeetingBinding,event:{id:string;text:string;at:string;speakerId?:string;traceId?:string}) {
    this.requireActive(b);const at=Date.parse(event.at);
    if(!idOK(event.id)||!bounded(event.text,6000)||!Number.isFinite(at)||Math.abs(this.now()-at)>300000)throw new DocumentError('Invalid or stale meeting transcript.');
    const old=this.db.prepare('SELECT text FROM meeting_transcripts WHERE session=? AND event=?').get(b.sessionId,event.id);
    if(old&&old.text!==event.text)throw new DocumentError('Conflicting transcript event.');
    const inserted=this.db.prepare('INSERT INTO meeting_transcripts VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(b.sessionId,event.id,event.text,at).changes===1;
    if(inserted)this.db.prepare('INSERT INTO meeting_transcript_context VALUES(?,?,?,?)').run(b.sessionId,event.id,/^speaker-[a-f0-9]{16}$/.test(event.speakerId??'')?event.speakerId??null:null,/^[a-f0-9-]{36}$/.test(event.traceId??'')?event.traceId??null:null);
    return inserted;
  }
  enrichTranscriptSpeaker(b:MeetingBinding,event:{id:string;traceId:string;speakerId?:string}) {
    this.requireActive(b);
    if(event.speakerId!==undefined&&!/^speaker-[a-f0-9]{16}$/.test(event.speakerId))return;
    const row=this.db.prepare('SELECT speaker FROM meeting_transcript_context WHERE session=? AND event=? AND trace=?').get(b.sessionId,event.id,event.traceId);
    if(!row||row.speaker==='')return;
    // NULL is unknown. Empty string permanently marks conflicting/mixed
    // evidence, so a subsequent caption cannot reassign that turn to one person.
    const speaker=!event.speakerId||(row.speaker&&row.speaker!==event.speakerId)?'':event.speakerId;
    this.db.prepare('UPDATE meeting_transcript_context SET speaker=? WHERE session=? AND event=? AND trace=?').run(speaker,b.sessionId,event.id,event.traceId);
  }
  speakerForTurn(b:MeetingBinding,traceId:string) {
    this.requireActive(b);
    const rows=this.db.prepare('SELECT speaker FROM meeting_transcript_context WHERE session=? AND trace=?').all(b.sessionId,traceId);
    return rows.length===1&&rows[0].speaker?String(rows[0].speaker):undefined;
  }
  claimDelivery(b:MeetingBinding,eventId:string) {
    this.requireActive(b);if(!idOK(eventId))throw new DocumentError('Invalid private reply event ID.');
    return this.db.prepare("INSERT INTO meeting_deliveries VALUES(?,?,'pending') ON CONFLICT DO NOTHING").run(b.sessionId,eventId).changes===1;
  }
  deliveryStatus(b:MeetingBinding,eventId:string,status?:string) {
    this.get(b);
    if(status)this.db.prepare('UPDATE meeting_deliveries SET status=? WHERE session=? AND event=?').run(status,b.sessionId,eventId);
    return this.db.prepare('SELECT status FROM meeting_deliveries WHERE session=? AND event=?').get(b.sessionId,eventId)?.status;
  }
  close(){this.db.close();}
}
