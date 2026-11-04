import {meetingVadProfile} from '../src/meeting-latency.ts';
import { PostgresStore } from '../src/store.ts';
import { Workflow } from '../src/workflow.ts';
import { createApp } from '../src/server.ts';
import { LocalStore } from '../src/local-store.ts';
import { MatterContext } from '../src/matter-context.ts';
import { Supermemory } from '../src/supermemory.ts';
import { GoogleRedline } from '../src/google-redline.ts';
import { googleToken } from '../src/google-auth.mjs';
import { existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { Attendee } from '../src/attendee.ts';
import { MeetingSessions } from '../src/meeting-session.ts';
import { MeetingTransport } from '../src/meeting-transport.ts';
import { MeetingRoutes } from '../src/meeting-routes.ts';
import { KeikiPrivateMessenger } from '../src/keiki.mjs';
import { MeetingIntelligence, openAIMeetingReasoner } from '../src/meeting-intelligence.ts';
import {RealtimeMeetingIntent} from '../src/meeting-intent.ts';
import {MaritimeMeetingPresenter} from '../src/meeting-computer.ts';
import {MeetingTrace} from '../src/meeting-trace.ts';

const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`Set ${key} before starting Cleo.`); return value; };
const config = {
  localOnly: !!process.env.CLEO_LOCAL_DB,
  desktopToken: process.env.CLEO_DESKTOP_TOKEN, desktopSender: process.env.CLEO_DESKTOP_SENDER,
  webhookKey: required('KEIKI_WEBHOOK_KEY'), downloadSecret: required('DOWNLOAD_SIGNING_SECRET'), publicUrl: required('PUBLIC_URL'),
  keikiIdentity: process.env.CLEO_LOCAL_DB && !process.env.KEIKI_AGENT_ID ? undefined : {
    agentId:required('KEIKI_AGENT_ID'),line:required('KEIKI_IMESSAGE_LINE'),
  },
  attachmentOrigins: required('KEIKI_ATTACHMENT_ORIGINS').split(',').map(s => s.trim()).filter(Boolean),
};
const port = Number(required('PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const store = process.env.CLEO_LOCAL_DB ? new LocalStore(process.env.CLEO_LOCAL_DB) : new PostgresStore(required('DATABASE_URL'));
const matter = process.env.CLEO_CONTEXT_DB ? new MatterContext(process.env.CLEO_CONTEXT_DB,
  process.env.SUPERMEMORY_API_KEY ? new Supermemory(process.env.SUPERMEMORY_API_KEY) : undefined) : undefined;
// An existing explicit link-sharing preference is independent of desktop pairing.
// New users have no public-link grant; this setting never controls who may use Cleo.
const publicReviewSender=process.env.CLEO_PUBLIC_REVIEW_SENDER;
const publicReviewOwner=publicReviewSender?createHmac('sha256',config.downloadSecret).update(publicReviewSender).digest('hex'):undefined;
const google = matter && (process.env.GOOGLE_ACCESS_TOKEN || (process.env.CLEO_GOOGLE_OAUTH_JSON && process.env.CLEO_GOOGLE_CLIENT_JSON) || existsSync('.local/google-oauth.json')) ? new GoogleRedline(googleToken(), matter, fetch,
  owner => owner === publicReviewOwner) : undefined;
const workflow = new Workflow(store, config, fetch, matter, google);
if (store instanceof PostgresStore) await store.migrate();
let meetings: MeetingRoutes | undefined, sessions: MeetingSessions | undefined;
let meetingTrace: MeetingTrace | undefined, meetingIntelligence: MeetingIntelligence | undefined;
if (process.env.CLEO_MEETINGS_ENABLED === 'true') {
  const path = required('CLEO_MEETING_DB');
  const attendeeKey = required('ATTENDEE_API_KEY'), openaiKey = required('OPENAI_API_KEY');
  const identity = { secret: required('KEIKI_IDENTITY_SECRET'), agentId: required('KEIKI_AGENT_ID'), line: required('KEIKI_IMESSAGE_LINE') };
  if (identity.secret.length < 32) throw new Error('KEIKI_IDENTITY_SECRET must contain at least 32 characters.');
  sessions = new MeetingSessions(path); workflow.meetings = sessions;
  const planner = new MeetingIntelligence(sessions, openAIMeetingReasoner(openaiKey), matter);
  meetingIntelligence = planner; meetingTrace = new MeetingTrace(path);
  const messenger = process.env.KEIKI_NOTICE_API_KEY ? new KeikiPrivateMessenger({ apiKey: process.env.KEIKI_NOTICE_API_KEY, agentId: identity.agentId,
    resolveRecipient: owner => store.getSender(owner,identity.agentId,identity.line) }) : undefined;
  const transport = new MeetingTransport(sessions, { path, publicUrl: config.publicUrl, attendee: new Attendee(attendeeKey), openaiKey,
    fastFollowups:process.env.CLEO_MEETING_FAST_FOLLOWUPS!=='false',
    vadProfile:meetingVadProfile(process.env.CLEO_MEETING_VAD_PROFILE),
    diagnose: (binding,event,context) => { try { meetingTrace?.record(binding,event,Date.now(),context); } catch { /* Diagnostics cannot disrupt a live turn. */ } },
    webhookSecret: process.env.ATTENDEE_WEBHOOK_SECRET, intelligence: planner, intent:new RealtimeMeetingIntent(openaiKey),messenger,
    presenter:process.env.MARITIME_COMPUTERS_KEY?new MaritimeMeetingPresenter(process.env.MARITIME_COMPUTERS_KEY):undefined,
    onTranscript: async (binding, event) => {
      void planner.director.warmBackground(binding,binding.owner,event.text).catch(() => {});
    },
    applyControl: async (binding,event,interpreted) => {
      const result = await workflow.meetingControl(binding.owner,binding.sourceId,binding.sessionId,event,interpreted);
      if (!('session' in result)) throw new Error('Meeting control is not configured.');
      return result;
    },
  });
  meetings = new MeetingRoutes(transport,workflow,identity);
  await transport.recover();
}
const server = createApp(workflow,undefined,meetings);
server.listen(port, process.env.CLEO_LOCAL_DB ? '127.0.0.1' : '0.0.0.0', () => console.log(`Cleo backend listening on port ${port}.`));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  meetingIntelligence?.close();
  await meetings?.transport.close();
  meetingTrace?.close();
  server.close(() => { sessions?.close(); matter?.close(); if (store instanceof PostgresStore) void store.pool.end(); else store.db.close(); });
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
