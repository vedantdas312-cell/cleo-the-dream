import { createHmac, timingSafeEqual } from 'node:crypto';

const origin = 'https://app.attendee.dev/api/v1';
const botPattern = /^bot_[A-Za-z0-9_-]{1,100}$/;
export class AttendeeError extends Error {
  status: number;
  constructor(status: number) { super('Meeting provider did not confirm the operation.'); this.status = status; }
}

// This client deliberately has no arbitrary URL, chat, desktop or file-output API.
export class Attendee {
  private key: string; private fetchImpl: typeof fetch;
  constructor(key: string, fetchImpl: typeof fetch = fetch) { this.key = key; this.fetchImpl = fetchImpl; }
  private async request(path: string, method = 'GET', body?: unknown) {
    const response = await this.fetchImpl(origin + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Token ${this.key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new AttendeeError(response.status);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  async join({ meetingUrl, audioUrl, webhookUrl, deduplicationKey }: {
    meetingUrl: string; audioUrl: string; webhookUrl: string; deduplicationKey: string;
  }): Promise<{ id: string; state: string }> {
    if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingUrl)) throw new Error('Use a Google Meet link.');
    if (!audioUrl.startsWith('wss://') || !webhookUrl.startsWith('https://')) throw new Error('Meeting callbacks require HTTPS.');
    const bot = await this.request('/bots', 'POST', {
      meeting_url: meetingUrl, bot_name: 'Cleo', deduplication_key: deduplicationKey,
      // Provider-enforced limits also apply if our backend loses its connection.
      automatic_leave_settings: {
        only_participant_in_meeting_timeout_seconds: 30,
        silence_activate_after_seconds: 300,
        silence_timeout_seconds: 600,
        waiting_room_timeout_seconds: 300,
        wait_for_host_to_start_meeting_timeout_seconds: 300,
        max_uptime_seconds: 7200,
      },
      recording_settings: { format: 'none' }, debug_settings: { create_debug_recording: false },
      transcription_settings: { meeting_closed_captions: {} },
      websocket_settings: { audio: { url: audioUrl, sample_rate: 24000 } },
      // Reserve the live browser, but publish neither webcam nor screenshare on join.
      voice_agent_settings: { reserve_resources: true },
      webhooks: [{ url: webhookUrl, triggers: ['bot.state_change', 'transcript.update','participant_events.speech_start_stop','participant_events.join_leave'] }],
    });
    if (!botPattern.test(bot.id ?? '')) throw new Error('Meeting provider returned an invalid bot.');
    return { id: bot.id, state: typeof bot.state === 'string' ? bot.state : 'joining' };
  }
  private path(id: string) {
    if (!botPattern.test(id)) throw new Error('Invalid meeting provider binding.');
    return `/bots/${id}`;
  }
  async inspect(id: string) { return this.request(this.path(id)); }
  async share(id: string, presentationUrl: string) {
    if (presentationUrl && !presentationUrl.startsWith('https://')) throw new Error('Presentation requires HTTPS.');
    await this.request(this.path(id) + '/voice_agent_settings', 'PATCH', { url: '', screenshare_url: presentationUrl });
  }
  async leave(id: string) { await this.request(this.path(id) + '/leave', 'POST'); }
}

// Attendee signs canonical recursively sorted JSON, NOT the raw HTTP bytes.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function verifyAttendeeWebhook(payload: unknown, signature: unknown, secret: string): boolean {
  if (!secret || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', Buffer.from(secret, 'base64')).update(canonicalJson(payload)).digest();
  const supplied = Buffer.from(signature, 'base64');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
