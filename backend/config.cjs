'use strict';

const SIGNAL_PATH = '/peerjs';

function parsePort(raw) {
  const value = raw == null || raw === '' ? '10000' : String(raw);
  if (!/^\d+$/.test(value)) throw new Error('PORT must be a numeric TCP port');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }
  return port;
}

function allowedOrigins(value) {
  const origins = String(value ?? 'https://roomwave-together.vercel.app,http://localhost:8080,http://127.0.0.1:8080')
    .split(',').map(x => x.trim()).filter(Boolean);
  if (!origins.length) throw new Error('ALLOWED_ORIGINS must contain at least one origin');
  for (const origin of origins) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error('Invalid ALLOWED_ORIGINS entry'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('ALLOWED_ORIGINS must contain only http(s) origins');
    }
  }
  return origins;
}

function peerSettings(env) {
  return {
    path: '/', // Express mounts this router at /peerjs; the browser uses /peerjs.
    proxied: true,
    allow_discovery: false,
    concurrent_limit: 100,
    alive_timeout: 60000,
    corsOptions: { origin: allowedOrigins(env.ALLOWED_ORIGINS), methods: ['GET', 'POST', 'OPTIONS'] },
  };
}

module.exports = { SIGNAL_PATH, parsePort, allowedOrigins, peerSettings };
