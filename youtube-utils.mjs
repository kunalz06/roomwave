// Share YouTube IDs, never arbitrary iframe URLs from other participants.
export function parseYouTubeId(input) {
  const value=String(input??'').trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  let url;
  try { url=new URL(value); } catch { return null; }
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password) return null;
  const host=url.hostname.toLowerCase();
  let id=null;
  if (host==='youtu.be') {
    id=url.pathname.split('/').filter(Boolean)[0];
  } else if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','www.youtube-nocookie.com'].includes(host)) {
    const segments=url.pathname.split('/').filter(Boolean);
    if (segments[0]==='watch') id=url.searchParams.get('v');
    else if (['shorts','embed','live','v'].includes(segments[0])) id=segments[1];
  }
  return typeof id==='string' && /^[\w-]{11}$/.test(id) ? id : null;
}
export function normalizeYouTubeState(value) {
  if (value===null) return null;
  if (!value || typeof value!=='object' || typeof value.videoId!=='string' || !/^[\w-]{11}$/.test(value.videoId)) return null;
  const position=typeof value.position==='number' && Number.isFinite(value.position) ? Math.max(0,Math.min(86400,value.position)) : 0;
  return {videoId:value.videoId,position,playing:value.playing===true};
}

// Estimate the current server-synchronized playback time between WebSocket updates.
export function expectedYouTubePosition(playback, receivedAt, now = Date.now()) {
  if (!playback || typeof playback.position !== 'number' || !Number.isFinite(playback.position)) return 0;
  const base = Math.max(0, Math.min(86400, playback.position));
  if (!playback.playing || !Number.isFinite(receivedAt)) return base;
  return Math.min(86400, base + Math.max(0, now - receivedAt) / 1000);
}
