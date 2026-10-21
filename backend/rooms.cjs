'use strict';
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { createBotManager } = require('./music-bot.cjs');
const { createYouTubeQueue } = require('./youtube-queue.cjs');

const ROOM_PATH = '/rooms';
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const PEER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const ROOM_LIMIT = 8;
const RESUME_GRACE_MS = 300000;
const TOKEN = /^[0-9a-f]{48}$/;
function validResumeToken(expected, actual){
  if(typeof expected!=='string'||typeof actual!=='string'||!TOKEN.test(actual)) return false;
  const a=Buffer.from(expected,'hex'),b=Buffer.from(actual,'hex');
  return a.length===b.length && timingSafeEqual(a,b);
}

function cleanName(input) {
  return String(input ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0,24) || 'Guest';
}
function cleanChat(input) {
  return String(input ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0,450);
}
function safeSend(socket, payload) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
}

function createRoomHub({ logger = console } = {}) {
  const rooms = new Map();
  const sessions = new Map();
  const youtubeQueue = createYouTubeQueue();
  const bot = createBotManager({onUpdate(code, state){
    const room=rooms.get(code);if(!room)return;
    for(const p of room.participants.values()) safeSend(p.socket,{type:'bot-state',bot:state});
  }});

  function emitYouTube(code) {
    const room=rooms.get(code), snapshot=youtubeQueue.snapshot(code);
    if(!room||!snapshot)return;
    room.youtube = snapshot.youtube ? {...snapshot.youtube,updatedAt:Date.now()} : null;
    for(const p of room.participants.values()) safeSend(p.socket,{type:'youtube-state',...snapshot});
  }
  function roster(room) {
    return [...room.participants.values()].map(p => ({ id: p.id, name: p.name }));
  }
  function sendRoster(room) {
    const payload = { type: 'roster', members: roster(room) };
    for (const p of room.participants.values()) safeSend(p.socket, payload);
  }
  function removeParticipant(code,id){
    const room=rooms.get(code);
    const p=room?.participants.get(id);
    if(!room||!p)return;
    if(p.timer){clearTimeout(p.timer);p.timer=null;}
    room.participants.delete(id);
    if(p.socket){sessions.delete(p.socket);}
    if(room.hostId===id||room.participants.size===0){
      rooms.delete(code);
      bot.drop(code);
      youtubeQueue.removeRoom(code);
      for(const other of room.participants.values()){
        if(other.timer)clearTimeout(other.timer);
        if(other.socket){
          sessions.delete(other.socket);
          safeSend(other.socket,{type:'room-closed'});
          try{other.socket.close(1000,'Room closed');}catch{}
        }
      }
    } else sendRoster(room);
  }
  function leave(socket, immediate=false) {
    const session=sessions.get(socket);
    if(!session)return;
    sessions.delete(socket);
    const p=rooms.get(session.code)?.participants.get(session.id);
    if(!p||p.socket!==socket)return; // A newer socket may have resumed this participant.
    p.socket=null;
    if(immediate){removeParticipant(session.code,session.id);return;}
    if(p.timer)clearTimeout(p.timer);
    p.timer=setTimeout(()=>{
      if(rooms.get(session.code)?.participants.get(session.id)===p && !p.socket)
        removeParticipant(session.code,session.id);
    },RESUME_GRACE_MS);
    p.timer.unref?.();
    // Keep the roster stable during transient mobile/network disconnects.
  }
  function currentYouTube(state) {
    const elapsed = state.playing ? Math.max(0,(Date.now()-state.updatedAt)/1000) : 0;
    return { videoId: state.videoId, playing: state.playing,
      position: Math.min(86400, state.position + elapsed) };
  }
  function handle(socket, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const type = message.type;
    if (type === 'create' || type === 'join' || type === 'resume') {
      if (sessions.has(socket)) { safeSend(socket, {type:'error', reason:'already-in-room'}); return; }
      const code = message.code;
      const id = message.peerId;
      if (typeof code !== 'string' || !ROOM_CODE.test(code) || typeof id !== 'string' || !PEER_ID.test(id)) {
        safeSend(socket, {type:'error', reason:'invalid-room'}); return;
      }
      let room = rooms.get(code);
      if(type==='resume') {
        const participant=room?.participants.get(id);
        if(!participant || !validResumeToken(participant.resumeToken,message.resumeToken)){
          safeSend(socket,{type:'error',reason:room?'invalid-resume':'room-not-found'});return;
        }
        if(participant.timer){clearTimeout(participant.timer);participant.timer=null;}
        const oldSocket=participant.socket;
        if(oldSocket && oldSocket!==socket){
          sessions.delete(oldSocket);
          try{oldSocket.close(1000,'Reconnected');}catch{}
        }
        participant.socket=socket;
        sessions.set(socket,{code,id});
        const youtube=youtubeQueue.snapshot(code);
        safeSend(socket,{type:'resumed',code,members:roster(room),
          youtube:youtube.youtube,youtubeQueue:youtube.queue,youtubeMode:youtube.mode,
          bot:bot.state(code),resumeToken:participant.resumeToken,
          ...(id===room.hostId?{botToken:bot.rooms.get(code)?.token}:{})});
        sendRoster(room);
        return;
      }
      if (type === 'create') {
        if (room) { safeSend(socket,{type:'error',reason:'room-exists'}); return; }
        if (id !== `roomwave-host-${code}`) { safeSend(socket,{type:'error',reason:'invalid-host'}); return; }
        room = { hostId: id, participants: new Map(), youtube: null };
        rooms.set(code, room);
        bot.create(code);
        youtubeQueue.setup(code);
      } else {
        if (!room) { safeSend(socket,{type:'error',reason:'room-not-found'}); return; }
        if (room.participants.size >= ROOM_LIMIT) { safeSend(socket,{type:'error',reason:'room-full'}); return; }
        if (room.participants.has(id) || id === room.hostId) { safeSend(socket,{type:'error',reason:'duplicate-peer'}); return; }
      }
      const participant = { socket, id, name: cleanName(message.name), resumeToken:randomBytes(24).toString('hex'), timer:null };
      room.participants.set(id, participant);
      sessions.set(socket, {code, id});
      safeSend(socket,{type:type === 'create' ? 'created' : 'joined', code, members:roster(room), youtube:youtubeQueue.snapshot(code).youtube, youtubeQueue:youtubeQueue.snapshot(code).queue, youtubeMode:youtubeQueue.snapshot(code).mode,bot:bot.state(code),resumeToken:participant.resumeToken,...(type==='create'?{botToken:bot.rooms.get(code).token}:{})});
      sendRoster(room);
      return;
    }
    const session = sessions.get(socket);
    if (!session) return;
    const room = rooms.get(session.code);
    if (!room) return;
    if(type==='leave'){leave(socket,true);return;}
    if(type==='bot-control' && session.id===room.hostId){
      bot.control(session.code,message.action,message.position);
    } else if (type === 'chat') {
      const body = cleanChat(message.body);
      if (!body) return;
      const payload={type:'chat', from:session.id, body, ts:Date.now()};
      for (const p of room.participants.values()) if (p.socket !== socket) safeSend(p.socket,payload);
    } else if(type==='youtube-add') {
      if(youtubeQueue.add(session.code,message.videoId,room.participants.get(session.id)?.name)) emitYouTube(session.code);
      else safeSend(socket,{type:'youtube-queue-error',message:'Could not add video. Check the link or queue limit.'});
    } else if(type==='youtube' && session.id===room.hostId) {
      if(youtubeQueue.setPlayback(session.code,message.youtube)) emitYouTube(session.code);
    } else if(session.id===room.hostId && type==='youtube-duration') {
      // Verified host iframe metadata; this enables autonomous next-track
      // selection without hosting YouTube media on Render.
      if(youtubeQueue.setDuration(session.code,message.videoId,message.duration))
        emitYouTube(session.code);
    } else if(session.id===room.hostId && type==='youtube-mode') {
      if(youtubeQueue.setMode(session.code,message.mode)) emitYouTube(session.code);
    } else if(session.id===room.hostId && (type==='youtube-next'||type==='youtube-ended')) {
      if(youtubeQueue.next(session.code,type==='youtube-ended')) emitYouTube(session.code);
    } else if(session.id===room.hostId && type==='youtube-select') {
      if(youtubeQueue.select(session.code,message.id)) emitYouTube(session.code);
    } else if(session.id===room.hostId && type==='youtube-remove') {
      if(youtubeQueue.remove(session.code,message.id)) emitYouTube(session.code);
    } else if(session.id===room.hostId && type==='youtube-move') {
      if(youtubeQueue.move(session.code,message.id,message.direction)) emitYouTube(session.code);
    } else if (type === 'music' && session.id === room.hostId) {
      const t = message.track;
      if (!t || typeof t !== 'object' || Array.isArray(t)) return;
      const num = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(n, 86400) : 0;
      const payload = { type:'music', track:{ title:String(t.title ?? '').slice(0,120), duration:num(t.duration),position:num(t.position),playing:Boolean(t.playing) } };
      for (const p of room.participants.values()) if (p.socket !== socket) safeSend(p.socket,payload);
    }
  }
  function receive(socket, raw) {
    if (raw.length > 4096) { socket.close(1009, 'Message too large'); return; }
    try { handle(socket, JSON.parse(raw.toString())); }
    catch (error) { logger.warn?.('Invalid room message:', error.message); safeSend(socket,{type:'error',reason:'invalid-message'}); }
  }
  function connected(socket) {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', raw => receive(socket, raw));
    socket.on('close', () => leave(socket));
    socket.on('error', () => leave(socket));
  }
  return { rooms, sessions, bot, youtubeQueue, handle, leave, connected };
}

function attachRooms(server, { allowedOrigins = [], logger = console } = {}) {
  const { WebSocketServer } = require('ws');
  const hub = createRoomHub({logger});
  const wss = new WebSocketServer({ noServer:true, maxPayload:4096 });
  server.on('upgrade', (req, socket, head) => {
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (path !== ROOM_PATH) return;
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', hub.connected);
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  },25000);
  heartbeat.unref?.();
  const botTicker=setInterval(()=>{
    hub.bot.tick();
    for(const code of hub.youtubeQueue.tick()){
      hub.youtubeQueue.snapshot(code) && hub.rooms.get(code) &&
        hub.rooms.get(code).participants.forEach(p=>safeSend(p.socket,{
          type:'youtube-state',...hub.youtubeQueue.snapshot(code)
        }));
    }
  },1000);
  botTicker.unref?.();
  wss.on('close', () => {clearInterval(heartbeat);clearInterval(botTicker);});
  return {hub, wss};
}

module.exports={ROOM_PATH, ROOM_LIMIT, RESUME_GRACE_MS, createRoomHub, attachRooms};
