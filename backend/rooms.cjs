'use strict';
const { createBotManager } = require('./music-bot.cjs');

const ROOM_PATH = '/rooms';
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const PEER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const ROOM_LIMIT = 8;

function cleanName(input) {
  return String(input ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0,24) || 'Guest';
}
function cleanChat(input) {
  return String(input ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0,450);
}
function safeSend(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function createRoomHub({ logger = console } = {}) {
  const rooms = new Map();
  const sessions = new Map();
  const bot = createBotManager({onUpdate(code, state){
    const room=rooms.get(code);if(!room)return;
    for(const p of room.participants.values()) safeSend(p.socket,{type:'bot-state',bot:state});
  }});

  function roster(room) {
    return [...room.participants.values()].map(p => ({ id: p.id, name: p.name }));
  }
  function sendRoster(room) {
    const payload = { type: 'roster', members: roster(room) };
    for (const p of room.participants.values()) safeSend(p.socket, payload);
  }
  function leave(socket) {
    const session = sessions.get(socket);
    if (!session) return;
    sessions.delete(socket);
    const room = rooms.get(session.code);
    if (!room) return;
    room.participants.delete(session.id);
    if (room.hostId === session.id || room.participants.size === 0) {
      rooms.delete(session.code);
      bot.drop(session.code);
      for (const p of room.participants.values()) {
        sessions.delete(p.socket);
        safeSend(p.socket, { type: 'room-closed' });
        try { p.socket.close(1000, 'Host left'); } catch {}
      }
    } else {
      sendRoster(room);
    }
  }
  function currentYouTube(state) {
    const elapsed = state.playing ? Math.max(0,(Date.now()-state.updatedAt)/1000) : 0;
    return { videoId: state.videoId, playing: state.playing,
      position: Math.min(86400, state.position + elapsed) };
  }
  function handle(socket, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const type = message.type;
    if (type === 'create' || type === 'join') {
      if (sessions.has(socket)) { safeSend(socket, {type:'error', reason:'already-in-room'}); return; }
      const code = message.code;
      const id = message.peerId;
      if (typeof code !== 'string' || !ROOM_CODE.test(code) || typeof id !== 'string' || !PEER_ID.test(id)) {
        safeSend(socket, {type:'error', reason:'invalid-room'}); return;
      }
      let room = rooms.get(code);
      if (type === 'create') {
        if (room) { safeSend(socket,{type:'error',reason:'room-exists'}); return; }
        if (id !== `roomwave-host-${code}`) { safeSend(socket,{type:'error',reason:'invalid-host'}); return; }
        room = { hostId: id, participants: new Map(), youtube: null };
        rooms.set(code, room);
        bot.create(code);
      } else {
        if (!room) { safeSend(socket,{type:'error',reason:'room-not-found'}); return; }
        if (room.participants.size >= ROOM_LIMIT) { safeSend(socket,{type:'error',reason:'room-full'}); return; }
        if (room.participants.has(id) || id === room.hostId) { safeSend(socket,{type:'error',reason:'duplicate-peer'}); return; }
      }
      const participant = { socket, id, name: cleanName(message.name) };
      room.participants.set(id, participant);
      sessions.set(socket, {code, id});
      safeSend(socket,{type:type === 'create' ? 'created' : 'joined', code, members:roster(room), youtube:room.youtube ? currentYouTube(room.youtube) : null,bot:bot.state(code),...(type==='create'?{botToken:bot.rooms.get(code).token}:{})});
      sendRoster(room);
      return;
    }
    const session = sessions.get(socket);
    if (!session) return;
    const room = rooms.get(session.code);
    if (!room) return;
    if(type==='bot-control' && session.id===room.hostId){
      bot.control(session.code,message.action,message.position);
    } else if (type === 'chat') {
      const body = cleanChat(message.body);
      if (!body) return;
      const payload={type:'chat', from:session.id, body, ts:Date.now()};
      for (const p of room.participants.values()) if (p.socket !== socket) safeSend(p.socket,payload);
    } else if (type === 'youtube' && session.id === room.hostId) {
      const v = message.youtube;
      if (v === null) {
        room.youtube = null;
        for (const p of room.participants.values()) if (p.socket !== socket) safeSend(p.socket,{type:'youtube',youtube:null});
        return;
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      if (v.videoId !== null && (typeof v.videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(v.videoId))) return;
      if (typeof v.position !== 'number' || !Number.isFinite(v.position) || v.position < 0 || v.position > 86400 || typeof v.playing !== 'boolean') return;
      if (v.videoId === null && (v.playing || v.position !== 0)) return;
      room.youtube = v.videoId ? { videoId:v.videoId,playing:v.playing,position:v.position,updatedAt:Date.now() } : null;
      const payload = {type:'youtube',youtube:room.youtube ? currentYouTube(room.youtube) : null};
      for(const p of room.participants.values()) if(p.socket !== socket) safeSend(p.socket,payload);
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
  return { rooms, sessions, bot, handle, leave, connected };
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
  const botTicker=setInterval(()=>hub.bot.tick(),1000);
  botTicker.unref?.();
  wss.on('close', () => {clearInterval(heartbeat);clearInterval(botTicker);});
  return {hub, wss};
}

module.exports={ROOM_PATH, ROOM_LIMIT, createRoomHub, attachRooms};
