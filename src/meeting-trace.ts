import { DatabaseSync } from 'node:sqlite';
import {safeTimingContext, type MeetingTraceContext} from './meeting-latency.ts';
import type { MeetingBinding } from './meeting-session.ts';

// Only fixed runtime markers are persisted: never model text, errors, names,
// URLs, audio, contract content, private messages or credentials.
const events = new Set([
  'meeting_followup_fast_path','meeting_direct_fast_path',
  'meeting_voice_response_created', 'meeting_voice_first_audio_received', 'meeting_voice_first_text_delta',
  'meeting_tool_started','meeting_tool_completed','meeting_tool_failed','meeting_tool_cancelled',
  'meeting_intent_addressed','meeting_intent_ignored','meeting_intent_note',
  'meeting_voice_connected', 'meeting_voice_connect_failed', 'meeting_voice_error',
  'meeting_voice_audio_not_connected', 'meeting_voice_direct_path_unavailable',
  'meeting_voice_response_requested', 'meeting_voice_first_frame_sent',
  'meeting_voice_output_sent', 'meeting_voice_cancelled', 'meeting_voice_timeout',
  'meeting_voice_backlog_limit', 'meeting_voice_transport_backpressure',
  'meeting_voice_direct_transcript', 'meeting_voice_rejected',
  'meeting_transcript_direct', 'meeting_transcript_caption_fallback',
  'meeting_intent_started', 'meeting_intent_completed', 'meeting_intent_failed',
  'meeting_room_speech_started', 'meeting_room_speech_stopped', 'meeting_interpreter_warm_failed',
  'meeting_private_steering_ready', 'meeting_private_steering_unavailable',
  'meeting_proposal_private_review', 'presentation_saved_comparison_fallback',
  'meeting_proposal_review_completed', 'meeting_script_audio_requested',
  'meeting_script_audio_validated', 'meeting_script_first_frame_sent', 'meeting_script_output_sent',
  'presentation_reconcile_failed',
]);

export class MeetingTrace {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meeting_runtime_trace(
        id INTEGER PRIMARY KEY, session TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS meeting_runtime_trace_session ON meeting_runtime_trace(session,id);
      CREATE TABLE IF NOT EXISTS meeting_timing_trace(
        id INTEGER PRIMARY KEY,session TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL,
        turnId TEXT NOT NULL,spanId TEXT NOT NULL,profile TEXT NOT NULL,operation TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS meeting_timing_trace_turn ON meeting_timing_trace(session,turnId,id);`);
  }
  record(binding: MeetingBinding, event: string, at = Date.now(), context?:MeetingTraceContext) {
    if (!events.has(event) || !/^[a-f0-9-]{36}$/.test(binding.sessionId) || !Number.isSafeInteger(at)) return;
    const safe=safeTimingContext(context);
    if(safe){
      this.db.prepare('INSERT INTO meeting_timing_trace(session,event,at,turnId,spanId,profile,operation) VALUES(?,?,?,?,?,?,?)').run(binding.sessionId,event,at,safe.turnId,safe.spanId??'',safe.profile??'',safe.operation??'');
      this.db.prepare('DELETE FROM meeting_timing_trace WHERE session=? AND id NOT IN (SELECT id FROM meeting_timing_trace WHERE session=? ORDER BY id DESC LIMIT 2000)').run(binding.sessionId,binding.sessionId);
      this.db.exec('DELETE FROM meeting_timing_trace WHERE id NOT IN (SELECT id FROM meeting_timing_trace ORDER BY id DESC LIMIT 20000)');
    }
    this.db.prepare('INSERT INTO meeting_runtime_trace(session,event,at) VALUES(?,?,?)').run(binding.sessionId,event,at);
    this.db.prepare('DELETE FROM meeting_runtime_trace WHERE session=? AND id NOT IN (SELECT id FROM meeting_runtime_trace WHERE session=? ORDER BY id DESC LIMIT 200)').run(binding.sessionId,binding.sessionId);
    this.db.exec('DELETE FROM meeting_runtime_trace WHERE id NOT IN (SELECT id FROM meeting_runtime_trace ORDER BY id DESC LIMIT 10000)');
  }
  close() { this.db.close(); }
}
