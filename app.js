import {
  normalizeRoomCode, isValidRoomCode, makeRoomCode, cleanName, cleanChat,
  hostPeerId, isValidPeerId, formatTime, peerOptionsFromEndpoint
} from './room-utils.mjs';
import { displayAudioOptions, hasLiveAudio } from './media-utils.mjs';
import { parseYouTubeId, normalizeYouTubeState, expectedYouTubePosition } from './youtube-utils.mjs';
import { attachRoomwaveMediaSession } from './media-session.mjs';

const $ = (id) => document.getElementById(id);
const LIMIT = 8;
const state = {
  peer: null, roomSocket: null, connecting: false, code: '', name: '', hosting: false, joined: false,
  members: new Map(), connections: new Map(),
  screenStream: null, screenCalls: new Map(), remoteScreens: new Map(),
  deviceAudioCapture: null, deviceAudioStream: null, deviceAudioFromScreen: false, deviceAudioSource: '',
  deviceAudioCalls: new Map(), incomingDeviceAudioCalls: new Map(), deviceAudioPlayers: new Map(),
  audioContext: null, audioDestination: null, audioSource: null,
  musicCalls: new Map(), incomingMusicCall: null, trackObjectURL: null,
  track: { title: '', duration: 0, position: 0, playing: false, stamped: 0 },
  joinTimeout: null, setupTimeout: null, warmupAbort: null, connectAttempt: 0,
  youtube: null, youtubePlayer: null, youtubeReady: false, youtubeEnabled: false, youtubeGeneration: 0,
  youtubeQueue: [], youtubeMode: 'sequential', youtubeReceivedAt: 0,
  bot: null, botToken: '', botReceivedAt: 0, botAudioEnabled: false, botUploading: false,
  resumeToken: '', resumePeerId: '', recovering: false, reconnectTimer: null, reconnectAttempts: 0, connectionOfflineAt: 0,
  botPlayPending: false, countMessages: 0, toastTimeout: null
};

