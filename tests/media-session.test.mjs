import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedAudioTime, attachRoomwaveMediaSession } from '../media-session.mjs';

test('seeks are bounded for local audio and reject invalid positions', () => {
  assert.equal(boundedAudioTime(80, 30), 30);
  assert.equal(boundedAudioTime(-5, 30), 0);
  assert.equal(boundedAudioTime(6, 30), 6);
  assert.equal(boundedAudioTime(NaN, 30), null);
  assert.equal(boundedAudioTime(1, Infinity), null);
});

test('host local files expose lock-screen play, pause and seek controls', async () => {
  const actions = new Map();
  const states = [];
  const session = {
    setActionHandler(action, fn) { actions.set(action, fn); },
    setPositionState(value) { states.push(value); },
    playbackState: 'none',
  };
  const media = {
    duration: 100,
    currentTime: 18,
    paused: true,
    async play() { this.paused = false; },
    pause() { this.paused = true; },
  };
  class Metadata { constructor(value) { Object.assign(this, value); } }
  const controller = attachRoomwaveMediaSession({
    session, Metadata, media, title: 'Original Track', artist: 'Roomwave', seekable: true,
  });
  assert.equal(session.metadata.title, 'Original Track');
  actions.get('seekto')({ seekTime: 150 });
  assert.equal(media.currentTime, 100);
  actions.get('seekbackward')({ seekOffset: 15 });
  assert.equal(media.currentTime, 85);
  actions.get('seekforward')({ seekOffset: 10 });
  assert.equal(media.currentTime, 95);
  actions.get('play')();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(media.paused, false);
  actions.get('pause')();
  assert.equal(media.paused, true);
  controller.setTitle('Another Track');
  assert.equal(session.metadata.title, 'Another Track');
  assert.ok(states.length > 0);
  controller.dispose();
  assert.equal(actions.get('play'), null);
  assert.equal(session.playbackState, 'none');
});

test('guest playback controls cannot seek someone else\'s file', () => {
  const actions = new Map();
  const session = { setActionHandler(key,fn) { actions.set(key,fn); }, playbackState:'none' };
  const remote = { paused:false, pause() { this.paused=true; }, play() { this.paused=false; } };
  const controller = attachRoomwaveMediaSession({session, media:remote, title:'Host audio', seekable:false});
  assert.equal(actions.has('seekto'),false);
  assert.ok(actions.has('play') && actions.has('pause'));
  controller.dispose();
});

test('unsupported platform media sessions fall back without crashing', () => {
  const stub = attachRoomwaveMediaSession({ session:null, media:{}, title:'A' });
  stub.refresh(); stub.setTitle('B'); stub.dispose();
});
