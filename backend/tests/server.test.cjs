'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePort, allowedOrigins, peerSettings, SIGNAL_PATH } = require('../config.cjs');
const { createService } = require('../server.cjs');

test('uses Render-assigned port and rejects invalid values', () => {
  assert.equal(parsePort(undefined), 10000);
  assert.equal(parsePort('37691'), 37691);
  for (const n of ['0', '65536', 'nope', '8080xyz', '-1']) assert.throws(() => parsePort(n));
});
test('rejects invalid CORS origins and accepts the production frontend', () => {
  assert.ok(allowedOrigins().includes('https://roomwave-together.vercel.app'));
  assert.deepEqual(allowedOrigins('https://roomwave-together.vercel.app,http://localhost:8080'),
    ['https://roomwave-together.vercel.app', 'http://localhost:8080']);
  assert.throws(() => allowedOrigins('https://example.com/path'));
  assert.throws(() => allowedOrigins('javascript:example'));
});
test('signaling is non-discoverable and limited to one service', () => {
  const opts = peerSettings({ ALLOWED_ORIGINS: 'https://roomwave-together.vercel.app' });
  assert.equal(SIGNAL_PATH, '/peerjs');
  assert.equal(opts.path, '/');
  assert.equal(opts.allow_discovery, false);
  assert.equal(opts.proxied, true);
  assert.equal(opts.concurrent_limit, 100);
});
test('HTTP app exposes an unauthenticated health route and mounts PeerJS', () => {
  const routes = new Map();
  const middleware = [];
  const fakeApp = {
    disable: () => {},
    use: (path, handler) => middleware.push([path, handler]),
    get: (path, handler) => routes.set(path, handler),
  };
  function express() { return fakeApp; }
  const peerServer = { on() {} };
  function ExpressPeerServer(server, opts) {
    assert.ok(server);
    assert.equal(opts.allow_discovery, false);
    return peerServer;
  }
  const instance = createService({ express, ExpressPeerServer, env: {} });
  assert.ok(instance.server);
  assert.ok(middleware.some(([path, obj]) => path === '/peerjs' && obj === peerServer));
  const headers = {};
  const res = {
    setHeader: (key, value) => { headers[key] = value; },
    status: (code) => { assert.equal(code, 200); return res; },
    json: (body) => { assert.deepEqual(body, { status: 'ok' }); },
  };
  routes.get('/health')({}, res);
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
  instance.server.close();
});