let audioSessionController = null;
function clearAudioSession() {
  try { audioSessionController?.dispose(); } catch {}
  audioSessionController = null;
}
function registerAudioSession(media, title, seekable) {
  if (!navigator.mediaSession || !media) return;
  clearAudioSession();
  audioSessionController = attachRoomwaveMediaSession({
    session: navigator.mediaSession,
    Metadata: window.MediaMetadata,
    media, title: title || 'Roomwave shared audio',
    artist: seekable ? 'Roomwave Room Radio' : 'Roomwave live room',
    seekable,
    onPlay: seekable ? async () => {
      try { await state.audioContext?.resume(); } catch {}
      return media.play();
    } : null
  });
}
function refreshAudioSession() {
  try { audioSessionController?.refresh(); } catch {}
}
function notify(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(state.toastTimeout);
  state.toastTimeout = setTimeout(() => { element.hidden = true; }, 5000);
}
function setLobbyBusy(busy, message = '') {
  $('createRoom').disabled = busy;
  $('joinRoom').disabled = busy;
  $('cancelConnection').hidden = !busy;
  $('lobbyConnectionStatus').hidden = !busy;
  $('lobbyConnectionStatus').textContent = busy ? message : '';
}
function connectionFailed(message) {
  resetRoom();
  notify(message);
}
function makeCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return makeRoomCode(bytes);
}
function memberName(id) {
  return state.members.get(id) || (id === state.peer?.id ? state.name : 'Friend');
}
function peerHost() { return hostPeerId(state.code); }
function myId() { return state.peer?.id; }
function isHostId(id) { return id === peerHost(); }
function otherMembers() {
  return [...state.members.keys()].filter(id => id !== myId());
}
function broadcast(data) {
  if (state.roomSocket?.readyState !== WebSocket.OPEN) return false;
  try { state.roomSocket.send(JSON.stringify(data)); return true; } catch { return false; }
}
function cachedRoom() {
  try {
    const value=JSON.parse(sessionStorage.getItem('roomwave:active')||'null');
    return value && isValidRoomCode(value.code) && isValidPeerId(value.peerId) &&
      typeof value.token==='string' && /^[0-9a-f]{48}$/.test(value.token) ? value:null;
  } catch {return null;}
}
function saveRoomSession() {
  if(!state.resumeToken || !isValidPeerId(myId()))return;
  try {
    sessionStorage.setItem('roomwave:active',JSON.stringify({
      code:state.code,peerId:myId(),hosting:state.hosting,token:state.resumeToken
    }));
  } catch {}
}
function clearRoomSession() {
  try{sessionStorage.removeItem('roomwave:active');}catch{}
}
function initIdentity() {
  state.name = cleanName($('displayName').value);
  $('displayName').value = state.name;
  try { localStorage.setItem('roomwave:name', state.name); } catch { /* private browsing */ }
}
function resetRoom(intentional = false) {
  if(intentional) { try{broadcast({type:'leave'});}catch{} }
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer=null;state.resumeToken='';state.recovering=false;
  state.reconnectAttempts=0;state.connectionOfflineAt=0;
  clearRoomSession();
  ++state.connectAttempt; // Invalidates any outstanding free-tier wakeup promise.
  state.warmupAbort?.abort();
  state.warmupAbort = null;
  clearTimeout(state.setupTimeout);
  state.setupTimeout = null;
  clearTimeout(state.joinTimeout);
  state.joinTimeout = null;
  stopSharing();
  stopDeviceAudio();
  clearYouTube();
  clearBot();
  clearAudioSession();
  $('connectionBanner').hidden=true;
  for (const call of state.incomingDeviceAudioCalls.values()) { try { call.close(); } catch {} }
  state.incomingDeviceAudioCalls.clear();
  for (const audio of state.deviceAudioPlayers.values()) { audio.pause(); audio.srcObject = null; audio.remove(); }
  state.deviceAudioPlayers.clear();
  for (const call of state.musicCalls.values()) { try { call.close(); } catch {} }
  state.musicCalls.clear();
  try { state.incomingMusicCall?.close(); } catch {}
  state.incomingMusicCall = null;
  const previousSocket = state.roomSocket;
  state.roomSocket = null;
  try { previousSocket?.close(1000, 'Left room'); } catch {}
  for (const conn of state.connections.values()) { try { conn.close(); } catch {} }
  state.connections.clear();
  const oldPeer = state.peer;
  state.peer = null; // Ignore synchronous close/error events from destruction.
  try { oldPeer?.destroy(); } catch {}
  state.connecting = false;
  setLobbyBusy(false);
  $('musicPlayer').pause();
  $('musicPlayer').removeAttribute('src');
  $('musicPlayer').load();
  if (state.trackObjectURL) URL.revokeObjectURL(state.trackObjectURL);
  state.trackObjectURL = null;
  state.audioSource?.disconnect();
  state.audioDestination?.disconnect();
  state.audioSource = null;
  state.audioDestination = null;
  state.audioContext?.close().catch(() => {});
  state.audioContext = null;
  $('remoteMusic').pause();
  $('remoteMusic').srcObject = null;
  state.members.clear();
  state.remoteScreens.clear();
  state.track = { title:'', duration:0, position:0, playing:false, stamped:0 };
  state.joined = false;
  state.code = '';
  state.hosting = false;
  state.countMessages = 0;
  $('chatMessages').replaceChildren();
  $('chatMessages').innerHTML = '<div class="chat-empty">Say hey to the room 👋<span>Good conversations start somewhere.</span></div>';
  $('room').hidden = true;
  $('lobby').hidden = false;
  history.replaceState(null, '', location.pathname);
}
async function enterRoom(isHost, code) {
  if (state.peer || state.connecting) return;
  if (!window.Peer) {
    notify('Connection library failed to load. Check your internet connection and reload the page.');
    return;
  }
  initIdentity();
  state.connecting = true;
  const attempt = ++state.connectAttempt;
  const endpoint = String(window.ROOMWAVE_SIGNALING_URL || '').trim();
  setLobbyBusy(true, 'Connecting to the room server…');

  let peerOptions;
  try {
    peerOptions = peerOptionsFromEndpoint(endpoint);
    if (endpoint) {
      // Render Free may sleep; wake it before opening the PeerJS WebSocket.
      setLobbyBusy(true, 'Waking the free room server — this can take a minute…');
      const controller = new AbortController();
      state.warmupAbort = controller;
      const timeout = setTimeout(() => controller.abort(), 85000);
      try {
        const healthUrl = `${new URL(endpoint).origin}/health`;
        const response = await fetch(healthUrl, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Room server health check failed');
      } finally {
        clearTimeout(timeout);
        if (state.warmupAbort === controller) state.warmupAbort = null;
      }
    }
  } catch (error) {
    if (attempt === state.connectAttempt) connectionFailed('Room server unavailable. Check your connection and try again.');
    return;
  }
  if (attempt !== state.connectAttempt) return;
  state.code = code;
  state.hosting = isHost;
  const cached=cachedRoom();
  if(cached && cached.code===code && cached.hosting===isHost){
    state.resumeToken=cached.token;
    state.resumePeerId=cached.peerId;
  }
  state.members.set(isHost ? peerHost() : '__pending__', state.name);
  const chosenId=isHost?peerHost():(isValidPeerId(state.resumePeerId)?state.resumePeerId:undefined);
  let peer;
  try { peer = new window.Peer(chosenId, peerOptions); }
  catch {
    connectionFailed('Could not initialize room connection. Reload and try again.');
    return;
  }
  state.connecting = false;
  state.peer = peer;
  setLobbyBusy(true, 'Registering with the room server…');
  state.setupTimeout = setTimeout(() => {
    if (state.peer === peer && !state.joined) {
      connectionFailed('Room connection timed out. Please try again.');
    }
  }, 20000);
  peer.on('open', (id) => {
    if (state.peer !== peer) return;
    state.members.delete('__pending__');
    state.members.set(id, state.name);
    setLobbyBusy(true, 'Joining the room server…');
    openRoomSocket(attempt, endpoint);
  });
  peer.on('call', acceptCall);
  peer.on('disconnected', () => {
    if(state.peer!==peer)return;
    // PeerJS is for screen and microphone media. A transient media failure
    // should not destroy the separate WebSocket room, chat or hosted Music Bot.
    try{peer.reconnect();}catch{}
    if(state.joined)notify('Reconnecting screen/audio sharing…');
  });
  peer.on('close', () => {
    if(state.peer!==peer)return;
    if(!state.joined)connectionFailed('Could not connect. Retry.');
    else notify('Screen sharing disconnected. Room chat and Music Bot remain available.');
  });
  peer.on('error', (error) => {
    if (state.peer !== peer) return;
    const type = error?.type || '';
    if (type === 'unavailable-id') {
      connectionFailed('That room code is already in use. Create another room.');
    } else if (type === 'peer-unavailable' && !state.joined) {
      connectionFailed('A participant connection was unavailable. Please retry.');
    } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable'].includes(type)) {
      if (!state.joined) connectionFailed('Room connection failed. Check your network and try again.');
      else notify('Connection issue. If participants disappear, leave and rejoin the room.');
    }
  });
}
function setConnectionBanner(message) {
  $('connectionBanner').hidden=!message;
  $('connectionText').textContent=message||'';
}
function scheduleReconnect() {
  if(!state.joined || !state.resumeToken || state.reconnectTimer || !state.peer)return;
  state.reconnectAttempts++;
  const delay=Math.min(12000,800*Math.pow(1.8,Math.min(state.reconnectAttempts,7)));
  state.reconnectTimer=setTimeout(()=>{
    state.reconnectTimer=null;
    reconnectRoom();
  },delay);
}
function reconnectRoom(force=false) {
  if(!state.joined || !state.resumeToken || !state.peer)return;
  if(state.roomSocket?.readyState===WebSocket.OPEN && !force)return;
  if(state.roomSocket?.readyState===WebSocket.CONNECTING && !force)return;
  clearTimeout(state.reconnectTimer);state.reconnectTimer=null;
  const old=state.roomSocket;state.roomSocket=null;
  try{old?.close();}catch{}
  if(state.peer.disconnected){try{state.peer.reconnect();}catch{}}
  setConnectionBanner('Reconnecting…');
  openRoomSocket(state.connectAttempt,String(window.ROOMWAVE_SIGNALING_URL||'').trim());
}
function displayRoom() {
  if (state.joined) return;
  clearTimeout(state.joinTimeout);
  state.joinTimeout = null;
  setLobbyBusy(false);
  state.joined = true;
  setConnectionBanner('');
  $('lobby').hidden = true;
  $('room').hidden = false;
  $('roomCodeDisplay').textContent = state.code;
  history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(state.code)}`);
  $('audioFile').disabled = !state.hosting;
  $('uploadButton').hidden = !state.hosting;
  $('playMusic').hidden = !state.hosting;
  $('stopMusic').hidden = !state.hosting;
  $('musicNotice').textContent = state.hosting
    ? 'Pick a local audio file to stream it live. Keep this tab open. Only share music you have permission to play.'
    : 'The host controls the music. Your volume is private to you.';
  renderPeople();
  renderScreens();
  renderMusic();
  renderDeviceAudio();
  renderYouTube();
  renderBot();
}
function openRoomSocket(attempt, endpoint) {
  if (attempt !== state.connectAttempt || !state.peer?.id) return;
  const url = new URL(endpoint);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/rooms';
  let socket;
  try { socket = new WebSocket(url.href); }
  catch { connectionFailed('Cannot connect to the room service. Please retry.'); return; }
  state.roomSocket = socket;
  state.setupTimeout=setTimeout(()=>{
    if(state.roomSocket!==socket)return;
    if(state.joined){
      try{socket.close();}catch{}
      scheduleReconnect();
    } else connectionFailed('Room did not respond. Retry joining.');
  },20000);
  socket.addEventListener('open', () => {
    if (state.roomSocket !== socket || attempt !== state.connectAttempt) return;
    socket.send(JSON.stringify({
      type:state.resumeToken?'resume':state.hosting?'create':'join',
      code:state.code,peerId:myId(),name:state.name,
      ...(state.resumeToken?{resumeToken:state.resumeToken}:{})
    }));
    if(!state.joined)setLobbyBusy(true,'Joining…');
  });
  socket.addEventListener('message', event => {
    if (state.roomSocket !== socket) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    onRoomMessage(data);
  });
  socket.addEventListener('close',()=>{
    if(state.roomSocket!==socket)return;
    clearTimeout(state.setupTimeout);state.setupTimeout=null;
    if(state.joined && state.resumeToken){
      state.roomSocket=null;
      if(!state.connectionOfflineAt)state.connectionOfflineAt=Date.now();
      setConnectionBanner('Connection lost · Reconnecting…');
      scheduleReconnect();
    } else connectionFailed('Could not connect. Try again.');
  });
  socket.addEventListener('error',()=>{
    // close event starts recovery; errors alone are not proof that the room ended.
    if(state.roomSocket===socket && state.joined)setConnectionBanner('Connection unstable');
  });
}
function applyRoster(members) {
  if (!Array.isArray(members)) return;
  const valid = members.slice(0,LIMIT).filter(m=>m && isValidPeerId(m.id) && typeof m.name==='string');
  if (!valid.some(m=>m.id===myId()) || !valid.some(m=>m.id===peerHost())) return;
  const next = new Map(valid.map(m=>[m.id,cleanName(m.name)]));
  const removed = [...state.members.keys()].filter(id=>!next.has(id));
  const added = [...next.keys()].filter(id=>!state.members.has(id) && id!==myId());
  state.members = next;
  for (const id of removed) {
    try { state.screenCalls.get(id)?.close(); } catch {}
    state.screenCalls.delete(id);
    try { state.musicCalls.get(id)?.close(); } catch {}
    state.musicCalls.delete(id);
    try { state.deviceAudioCalls.get(id)?.close(); } catch {}
    state.deviceAudioCalls.delete(id);
    try { state.incomingDeviceAudioCalls.get(id)?.close(); } catch {}
    clearIncomingDeviceAudio(id);
    if (state.remoteScreens.has(id)) state.remoteScreens.delete(id);
  }
  renderPeople();
  renderScreens();
  // Server roster is authoritative; media is still direct WebRTC where the network supports it.
  for (const id of added) {
    if (state.screenStream) sendScreenTo(id);
    if (state.deviceAudioStream) sendDeviceAudioTo(id);
    if (state.hosting && state.audioDestination) sendMusicTo(id);
  }
  if (state.hosting && state.track.title && added.length) broadcast({type:'music',track:currentTrack()});
}
function onRoomMessage(data) {
  if (!data || typeof data !== 'object') return;
  if (data.type==='created'||data.type==='joined'||data.type==='resumed') {
    if(data.code!==state.code || (state.joined && data.type!=='resumed'))return;
    const wasJoined=state.joined;
    state.resumeToken=typeof data.resumeToken==='string'?data.resumeToken:state.resumeToken;
    saveRoomSession();
    state.reconnectAttempts=0;state.connectionOfflineAt=0;
    clearTimeout(state.reconnectTimer);state.reconnectTimer=null;
    setConnectionBanner('');
    applyRoster(data.members);
    clearTimeout(state.setupTimeout);
    state.setupTimeout = null;
    if(!wasJoined)displayRoom();
    if(state.hosting && typeof data.botToken==='string') state.botToken=data.botToken;
    setBotState(data.bot);
    state.youtubeQueue = Array.isArray(data.youtubeQueue)?data.youtubeQueue:[];
    state.youtubeMode = data.youtubeMode || 'sequential';
    setYouTubeState(data.youtube);
  } else if (data.type==='roster') {
    applyRoster(data.members);
  } else if (data.type==='chat' && state.joined) {
    if (state.members.has(data.from) && typeof data.body==='string') addChat(data.from,cleanChat(data.body),Number(data.ts));
  } else if (data.type==='music' && !state.hosting) {
    if (!data.track || typeof data.track!=='object') return;
    const t=data.track;
    state.track={title:String(t.title??'').slice(0,120),duration:validNumber(t.duration),
      position:validNumber(t.position),playing:Boolean(t.playing),stamped:Date.now()};
    if ($('remoteMusic').srcObject && audioSessionController) {
      audioSessionController.setTitle(state.track.title || 'Host shared music');
      refreshAudioSession();
    }
    renderMusic();
  } else if (data.type==='bot-state' && state.joined) {
    setBotState(data.bot);
  } else if (data.type==='youtube-state' && state.joined) {
    state.youtubeQueue = Array.isArray(data.queue) ? data.queue : [];
    state.youtubeMode = data.mode || 'sequential';
    setYouTubeState(data.youtube);
  } else if (data.type==='youtube-queue-error' && state.joined) {
    notify(String(data.message||'Queue operation failed.').slice(0,150));
  } else if (data.type==='youtube' && !state.hosting && state.joined) {
    setYouTubeState(data.youtube);
  } else if (data.type==='room-closed') {
    connectionFailed('This room has ended.');
  } else if (data.type==='error') {
    if(data.reason==='room-not-found' && state.hosting && state.resumeToken && !state.joined){
      state.resumeToken='';state.resumePeerId='';clearRoomSession();
      const old=state.roomSocket;state.roomSocket=null;
      try{old?.close();}catch{}
      openRoomSocket(state.connectAttempt,String(window.ROOMWAVE_SIGNALING_URL||'').trim());
      return;
    }
    const messages = {
      'room-not-found':'Room not found. Ask the host for a new invite link.',
      'room-full':'That room is full (maximum 8 people).',
      'room-exists':'That room code is already taken. Create another room.',
      'duplicate-peer':'Room is open elsewhere. Close the other tab.',
      'invalid-resume':'Session expired. Rejoin the room.',
      'invalid-room':'Invalid room code. Try another invite.',
    };
    connectionFailed(messages[data.reason] || 'Could not join. Try again.');
  }
}

let youtubeApiPromise = null;
function youtubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const prior = window.onYouTubeIframeAPIReady;
    const timeout = setTimeout(() => { youtubeApiPromise=null; reject(new Error('YouTube player timed out')); }, 20000);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      if (typeof prior === 'function') try { prior(); } catch {}
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      clearTimeout(timeout);
      youtubeApiPromise=null;
      reject(new Error('Cannot load YouTube player'));
    };
    document.head.append(script);
  });
  return youtubeApiPromise;
}
function clearYouTube() {
  state.youtubeGeneration++;
  const previous = state.youtubePlayer;
  state.youtubePlayer = null;
  state.youtubeReady = false;
  state.youtube = null;
  state.youtubeEnabled = false;
  state.youtubeQueue = [];
  state.youtubeMode = 'sequential';
  state.youtubeReceivedAt = 0;
  try { previous?.destroy(); } catch {}
  $('youtubePlayerHolder').replaceChildren();
  $('youtubeEnable').hidden = true;
}
function youtubeVisible() {
  const el = $('youtubePlayerHolder');
  if (document.visibilityState === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  const height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
  return rect.height > 0 && height / rect.height >= 0.5;
}

function renderYouTubeQueue() {
  const list=$('youtubeQueueList');
  list.replaceChildren();
  const queue=Array.isArray(state.youtubeQueue)?state.youtubeQueue:[];
  $('youtubeQueueCount').textContent=queue.length+' / 40 queued';
  if(!queue.length){
    const empty=document.createElement('li'); empty.className='youtube-queue-empty';
    empty.textContent='No upcoming videos. Anyone in the room can add a link.';
    list.append(empty);return;
  }
  queue.forEach((item,i)=>{
    if(!item || !/^[A-Za-z0-9_-]{11}$/.test(item.videoId))return;
    const li=document.createElement('li');li.className='youtube-queue-item';
    const info=document.createElement('div');info.className='youtube-queue-info';
    const title=document.createElement('span');title.className='youtube-queue-video';
    title.textContent=(i+1)+'. '+item.videoId;
    const added=document.createElement('small');added.textContent='Added by '+String(item.by||'Guest').slice(0,24);
    info.append(title,added);
    const thumb=document.createElement('img');
    thumb.className='youtube-queue-thumbnail';
    thumb.width=72;thumb.height=54;
    thumb.loading='lazy';
    thumb.alt='';
    thumb.src='https://i.ytimg.com/vi/'+item.videoId+'/default.jpg';
    const link=document.createElement('a');
    link.href='https://www.youtube.com/watch?v='+item.videoId;
    link.target='_blank';link.rel='noopener noreferrer';link.textContent='YouTube ↗';
    li.append(thumb,info,link);
    if(state.hosting && typeof item.id==='string') {
      const actions=document.createElement('div');actions.className='youtube-queue-actions';
      for(const [label,action,disabled] of [
        ['▶','youtube-select',false],
        ['↑','youtube-move',i===0],
        ['↓','youtube-move',i===queue.length-1],
        ['×','youtube-remove',false]
      ]) {
        const button=document.createElement('button');
        button.type='button';button.className='youtube-queue-control';
        button.textContent=label;button.disabled=disabled;
        button.title=action==='youtube-select'?'Play this next':action==='youtube-remove'?'Remove':label==='↑'?'Move up':'Move down';
        button.setAttribute('aria-label',button.title+' '+item.videoId);
        button.addEventListener('click',()=>broadcast({
          type:action,id:item.id,...(action==='youtube-move'?{direction:label==='↑'?-1:1}:{})
        }));
        actions.append(button);
      }
      li.append(actions);
    }
    list.append(li);
  });
}

function renderYouTube() {
  if (!state.joined) return;
  const selected = Boolean(state.youtube);
  $('youtubeForm').hidden = false;
  renderYouTubeQueue();
  $('youtubeClear').hidden = !state.hosting || !selected;
  $('youtubePlayerHolder').hidden = !selected;
  $('youtubeEmpty').hidden = selected;
  $('youtubeActions').hidden = !selected;
  $('youtubePlay').hidden = !state.hosting;
  $('youtubePause').hidden = !state.hosting;
  $('youtubeSync').hidden = !state.hosting;
  $('youtubeNext').hidden = !state.hosting;
  $('youtubeMode').disabled = !state.hosting;
  $('youtubeMode').value = state.youtubeMode;
  $('youtubeTitle').textContent = selected
    ? (state.youtube.playing ? 'Playing together on YouTube' : 'YouTube video is ready')
    : 'No YouTube video selected';
  $('youtubeSource').hidden = !selected;
  if (selected) $('youtubeSource').href = 'https://www.youtube.com/watch?v=' + state.youtube.videoId;
  $('youtubeEnable').hidden = !selected || state.hosting || !state.youtube.playing || state.youtubeEnabled;
  $('youtubeStatus').textContent = !selected
    ? (state.hosting ? 'Paste a YouTube link to share a song or video with the room.' : 'The host can choose a YouTube song or video.')
    : (!state.hosting && state.youtube.playing && !state.youtubeEnabled
      ? 'Press Enable playback to listen. If your browser blocks playback, press Play inside YouTube.'
      : (state.youtube.playing ? 'Host playback is live. Playback is synchronized approximately.' : 'Waiting for the host to play.'));
}
function youtubePosition() {
  try {
    const value = state.youtubePlayer?.getCurrentTime?.();
    if (Number.isFinite(value) && value >= 0) return Math.min(86400, value);
  } catch {}
  return state.youtube?.position ?? 0;
}
function broadcastYouTube() {
  if (!state.hosting || !state.joined || !state.youtube) return;
  state.youtube.position = youtubePosition();
  broadcast({type:'youtube', youtube:{...state.youtube}});
  renderYouTube();
}
function syncYouTubePlayer() {
  if (!state.joined || !state.youtube || !state.youtubePlayer || !state.youtubeReady) return;
  const player = state.youtubePlayer;
  const target = expectedYouTubePosition(state.youtube, state.youtubeReceivedAt);
  const diff = Math.abs(youtubePosition() - target);
  try {
    if (diff > 2.5) player.seekTo(target, true);
    if (!state.youtube.playing) {
      player.pauseVideo();
    } else if (!state.hosting && state.youtubeEnabled && youtubeVisible()) {
      if(player.getPlayerState?.() !== window.YT?.PlayerState?.PLAYING) player.playVideo();
    } else if (!state.hosting) {
      $('youtubeEnable').hidden = false;
    }
  } catch {}
}
// YouTube permits playback only in its visible embedded player.
function pauseYouTubeWhenInvisible() {
  if (!state.youtubePlayer || !state.youtubeReady || youtubeVisible()) return;
  try {
    if (state.youtubePlayer.getPlayerState?.() === window.YT?.PlayerState?.PLAYING) {
      state.youtubePlayer.pauseVideo();
      if (!state.hosting) {
        state.youtubeEnabled = false;
        $('youtubeEnable').hidden = false;
      }
    }
  } catch {}
}
function mountYouTube() {
  const video = state.youtube?.videoId;
  if (!video || !state.joined) return;
  const generation = ++state.youtubeGeneration;
  state.youtubeReady = false;
  const old = state.youtubePlayer;
  state.youtubePlayer = null;
  try { old?.destroy(); } catch {}
  $('youtubePlayerHolder').replaceChildren();
  const slot = document.createElement('div');
  slot.id = 'youtubePlayerSlot';
  $('youtubePlayerHolder').append(slot);
  youtubeAPI().then(YT => {
    if (generation !== state.youtubeGeneration || !state.joined || state.youtube?.videoId !== video) return;
    state.youtubePlayer = new YT.Player(slot, {
      videoId: video,
      playerVars: {playsinline:1, controls:1, origin:location.origin},
      events: {
        onReady: () => {
          if (generation !== state.youtubeGeneration) return;
          state.youtubeReady = true;
          syncYouTubePlayer();
          if(state.hosting && state.youtube?.playing && youtubeVisible()) {
            try {state.youtubePlayer.playVideo();} catch {}
          }
        },
        onStateChange: (event) => {
          if (generation !== state.youtubeGeneration || !state.youtube) return;
          if (!state.hosting) {
            if (event.data === YT.PlayerState.PLAYING) {
              state.youtubeEnabled = true;
              $('youtubeEnable').hidden = true;
            }
            return;
          }
          if(event.data === YT.PlayerState.ENDED) {
            broadcast({type:'youtube-ended'});
            return;
          }
          if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.PAUSED) {
            state.youtube.playing = event.data === YT.PlayerState.PLAYING;
            broadcastYouTube();
          }
        },
        onAutoplayBlocked: () => {
          if (!state.hosting) {
            state.youtubeEnabled = false;
            $('youtubeEnable').hidden = false;
          } else if (state.youtube?.playing) {
            // A server clock must not advance while the host cannot start playback.
            state.youtube.playing = false;
            broadcastYouTube();
          }
          $('youtubeStatus').textContent = 'Your browser blocked automatic playback. Click Play inside the YouTube player.';
        },
        onError: () => {
          $('youtubeStatus').textContent = 'This video cannot be embedded or is unavailable. Try another link.';
        }
      }
    });
  }).catch(() => {
    if (generation === state.youtubeGeneration) $('youtubeStatus').textContent = 'YouTube could not load. Check your browser or content-blocking settings.';
  });
}
function setYouTubeState(value) {
  const normalized = normalizeYouTubeState(value);
  const previousId = state.youtube?.videoId;
  // Repeat-one restarts the same video; advance the host player back to zero.
  if(state.hosting && normalized && previousId===normalized.videoId &&
     normalized.playing && normalized.position < 2 && youtubePosition() > 4 &&
     state.youtubePlayer && state.youtubeReady && youtubeVisible()) {
    try {state.youtubePlayer.seekTo(0,true);state.youtubePlayer.playVideo();} catch {}
  }
  state.youtube = normalized;
  state.youtubeReceivedAt = Date.now();
  if (!normalized) {
    state.youtubeGeneration++;
    try { state.youtubePlayer?.destroy(); } catch {}
    state.youtubePlayer = null;
    state.youtubeReady = false;
    state.youtubeEnabled = false;
    $('youtubePlayerHolder').replaceChildren();
  } else if (previousId !== normalized.videoId) {
    mountYouTube();
  } else if (!state.hosting) {
    syncYouTubePlayer();
  }
  renderYouTube();
}
function setYouTubeFromForm(event) {
  event.preventDefault();
  if (!state.joined) return;
  const id = parseYouTubeId($('youtubeInput').value);
  if (!id) {
    notify('Paste a YouTube video, Shorts, or music.youtube.com watch link (not a playlist-only link).');
    return;
  }
  if (broadcast({type:'youtube-add',videoId:id})) {
    $('youtubeInput').value='';
    notify('Video submitted to the shared YouTube queue.');
  } else notify('Room connection unavailable. Try again.');
}
function hostYouTubeAction(action) {
  if (!state.hosting || !state.youtube || !state.youtubeReady) {
    notify('YouTube is loading. You can also use the player controls.');
    return;
  }
  try {
    if (action === 'play') {
      if (!youtubeVisible()) {
        $('youtubePlayerHolder').scrollIntoView({behavior:'smooth',block:'center'});
        notify('YouTube playback requires its video to remain visible.');
        return;
      }
      state.youtubePlayer.playVideo();
    }
    if (action === 'pause') state.youtubePlayer.pauseVideo();
    if (action === 'sync') broadcastYouTube();
  } catch { notify('Use the YouTube player controls to start or pause.'); }
}


const BOT_MAX_SIZE = 12 * 1024 * 1024;
const BOT_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg:'audio/ogg',
  opus:'audio/ogg', wav:'audio/wav', webm:'audio/webm',
  aac:'audio/aac', flac:'audio/flac'
};
function botPlayer() { return $('botAudio'); }
function clearBot() {
  state.bot=null;state.botToken='';state.botAudioEnabled=false;
  state.botReceivedAt=0;state.botUploading=false;state.botPlayPending=false;
  const player=botPlayer();
  player.pause();player.removeAttribute('src');player.load();
  $('botEnable').hidden=true;
  $('botQueue').replaceChildren();
}
function botPosition() {
  if (!state.bot) return 0;
  const c=state.bot.current;
  return c ? Math.max(0, Math.min(c.duration, state.bot.position+
    (state.bot.playing ? Math.max(0,(Date.now()-state.botReceivedAt)/1000) : 0))) : 0;
}
function setBotState(next) {
  if (!state.joined) return;
  const oldId=state.bot?.current?.id;
  const current=next && typeof next==='object' && next.current && /^[a-f0-9]{32}$/.test(next.current.id) ? next.current : null;
  state.bot=next && typeof next==='object' ? {...next,current} : null;
  state.botReceivedAt=Date.now();
  if(oldId!==current?.id) {
    const audio=botPlayer();audio.pause();state.botPlayPending=false;audio.removeAttribute('src');
    if(current && state.bot) {
      const origin=new URL(window.ROOMWAVE_SIGNALING_URL).origin;
      audio.src=origin+'/bot/tracks/'+current.id;
    }
    audio.load();
    if (current && navigator.mediaSession) registerAudioSession(audio,current.title,false);
    else if(!current) clearAudioSession();
  }
  renderBot();
  syncBotAudio();
}
function renderBot() {
  if(!state.joined)return;
  const b=state.bot;
  const c=b?.current;
  $('botControls').hidden=!state.hosting;
  $('botUploadFile').disabled=!state.hosting||state.botUploading;
  $('botUploadButton').disabled=!state.hosting||state.botUploading||!state.botToken;
  $('botUploadButton').textContent=state.botUploading?'Uploading…':'＋ Add to queue';
  $('botName').textContent=c ? c.title:'Nothing queued yet';
  $('botStatus').textContent=state.botUploading?'Uploading track to Roomwave Bot…':
    !c ? 'Add a music file that you are allowed to share.' :
    b.playing?'♫ Bot is playing for the room':'Bot is paused — host can press Play';
  $('botPosition').textContent=c ? formatTime(botPosition())+' / '+formatTime(c.duration) : '0:00';
  $('botPlay').disabled=!c;
  $('botPause').disabled=!c;
  $('botSkip').disabled=!c;
  $('botStop').disabled=!c;
  $('botEnable').hidden=!c || !b.playing || state.botAudioEnabled;
  $('botQueue').replaceChildren();
  const queue=Array.isArray(b?.queue)?b.queue:[];
  for (const [i,t] of queue.entries()) {
    const item=document.createElement('li');
    item.textContent=(i+1)+'. '+String(t.title).slice(0,90)+' · '+formatTime(t.duration);
    $('botQueue').append(item);
  }
  if (!queue.length) {
    const li=document.createElement('li');li.textContent='No upcoming songs';$('botQueue').append(li);
  }
}
function syncBotAudio() {
  const b=state.bot,c=b?.current,a=botPlayer();
  if(!c || !b) return;
  if(a.readyState>=1){
    const position=botPosition();
    if(Number.isFinite(a.duration) && position<a.duration &&
       Math.abs(a.currentTime-position)>(document.visibilityState==='hidden'?12:3)){
      try{a.currentTime=position;}catch{}
    }
  }
  if(!b.playing){
    if(!a.paused)a.pause();
    refreshAudioSession();
    return;
  }
  if(!state.botAudioEnabled) {
    $('botEnable').hidden=false;
    return;
  }
  if(a.ended || !a.paused || state.botPlayPending)return;
  state.botPlayPending=true;
  a.play().then(()=>{
    refreshAudioSession();$('botEnable').hidden=true;
  }).catch(()=>{
    state.botAudioEnabled=false;$('botEnable').hidden=false;
    $('botStatus').textContent='Tap Enable sound';
  }).finally(()=>{state.botPlayPending=false;});
}
function botControl(action,position) {
  if(!state.hosting||!state.joined||!state.bot?.current)return;
  if(action==='play') state.botAudioEnabled=true;
  broadcast({type:'bot-control',action,position});
  if(action==='play') botPlayer().play().catch(()=>{$('botEnable').hidden=false;});
}
async function botFileDuration(file) {
  const blobUrl=URL.createObjectURL(file),audio=document.createElement('audio');
  audio.preload='metadata';
  try {
    return await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Could not read track duration')),12000);
      audio.onloadedmetadata=()=>{
        clearTimeout(timeout);
        if(!Number.isFinite(audio.duration)||audio.duration<1||audio.duration>7200) reject(new Error('Unsupported audio duration'));
        else resolve(audio.duration);
      };
      audio.onerror=()=>{clearTimeout(timeout);reject(new Error('The browser cannot decode this audio file'));};
      audio.src=blobUrl;audio.load();
    });
  } finally {
    audio.pause();audio.removeAttribute('src');audio.load();URL.revokeObjectURL(blobUrl);
  }
}
async function uploadBotTrack(event) {
  event.preventDefault();
  if(!state.hosting||!state.joined||state.botUploading||!state.botToken)return;
  const file=$('botUploadFile').files?.[0];
  if(!file){notify('Choose an MP3, M4A, OGG or WAV audio file first.');return;}
  if(file.size<128||file.size>BOT_MAX_SIZE){notify('The bot accepts tracks up to 12 MB.');return;}
  const ext=file.name.split('.').pop()?.toLowerCase();
  const mime=BOT_TYPES[ext];
  if(!mime){notify('Choose an MP3, M4A, OGG, WAV, WebM, AAC, or FLAC audio file.');return;}
  state.botUploading=true;renderBot();
  try {
    const duration=await botFileDuration(file);
    if(!state.joined||!state.hosting||!state.botToken)return;
    const endpoint=new URL(window.ROOMWAVE_SIGNALING_URL);
    const url=endpoint.origin+'/bot/upload?code='+encodeURIComponent(state.code);
    const response=await fetch(url,{method:'POST',headers:{
      'Content-Type':mime,'X-Room-Bot-Token':state.botToken,
      'X-Music-Title':encodeURIComponent(file.name.slice(0,90)),
      'X-Music-Duration':String(duration)
    },body:file});
    const result=await response.json();
    if(!response.ok||result.error)throw new Error(
      result.error==='queue-full'?'Bot queue is full (5 tracks maximum).':
      result.error==='size-limit'?'Bot memory limit reached. Skip tracks or try smaller files.':
      result.error==='unauthorized'?'Your host session expired. Create another room.':
      result.error||'Upload failed'
    );
    $('botUploadFile').value='';
    notify('♫ Added '+file.name+' to the Roomwave Bot queue.');
  } catch(err){notify('Music Bot: '+(err?.message||'Upload failed.')); }
  finally{state.botUploading=false;renderBot();}
}

function validNumber(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(n,86400) : 0; }
function renderPeople() {
  if (!state.joined) return;
  const list = $('peopleList'); list.replaceChildren();
  const ordered = [...state.members.entries()].sort(([a],[b]) => Number(isHostId(b)) - Number(isHostId(a)));
  for (const [id,name] of ordered) {
    const row = document.createElement('div'); row.className = 'person-row';
    const avatar = document.createElement('span'); avatar.className='avatar'; avatar.textContent=(name[0]||'?').toUpperCase();
    const info = document.createElement('div'); info.style.minWidth='0';
    const title = document.createElement('div'); title.className='person-name'; title.textContent = name + (id === myId() ? ' (you)' : '');
    const subtitle = document.createElement('span'); subtitle.className='person-sub'; subtitle.textContent=id===myId()?'Connected as you':'Connected';
    info.append(title,subtitle);row.append(avatar,info);
    if (isHostId(id)) { const badge=document.createElement('span');badge.className='person-host';badge.textContent='HOST';row.append(badge); }
    list.append(row);
  }
  $('peopleCount').textContent = `${ordered.length} / ${LIMIT}`;
}
function acceptCall(call) {
  if (!state.members.has(call.peer)) { call.close(); return; }
  const kind = call.metadata?.kind;
  if (kind !== 'screen' && kind !== 'music' && kind !== 'device-audio') { call.close(); return; }
  if (kind === 'music' && (state.hosting || !isHostId(call.peer))) { call.close(); return; }
  try { call.answer(); } catch { call.close(); return; }
  if (kind === 'screen') {
    call.on('stream', stream => {
      const prev = state.remoteScreens.get(call.peer);
      if (prev && prev.call !== call) { try { prev.call.close(); } catch {} }
      state.remoteScreens.set(call.peer, { stream, call });
      renderScreens();
    });
    call.on('close', () => {
      if (state.remoteScreens.get(call.peer)?.call === call) { state.remoteScreens.delete(call.peer); renderScreens(); }
    });
  } else if (kind === 'device-audio') {
    const previous = state.incomingDeviceAudioCalls.get(call.peer);
    if (previous && previous !== call) { try { previous.close(); } catch {} }
    state.incomingDeviceAudioCalls.set(call.peer, call);
    call.on('stream', stream => {
      if (state.incomingDeviceAudioCalls.get(call.peer) !== call) return;
      if (!hasLiveAudio(stream)) return;
      let audio = state.deviceAudioPlayers.get(call.peer);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true; audio.playsInline = true;
        audio.setAttribute('aria-label', `Shared audio from ${memberName(call.peer)}`);
        $('sharedAudioOutputs').append(audio);
        state.deviceAudioPlayers.set(call.peer, audio);
      }
      audio.srcObject = stream;
      audio.volume = Number($('volume').value) / 100;
      audio.play().catch(() => { $('enableAudio').hidden = false; });
      renderDeviceAudio();
    });
    call.on('close', () => { if (state.incomingDeviceAudioCalls.get(call.peer) === call) clearIncomingDeviceAudio(call.peer); });
    call.on('error', () => { if (state.incomingDeviceAudioCalls.get(call.peer) === call) clearIncomingDeviceAudio(call.peer); });
  } else {
    if (state.incomingMusicCall) { try { state.incomingMusicCall.close(); } catch {} }
    state.incomingMusicCall = call;
    call.on('stream', stream => {
      const audio = $('remoteMusic'); audio.srcObject = stream;
      registerAudioSession(audio, state.track.title || 'Host shared music', false);
      audio.volume = Number($('volume').value)/100;
      audio.play().then(() => { $('enableAudio').hidden = true; })
        .catch(() => { $('enableAudio').hidden = false; });
    });
    call.on('close', () => {
      if (state.incomingMusicCall === call) { clearAudioSession(); $('remoteMusic').srcObject=null; state.incomingMusicCall=null; }
    });
  }
}
function sendScreenTo(id) {
  if (!state.peer || !state.screenStream || !state.members.has(id) || state.screenCalls.has(id)) return;
  try {
    // Audio is sent as a separate audio-only call so the video tile stays muted.
    const videoOnly = new MediaStream(state.screenStream.getVideoTracks());
    const call = state.peer.call(id, videoOnly, { metadata:{kind:'screen'} });
    state.screenCalls.set(id,call);
    call.on('close',()=>{if(state.screenCalls.get(id)===call)state.screenCalls.delete(id);});
    call.on('error',()=>{if(state.screenCalls.get(id)===call)state.screenCalls.delete(id);});
  } catch { notify('Could not send screen to a participant.'); }
}
async function shareScreen() {
  if (state.screenStream) { stopSharing(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { notify('Screen sharing requires a supported desktop browser on HTTPS.'); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15 }, audio: { suppressLocalAudioPlayback: false },
      systemAudio: 'include', windowAudio: 'system', selfBrowserSurface: 'exclude'
    });
    if (!state.joined) { stream.getTracks().forEach(track => track.stop()); return; }
    state.screenStream = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', stopSharing, { once: true });
    if (hasLiveAudio(stream) && !state.deviceAudioStream) {
      startDeviceAudio(stream, true);
      notify('Sharing your screen and its audio with the room.');
    } else if (!hasLiveAudio(stream)) {
      notify('Screen sharing started without sound. To include audio, select a tab with “Share tab audio” enabled.');
    }
    for (const id of otherMembers()) sendScreenTo(id);
    renderScreens();
  } catch (error) {
    if (error?.name !== 'NotAllowedError') notify('Screen capture failed. Try sharing a different tab or window.');
  }
}
function stopSharing() {
  if (state.deviceAudioFromScreen) stopDeviceAudio();
  if (state.screenStream) {for(const track of state.screenStream.getTracks())track.stop();state.screenStream=null;}
  for(const call of state.screenCalls.values()){try{call.close();}catch{}}
  state.screenCalls.clear();renderScreens();
}
function clearIncomingDeviceAudio(id) {
  state.incomingDeviceAudioCalls.delete(id);
  const audio = state.deviceAudioPlayers.get(id);
  if (audio) { audio.pause(); audio.srcObject = null; audio.remove(); }
  state.deviceAudioPlayers.delete(id);
  renderDeviceAudio();
}
function renderDeviceAudio() {
  const own = Boolean(state.deviceAudioStream);
  const names = [...state.deviceAudioPlayers.keys()].map(id => memberName(id));
  const status = $('deviceAudioStatus');
  if (own) status.textContent = state.deviceAudioSource === 'microphone'
    ? 'Your microphone is live for everyone in the room.'
    : 'You are broadcasting shared audio to the room.';
  else if (names.length) status.textContent = `Listening to ${names.join(', ')}'s shared audio.`;
  else status.textContent = 'No device or tab audio is being shared.';
  $('shareDeviceAudio').textContent = own ? '■ Stop sharing audio' : '♫ Share tab / device audio';
  $('shareDeviceAudio').classList.toggle('btn-primary', !own);
  $('shareDeviceAudio').classList.toggle('btn-outline', own);
  $('shareMicrophone').disabled = own;
  $('sharedAudioCount').textContent = `${names.length + Number(own)} SHARING`;
}
function sendDeviceAudioTo(id) {
  if (!state.peer || !state.deviceAudioStream || !state.members.has(id) ||
      id === myId() || state.deviceAudioCalls.has(id)) return;
  try {
    const call = state.peer.call(id, state.deviceAudioStream, { metadata:{kind:'device-audio'} });
    state.deviceAudioCalls.set(id, call);
    call.on('close', () => { if (state.deviceAudioCalls.get(id) === call) state.deviceAudioCalls.delete(id); });
    call.on('error', () => { if (state.deviceAudioCalls.get(id) === call) state.deviceAudioCalls.delete(id); });
  } catch { notify('Could not send shared audio to one participant.'); }
}
function startDeviceAudio(capture, fromScreen = false, source = 'tab') {
  if (!hasLiveAudio(capture)) return false;
  state.deviceAudioCapture = capture;
  state.deviceAudioFromScreen = fromScreen;
  state.deviceAudioSource = fromScreen ? 'screen' : source;
  state.deviceAudioStream = new MediaStream(capture.getAudioTracks());
  for (const track of capture.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (state.deviceAudioCapture === capture) stopDeviceAudio();
    }, {once:true});
  }
  if (!fromScreen) capture.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (state.deviceAudioCapture === capture) stopDeviceAudio();
  }, {once:true});
  for (const id of otherMembers()) sendDeviceAudioTo(id);
  renderDeviceAudio();
  return true;
}
async function shareDeviceAudio() {
  if (state.deviceAudioStream) { stopDeviceAudio(); return; }
  if (!state.joined || !navigator.mediaDevices?.getDisplayMedia) {
    notify('This browser cannot capture audio from other apps. Desktop Chrome or Edge can share supported tabs and system audio. Mobile users can listen.');
    return;
  }
  try {
    // Must happen directly from the click: getDisplayMedia needs transient user activation.
    // The browser always requires choosing a display surface, even for audio-only sharing.
    const capture = await navigator.mediaDevices.getDisplayMedia(displayAudioOptions());
    if (!state.joined) { capture.getTracks().forEach(track => track.stop()); return; }
    if (!hasLiveAudio(capture)) {
      capture.getTracks().forEach(track => track.stop());
      notify('No audio was shared. Select a playing Chrome/Edge tab and enable “Share tab audio” in the picker, or select supported system audio.');
      return;
    }
    startDeviceAudio(capture);
    notify('Your selected tab or device audio is now shared. Wear headphones to avoid echo.');
  } catch (error) {
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError')
      notify('Audio capture is unavailable for that source. Try sharing a browser tab in Chrome or Edge.');
  }
}
async function shareMicrophone() {
  if (state.deviceAudioStream) {
    notify('Stop the current audio share before using the microphone.'); return;
  }
  if (!state.joined || !navigator.mediaDevices?.getUserMedia) {
    notify('Microphone capture is unavailable on this device or browser.'); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation:false, noiseSuppression:false}, video:false
    });
    if (!state.joined) { stream.getTracks().forEach(track=>track.stop()); return; }
    startDeviceAudio(stream, false, 'microphone');
    notify('Microphone sharing started. This records nearby sound, NOT internal app audio. Use headphones to avoid feedback.');
  } catch (error) {
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError')
      notify('Microphone access failed. Check the microphone permission in your browser.');
  }
}
function stopDeviceAudio() {
  const capture = state.deviceAudioCapture;
  const fromScreen = state.deviceAudioFromScreen;
  state.deviceAudioCapture = null;
  state.deviceAudioStream = null;
  state.deviceAudioFromScreen = false;
  state.deviceAudioSource = '';
  for (const call of state.deviceAudioCalls.values()) { try { call.close(); } catch {} }
  state.deviceAudioCalls.clear();
  if (capture) {
    const tracks = fromScreen ? capture.getAudioTracks() : capture.getTracks();
    for (const track of tracks) { try { track.stop(); } catch {} }
  }
  renderDeviceAudio();
}
function screenTile(owner,stream,isLocal=false) {
  const tile=document.createElement('div'); tile.className='stream-tile';
  const video=document.createElement('video'); video.autoplay=true;video.playsInline=true;video.muted=true;video.srcObject=stream;
  video.addEventListener('loadedmetadata',()=>video.play().catch(()=>{}));
  const label=document.createElement('div'); label.className='tile-label';label.textContent=isLocal?'You · sharing':`${memberName(owner)} · sharing`;
  const live=document.createElement('div');live.className='tile-live';live.textContent='● LIVE';
  tile.append(video,label,live);return tile;
}
function renderScreens() {
  if (!state.joined) return;
  const holder=$('screenStage');holder.replaceChildren();
  const count=state.remoteScreens.size+(state.screenStream?1:0);
  if (state.screenStream) holder.append(screenTile(myId(),state.screenStream,true));
  for (const [id,{stream}] of state.remoteScreens) holder.append(screenTile(id,stream));
  if (!count) holder.innerHTML='<div class="empty-stage"><div class="stage-icon"><svg viewBox="0 0 80 80" fill="none" aria-hidden="true"><rect x="10" y="18" width="60" height="43" rx="8" stroke="currentColor" stroke-width="2.5"/><path d="M32 70h16M40 61v9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="40" cy="39" r="10" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-width="2"/><path d="m37 34 10 5-10 5V34Z" fill="currentColor"/></svg></div><h3>The stage is yours</h3><p>Be the first to share your screen. Everyone in the room will see it here.</p></div>';
  $('screenCount').textContent=`${count} SHARING`;
  $('shareScreen').textContent=state.screenStream?'■  Stop sharing':'▣  Share your screen';
  $('shareScreen').classList.toggle('btn-primary',!state.screenStream);
  $('shareScreen').classList.toggle('btn-outline',!!state.screenStream);
  $('shareStatus').textContent=count?`${count} live screen${count>1?'s':''} on stage`:'No one’s sharing right now';
}
function audioSetup() {
  if (state.audioContext) return;
  const AC=window.AudioContext||window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio unavailable');
  state.audioContext=new AC();
  state.audioSource=state.audioContext.createMediaElementSource($('musicPlayer'));
  state.audioDestination=state.audioContext.createMediaStreamDestination();
  state.audioSource.connect(state.audioDestination);
  state.audioSource.connect(state.audioContext.destination);
}
function sendMusicTo(id) {
  if (!state.hosting || !state.peer || !state.audioDestination || !state.members.has(id) || state.musicCalls.has(id)) return;
  try {
    const call=state.peer.call(id,state.audioDestination.stream,{metadata:{kind:'music'}});
    state.musicCalls.set(id,call);
    call.on('close',()=>{if(state.musicCalls.get(id)===call)state.musicCalls.delete(id);});
    call.on('error',()=>{if(state.musicCalls.get(id)===call)state.musicCalls.delete(id);});
  } catch { notify('Could not send audio to a participant.'); }
}
function currentTrack() {
  const player=$('musicPlayer');
  if (!state.hosting) return state.track;
  return { title:state.track.title, duration:validNumber(player.duration),
    position:validNumber(player.currentTime), playing:!player.paused && !player.ended };
}
function sendMusic() {if(state.hosting && state.joined){state.track={...currentTrack(),stamped:Date.now()};broadcast({type:'music',track:currentTrack()});renderMusic();refreshAudioSession();}}
function renderMusic() {
  if (!state.joined) return;
  const t=state.hosting?{...currentTrack(),stamped:Date.now()}:state.track;
  const elapsed=t.playing && !state.hosting ? Math.min(t.duration||Infinity,t.position+(Date.now()-t.stamped)/1000) : t.position;
  $('trackTitle').textContent=t.title||'Nothing on the decks yet';
  $('trackSubtitle').textContent=t.title?(t.playing?'Playing live · everyone hears the same moment':'Paused · waiting for the next beat'):'The host picks the music. Everyone hears it live.';
  $('musicElapsed').textContent=formatTime(elapsed);
  $('musicDuration').textContent=formatTime(t.duration);
  $('musicProgressFill').style.width=`${t.duration>0?Math.min(100,elapsed/t.duration*100):0}%`;
  if (state.hosting) {
    $('playMusic').disabled=!t.title;
    $('stopMusic').disabled=!t.title;
    $('playMusic').textContent=t.playing?'Ⅱ  Pause':'▶  Play';
  }
}
async function chooseAudio(file) {
  if (!state.hosting || !file) return;
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name)) {notify('Choose an audio file (MP3, WAV, M4A or OGG).');return;}
  try { audioSetup(); await state.audioContext.resume(); }
  catch { notify('Audio playback is not supported in this browser.'); return; }
  $('musicPlayer').pause();
  if(state.trackObjectURL) URL.revokeObjectURL(state.trackObjectURL);
  state.trackObjectURL=URL.createObjectURL(file);
  $('musicPlayer').src=state.trackObjectURL;
  $('musicPlayer').load();
  state.track.title=file.name.replace(/\.[^.]+$/,'').slice(0,120);
  state.track.duration=0;
  registerAudioSession($('musicPlayer'), state.track.title, true);
  for (const id of otherMembers()) sendMusicTo(id);
  sendMusic();
  notify(`“${state.track.title}” is ready to play.`);
}
async function playPauseMusic() {
  if (!state.hosting || !state.track.title) return;
  const player=$('musicPlayer');
  if(!player.paused){player.pause();return;}
  try {await state.audioContext.resume();await player.play();}
  catch{notify('Could not play this file. Try MP3 or WAV.');}
}
function addChat(id,body,ts=Date.now()) {
  if (!body) return;
  const log=$('chatMessages');
  if(!state.countMessages++) log.replaceChildren();
  const name=memberName(id);
  const row=document.createElement('div');row.className='chat-row';
  const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=(name[0]||'?').toUpperCase();
  const content=document.createElement('div');content.className='chat-content';
  const title=document.createElement('div');title.className='chat-author';title.textContent=name+(id===myId()?' (you)':'');
  const time=document.createElement('time');time.textContent=new Date(Number.isFinite(ts)&&Math.abs(ts-Date.now())<86400000?ts:Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const message=document.createElement('div');message.className='chat-text';message.textContent=body;
  title.append(time);content.append(title,message);row.append(avatar,content);log.append(row);
  while(log.children.length>75) log.firstElementChild.remove();
  log.scrollTop=log.scrollHeight;
}
async function copyInvite() {
  if(!state.code)return;
  const url=`${location.origin}${location.pathname}?room=${encodeURIComponent(state.code)}`;
  try{await navigator.clipboard.writeText(url);notify('Invite link copied! Send it to your friends.');}
  catch{try{window.prompt('Copy your invite link:',url);}catch{notify(`Room code: ${state.code}`);}}
}
$('botUploadForm').addEventListener('submit',uploadBotTrack);
$('botPlay').addEventListener('click',()=>botControl('play'));
$('botPause').addEventListener('click',()=>botControl('pause'));
$('botSkip').addEventListener('click',()=>botControl('skip'));
$('botStop').addEventListener('click',()=>botControl('stop'));
$('botEnable').addEventListener('click',async()=>{
  state.botAudioEnabled=true;
  try { await botPlayer().play(); $('botEnable').hidden=true;refreshAudioSession(); }
  catch { state.botAudioEnabled=false;notify('Tap play on the bot audio player to enable sound.'); }
});
$('botAudio').addEventListener('loadedmetadata',syncBotAudio);
$('botAudio').addEventListener('waiting',()=>{
  if(state.bot?.playing) $('botStatus').textContent='Buffering…';
});
$('botAudio').addEventListener('stalled',()=>{
  if(state.bot?.playing) $('botStatus').textContent='Waiting for audio…';
});
$('botAudio').addEventListener('canplay',()=>{
  if(state.bot?.playing) {
    renderBot();
    if(!botPlayer().paused)refreshAudioSession();
  }
});
$('botAudio').addEventListener('timeupdate',refreshAudioSession);
$('botAudio').addEventListener('play',refreshAudioSession);
$('botAudio').addEventListener('pause',refreshAudioSession);
$('youtubeForm').addEventListener('submit', setYouTubeFromForm);
$('youtubeNext').addEventListener('click',()=>{if(state.hosting)broadcast({type:'youtube-next'});});
$('youtubeMode').addEventListener('change',e=>{
  if(state.hosting) broadcast({type:'youtube-mode',mode:e.target.value});
});
$('youtubeClear').addEventListener('click',()=>{
  if (!state.hosting || !state.joined) return;
  setYouTubeState(null);
  broadcast({type:'youtube',youtube:null});
});
$('youtubePlay').addEventListener('click',()=>hostYouTubeAction('play'));
$('youtubePause').addEventListener('click',()=>hostYouTubeAction('pause'));
$('youtubeSync').addEventListener('click',()=>hostYouTubeAction('sync'));
$('youtubeEnable').addEventListener('click',()=>{
  if (!state.youtube || !youtubeVisible()) {
    $('youtubePlayerHolder').scrollIntoView({behavior:'smooth',block:'center'});
    notify('Tap Play inside the visible YouTube player to allow sound.');
    return;
  }
  state.youtubeEnabled = true;
  if (state.youtubeReady) syncYouTubePlayer();
  else notify('YouTube is loading. Tap Play inside its player once ready.');
  renderYouTube();
});
$('createRoom').addEventListener('click',()=>enterRoom(true,makeCode()));
$('cancelConnection').addEventListener('click', () => resetRoom());
$('joinRoom').addEventListener('click',()=>{
  const code=normalizeRoomCode($('roomCodeInput').value);
  if(!isValidRoomCode(code)){notify('Enter a valid 6-character room code.');return;}
  enterRoom(false,code);
});
$('roomCodeInput').addEventListener('input',e=>{e.target.value=normalizeRoomCode(e.target.value);});
$('roomCodeInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('joinRoom').click();});
$('displayName').addEventListener('keydown',e=>{if(e.key==='Enter')$('createRoom').click();});
$('copyInvite').addEventListener('click',copyInvite);
$('copyInviteSide').addEventListener('click',copyInvite);
$('leaveRoom').addEventListener('click',()=>resetRoom(true));
$('retryConnection').addEventListener('click',()=>reconnectRoom(true));
window.addEventListener('online',()=>{if(state.joined && state.roomSocket?.readyState!==WebSocket.OPEN)reconnectRoom(true);});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    if(state.joined && state.roomSocket?.readyState!==WebSocket.OPEN)reconnectRoom(true);
    if(state.bot?.current)syncBotAudio();
  }
});
$('shareScreen').addEventListener('click',shareScreen);
$('shareDeviceAudio').addEventListener('click', shareDeviceAudio);
$('shareMicrophone').addEventListener('click', shareMicrophone);
$('audioFile').addEventListener('change',e=>{chooseAudio(e.target.files?.[0]);e.target.value='';});
$('playMusic').addEventListener('click',playPauseMusic);
$('stopMusic').addEventListener('click',()=>{if(!state.hosting)return;const p=$('musicPlayer');p.pause();p.currentTime=0;sendMusic();});
$('musicPlayer').addEventListener('loadedmetadata',sendMusic);
$('musicPlayer').addEventListener('play',sendMusic);
$('musicPlayer').addEventListener('pause',sendMusic);
$('musicPlayer').addEventListener('seeked',sendMusic);
$('musicPlayer').addEventListener('ended',sendMusic);
$('volume').addEventListener('input',e=>{
  const v=Number(e.target.value)/100;
  $('remoteMusic').volume=v; $('musicPlayer').volume=v; $('botAudio').volume=v;
  for (const audio of state.deviceAudioPlayers.values()) audio.volume=v;
});
$('chatForm').addEventListener('submit',e=>{
  e.preventDefault(); if(!state.joined)return;
  const body=cleanChat($('chatInput').value); if(!body)return;
  $('chatInput').value=''; const message={type:'chat',body,ts:Date.now()};
  addChat(myId(),body,message.ts);broadcast(message);
});
$('enableAudio').addEventListener('click',async()=>{
  const players = [$('remoteMusic'), ...state.deviceAudioPlayers.values()].filter(a => a.srcObject);
  const results = await Promise.allSettled(players.map(audio => audio.play()));
  refreshAudioSession();
  if (results.some(result => result.status === 'rejected')) {
    notify('Sound is still blocked. Allow audio playback in your browser settings.');
  } else {
    $('enableAudio').hidden=true; notify('Shared audio enabled.');
  }
});
setInterval(()=>{
  if(!state.joined)return;
  renderMusic();
  if (state.bot?.current){renderBot();syncBotAudio();}
  if (state.hosting && state.youtube?.playing && state.youtubeReady && Date.now() - (state.youtubeLastSync || 0) > 5000) {
    state.youtubeLastSync = Date.now();
    broadcastYouTube();
  }
  if(state.hosting && state.track.title && !$('musicPlayer').paused) {
    const currentSecond=Math.floor($('musicPlayer').currentTime);
    if(currentSecond>0 && currentSecond%3===0 && state._lastSentSecond!==currentSecond) {state._lastSentSecond=currentSecond;sendMusic();}
  }
},500);
try{$('displayName').value=localStorage.getItem('roomwave:name')||'';}catch{}
const queryRoom=normalizeRoomCode(new URLSearchParams(location.search).get('room'));
if(isValidRoomCode(queryRoom)){
  $('roomCodeInput').value=queryRoom;
  const cached=cachedRoom();
  if(cached?.code===queryRoom){
    if(cached.hosting)state.resumePeerId=cached.peerId;
    setTimeout(()=>enterRoom(Boolean(cached.hosting),queryRoom),0);
  } else {
    let name='';
    try{name=localStorage.getItem('roomwave:name')||'';}catch{}
    if(name.trim())setTimeout(()=>enterRoom(false,queryRoom),0);
  }
}
document.addEventListener('visibilitychange', pauseYouTubeWhenInvisible);
window.addEventListener('scroll', pauseYouTubeWhenInvisible, { passive: true });
window.addEventListener('resize', pauseYouTubeWhenInvisible);
// Installation helps the app stay in the task switcher. It does not bypass OS
// background throttling or YouTube's rules for keeping the visible player on screen.
let roomwaveInstallPrompt=null;
window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();
  roomwaveInstallPrompt=event;
  $('installRoomwave').hidden=false;
});
window.addEventListener('appinstalled',()=>{
  roomwaveInstallPrompt=null;
  $('installRoomwave').hidden=true;
});
$('installRoomwave').addEventListener('click',async()=>{
  if(roomwaveInstallPrompt){
    const prompt=roomwaveInstallPrompt;roomwaveInstallPrompt=null;
    try {await prompt.prompt();} catch {}
  } else {
    notify('Install Roomwave from your browser menu: Add to Home Screen or Install app. Keep the app open for room connection.');
  }
});
if('serviceWorker' in navigator && window.isSecureContext){
  window.addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js').catch(()=>{}));
}

window.addEventListener('beforeunload',()=>{try{state.peer?.destroy();}catch{}});