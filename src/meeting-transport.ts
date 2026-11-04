import {directMeetingConversation,isSimpleMeetingFollowup} from './meeting-followup.ts';
import {type MeetingTraceContext,type MeetingVadProfile} from './meeting-latency.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Attendee, verifyAttendeeWebhook } from './attendee.ts';
import { MeetingSessions, meetingFocus, type MeetingBinding, type MeetingLease, type OwnerMeetingEvent, type MeetingCommand, type MeetingScope, parseMeetingCommand } from './meeting-session.ts';
import { MeetingRealtime, type SafeMeetingSteering } from './meeting-realtime.ts';
import { validatePrivateSteering, type PrivateSteering } from './meeting-private-director.ts';
import type { MeetingIntelligence } from './meeting-intelligence.ts';
import type {MeetingPresenter} from './meeting-computer.ts';
import {presentationLocation} from './meeting-presentation-model.ts';
import {readableDiff} from './docx.ts';
import type {MeetingIntent,MeetingIntentInput} from './meeting-intent.ts';
type PrivateMessenger = {send:(input:{owner:string;text:string;signal?:AbortSignal})=>Promise<{status:string}>};
import {DocumentError} from './docx.ts';
import {MeetingTranscriptGate} from './meeting-transcript-gate.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const freshToken = () => randomBytes(32).toString('base64url');
type Row = { session: string; binding: string; bot: string | null; state: string; audio_hash: string; events_hash: string };
type Transcript = { id: string; text: string; at: string; traceId?:string; speakerId?:string };
type TransportOptions = {
  path: string; publicUrl: string; attendee: Attendee; openaiKey: string; webhookSecret?: string;
  onTranscript?: (binding: MeetingBinding, event: Transcript) => Promise<unknown>;
  applyControl?: (binding: MeetingBinding, event: OwnerMeetingEvent, interpreted?:MeetingCommand) => Promise<ReturnType<MeetingSessions['control']>>;
  captionFallbackMs?:number;
  vadProfile?:MeetingVadProfile;
  fastFollowups?:boolean;
  directTranscriptFallbackMs?:number;
  Voice?: typeof MeetingRealtime; now?: () => number;
  diagnose?: (binding:MeetingBinding,event:string,context?:MeetingTraceContext)=>void;
  steering?: (binding:MeetingBinding)=>SafeMeetingSteering|undefined;
  intelligence?: Pick<MeetingIntelligence, 'reply'> & Partial<Pick<MeetingIntelligence,'remind'|'steer'>>;
  presenter?:MeetingPresenter;
  intent?:MeetingIntent;
  messenger?:PrivateMessenger;
};

