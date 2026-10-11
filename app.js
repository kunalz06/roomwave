import {
  normalizeRoomCode, isValidRoomCode, makeRoomCode, cleanName, cleanChat,
  hostPeerId, isValidPeerId, formatTime, peerOptionsFromEndpoint
} from './room-utils.mjs';

const $ = (id) => document.getElementById(id);
const LIMIT = 8;
const state = {
  peer: null, connecting: false, code: '', name: '', hosting: false, joined: false,
  members: new Map(), connections: new Map(),
  screenStream: null, screenCalls: new Map(), remoteScreens: new Map(),
  audioContext: null, audioDestination: null, audioSource: null,
  musicCalls: new Map(), incomingMusicCall: null, trackObjectURL: null,
  track: { title: '', duration: 0, position: 0, playing: false, stamped: 0 },
  joinTimeout: null, setupTimeout: null, warmupAbort: null, connectAttempt: 0,
  countMessages: 0, toastTimeout: null
};

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
function activeConnections() {
  return Array.from(state.connections.values()).filter(c => c.open);
}
function send(conn, data) {
  if (!conn?.open) return;
  try { conn.send(data); } catch { /* A disconnect will be handled by PeerJS. */ }
}
function broadcast(data) { for (const conn of activeConnections()) send(conn, data); }
function initIdentity() {
  state.name = cleanName($('displayName').value);
  $('displayName').value = state.name;
  try { localStorage.setItem('roomwave:name', state.name); } catch { /* private browsing */ }
}
function resetRoom() {
  ++state.connectAttempt; // Invalidates any outstanding free-tier wakeup promise.
  state.warmupAbort?.abort();
  state.warmupAbort = null;
  clearTimeout(state.setupTimeout);
  state.setupTimeout = null;
  clearTimeout(state.joinTimeout);
  state.joinTimeout = null;
  stopSharing();
  for (const call of state.musicCalls.values()) { try { call.close(); } catch {} }
  state.musicCalls.clear();
  try { state.incomingMusicCall?.close(); } catch {}
  state.incomingMusicCall = null;
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
  state.members.set(isHost ? peerHost() : '__pending__', state.name);
  const chosenId = isHost ? peerHost() : undefined;
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
    clearTimeout(state.setupTimeout);
    state.setupTimeout = null;
    state.members.delete('__pending__');
    state.members.set(id, state.name);
    if (state.hosting) {
      displayRoom();
    } else {
      setLobbyBusy(true, 'Connecting to the room host…');
      connectTo(peerHost(), true);
      state.joinTimeout = setTimeout(() => {
        if (!state.joined && state.peer === peer) {
          connectionFailed('Could not join that room. Check the code and that the host is still online.');
        }
      }, 20000);
    }
  });
  peer.on('connection', registerConnection);
  peer.on('call', acceptCall);
  peer.on('disconnected', () => {
    if (state.peer !== peer) return;
    if (!state.joined) {
      connectionFailed('Lost the connection to the room server. Please retry.');
      return;
    }
    notify('Room server disconnected. Attempting to reconnect…');
    try { peer.reconnect(); } catch { /* Room may reconnect automatically. */ }
  });
  peer.on('close', () => {
    if (state.peer === peer) connectionFailed('Room connection ended. Please create or join a room again.');
  });
  peer.on('error', (error) => {
    if (state.peer !== peer) return;
    const type = error?.type || '';
    if (type === 'unavailable-id') {
      connectionFailed('That room code is already in use. Create another room.');
    } else if (type === 'peer-unavailable' && !state.joined) {
      connectionFailed('Room not found. Ask the host to create it first.');
    } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable'].includes(type)) {
      if (!state.joined) connectionFailed('Room connection failed. Check your network and try again.');
      else notify('Connection issue. If participants disappear, leave and rejoin the room.');
    }
  });
}
function displayRoom() {
  if (state.joined) return;
  clearTimeout(state.joinTimeout);
  state.joinTimeout = null;
  setLobbyBusy(false);
  state.joined = true;
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
}
function connectTo(id, mustConnect = false) {
  if (!state.peer || !isValidPeerId(id) || id === myId()) return;
  if (!mustConnect && myId() > id) return;
  const existing = state.connections.get(id);
  if (existing && !existing.disconnected) return;
  try { registerConnection(state.peer.connect(id, { reliable: true })); }
  catch { notify('Could not connect to a participant.'); }
}
function registerConnection(conn) {
  if (!state.peer || !isValidPeerId(conn.peer) || conn.peer === myId()) { conn.close(); return; }
  // For simultaneous mesh dials, keep the outgoing connection from the lower peer ID.
  const existing = state.connections.get(conn.peer);
  if (existing && existing !== conn) {
    const preferOutgoing = myId() < conn.peer;
    const isNewOutgoing = conn.type === 'data' && conn.options?.metadata?.outgoing === true;
    // Already have an active channel; do not risk closing the only live channel.
    if (existing.open) { conn.close(); return; }
    if (preferOutgoing && !isNewOutgoing && !isHostId(conn.peer)) { conn.close(); return; }
    try { existing.close(); } catch {}
  }
  state.connections.set(conn.peer, conn);
  conn.on('open', () => {
    if (state.connections.get(conn.peer) !== conn) return;
    send(conn, { type:'hello', name:state.name });
    if (state.screenStream) sendScreenTo(conn.peer);
    if (state.hosting && state.audioDestination) sendMusicTo(conn.peer);
  });
  conn.on('data', data => handleMessage(conn, data));
  conn.on('close', () => {
    if (state.connections.get(conn.peer) !== conn) return;
    state.connections.delete(conn.peer);
    if (state.hosting) {
      state.members.delete(conn.peer);
      sendRoster();
    } else if (isHostId(conn.peer)) {
      notify('The host left the room. Returning to the lobby.');
      resetRoom();
      return;
    } else { state.members.delete(conn.peer); }
    renderPeople();
  });
  conn.on('error', () => { /* PeerJS also emits close; avoid duplicate messages. */ });
}
function sendRoster() {
  if (!state.hosting) return;
  const members = Array.from(state.members.entries()).filter(([id]) => id === myId() || state.connections.get(id)?.open)
    .slice(0,LIMIT).map(([id,name]) => ({ id, name }));
  broadcast({ type:'roster', members });
}
function handleMessage(conn, data) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
  const fromHost = isHostId(conn.peer);
  if (data.type === 'hello') {
    if (state.hosting && !state.members.has(conn.peer) && state.members.size >= LIMIT) {
      send(conn,{type:'room-full'}); setTimeout(() => conn.close(), 100); return;
    }
    const name = cleanName(data.name);
    state.members.set(conn.peer, name);
    renderPeople();
    if (state.hosting) {
      sendRoster();
      send(conn, { type:'music', track:currentTrack() });
    }
  } else if (data.type === 'roster' && fromHost && !state.hosting) {
    if (!Array.isArray(data.members)) return;
    const clean = data.members.slice(0,LIMIT).filter(m => m && isValidPeerId(m.id) && typeof m.name === 'string');
    if (!clean.some(m => m.id === myId()) || !clean.some(m => m.id === peerHost())) return;
    for (const m of clean) state.members.set(m.id, cleanName(m.name));
    for (const id of [...state.members.keys()]) if (id !== myId() && !clean.some(m => m.id === id)) state.members.delete(id);
    displayRoom();
    for (const member of clean) if (member.id !== myId() && member.id !== peerHost()) connectTo(member.id);
    renderPeople();
  } else if (data.type === 'room-full' && fromHost && !state.hosting) {
    notify('That room is full (maximum 8 people).'); resetRoom();
  } else if (data.type === 'chat' && state.joined) {
    if (typeof data.body === 'string') addChat(conn.peer, cleanChat(data.body), Number(data.ts));
  } else if (data.type === 'music' && fromHost && !state.hosting) {
    if (data.track && typeof data.track === 'object') {
      const t = data.track;
      state.track = {
        title: String(t.title ?? '').slice(0,120),
        duration: validNumber(t.duration), position: validNumber(t.position),
        playing: Boolean(t.playing), stamped:Date.now()
      };
      renderMusic();
    }
  }
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
  const kind = call.metadata?.kind;
  if (kind !== 'screen' && kind !== 'music') { call.close(); return; }
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
  } else {
    if (state.incomingMusicCall) { try { state.incomingMusicCall.close(); } catch {} }
    state.incomingMusicCall = call;
    call.on('stream', stream => {
      const audio = $('remoteMusic'); audio.srcObject = stream;
      audio.volume = Number($('volume').value)/100;
      audio.play().then(() => { $('enableAudio').hidden = true; })
        .catch(() => { $('enableAudio').hidden = false; });
    });
    call.on('close', () => {
      if (state.incomingMusicCall === call) { $('remoteMusic').srcObject=null; state.incomingMusicCall=null; }
    });
  }
}
function sendScreenTo(id) {
  if (!state.peer || !state.screenStream || !state.connections.get(id)?.open || state.screenCalls.has(id)) return;
  try {
    const call = state.peer.call(id, state.screenStream, { metadata:{kind:'screen'} });
    state.screenCalls.set(id,call);
    call.on('close',()=>{if(state.screenCalls.get(id)===call)state.screenCalls.delete(id);});
    call.on('error',()=>{if(state.screenCalls.get(id)===call)state.screenCalls.delete(id);});
  } catch { notify('Could not send screen to a participant.'); }
}
async function shareScreen() {
  if (state.screenStream) { stopSharing(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { notify('Screen sharing requires a supported desktop browser on HTTPS.'); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:{frameRate:15}, audio:false });
    state.screenStream = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended',stopSharing,{once:true});
    for (const conn of activeConnections()) sendScreenTo(conn.peer);
    renderScreens();
  } catch (error) {
    if (error?.name !== 'NotAllowedError') notify('Screen capture failed. Try sharing a different tab or window.');
  }
}
function stopSharing() {
  if (state.screenStream) {for(const track of state.screenStream.getTracks())track.stop();state.screenStream=null;}
  for(const call of state.screenCalls.values()){try{call.close();}catch{}}
  state.screenCalls.clear();renderScreens();
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
  if (!state.hosting || !state.peer || !state.audioDestination || !state.connections.get(id)?.open || state.musicCalls.has(id)) return;
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
function sendMusic() {if(state.hosting && state.joined){state.track={...currentTrack(),stamped:Date.now()};broadcast({type:'music',track:currentTrack()});renderMusic();}}
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
  for (const conn of activeConnections()) sendMusicTo(conn.peer);
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
$('leaveRoom').addEventListener('click',()=>resetRoom());
$('shareScreen').addEventListener('click',shareScreen);
$('audioFile').addEventListener('change',e=>{chooseAudio(e.target.files?.[0]);e.target.value='';});
$('playMusic').addEventListener('click',playPauseMusic);
$('stopMusic').addEventListener('click',()=>{if(!state.hosting)return;const p=$('musicPlayer');p.pause();p.currentTime=0;sendMusic();});
$('musicPlayer').addEventListener('loadedmetadata',sendMusic);
$('musicPlayer').addEventListener('play',sendMusic);
$('musicPlayer').addEventListener('pause',sendMusic);
$('musicPlayer').addEventListener('seeked',sendMusic);
$('musicPlayer').addEventListener('ended',sendMusic);
$('volume').addEventListener('input',e=>{const v=Number(e.target.value)/100;$('remoteMusic').volume=v;$('musicPlayer').volume=v;});
$('chatForm').addEventListener('submit',e=>{
  e.preventDefault(); if(!state.joined)return;
  const body=cleanChat($('chatInput').value); if(!body)return;
  $('chatInput').value=''; const message={type:'chat',body,ts:Date.now()};
  addChat(myId(),body,message.ts);broadcast(message);
});
$('enableAudio').addEventListener('click',async()=>{
  try{await $('remoteMusic').play();$('enableAudio').hidden=true;notify('Audio enabled. Enjoy the music!');}
  catch{notify('Your browser blocked audio. Check its autoplay or sound settings.');}
});
setInterval(()=>{
  if(!state.joined)return;
  renderMusic();
  if(state.hosting && state.track.title && !$('musicPlayer').paused) {
    const currentSecond=Math.floor($('musicPlayer').currentTime);
    if(currentSecond>0 && currentSecond%3===0 && state._lastSentSecond!==currentSecond) {state._lastSentSecond=currentSecond;sendMusic();}
  }
},500);
try{$('displayName').value=localStorage.getItem('roomwave:name')||'';}catch{}
const queryRoom=normalizeRoomCode(new URLSearchParams(location.search).get('room'));
if(isValidRoomCode(queryRoom))$('roomCodeInput').value=queryRoom;
window.addEventListener('beforeunload',()=>{try{state.peer?.destroy();}catch{}});