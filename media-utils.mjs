// Screen Capture requires video, even when the user only wants sound.
export function displayAudioOptions() {
  return {
    video: true, audio: { suppressLocalAudioPlayback: false },
    systemAudio: 'include', windowAudio: 'system', selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include'
  };
}
export function hasLiveAudio(stream) {
  return Boolean(stream?.getAudioTracks?.().some(track => track.readyState !== 'ended'));
}