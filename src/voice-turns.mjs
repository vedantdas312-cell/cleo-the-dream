import { RealtimeTurnState } from './realtime-turn-state.mjs';
import { AnnouncementWindow } from './vendor/qwen-audio-agent/announcement-window.mjs';

// Upstream owns turn correlation and the speaking/playback boundary. Cleo owns
// the bounded result queue and native playback receipts. No provider credentials here.
export class VoiceTurns {
  turns = new RealtimeTurnState();
  window = new AnnouncementWindow();
  pending = new Map();
  responses = new Map();
  continuations = new Set();
  generating = new Set();
  closed = false;

  speechStarted(itemId) {
    const { context } = this.turns.beginVoice(itemId);
    this.turns.commit(context);
    this.responses.clear();
    this.continuations.clear(); this.generating.clear();
    this.window.reset();
    this.window.beginTurn(context.turnId);
    return context;
  }
  speechStopped() { this.turns.endSpeech(); this.window.endSpeech(); }
  responseStarted(id) { this.responses.set(id, this.turns.current()); this.generating.add(id); }
  audioQueued(id) {
    const context = this.responses.get(id);
    if (!context || this.turns.isStale(context) || this.closed) return false;
    this.window.queueAudio(id, context);
    return true;
  }
  playbackStarted(id) { if (this.responses.has(id)) this.window.startPlayback(id); }
  playbackFinished(id) {
    if (!this.responses.has(id)) return;
    this.window.finishPlayback(id, { awaitsToolFollowUp: this.continuations.has(id) });
    this.responses.delete(id); this.continuations.delete(id);
  }
  responseDone(id, hasAudio, awaitsToolFollowUp = false) {
    const context = this.responses.get(id);
    if (!context) return;
    this.generating.delete(id);
    if (awaitsToolFollowUp) this.continuations.add(id);
    this.window.responseDone({ ...context, hasAudio, awaitsToolFollowUp });
    if (!hasAudio) { this.responses.delete(id); this.continuations.delete(id); }
  }
  queueResult(id, text) {
    if (this.closed || typeof text !== 'string' || !text.trim()) return;
    if (this.pending.size >= 8 && !this.pending.has(id)) throw new Error('Result queue is full');
    this.pending.set(id, text.slice(0,16000));
  }
  takeResult() {
    if (this.closed || this.generating.size || this.window.isBlocked()) return null;
    const entry = this.pending.entries().next().value;
    if (!entry) return null;
    this.pending.delete(entry[0]);
    return { id: entry[0], text: entry[1] };
  }
  close() { this.closed = true; this.turns.close(); this.window.reset(); this.pending.clear(); this.responses.clear(); this.generating.clear(); this.continuations.clear(); }
}
