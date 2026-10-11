import test from 'node:test';
import assert from 'node:assert/strict';
import { displayAudioOptions, hasLiveAudio } from '../media-utils.mjs';

test('requests optional system and tab audio but always includes required video capture', () => {
  const opts = displayAudioOptions();
  assert.equal(opts.video, true);
  assert.equal(opts.systemAudio, 'include');
  assert.equal(opts.audio.suppressLocalAudioPlayback, false);
  assert.equal(opts.selfBrowserSurface, 'exclude');
});
test('detects absent or ended audio tracks so sharing without sound is not falsely advertised', () => {
  assert.equal(hasLiveAudio(null), false);
  assert.equal(hasLiveAudio({getAudioTracks:()=>[]}), false);
  assert.equal(hasLiveAudio({getAudioTracks:()=>[{readyState:'ended'}]}), false);
  assert.equal(hasLiveAudio({getAudioTracks:()=>[{readyState:'live'}]}), true);
});