import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTurns } from '../src/voice-turns.mjs';

test('background result waits for speech AND actual local playback completion', () => {
  const turns = new VoiceTurns();
  turns.speechStarted('u1'); turns.queueResult('job1', 'Found a conflicting notice period.');
  assert.equal(turns.takeResult(), null);
  turns.speechStopped(); turns.responseStarted('r1');
  assert.equal(turns.audioQueued('r1'), true); turns.playbackStarted('r1');
  turns.responseDone('r1', true);
  assert.equal(turns.takeResult(), null, 'generation finished but user still hears audio');
  turns.playbackFinished('r1');
  assert.equal(turns.takeResult().id, 'job1'); assert.equal(turns.takeResult(), null);
});
test('interrupt rejects old audio while preserving accepted background results', () => {
  const turns = new VoiceTurns();
  turns.speechStarted('u1'); turns.responseStarted('r1'); turns.audioQueued('r1');
  turns.queueResult('job1', 'Review ready');
  turns.speechStarted('u2');
  assert.equal(turns.audioQueued('r1'), false);
  turns.playbackFinished('r1'); assert.equal(turns.takeResult(), null);
  turns.speechStopped(); turns.responseStarted('r2'); turns.responseDone('r2', false);
  assert.equal(turns.takeResult().id, 'job1');
});
test('tool continuation keeps the announcement slot closed; closing rejects late work', () => {
  const turns = new VoiceTurns();
  turns.speechStarted('u1'); turns.speechStopped(); turns.responseStarted('r1');
  turns.responseDone('r1', false, true); turns.queueResult('job1', 'Ready');
  assert.equal(turns.takeResult(), null);
  turns.close(); turns.queueResult('late', 'Late');
  assert.equal(turns.takeResult(), null); assert.equal(turns.audioQueued('r1'), false);
});
test('a spoken tool preamble finishing does not announce a background result over its continuation', () => {
  const turns = new VoiceTurns();
  turns.speechStarted('u1'); turns.speechStopped(); turns.responseStarted('r1');
  turns.audioQueued('r1'); turns.responseDone('r1', true, true);
  turns.queueResult('job1', 'Finding'); turns.playbackFinished('r1');
  assert.equal(turns.takeResult(), null);
  turns.responseStarted('r2'); turns.responseDone('r2', false);
  assert.equal(turns.takeResult().id, 'job1');
});
