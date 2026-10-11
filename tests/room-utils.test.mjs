import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoomCode, isValidRoomCode, makeRoomCode, cleanName, cleanChat, hostPeerId, isValidPeerId, formatTime, peerOptionsFromEndpoint } from '../room-utils.mjs';

test('normalizes pasted room codes without changing valid characters', () => {
  assert.equal(normalizeRoomCode(' ab-c 23 '), 'ABC23');
  assert.equal(normalizeRoomCode(' abcdefgh '), 'ABCDEF');
});
test('validates alphabet designed to avoid ambiguous characters', () => {
  assert.equal(isValidRoomCode('ABCD23'), true);
  assert.equal(isValidRoomCode('ABCI01'), false);
  assert.equal(isValidRoomCode('ABCDE'), false);
});
test('creates valid room code from cryptographic byte source', () => {
  const array = new Uint8Array([0,1,2,3,4,5]);
  assert.equal(isValidRoomCode(makeRoomCode(array)), true);
  assert.equal(makeRoomCode(array), 'ABCDEF');
});
test('protects display names and chat from oversized content', () => {
  assert.equal(cleanName('   Hello   Everyone  '), 'Hello Everyone');
  assert.equal(cleanName(''), 'Guest');
  assert.equal(cleanName('x'.repeat(90)).length, 24);
  assert.equal(cleanChat('  hello  \n  friends  '), 'hello friends');
  assert.equal(cleanChat('x'.repeat(700)).length, 450);
});
test('stable host ID and safe peer IDs', () => {
  assert.equal(hostPeerId('ABCD23'), 'roomwave-host-ABCD23');
  assert.equal(isValidPeerId('aBc-9_z'), true);
  assert.equal(isValidPeerId('a/b'), false);
});
test('formats playback durations with fallbacks', () => {
  assert.equal(formatTime(65.5), '1:05');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-3), '0:00');
});

test('uses the Render signaling endpoint with HTTPS and its mounted path', () => {
  assert.deepEqual(peerOptionsFromEndpoint('https://roomwave-signaling.onrender.com'), {
    host: 'roomwave-signaling.onrender.com', port: 443, secure: true, path: '/peerjs', debug: 0
  });
  assert.deepEqual(peerOptionsFromEndpoint(''), { debug: 0 });
  assert.deepEqual(peerOptionsFromEndpoint('http://localhost:10000'), {
    host: 'localhost', port: 10000, secure: false, path: '/peerjs', debug: 0
  });
});
test('rejects potentially unsafe signaling endpoint syntax', () => {
  for (const endpoint of ['file:///tmp/x', 'https://example.com/path', 'https://u:p@example.com/',
    'https://example.com/?x=1', 'not-a-url', 'https://example.com/#fragment']) {
    assert.throws(() => peerOptionsFromEndpoint(endpoint));
  }
});
