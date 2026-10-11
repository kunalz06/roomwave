export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function normalizeRoomCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
export function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-HJ-NP-Z2-9]{6}$/.test(code);
}
export function makeRoomCode(bytes) {
  if (!bytes || bytes.length < 6) throw new Error('Need six random bytes');
  return Array.from(bytes.slice(0, 6), n => CODE_CHARS[n % CODE_CHARS.length]).join('');
}
export function cleanName(input) {
  return String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0,24) || 'Guest';
}
export function cleanChat(input) {
  return String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0,450);
}
export function hostPeerId(code) { return `roomwave-host-${code}`; }
export function isValidPeerId(id) { return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id); }
export function formatTime(secs) {
  const s = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2,'0')}`;
}

// An empty endpoint keeps existing deployments on PeerJS Cloud until Render is live.
export function peerOptionsFromEndpoint(endpoint) {
  const raw = String(endpoint ?? '').trim();
  if (!raw) return { debug: 0 };
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid signaling URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Signaling URL must be a plain HTTP(S) origin');
  }
  return {
    host: url.hostname, port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    path: '/peerjs', secure: url.protocol === 'https:', debug: 0
  };
}
