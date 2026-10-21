/**
 * Media Session controls for Roomwave's own authorized file/stream playback.
 * Never attach this module to an embedded YouTube player.
 */
export function boundedAudioTime(position, duration) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.min(duration, position));
}

export function attachRoomwaveMediaSession({
  session, Metadata, media, title, artist = 'Roomwave', seekable = false, onPlay = null,
}) {
  if (!session || !media || typeof session.setActionHandler !== 'function') {
    return { refresh() {}, setTitle() {}, dispose() {} };
  }

  let active = true;
  const actions = [];

  const refresh = () => {
    if (!active) return;
    try { session.playbackState = media.paused ? 'paused' : 'playing'; } catch {}
    if (seekable && typeof session.setPositionState === 'function' &&
        Number.isFinite(media.duration) && media.duration > 0) {
      const position = boundedAudioTime(media.currentTime, media.duration);
      if (position !== null) {
        try { session.setPositionState({ duration: media.duration, position, playbackRate: 1 }); } catch {}
      }
    }
  };
  const setTitle = (nextTitle) => {
    if (!active || typeof Metadata !== 'function') return;
    try { session.metadata = new Metadata({ title: String(nextTitle || 'Shared audio').slice(0, 120), artist }); } catch {}
  };
  const bind = (action, handler) => {
    try { session.setActionHandler(action, handler); actions.push(action); } catch { /* Unsupported action. */ }
  };
  const seek = (nextPosition) => {
    const clamped = boundedAudioTime(nextPosition, media.duration);
    if (clamped === null) return;
    try { media.currentTime = clamped; } catch {}
    refresh();
  };
  bind('play', () => {
    const result = typeof onPlay === 'function' ? onPlay() : media.play();
    Promise.resolve(result).then(refresh).catch(() => { refresh(); });
  });
  bind('pause', () => { try { media.pause(); } catch {} refresh(); });
  if (seekable) {
    bind('seekto', (details) => seek(details?.seekTime));
    bind('seekbackward', (details) => seek(media.currentTime - (details?.seekOffset || 10)));
    bind('seekforward', (details) => seek(media.currentTime + (details?.seekOffset || 10)));
  }
  setTitle(title);
  refresh();

  return {
    refresh, setTitle,
    dispose() {
      if (!active) return;
      active = false;
      for (const action of actions) {
        try { session.setActionHandler(action, null); } catch {}
      }
      try { session.metadata = null; } catch {}
      try { session.playbackState = 'none'; } catch {}
    },
  };
}
