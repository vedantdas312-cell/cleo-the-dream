import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DocumentError } from './docx.ts';
import { Workflow, type ToolRequest } from './workflow.ts';
import { MeetingTransport } from './meeting-transport.ts';
import { meetingCommandHelp, verifiedKeikiToolEvent, verifyKeikiMeetingIdentity } from './meeting-keiki.ts';
import { presentationCsp, presentationHtml } from './meeting-presentation.ts';
import { verifiedKeikiSender } from './keiki-sender.ts';

async function rawBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length; if (bytes > limit) throw new DocumentError('Meeting request is too large.'); chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export class MeetingRoutes {
  readonly transport: MeetingTransport; private workflow: Workflow;
  private identity: { secret: string; agentId: string; line: string };
  constructor(transport: MeetingTransport, workflow: Workflow, identity: {secret: string; agentId: string; line: string}) {
    this.transport = transport; this.workflow = workflow; this.identity = identity;
  }
  authenticateTool(raw: string, request: IncomingMessage, body: ToolRequest) {
    // Same documented signing algorithm as the identity callback. The unique
    // configured agent secret authenticates the sender; ChannelEnvelope is
    // platform-stamped, outside the model's input object.
    const timestamp = request.headers['x-keiki-timestamp'], signature = request.headers['x-keiki-signature'];
    if (!this.identity.agentId || !this.identity.line || this.identity.secret.length < 32 || typeof timestamp !== 'string' ||
      typeof signature !== 'string' || !/^\d+$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
    const instant = Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp);
    if (!Number.isFinite(instant) || Math.abs(Date.now() - instant) > 300000) return false;
    const expected = createHmac('sha256', this.identity.secret).update(timestamp + '.' + raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) return false;
    try { verifiedKeikiSender(body,this.identity); this.workflow.owner(body); return true; } catch { return false; }
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/meeting/')) return false;
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); return true; };
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && url.pathname === '/meeting/presentation') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': presentationCsp,
        'Permissions-Policy': 'camera=(), microphone=(), display-capture=()', 'X-Frame-Options': 'DENY' });
      response.end(presentationHtml); return true;
    }
    if (request.method === 'GET' && url.pathname === '/meeting/presentation-data') {
      const token = /^Bearer ([\w-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
      const view = token ? this.transport.presentation(token) : undefined;
      return view ? json(200, view) : json(403, { active: false });
    }
    if (request.method === 'GET' && url.pathname === '/meeting/presentation-events') {
      const token = /^Bearer ([\w-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
      if (!token || !this.transport.presentation(token)) return json(403, { active: false });
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      let closed = false;
      let unsubscribe = () => {};
      const finish = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); response.end(); };
      const notify = () => {
        if (closed) return;
        const active = !!this.transport.presentation(token);
        // Only state notifications cross this stream. Contract content stays
        // behind the independently authorized presentation-data request.
        response.write(`event: ${active ? 'refresh' : 'revoked'}\ndata: {}\n\n`);
        if (!active) finish();
      };
      const heartbeat = setInterval(() => {
        if (!this.transport.presentation(token)) notify();
        else response.write(': keepalive\n\n');
      }, 15000);
      heartbeat.unref();
      unsubscribe = this.transport.sessions.onRevoke((_binding, scopes) => {
        if (!scopes || scopes.some(scope => ['share','presentation','end'].includes(scope))) notify();
      });
      response.on('close', finish);
      notify();
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/meeting/presentation-frame') {
      const token=/^Bearer ([\w-]{43})$/.exec(request.headers.authorization??'')?.[1];
      const selection=request.headers['x-cleo-redline'];
      if(selection!==undefined&&(typeof selection!=='string'||! /^(?:none|r[1-9]\d{0,2})$/.test(selection)))return json(400,{active:false});
      const frame=token?await this.transport.presentationFrame(token,selection==='none'?null:selection as string|undefined):undefined;
      response.setHeader('Cache-Control','no-store');
      if(!frame)return json(403,{active:false});
      response.writeHead(200,{'Content-Type':frame.mimeType});response.end(Buffer.from(frame.imageB64,'base64'));return true;
    }
    if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) return json(404, { error: 'Not found.' });
    const callback = /^\/meeting\/events\/([\w-]{43})$/.exec(url.pathname);
    if (callback) {
      let body: unknown;
      try { body = JSON.parse(await rawBody(request, 128000)); } catch { return json(400, { error: 'Invalid event.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid event.' });
      const accepted = await this.transport.webhook(callback[1], body, request.headers['x-webhook-signature']);
      return json(accepted ? 200 : 401, { accepted });
    }
    if (url.pathname === '/meeting/identity') {
      if (!this.identity.secret || !this.identity.agentId || !this.identity.line) return json(503, { error: 'Meeting identity is not configured.' });
      let verified;
      try {
        verified = verifyKeikiMeetingIdentity({ ...this.identity, rawBody: await rawBody(request, 64000),
          timestamp: String(request.headers['x-keiki-timestamp'] ?? ''), signature: String(request.headers['x-keiki-signature'] ?? ''),
          resolveOwner: phone => /^\+[1-9]\d{7,14}$/.test(phone) ? this.workflow.ownerForSender(phone) : undefined,
        });
      } catch { return json(401, { error: 'Unverified meeting identity.' }); }
      await this.workflow.registerSender({input:{},context:{phone:verified.phone,agentId:this.identity.agentId,
        channel:{channel:'imessage',provider:'photon',teamId:this.identity.line,userId:verified.phone,isDirect:true}}});
      const events = verified.events.map(event => this.transport.sessions.recordIngress(event));
      const session = this.transport.sessions.active(verified.owner);
      let reply: string | undefined;
      if (session) {
        for (const event of events) {
          try {
            const result = await this.transport.control(session, event);
            if('private_reminder' in result&&result.private_reminder)reply=result.private_reminder;
            else if ('action' in result && result.action !== 'note') reply = result.action==='combined'
              ? 'Your combined requests were applied to the current meeting. Speech and screen delivery remain subject to the connection status.'
              : result.action==='walkthrough' ? 'I will walk through the saved document one passage at a time when meeting audio is connected.'
              : ['speak','explain','takeover','greet','propose'].includes(result.action)
              ? 'I received your request to speak in the meeting. Audio delivery is not confirmed yet.'
              : result.action === 'share' ? 'Document sharing requested. Only the dedicated saved document view can be shown.'
              : result.action === 'stop' ? 'Public output stopped. Leaving the meeting was requested.'
              : result.action === 'quiet' ? 'Public speech stopped.'
              : result.action === 'stop_share' ? 'The public contract view is closed. Stopping the provider screen share was requested.'
              : 'Selected passage updated. Nothing has been accepted or signed.';
          } catch { reply = 'That meeting action was not confirmed. Public output remains subject to the current permissions; please check the meeting status.'; }
        }
      }
      return json(200, { userId: verified.owner, role: 'owner', scopes: ['cleo:contracts'], ttlSeconds: 0, ...(reply ? { reply } : {}) });
    }
    return json(404, { error: 'Not found.' });
  }
  async tool(path: string, body: ToolRequest) {
    const owner = this.workflow.owner(body), input = body.input as Record<string, unknown>;
    if (path === '/tools/meeting_control' || path === '/tools/join_meeting') {
      const event = this.transport.sessions.recordIngress(verifiedKeikiToolEvent(body,this.identity.agentId,this.identity.line,owner));
      if (path === '/tools/meeting_control') {
        const session = this.transport.sessions.active(owner);
        if (!session) return { status:'no_active_meeting' };
        const result=await this.transport.control(session,event);
        return {...result,instruction:'private_reminder' in result&&result.private_reminder?'Reply with private_reminder only to this owner over iMessage. Never repeat it to the meeting. Report any sharing status separately.':'action' in result && result.action==='note'?'Recorded privately. Do not repeat this instruction publicly.':'Report the actual permissions, not confirmed playback or screen delivery.'};
      }
    }
    if (path === '/tools/join_meeting') {
      if (typeof input.meeting_url !== 'string' || typeof input.request_id !== 'string' ||
        ['source_id','output_id','draft_id'].some(k=>input[k]!==undefined&&typeof input[k]!=='string')) throw new DocumentError('Choose a saved document, Google Meet link and stable request ID.');
      const channel = body.context.channel as Record<string, unknown> | undefined;
      const requestId = typeof channel === 'object' && typeof channel.messageId === 'string' ? channel.messageId : input.request_id;
      await this.transport.requireJoinIntent(owner, input.meeting_url, requestId);
      const selected=await this.workflow.meetingSelection(owner,input);
      const {sourceId,outputId,document}=selected;
      const session = this.transport.sessions.create({ owner, sourceId, meetingUrl: input.meeting_url,requestId,publicDocument:document });
      if(!document.sections){
        const googleDocument=await this.workflow.meetingGoogleDocument?.(owner,sourceId,outputId);
        if(googleDocument)this.transport.sessions.bindGoogleDocument(session,googleDocument);
      }
      const result = await this.transport.join(session);
      return { ...result, source_id: session.sourceId, output_id:outputId, saved_redlines:document.redlines.length,saved_passages:document.sections?.length, presentation:document.sections?'saved_document_view':'saved_contract_view', instruction: meetingCommandHelp(),
        meeting_context: 'Cleo listens for meeting context. Text questions receive private answers; ordinary guidance applies at a natural sentence boundary.' };
    }
    const session = this.transport.sessions.active(owner);
    if (!session) {
      let directMessageVerified = false;
      try { verifiedKeikiToolEvent(body,this.identity.agentId,this.identity.line,owner); directMessageVerified = true; } catch { /* Read-only setup result. */ }
      return { status: 'no_active_meeting', meetings_enabled: true, direct_message_controls_verified: directMessageVerified,
        instruction: directMessageVerified ? 'Ready to receive a direct Meet link and saved contract or generated draft. Joining will be quiet.' : 'The current request lacks verified direct iMessage evidence. Do not claim meeting controls are connected.' };
    }
    if (input.session_id !== undefined && input.session_id !== session.sessionId) throw new DocumentError('This meeting is not the current owner session.');
    return this.transport.status(session);
  }
}
