import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage } from 'node:http';
import { DocumentError } from './docx.ts';
import { Workflow, equalSecret, type ToolRequest } from './workflow.ts';
import { LegalSkillLibrary } from './legal-skills.ts';
import type { MeetingRoutes } from './meeting-routes.ts';
import { serveLanding } from './landing.ts';

async function readJson(request: IncomingMessage): Promise<{body: ToolRequest; raw: string}> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new DocumentError('Tool request is too large.');
    chunks.push(chunk);
  }
  try { const raw = Buffer.concat(chunks).toString(); return {body: JSON.parse(raw), raw}; }
  catch { throw new DocumentError('Send valid JSON.'); }
}

export function createApp(workflow: Workflow, skills = new LegalSkillLibrary(), meetings?: MeetingRoutes) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? '/', workflow.config.publicUrl);
      if (request.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, service: 'cleo-redlines', revision: process.env.CLEO_BUILD_SHA ?? 'development' });
      if (await serveLanding(request, response, url)) return;
      if (meetings && await meetings.handle(request, response, url)) return;
      if (request.method === 'GET' && (url.pathname.startsWith('/files/') || url.pathname.startsWith('/drafts/') || url.pathname.startsWith('/previews/'))) {
        const file = await workflow.download(url);
        const filename = ['Cleo-draft.docx', 'Cleo-redlined.docx', 'Cleo-converted-redline.docx', 'Cleo-redline-review.pdf'].includes(file.filename) ? file.filename : 'Cleo-document.docx';
        response.writeHead(200, { 'Content-Type': filename.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="${filename}"` });
        response.end(file.bytes); return;
      }
      if (request.method === 'POST' && ['/desktop/list','/desktop/resolve','/desktop/recall','/desktop/remember','/desktop/read_document','/desktop/suggest_document'].includes(url.pathname)) {
        const supplied = request.headers['x-cleo-desktop-key'];
        if (!workflow.config.desktopToken || typeof supplied !== 'string' || !equalSecret(supplied,workflow.config.desktopToken)) return json(401,{error:'Unauthorized.'});
        if (!request.headers['content-type']?.startsWith('application/json')) return json(415,{error:'Use application/json.'});
        const {body} = await readJson(request);
        return json(200,await workflow.desktopContext(url.pathname.slice('/desktop/'.length),body.input));
      }
      if (request.method !== 'POST' || !['/tools/join_meeting','/tools/meeting_status','/tools/meeting_control','/tools/remember_contract_context', '/tools/recall_contract_context', '/tools/read_contract', '/tools/read_contract_page', '/tools/redline_contract', '/tools/create_legal_draft', '/tools/list_review_skills', '/tools/get_review_skill'].includes(url.pathname)) return json(404, { error: 'Not found.' });
      const supplied = request.headers['x-orchid-api-key'];
      const legacyAuthenticated = typeof supplied === 'string' && equalSecret(supplied, workflow.config.webhookKey);
      const signedCandidate = supplied === undefined && meetings && typeof request.headers['x-keiki-signature'] === 'string' && typeof request.headers['x-keiki-timestamp'] === 'string';
      const denied = () => {
        // Keyed fingerprint allows an operator to diagnose a mismatched credential without recording it.
        const diagnostic = JSON.stringify({ event: 'webhook_auth_denied', time: new Date().toISOString(), headerPresent: typeof supplied === 'string', credentialLength: typeof supplied === 'string' ? supplied.length : 0,
          fingerprint: typeof supplied === 'string' ? createHmac('sha256', workflow.config.downloadSecret).update(supplied).digest('hex') : null });
        console.warn(diagnostic);
        // Maritime's event log does not retain application stderr. Keep only the last safe diagnostic.
        try { writeFileSync(join(tmpdir(), 'cleo-last-webhook-auth.json'), diagnostic, { mode: 0o600 }); } catch { /* Authentication must still fail closed. */ }
        return json(401, { error: 'Unauthorized.' });
      };
      if (!legacyAuthenticated && !signedCandidate) return denied();
      if (!request.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'Use application/json.' });
      const {body,raw} = await readJson(request);
      if (!legacyAuthenticated && !meetings?.authenticateTool(raw,request,body)) return denied();
      try { await workflow.registerSender(body); }
      catch (error) {
        const context = body?.context;
        const phone = context?.phone;
        const diagnostic = JSON.stringify({ event: 'webhook_context_denied', time: new Date().toISOString(),
          bodyFields: body && typeof body === 'object' ? Object.keys(body) : [],
          contextFields: context && typeof context === 'object' ? Object.keys(context) : [],
          channel: typeof context?.channel === 'string' && /^[a-zA-Z_-]{1,40}$/.test(context.channel) ? context.channel : typeof context?.channel,
          internal: context?.internal === true, internalType: typeof context?.internal,
          phoneType: typeof phone, phoneLength: typeof phone === 'string' ? phone.length : 0 });
        try { writeFileSync(join(tmpdir(), 'cleo-last-webhook-context.json'), diagnostic, { mode: 0o600 }); } catch { /* Denial is unchanged. */ }
        throw error;
      }
      if (['/tools/join_meeting','/tools/meeting_status','/tools/meeting_control'].includes(url.pathname)) return json(200, meetings ? await meetings.tool(url.pathname, body) : {status:'not_configured',instruction:'Meeting attendance is not configured.'});
      if (url.pathname === '/tools/remember_contract_context' || url.pathname === '/tools/recall_contract_context') {
        return json(200, await workflow.contractContext(body, url.pathname === '/tools/remember_contract_context'));
      }
      if (url.pathname === '/tools/list_review_skills' || url.pathname === '/tools/get_review_skill') {
        workflow.owner(body);
        if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw new DocumentError('Provide a skill input object.');
        return json(200, url.pathname === '/tools/list_review_skills' ? await skills.list(body.input) : await skills.get(body.input));
      }
      if (url.pathname === '/tools/read_contract') {
        const attachments = body.context?.attachments;
        const id = body.input?.attachment_id;
        const file = attachments && typeof id === 'string' && Object.hasOwn(attachments, id) ? attachments[id] : undefined;
        // Last-request shape only: never retain names, IDs, signed URLs, text or phone numbers.
        const diagnostic = JSON.stringify({ event: 'attachment_intake', time: new Date().toISOString(),
          attachmentsPresent: !!attachments, attachmentCount: attachments ? Object.keys(attachments).length : 0,
          selectedAttachmentPresent: !!file, filenamePresent: typeof file?.filename === 'string' && !!file.filename.trim(),
          mimeTypePresent: typeof file?.mime_type === 'string' && !!file.mime_type.trim(),
          downloadUrlPresent: typeof file?.url === 'string' && !!file.url.trim(), checksumPresent: !!file?.sha256 });
        try { writeFileSync(join(tmpdir(), 'cleo-last-attachment-intake.json'), diagnostic, { mode: 0o600 }); } catch { /* Intake continues without diagnostics. */ }
      }
      const result = url.pathname === '/tools/create_legal_draft' ? await workflow.draft(body)
        : url.pathname === '/tools/read_contract' ? await workflow.read(body)
        : url.pathname === '/tools/read_contract_page' ? await workflow.pageSource(body) : await workflow.revise(body);
      return json(200, result);
    } catch (error) {
      // Do not put contract text, signed download URLs or credentials into logs.
      if (error instanceof DocumentError) return json(422, { error: error.message });
      console.error('Cleo request failed. Check provider availability and deployment configuration.');
      return json(503, { error: 'Operation not confirmed. Retry reading the source before requesting another redline.' });
    }
  });
  meetings?.transport.attach(server);
  return server;
}