export class MeetingTransport {
  readonly sessions: MeetingSessions;
  private options: TransportOptions;
  private db: DatabaseSync;
  private sockets = new Map<string, WebSocket>();
  private voices = new Map<string, MeetingRealtime<MeetingLease>>();
  private shares = new Map<string, { binding: MeetingBinding; revision: number }>();
  private queues = new Map<string, Promise<void>>();
  private lastAudio = new Map<string, number>();
  private pendingVoice = new Map<string,symbol>();
  private negotiations = new Map<string, AbortController>();
  private expirations = new Map<string, ReturnType<typeof setTimeout>>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 150_000, perMessageDeflate: false });
  private removeListener: () => void;
  private closed = false;
  private intents=new Map<string,{controller:AbortController;channel:'meeting'|'imessage'}>();
  private intentErrors=new Set<string>();
  private queuedRoom=new Map<string,Transcript>();
  private roomClock=new Map<string,number>();
  private roomSpeakers=new Map<string,Set<string>>();
  private roomActivityClock=new Map<string,number>();
  private roomWaiting=new Map<string,{revision:number;work:()=>Promise<unknown>}>();
  private reminders=new Map<string,AbortController>();
  private presentationReady=new Map<string,string|null>();
  private presentationErrors=new Set<string>();
  private steeringCache=new Map<string,{revision:number;context:string;value:PrivateSteering;focusConsumed?:boolean}>();
  private navigationRevision=new Map<string,number>();
  private steeringWork=new Map<string,AbortController>();
  private audioBacklog=new Map<string,Buffer[]>();
  private voiceRetryAt=new Map<string,number>();
  private connecting=new Map<string,Promise<MeetingRealtime<MeetingLease>|undefined>>();
  private trace=new Map<string,{event:string;at:number}[]>();
  private heard=new Map<string,{id:string;source:'direct'|'caption';text:string;at:number;receivedAt:number;paired:boolean;traceId?:string}[]>();
  private captionTimers=new Set<ReturnType<typeof setTimeout>>();
  private transcriptGates=new Map<string,MeetingTranscriptGate>();
  private dialogueState=new Map<string,{traceId?:string;speakerId?:string;at:number;redlineId:string|null;mode:'conversation'|'walkthrough'|'greeting';awaitingQuestion:boolean}>();
  private presentationDiffs=new Map<string,ReturnType<typeof readableDiff>>();
  constructor(sessions: MeetingSessions, options: TransportOptions) {
    this.sessions = sessions; this.options = options;
    const url = new URL(options.publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Meeting transport needs a public HTTPS origin.');
    this.db = new DatabaseSync(options.path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meeting_transport(session TEXT PRIMARY KEY,binding TEXT NOT NULL,bot TEXT,state TEXT NOT NULL,audio_hash TEXT NOT NULL UNIQUE,events_hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS meeting_provider_events(id TEXT PRIMARY KEY,session TEXT NOT NULL,fingerprint TEXT NOT NULL);`);
    this.removeListener = sessions.onRevoke((binding,scopes) => {
      this.cancel(binding,scopes);
      if(scopes.includes('guidance')&&this.sessions.get(binding).status==='active')this.refreshSteering(binding);
      if(scopes.some(scope=>['share','presentation','end'].includes(scope)))void this.reconcile(binding).catch(() => {this.diagnose(binding,'presentation_reconcile_failed');});
    });
  }
  private diagnose(binding:MeetingBinding,event:string,context?:MeetingTraceContext){
    const safe=event.replace(/[^a-z_]/g,'').slice(0,80),trace=this.trace.get(binding.sessionId)??[];
    trace.push({event:safe,at:this.options.now?.()??Date.now()});this.trace.set(binding.sessionId,trace.slice(-40));this.options.diagnose?.(binding,safe,context?{...context,profile:this.options.vadProfile??'semantic_medium'}:undefined);
  }

  private async measured<T>(binding:MeetingBinding,operation:NonNullable<MeetingTraceContext['operation']>,work:()=>Promise<T>,context?:MeetingTraceContext,signal?:AbortSignal):Promise<T>{
    const span={...context,turnId:context?.turnId??randomUUID(),spanId:randomUUID(),operation};
    this.diagnose(binding,'meeting_tool_started',span);
    try{const result=await work();this.diagnose(binding,signal?.aborted?'meeting_tool_cancelled':'meeting_tool_completed',span);return result;}
    catch(error){this.diagnose(binding,signal?.aborted?'meeting_tool_cancelled':'meeting_tool_failed',span);throw error;}
  }
  private refreshSteering(binding:MeetingBinding,traceContext?:MeetingTraceContext){
    if(this.closed||!this.options.intelligence?.steer)return;
    const id=binding.sessionId,session=this.sessions.get(binding),revision=session.guidanceRevision,context=JSON.stringify(this.sessions.recentTranscript(binding)),previous=this.steeringCache.get(id),navigationAtStart=this.navigationRevision.get(id)??0;
    this.steeringWork.get(id)?.abort();const controller=new AbortController();this.steeringWork.set(id,controller);this.steeringCache.delete(id);
    void this.measured(binding,'steering',()=>this.options.intelligence!.steer!(binding,AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])),traceContext,controller.signal).then(value=>{
      if(controller.signal.aborted||this.closed||this.sessions.get(binding).status!=='active'||this.sessions.get(binding).guidanceRevision!==revision||JSON.stringify(this.sessions.recentTranscript(binding))!==context)return;
      const safe=validatePrivateSteering(value,this.sessions.publicView(binding).redlines.map(r=>r.id));
      this.steeringCache.set(id,{revision,context,value:safe,focusConsumed:safe.action==='focus'&&((this.navigationRevision.get(id)??0)>navigationAtStart||(previous?.revision===revision&&previous.focusConsumed))});this.diagnose(binding,'meeting_private_steering_ready');
    }).catch(()=>{this.diagnose(binding,'meeting_private_steering_unavailable');}).finally(()=>{if(this.steeringWork.get(id)===controller)this.steeringWork.delete(id);});
  }
  private row(session: string) { return this.db.prepare('SELECT * FROM meeting_transport WHERE session=?').get(session) as Row | undefined; }
  async requireJoinIntent(owner:string,meetingUrl:string,eventId:string) {
    if(!this.options.intent?.authorizeInvitation)return this.sessions.requireJoinIntent(owner,meetingUrl,eventId);
    const text=this.sessions.joinInvitation(owner,meetingUrl,eventId);
    let allowed:boolean;
    try{allowed=await this.options.intent.authorizeInvitation(text,meetingUrl,AbortSignal.timeout(15000));}
    catch{throw new DocumentError('Your direct message was verified, but meeting invitation understanding is unavailable. No join was attempted.');}
    if(!allowed)throw new DocumentError('Your direct message was verified, but it did not ask Cleo to join this meeting now.');
    // Re-check the original receipt after asynchronous interpretation.
    this.sessions.joinInvitation(owner,meetingUrl,eventId);
    return true;
  }
  private active(binding: MeetingBinding) {
    const session = this.sessions.get(binding);
    if (this.closed || session.status !== 'active' || session.expiresAt <= (this.options.now?.() ?? Date.now())) throw new Error('Meeting is closed.');
    return session;
  }
  private valid(lease: MeetingLease) { try { return !this.closed && this.sessions.assertLease(lease); } catch { return false; } }
  private callback(path: string, token: string) { return new URL(path + token, this.options.publicUrl).href; }
  private expireAtEnd(binding: MeetingBinding) {
    clearTimeout(this.expirations.get(binding.sessionId));
    const session = this.sessions.get(binding);
    const timer = setTimeout(() => {
      this.expirations.delete(binding.sessionId);
      if (!this.closed) this.sessions.end(binding);
    }, Math.max(0, session.expiresAt - (this.options.now?.() ?? Date.now())));
    timer.unref(); this.expirations.set(binding.sessionId,timer);
  }
  async join(binding: MeetingBinding) {
    const s = this.active(binding);
    const old = this.row(s.sessionId);
    if (old) return { status: old.state, session_id: s.sessionId, attendance_confirmed: ['joined_recording','joined_not_recording'].includes(old.state) };
    const audio = freshToken(), events = freshToken();
    // Claim before the external POST: lost responses never cause duplicate attendance.
    this.db.prepare('INSERT INTO meeting_transport VALUES(?,?,NULL,?,?,?)').run(s.sessionId, JSON.stringify(binding), 'join_pending', hash(audio), hash(events));
    try {
      const bot = await this.options.attendee.join({ meetingUrl: s.meetingUrl,
        audioUrl: this.callback('/meeting/audio/', audio).replace(/^https:/, 'wss:'),
        webhookUrl: this.callback('/meeting/events/', events), deduplicationKey: 'cleo-' + s.sessionId });
      this.db.prepare('UPDATE meeting_transport SET bot=?,state=? WHERE session=?').run(bot.id, bot.state, s.sessionId);
      try { this.active(binding); this.sessions.bindProvider(binding, bot.id); }
      catch { await this.options.attendee.leave(bot.id); return { status: 'leave_requested', session_id: s.sessionId, attendance_confirmed: false }; }
      this.expireAtEnd(binding);this.refreshSteering(binding);
      void this.options.intent?.prepare?.(binding.sessionId).catch(()=>{this.diagnose(binding,'meeting_interpreter_warm_failed');});
      return { status: bot.state, session_id: s.sessionId, attendance_confirmed: false, speaking: false, sharing: false };
    } catch {
      this.db.prepare("UPDATE meeting_transport SET state='needs_inspection' WHERE session=?").run(s.sessionId);
      return { status: 'needs_inspection', session_id: s.sessionId, attendance_confirmed: false,
        instruction: 'Attendance is uncertain. Reuse this session; do not create another bot automatically.' };
    }
  }
  status(binding: MeetingBinding) {
    const s = this.sessions.get(binding), row = this.row(s.sessionId);
    return { session_id: s.sessionId, status: s.status, provider_status: row?.state ?? 'not_started',
      speaking_permitted: s.speak, sharing_permitted: s.share, audio_connected: this.sockets.has(s.sessionId),
      screen_share: this.sharesHas(s.sessionId) ? 'requested' : 'off_or_unconfirmed',
      presentation:s.selectedSectionId?'saved_document_view':s.googleDocumentId&&this.options.presenter?'google_doc':'saved_contract_view',selected_section_id:s.selectedSectionId,
      presentation_status:this.presentationErrors.has(s.sessionId)?'unavailable':this.sharesHas(s.sessionId)?'ready_for_provider':'off_or_preparing',
      natural_language_controls:!!this.options.intent,room_voice_controls:!!this.options.intent,
      request_understanding:this.intentErrors.has(s.sessionId)?'unavailable':this.intents.has(s.sessionId)?'processing':'ready',
      sharing_generation:s.shareRevision,speech_revision:s.speechRevision,guidance_revision:s.guidanceRevision,takeover:s.takeover,paused:s.paused,
      diagnostics:this.trace.get(s.sessionId)??[],
      walkthrough:this.dialogueState.get(s.sessionId)?.awaitingQuestion?'waiting_for_questions':'off' };
  }
  private sharesHas(id: string) { return [...this.shares.values()].some(v => v.binding.sessionId === id); }
  async control(binding: MeetingBinding, event: OwnerMeetingEvent) {
    const parsed=parseMeetingCommand(event.text),atoms=parsed.actions??[parsed];
    // Explicit stop requests have a deterministic fast path; arbitrary wording
    // uses the isolated Realtime interpreter. Notes do not cancel public output.
    const immediate=this.options.intent?(atoms.every(a=>['quiet','stop_share','stop'].includes(a.action))?parsed:{action:'note' as const}):undefined;
    let result = this.options.applyControl ? await this.options.applyControl(binding, event,immediate) : this.sessions.control(binding, event,immediate);
    if (result.status === 'duplicate') return { ...this.status(binding), control_status: 'duplicate' };
    if(this.options.intent&&immediate?.action==='note') {
      const revision=result.session.revision,controller=new AbortController();this.intents.set(binding.sessionId,{controller,channel:'imessage'});
      try {
        const intent=await this.measured(binding,'intent',()=>this.options.intent!.resolve(this.intentInput(binding,event.text,'imessage'),controller.signal),undefined,controller.signal);
        if(controller.signal.aborted||this.sessions.get(binding).revision!==revision)return {...this.status(binding),control_status:'superseded'};
        result=this.sessions.resolveControl(binding,revision,intent.command);
        this.intentErrors.delete(binding.sessionId);
      }catch{if(controller.signal.aborted)return {...this.status(binding),control_status:'superseded'};this.intentErrors.add(binding.sessionId);return {...this.status(binding),action:'note' as const,understanding:'unavailable',instruction:'The message remains private. Its requested actions were not confirmed.'};}
      finally{if(this.intents.get(binding.sessionId)?.controller===controller){this.intents.delete(binding.sessionId);const queued=this.queuedRoom.get(binding.sessionId);this.queuedRoom.delete(binding.sessionId);if(queued&&this.freshRoomEvent(binding,Date.parse(queued.at)))void this.roomRequest(binding,queued).catch(()=>{});}}
    }
    return this.finishControl(binding,result);
  }
  private intentInput(binding:MeetingBinding,text:string,channel:'imessage'|'meeting',speakerId?:string):MeetingIntentInput {
    const session=this.sessions.get(binding),view=this.sessions.publicView(binding),dialogue=this.sessions.publicDialogue(binding);
    return {sessionId:binding.sessionId,speakerId,publicTurns:dialogue,takeover:session.takeover,paused:session.paused,text,channel,speaking:session.speak,sharing:session.share,selectedRedlineId:view.selectedRedlineId,selectedSectionId:view.selectedSectionId,sections:view.sections?.map(s=>({id:s.id,text:view.paragraphs.find(p=>p.id===s.paragraphId)!.text.slice(0,700)})),redlines:view.redlines,recentPublicTurns:dialogue.map(t=>(t.role==='cleo'?'Cleo: ':'Participant: ')+t.text),conversationActive:!session.paused&&dialogue.some(t=>t.role==='cleo'&&(this.options.now?.()??Date.now())-t.at<90000)};
  }
  private async finishControl(binding:MeetingBinding,result:Extract<ReturnType<MeetingSessions['control']>,{status:'applied'}>,context?:MeetingTraceContext,speakerId?:string) {
    const actions=result.actions;
    if(actions.some(action=>['select','select_section','next','previous','walkthrough','explain'].includes(action))){
      this.navigationRevision.set(binding.sessionId,result.session.revision);
      const cached=this.steeringCache.get(binding.sessionId);if(cached?.value.action==='focus')cached.focusConsumed=true;
    }
    let privateReminder:string|undefined;
    if(actions.includes('remind')&&result.session.status==='active') {
      const controller=new AbortController();this.reminders.set(binding.sessionId,controller);
      try { privateReminder=this.options.intelligence?.remind?await this.measured(binding,'reminder',()=>this.options.intelligence!.remind!(binding,controller.signal),context,controller.signal):'Private reminder is unavailable right now.'; }
      catch {privateReminder='Private reminder was interrupted or unavailable. Nothing was spoken aloud.';}
      finally {if(this.reminders.get(binding.sessionId)===controller)this.reminders.delete(binding.sessionId);}
    }
    // Public replies never wait for document preparation or private reasoning.
    if(result.session.speak&&actions.some(a=>['greet','propose','speak','takeover','explain','walkthrough'].includes(a))) {
      const revision=result.session.speechRevision;
      this.afterRoomTurn(binding,async()=>{
        if(this.sessions.get(binding).speechRevision!==revision||this.queuedRoom.has(binding.sessionId))return;
        if(actions.includes('propose'))await this.propose(binding,context);
        else await this.respond(binding,actions.includes('greet')?'greeting':actions.some(a=>['explain','walkthrough'].includes(a))?'walkthrough':'conversation',false,context,speakerId);
      });
    }
    return { action: result.action, actions, ...(privateReminder?{private_reminder:privateReminder,reminder_audience:'owner_imessage_only'}:{}), ...this.status(binding) };
  }
  private cancel(binding: MeetingBinding,scopes:MeetingScope[]=['speech','share','guidance','end']) {
    const id=binding.sessionId;
    if(scopes.includes('end')||this.sessions.get(binding).paused||(scopes.includes('presentation')&&this.dialogueState.get(id)?.redlineId!==meetingFocus(this.sessions.get(binding))))this.dialogueState.delete(id);
    if(scopes.includes('speech')||scopes.includes('end')){
      this.roomWaiting.delete(id);
      this.negotiations.get(id)?.abort();this.voices.get(id)?.cancel();
    }
    if(scopes.includes('guidance')||scopes.includes('end'))this.reminders.get(id)?.abort();
    if(scopes.includes('end')){this.audioBacklog.delete(id);this.steeringWork.get(id)?.abort();this.steeringCache.delete(id);this.intents.get(id)?.controller.abort();this.options.intent?.close?.(id);}
    if(scopes.includes('share')||scopes.includes('end')) {
      for(const [token,share] of this.shares)if(share.binding.sessionId===id)this.shares.delete(token);
      // Hide promptly even if an earlier navigation is still preparing.
      if(!this.sessions.get(binding).share){const row=this.row(id);if(row?.bot)void this.options.attendee.share(row.bot,'').catch(()=>{});}
    }
  }
  private reconcile(binding: MeetingBinding): Promise<void> {
    const previous = this.queues.get(binding.sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const row = this.row(binding.sessionId); if (!row?.bot || this.closed) return;
      const s = this.sessions.get(binding);
      if (s.status === 'ended' || s.expiresAt <= (this.options.now?.() ?? Date.now())) {
        await this.options.presenter?.close(binding).catch(()=>{});
        this.voices.get(s.sessionId)?.close(); this.voices.delete(s.sessionId);
        this.sockets.get(s.sessionId)?.close();
        await Promise.allSettled([this.options.attendee.share(row.bot, '')]);
        await this.options.attendee.leave(row.bot);
        this.db.prepare("UPDATE meeting_transport SET state='leave_requested' WHERE session=?").run(s.sessionId); return;
      }
      if (!s.share) {await this.options.attendee.share(row.bot,'');await this.options.presenter?.close(binding).catch(()=>{});return;}
      const stillGranted=()=>{try{const current=this.sessions.lease(binding,'share');return !this.closed&&current.revision===s.shareRevision;}catch{return false;}};
      if(this.sharesHas(s.sessionId)){await this.preparePresentation(binding,stillGranted);return;}
      if(!stillGranted())return;
      // Publish the saved comparison immediately; browser preparation updates
      // this same authorized surface asynchronously without blanking it.
      const lease=this.sessions.lease(binding,'share');
      const token = freshToken();
      this.shares.set(hash(token), { binding, revision: lease.revision });
      try {
        await this.options.attendee.share(row.bot, new URL('/meeting/presentation#' + token, this.options.publicUrl).href);
        if (!stillGranted()) { this.shares.delete(hash(token)); await this.options.attendee.share(row.bot, '');return; }
        await this.preparePresentation(binding,stillGranted);
      } catch (error) { this.shares.delete(hash(token)); throw error; }
    });
    this.queues.set(binding.sessionId, current);
    void current.finally(() => { if (this.queues.get(binding.sessionId) === current) this.queues.delete(binding.sessionId); }).catch(() => {});
    return current;
  }
  private async preparePresentation(binding:MeetingBinding,valid:()=>boolean) {
    const s=this.sessions.get(binding);if(!s.googleDocumentId||!this.options.presenter||s.selectedSectionId)return;
    const view=this.sessions.publicView(binding),selected=view.redlines.find(r=>r.id===view.selectedRedlineId);
    this.presentationReady.delete(binding.sessionId);
    try {
      const queries=[...new Set([selected?.original,selected?.replacement].filter((v):v is string=>!!v).map(v=>v.replace(/\s+/g,' ').trim().slice(0,200)))];
      await this.measured(binding,'presentation',()=>this.options.presenter!.prepare(binding,s.googleDocumentId!,queries,valid,selected?presentationLocation(view,selected.id):undefined,view));
      if(valid()&&this.sessions.get(binding).selectedRedlineId===view.selectedRedlineId){this.presentationErrors.delete(binding.sessionId);this.presentationReady.set(binding.sessionId,view.selectedRedlineId);}
    } catch {this.presentationErrors.add(binding.sessionId);this.diagnose(binding,'presentation_saved_comparison_fallback');}
  }
  async presentationFrame(token:string,expectedSelectedRedlineId?:string|null) {
    const entry=this.shares.get(hash(token));if(!entry||!this.options.presenter)return undefined;
    const selected=this.sessions.get(entry.binding).selectedRedlineId;
    if(expectedSelectedRedlineId!==undefined&&selected!==expectedSelectedRedlineId)return undefined;
    const valid=()=>this.presentation(token)?.mode==='saved_snapshot'&&this.shares.get(hash(token))===entry&&this.sessions.get(entry.binding).selectedRedlineId===selected&&(expectedSelectedRedlineId===undefined||selected===expectedSelectedRedlineId);
    if(!valid())return undefined;
    try{const frame=await this.options.presenter.frame(entry.binding,valid);return valid()?frame:undefined;}catch{return undefined;}
  }
  presentation(token: string) {
    const entry = this.shares.get(hash(token));
    if (!entry) return undefined;
    try {
      const lease = this.sessions.lease(entry.binding, 'share');
      if (lease.revision !== entry.revision || !this.valid(lease)) return undefined;
      const view = this.sessions.publicView(entry.binding);
      const selected=view.redlines.find(r=>r.id===view.selectedRedlineId);
      const diffKey=entry.binding.sessionId+':'+selected?.id;
      if(selected&&!this.presentationDiffs.has(diffKey))this.presentationDiffs.set(diffKey,readableDiff(selected.original,selected.replacement));
      return { active: true, selectedRedlineId: view.selectedRedlineId, mode:!view.sections&&this.sessions.get(entry.binding).googleDocumentId&&this.options.presenter&&!this.presentationErrors.has(entry.binding.sessionId)&&this.presentationReady.has(entry.binding.sessionId)&&this.presentationReady.get(entry.binding.sessionId)===view.selectedRedlineId?'saved_snapshot':'contract',
        generation:entry.revision,leaseExpiresAt:lease.expiresAt,leaseMs:Math.max(0,lease.expiresAt-(this.options.now?.()??Date.now())),
        fallbackReason:this.presentationErrors.has(entry.binding.sessionId)?'Snapshot unavailable; showing the saved comparison.':undefined,
        selectedDiff:selected?this.presentationDiffs.get(diffKey):null,
        document: { title: view.title, paragraphs:view.paragraphs,redlines:view.redlines,...(view.sections?{sections:view.sections}:{}) },selectedSectionId:view.selectedSectionId };
    } catch { return undefined; }
  }
  private async ensureVoice(binding:MeetingBinding):Promise<MeetingRealtime<MeetingLease>|undefined> {
    const id=binding.sessionId,existing=this.voices.get(id);if(existing)return existing;
    if(this.closed||(this.voiceRetryAt.get(id)??0)>Date.now())return undefined;
    if(this.connecting.has(id))return this.connecting.get(id);
    const connect=(async()=>{
      const Voice=this.options.Voice??MeetingRealtime;
      const gate=new MeetingTranscriptGate((event,source)=>{void this.acceptTranscript(binding,event,source).catch(()=>{});},this.options.now,this.options.directTranscriptFallbackMs,update=>this.enrichSpeaker(binding,update));
      this.transcriptGates.get(id)?.close();this.transcriptGates.set(id,gate);
      const voice=new Voice<MeetingLease>({apiKey:this.options.openaiKey,vadProfile:this.options.vadProfile,
        valid:lease=>{if(!this.valid(lease))return false;if(lease.expiresAt-(this.options.now?.()??Date.now())<10000){const next=this.sessions.lease(lease,'speak');if(next.revision!==lease.revision)return false;lease.expiresAt=next.expiresAt;}return true;},
        diagnose:(event,context)=>this.diagnose(binding,event,context),
        onTranscript:event=>{const now=this.options.now?.()??Date.now();gate.direct(event.id,{id:'direct-'+hash(event.id),text:event.text,at:new Date(now).toISOString(),speakerId:undefined});},
        onSpeechStart:turnId=>{const speakersBefore=[...(this.roomSpeakers.get(id)??[])].filter(s=>s!=='realtime-vad').map(s=>this.speakerAlias(binding,s));const traceId=gate.start(turnId,speakersBefore)??randomUUID();this.diagnose(binding,'meeting_room_speech_started',{turnId:traceId});const speakers=this.roomSpeakers.get(id)??new Set<string>();speakers.add('realtime-vad');this.roomSpeakers.set(id,speakers);this.interruptRoom(binding);},
        onSpeechStop:turnId=>{const traceId=gate.stop(turnId);if(turnId&&!traceId)return;this.diagnose(binding,'meeting_room_speech_stopped',traceId?{turnId:traceId}:undefined);this.roomSpeakers.get(id)?.delete('realtime-vad');this.flushRoom(binding);},
        onPublicTranscript:text=>{try{this.sessions.recordPublicSpeech(binding,text);}catch{/* Ended meanwhile. */}},
        onClose:()=>{gate.close();if(this.transcriptGates.get(id)===gate)this.transcriptGates.delete(id);if(this.voices.get(id)===voice){this.voices.delete(id);this.voiceRetryAt.set(id,Date.now()+1000);}},
        send:packet=>{const socket=this.sockets.get(id);if(!socket||socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>1920)return false;socket.send(JSON.stringify(packet));return true;}});
      try{await voice.connect();this.active(binding);if(!this.sockets.has(id)){voice.close();return undefined;}this.voices.set(id,voice);this.voiceRetryAt.delete(id);for(const chunk of this.audioBacklog.get(id)??[])voice.receiveAudio(chunk);this.audioBacklog.delete(id);this.diagnose(binding,'meeting_voice_connected');return voice;}
      catch{voice.close();this.voiceRetryAt.set(id,Date.now()+2000);this.diagnose(binding,'meeting_voice_connect_failed');return undefined;}
    })();
    this.connecting.set(id,connect);try{return await connect;}finally{this.connecting.delete(id);}
  }
  // Compatibility for explicitly prepared, evidence-bound scripts only.
  async speak(binding: MeetingBinding, prepared?: {text:string;lease:MeetingLease},context?:MeetingTraceContext) {
    if(!prepared)return this.respond(binding);
    const voice=await this.ensureVoice(binding);
    // Connection setup can yield while someone starts speaking. Discard this
    // prepared turn instead of playing over them or replaying it later.
    if(!voice||!this.valid(prepared.lease)||this.roomSpeakers.get(binding.sessionId)?.size)return false;
    const sentences=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(prepared.text)].map(part=>part.segment.trim()).filter(Boolean);
    for(const sentence of sentences){
      if(!this.valid(prepared.lease)||this.roomSpeakers.get(binding.sessionId)?.size)return false;
      const revision=this.sessions.get(binding).guidanceRevision;
      if(!await voice.speak(sentence,prepared.lease,context))return false;
      if(!this.valid(prepared.lease))return false;
      this.sessions.recordPublicSpeech(binding,sentence);
      const next=this.steeringCache.get(binding.sessionId);
      if(next&&next.revision!==revision&&next.revision===this.sessions.get(binding).guidanceRevision&&next.context===JSON.stringify(this.sessions.recentTranscript(binding))&&next.value.action!=='none'){
        if(next.value.action==='yield')return true;
        return this.respond(binding,'conversation',true,context);
      }
    }
    return true;
  }
  private flushRoom(binding:MeetingBinding){
    const id=binding.sessionId;if(this.roomSpeakers.get(id)?.size)return;
    const waiting=this.roomWaiting.get(id);this.roomWaiting.delete(id);
    if(waiting&&this.sessions.get(binding).speechRevision===waiting.revision)this.afterRoomTurn(binding,waiting.work);
  }
  private afterRoomTurn(binding:MeetingBinding,work:()=>Promise<unknown>) {
    if(this.roomSpeakers.get(binding.sessionId)?.size){this.roomWaiting.set(binding.sessionId,{revision:this.sessions.get(binding).speechRevision,work});return;}
    void work().catch(()=>{});
  }
  async respond(binding: MeetingBinding, mode:'conversation'|'walkthrough'|'greeting'='conversation', continuation=false,context?:MeetingTraceContext,speakerId?:string) {
    const id=binding.sessionId,session=this.sessions.get(binding);
    if(this.closed||!session.speak||session.paused)return false;
    if(this.roomSpeakers.get(id)?.size){this.afterRoomTurn(binding,()=>this.respond(binding,mode,continuation,context,speakerId));return false;}
    // Never replay a queued old reply after a transport reconnect.
    if(!this.sockets.has(id)){this.diagnose(binding,'meeting_voice_audio_not_connected');return false;}
    const lease=this.sessions.lease(binding,'speak');
    const voice=await this.ensureVoice(binding);if(!voice||!this.valid(lease))return false;
    const voiceTurn=Symbol();this.pendingVoice.set(id,voiceTurn);
    try{
      if(typeof voice.respond!=='function'){this.diagnose(binding,'meeting_voice_direct_path_unavailable');return false;}
      let sent=false;
      // A short conversational beat completes before new owner guidance is
      // applied. Human interruption still cancels audio immediately.
      for(let sentence=0;sentence<3;sentence++) {
        if(!this.valid(lease)||this.roomSpeakers.get(id)?.size)return sent;
        let view=this.sessions.publicView(binding);const cached=this.steeringCache.get(id);
        const currentRevision=this.sessions.get(binding).guidanceRevision;
        const steering=cached?.revision===currentRevision&&cached.context===JSON.stringify(this.sessions.recentTranscript(binding))?cached.value:undefined;
        if(steering?.action==='yield'&&mode!=='greeting')return sent;
        const safe:SafeMeetingSteering={direction:steering?.action==='ask'||steering?.action==='clarify'?'clarify':steering?.action==='push_back'?'push_back':steering?.action==='defer'?'defer':'explain',allowProposals:false};
        if(mode==='conversation'&&cached&&!cached.focusConsumed&&steering?.action==='focus'&&view.redlines.some(r=>r.id===steering.redlineId)){
          cached.focusConsumed=true;
          this.sessions.resolveControl(binding,this.sessions.get(binding).revision,{action:'select',redlineId:steering.redlineId});
          view=this.sessions.publicView(binding);
        }
        const appliedRevision=currentRevision;
        const completed=await voice.respond({traceContext:context,document:view,dialogue:this.sessions.recentTranscript(binding),previousSpeech:this.sessions.publicUtterances(binding),publicTurns:this.sessions.publicDialogue(binding),selectedRedlineId:view.selectedRedlineId,selectedSectionId:view.selectedSectionId,mode,continuation:continuation||sentence>0,steering:this.options.steering?.(binding)??safe},lease);
        if(!completed)return false;
        sent=true;
        if(!this.valid(lease)||this.roomSpeakers.get(id)?.size)return sent;
        // Waiting invites a new participant turn; it is not a playback receipt.
        this.dialogueState.set(id,{traceId:context?.turnId,speakerId:context?.turnId?this.sessions.speakerForTurn(binding,context.turnId):speakerId,at:this.options.now?.()??Date.now(),redlineId:meetingFocus(view),mode,awaitingQuestion:mode==='walkthrough'});
        const next=this.steeringCache.get(id);
        if(mode==='greeting'||!next||next.revision===appliedRevision||next.revision!==this.sessions.get(binding).guidanceRevision||next.context!==JSON.stringify(this.sessions.recentTranscript(binding))||next.value.action==='none')break;
      }
      return sent;
    }finally{if(this.pendingVoice.get(id)===voiceTurn)this.pendingVoice.delete(id);}
  }
  private async propose(binding:MeetingBinding,context?:MeetingTraceContext){
    if(!this.options.intelligence?.reply||!this.sockets.has(binding.sessionId))return false;
    const id=binding.sessionId,controller=new AbortController(),revision=this.sessions.get(binding).guidanceRevision,voiceTurn=Symbol();
    this.negotiations.get(id)?.abort();this.negotiations.set(id,controller);this.diagnose(binding,'meeting_proposal_private_review');
    try{
      // The candidate is generated exclusively from public evidence. reply's
      // private director reviews it BEFORE the compatibility script can play.
      const candidate=await this.measured(binding,'proposal',()=>this.options.intelligence!.reply(binding,controller.signal),context,controller.signal);
      this.diagnose(binding,'meeting_proposal_review_completed');
      if(!candidate||controller.signal.aborted||this.roomSpeakers.get(id)?.size||revision!==this.sessions.get(binding).guidanceRevision||!this.valid(candidate.lease))return false;
      // Review is checked before playback. Later ordinary guidance must not
      // invalidate the active sentence; stops still revoke its speech lease.
      this.pendingVoice.set(id,voiceTurn);return await this.speak(binding,candidate,context);
    }finally{if(this.pendingVoice.get(id)===voiceTurn)this.pendingVoice.delete(id);if(this.negotiations.get(id)===controller)this.negotiations.delete(id);}
  }
  attach(server: Server) {
    server.on('upgrade', (request, socket, head) => {
      let row: Row | undefined;
      try {
        const url = new URL(request.url ?? '/', this.options.publicUrl);
        const token = /^\/meeting\/audio\/([\w-]{43})$/.exec(url.pathname)?.[1];
        if (!token || request.headers.origin || url.search || this.closed) throw new Error('Unauthorized');
        row = this.db.prepare('SELECT * FROM meeting_transport WHERE audio_hash=?').get(hash(token)) as Row | undefined;
        if (!row?.bot) throw new Error('Not bound');
        this.active(JSON.parse(row.binding));
      } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const bound = row!;
      this.wss.handleUpgrade(request, socket, head, ws => {
        this.sockets.get(bound.session)?.close(); this.voices.get(bound.session)?.cancel();
        this.sockets.set(bound.session, ws);this.lastAudio.delete(bound.session);
        void this.ensureVoice(JSON.parse(bound.binding));
        void this.options.intent?.prepare?.(bound.session).catch(()=>{this.diagnose(JSON.parse(bound.binding),'meeting_interpreter_warm_failed');});
        ws.on('error', () => { /* Do not log provider payloads or access URLs. */ });
        ws.on('close', () => {
          if (this.sockets.get(bound.session) !== ws) return;
          this.sockets.delete(bound.session); this.voices.get(bound.session)?.close(); this.voices.delete(bound.session);
        });
        ws.on('message', (raw, binary) => {
          try {
            if (binary || this.sockets.get(bound.session) !== ws) throw new Error('Invalid audio');
            this.active(JSON.parse(bound.binding));
            const event = JSON.parse(raw.toString());
            if (event.bot_id !== bound.bot || event.trigger !== 'realtime_audio.mixed' || event.data?.sample_rate !== 24000 ||
              typeof event.data.chunk !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data.chunk)) throw new Error('Invalid audio');
            const timestamp = event.data.timestamp_ms;
            if (!Number.isFinite(timestamp) || timestamp <= (this.lastAudio.get(bound.session) ?? -1)) return;
            const bytes = Buffer.from(event.data.chunk, 'base64');
            if (!bytes.length || bytes.length > 96000 || bytes.length % 2) throw new Error('Invalid audio');
            this.lastAudio.set(bound.session, timestamp);
            const voice=this.voices.get(bound.session);
            if(voice)voice.receiveAudio(bytes);
            else {
              const backlog=this.audioBacklog.get(bound.session)??[];backlog.push(bytes);
              while(backlog.reduce((total,b)=>total+b.length,0)>96000)backlog.shift();
              this.audioBacklog.set(bound.session,backlog);void this.ensureVoice(JSON.parse(bound.binding));
            }
          } catch { ws.close(1008, 'Invalid meeting stream'); }
        });
      });
    });
  }
  async webhook(token: string, payload: Record<string, any>, signature?: unknown) {
    const row = this.db.prepare('SELECT * FROM meeting_transport WHERE events_hash=?').get(hash(token)) as Row | undefined;
    if (!row?.bot || payload.bot_id !== row.bot || (this.options.webhookSecret && !verifyAttendeeWebhook(payload, signature, this.options.webhookSecret))) return false;
    const binding: MeetingBinding = JSON.parse(row.binding);
    if (typeof payload.idempotency_key !== 'string' || !/^[\w-]{1,200}$/.test(payload.idempotency_key)) return false;
    const fingerprint = hash(JSON.stringify(payload));
    const old = this.db.prepare('SELECT session,fingerprint FROM meeting_provider_events WHERE id=?').get(payload.idempotency_key);
    if (old) return old.session === row.session && old.fingerprint === fingerprint;
    if (!['bot.state_change','transcript.update','participant_events.speech_start_stop','participant_events.join_leave'].includes(payload.trigger)) return false;
    this.db.prepare('INSERT INTO meeting_provider_events VALUES(?,?,?)').run(payload.idempotency_key, row.session, fingerprint);
    if (payload.trigger === 'bot.state_change') {
      const state = payload.data?.new_state;
      if (typeof state !== 'string' || !/^[a-z_]{1,60}$/.test(state)) return false;
      this.db.prepare('UPDATE meeting_transport SET state=? WHERE session=?').run(state, row.session);
      if (['ended','fatal_error','post_processing'].includes(state)) this.sessions.end(binding);
      else if (['joined_recording','joined_not_recording'].includes(state) && this.sessions.get(binding).share) {
        void this.reconcile(binding).catch(() => {});
      }
    } else if(['participant_events.speech_start_stop','participant_events.join_leave'].includes(payload.trigger)) {
      const data=payload.data,participant=data?.participant_uuid,key=binding.sessionId+':'+participant;
      if(this.options.intent&&['speech_start','speech_stop','leave'].includes(data?.event_type)&&typeof participant==='string'&&participant&&this.freshRoomEvent(binding,data.timestamp_ms,false)&&data.timestamp_ms>=(this.roomActivityClock.get(key)??0)) {
        this.roomActivityClock.set(key,data.timestamp_ms);
        const speakers=this.roomSpeakers.get(binding.sessionId)??new Set<string>();this.roomSpeakers.set(binding.sessionId,speakers);
        if(data.event_type==='speech_start'){speakers.add(participant);this.transcriptGates.get(binding.sessionId)?.speaker(this.speakerAlias(binding,participant));this.interruptRoom(binding);}
        else {
          speakers.delete(participant);
          this.flushRoom(binding);
        }
      }
    } else {
      const text = payload.data?.transcription?.transcript;
      if (typeof text !== 'string' || !text.trim() || text.length > 6000) return false;
      try { this.active(binding); } catch { return true; }
      // Captions may contain our own voice. Never let those start a feedback loop.
      const speaker = payload.data?.participant;
      if (speaker?.is_bot === true || /^cleo$/i.test(String(payload.data?.speaker_name ?? speaker?.full_name ?? speaker?.name ?? ''))) return true;
      if(!this.freshRoomEvent(binding,payload.data.timestamp_ms,false)||typeof payload.data.speaker_uuid!=='string'||!payload.data.speaker_uuid)return true;
      const event={id:payload.idempotency_key,text,at:new Date(payload.data.timestamp_ms).toISOString(),speakerId:this.speakerAlias(binding,payload.data.speaker_uuid)};
      const duration=payload.data.duration_ms;
      if(this.transcriptGates.get(binding.sessionId)?.caption({...event,
        ...(Number.isFinite(duration)&&duration>=0?{durationMs:duration}:{})}))return true;
      // Direct audio transcription wins the normal latency path. Captions remain
      // a short-delay fallback and are deduplicated against that same utterance.
      const timer=setTimeout(()=>{this.captionTimers.delete(timer);void this.acceptTranscript(binding,event,'caption').catch(()=>{});},this.options.captionFallbackMs??500);timer.unref();this.captionTimers.add(timer);

    }
    return true;
  }
  private speakerAlias(binding:MeetingBinding,id:string){return 'speaker-'+hash(binding.sessionId+':'+id).slice(0,16);}
  private freshRoomEvent(binding:MeetingBinding,at:unknown,caption=true) {
    try{const s=this.active(binding),now=this.options.now?.()??Date.now();return typeof at==='number'&&Number.isFinite(at)&&at>=s.createdAt&&at>=now-30000&&at<=now+5000&&(!caption||at>=(this.roomClock.get(binding.sessionId)??0))&&(!caption||at>=this.sessions.lastOwnerControlAt(binding));}catch{return false;}
  }
  private enrichSpeaker(binding:MeetingBinding,update:{id:string;traceId:string;speakerId?:string}) {
    try{
      this.sessions.enrichTranscriptSpeaker(binding,update);
      const current=this.dialogueState.get(binding.sessionId);
      if(current?.traceId===update.traceId)current.speakerId=this.sessions.speakerForTurn(binding,update.traceId);
    }catch{/* An ended meeting cannot receive late metadata. */}
  }
  private async acceptTranscript(binding:MeetingBinding,event:Transcript,source:'direct'|'caption'){
    if(!this.freshRoomEvent(binding,Date.parse(event.at),false))return;
    const normalize=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    const text=normalize(event.text);if(!text)return;
    const now=this.options.now?.()??Date.now(),at=Date.parse(event.at);
    const heard=(this.heard.get(binding.sessionId)??[]).filter(t=>now-t.receivedAt<10000);
    if(heard.some(t=>t.source===source&&t.id===event.id))return;
    // Pair at most one exact normalized copy from the other ingress. Repeated
    // words with a fresh same-source ID are new utterances, including stops.
    const candidates=heard.filter(t=>t.source!==source&&!t.paired&&t.text===text&&Math.abs(t.at-at)<=2500)
      .sort((a,b)=>Math.abs(a.at-at)-Math.abs(b.at-at));
    const counterpart=candidates[0];
    if(counterpart){
      counterpart.paired=true;
      if(candidates.length===1&&source==='caption'&&event.speakerId&&counterpart.traceId)this.enrichSpeaker(binding,{id:counterpart.id,traceId:counterpart.traceId,speakerId:event.speakerId});
      heard.push({id:event.id,source,text,at,receivedAt:now,paired:true});this.heard.set(binding.sessionId,heard.slice(-80));
      return;
    }
    if(source==='caption'&&!this.freshRoomEvent(binding,at))return;
    event={...event,traceId:event.traceId??randomUUID()};
    heard.push({id:event.id,source,text,at,receivedAt:now,paired:false,traceId:event.traceId});this.heard.set(binding.sessionId,heard.slice(-80));
    this.roomClock.set(binding.sessionId,Math.max(Date.parse(event.at),this.roomClock.get(binding.sessionId)??0));
    this.interruptRoom(binding);
    const previous=this.dialogueState.get(binding.sessionId);
    if(!event.speakerId||event.speakerId!==previous?.speakerId)this.dialogueState.delete(binding.sessionId);
    const context={turnId:event.traceId!};
    this.sessions.transcript(binding,event);this.refreshSteering(binding,context);this.diagnose(binding,source==='direct'?'meeting_transcript_direct':'meeting_transcript_caption_fallback',context);
    // Keep optional context enrichment independent of public speech; no automatic private notices.
    void this.options.onTranscript?.(binding,event).catch(()=>{});
    await this.roomRequest(binding,event);
  }
  private interruptRoom(binding:MeetingBinding) {
    if(this.pendingVoice.has(binding.sessionId)||this.negotiations.has(binding.sessionId)||this.roomWaiting.has(binding.sessionId))this.sessions.interruptSpeech(binding);
  }
  private async roomRequest(binding:MeetingBinding,event:Transcript) {
    if(!this.options.intent)return;
    const context={turnId:event.traceId??randomUUID()};
    const immediate=parseMeetingCommand(event.text),atoms=immediate.actions??[immediate];
    if(atoms.every(a=>['quiet','stop_share','stop'].includes(a.action))){const result=this.sessions.resolveControl(binding,this.sessions.get(binding).revision,immediate);await this.finishControl(binding,result);return;}
    if(this.intents.has(binding.sessionId)){this.queuedRoom.set(binding.sessionId,event);return;}
    const state=this.sessions.get(binding),conversation=this.dialogueState.get(binding.sessionId),direct=this.options.fastFollowups===false?undefined:directMeetingConversation(event.text);
    if(direct){
      this.diagnose(binding,'meeting_direct_fast_path',context);
      const result=this.sessions.resolveControl(binding,state.revision,{action:direct});
      await this.finishControl(binding,result,context,event.speakerId);return;
    }
    if(this.options.fastFollowups!==false&&!state.paused&&conversation&&event.speakerId&&event.speakerId===conversation.speakerId&&meetingFocus(state)===conversation.redlineId&&(this.options.now?.()??Date.now())-conversation.at<90000&&isSimpleMeetingFollowup(event.text)){
      this.diagnose(binding,'meeting_followup_fast_path',context);
      const result=this.sessions.resolveControl(binding,state.revision,{action:conversation.mode==='walkthrough'?'explain':'speak'});
      await this.finishControl(binding,result,context,event.speakerId);return;
    }
    const revision=state.revision,controller=new AbortController();
    this.intents.set(binding.sessionId,{controller,channel:'meeting'});
    this.diagnose(binding,'meeting_intent_started',context);
    try {
      const intent=await this.measured(binding,'intent',()=>this.options.intent!.resolve(this.intentInput(binding,event.text,'meeting',event.speakerId),controller.signal),context,controller.signal);
      this.diagnose(binding,'meeting_intent_completed',context);
      this.diagnose(binding,!intent.addressed?'meeting_intent_ignored':intent.command.action==='note'?'meeting_intent_note':'meeting_intent_addressed',context);
      if(controller.signal.aborted||this.closed||this.sessions.get(binding).revision!==revision)return;
      this.intentErrors.delete(binding.sessionId);
      if(intent.addressed&&intent.command.action!=='note') {
        if(this.intents.get(binding.sessionId)?.controller===controller)this.intents.delete(binding.sessionId);
        const result=this.sessions.resolveControl(binding,revision,intent.command);
        const response=await this.finishControl(binding,result,context,event.speakerId);
        if(response.private_reminder&&this.options.messenger&&this.sessions.get(binding).guidanceRevision===result.session.guidanceRevision&&this.sessions.get(binding).status==='active') {
          const id='reminder-'+hash(event.id);if(this.sessions.claimDelivery(binding,id)) {
            const delivery=await this.options.messenger.send({owner:binding.owner,text:'Private meeting reminder: '+response.private_reminder});
            this.sessions.deliveryStatus(binding,id,delivery.status);
          }
        }
      }
    }catch{if(!controller.signal.aborted&&!this.closed){this.intentErrors.add(binding.sessionId);this.diagnose(binding,'meeting_intent_failed',context);}}
    finally{if(this.intents.get(binding.sessionId)?.controller===controller)this.intents.delete(binding.sessionId);const queued=this.queuedRoom.get(binding.sessionId);this.queuedRoom.delete(binding.sessionId);if(queued&&this.freshRoomEvent(binding,Date.parse(queued.at)))void this.roomRequest(binding,queued).catch(()=>{});}
  }
  async recover() {
    // Restart invalidates public permissions. Remove any remote presentation left over.
    for (const row of this.db.prepare('SELECT * FROM meeting_transport WHERE bot IS NOT NULL').all() as Row[]) {
      if (['ended','fatal_error','leave_requested'].includes(row.state)) continue;
      try { const binding = JSON.parse(row.binding); this.expireAtEnd(binding); await this.reconcile(binding); } catch { /* Status remains unconfirmed; no grants restored. */ }
    }
  }
  async close() {
    for(const gate of this.transcriptGates.values())gate.close();this.transcriptGates.clear();
    this.closed = true; this.removeListener();for(const controller of this.steeringWork.values())controller.abort();for(const timer of this.captionTimers)clearTimeout(timer);this.options.intent?.close?.(); this.shares.clear();
    for(const {controller} of this.intents.values())controller.abort();this.intents.clear();this.queuedRoom.clear();this.roomWaiting.clear();this.roomSpeakers.clear();
    this.presentationDiffs.clear();this.dialogueState.clear();
    for(const controller of this.reminders.values())controller.abort();
    for (const timer of this.expirations.values()) clearTimeout(timer);
    for (const controller of this.negotiations.values()) controller.abort();
    for (const voice of this.voices.values()) voice.close();
    for (const socket of this.sockets.values()) socket.close();
    this.wss.close();
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled((this.db.prepare('SELECT * FROM meeting_transport WHERE bot IS NOT NULL').all() as Row[])
      .filter(row => !['ended','fatal_error','leave_requested'].includes(row.state)).map(async row => {
        await this.options.presenter?.close(JSON.parse(row.binding)).catch(()=>{});
        await this.options.attendee.share(row.bot!, '');
        await this.options.attendee.leave(row.bot!);
      }));
    this.db.close();
  }
}
