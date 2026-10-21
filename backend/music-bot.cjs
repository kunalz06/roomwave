'use strict';
const { randomBytes, timingSafeEqual } = require('node:crypto');

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TRACKS_PER_ROOM = 5;
const MIME = new Set(['audio/mpeg','audio/mp4','audio/x-m4a','audio/ogg','audio/wav','audio/wave','audio/webm','audio/aac','audio/flac']);

function safeToken(actual, supplied) {
  if (typeof supplied !== 'string' || !/^[0-9a-f]{48}$/.test(supplied)) return false;
  const a=Buffer.from(actual,'hex'), b=Buffer.from(supplied,'hex');
  return a.length===b.length && timingSafeEqual(a,b);
}
function createBotManager({now=()=>Date.now(),onUpdate=()=>{}}={}) {
  const rooms=new Map(), tracks=new Map();
  let bytes=0;
  const id=()=>randomBytes(16).toString('hex');
  function create(code) {
    const bot={token:randomBytes(24).toString('hex'),current:null,queue:[],playing:false,position:0,updatedAt:now(),revision:0};
    rooms.set(code,bot);
    return bot.token;
  }
  function authorized(code,token) { const b=rooms.get(code);return Boolean(b && safeToken(b.token,token)); }
  function position(b) {
    if (!b.current) return 0;
    return Math.max(0,Math.min(b.current.duration,b.position+(b.playing?Math.max(0,(now()-b.updatedAt)/1000):0)));
  }
  function publicTrack(t) {return t && {id:t.id,title:t.title,duration:t.duration,url:'/bot/tracks/'+t.id};}
  function state(code) {
    const b=rooms.get(code);
    if(!b)return null;
    return {current:publicTrack(b.current),queue:b.queue.map(publicTrack),playing:b.playing,position:position(b),revision:b.revision};
  }
  function emit(code){const b=rooms.get(code);if(b){b.revision++;onUpdate(code,state(code));}}
  function free(t){if(t){tracks.delete(t.id);bytes-=t.data.length;}}
  function drop(code) {
    const b=rooms.get(code);if(!b)return;
    free(b.current);for(const t of b.queue) free(t);rooms.delete(code);
  }
  function upload(code,token,{data,title,mime,duration}) {
    const b=rooms.get(code);
    if(!b || !authorized(code,token)) return {error:'unauthorized'};
    if(!Buffer.isBuffer(data) || data.length<128 || data.length>MAX_FILE_BYTES || bytes+data.length>MAX_TOTAL_BYTES)
      return {error:'size-limit'};
    if(!MIME.has(mime) || typeof duration!=='number' || !Number.isFinite(duration) || duration<1 || duration>7200) return {error:'invalid-track'};
    if(b.queue.length+Number(Boolean(b.current))>=MAX_TRACKS_PER_ROOM) return {error:'queue-full'};
    const name=String(title??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,90)||'Audio track';
    const t={id:id(),title:name,duration,mime,data};
    tracks.set(t.id,t);bytes+=data.length;
    if(!b.current){b.current=t;b.playing=false;b.position=0;b.updatedAt=now();}
    else b.queue.push(t);
    emit(code);
    return {track:publicTrack(t)};
  }
  function advance(code,b,playing=b.playing) {
    free(b.current);
    b.current=b.queue.shift()||null;
    b.position=0;b.updatedAt=now();b.playing=Boolean(b.current && playing);
    emit(code);
  }
  function control(code,action,value) {
    const b=rooms.get(code);if(!b || !b.current)return false;
    const p=position(b);
    if(action==='play'){b.position=p;b.playing=true;}
    else if(action==='pause'){b.position=p;b.playing=false;}
    else if(action==='skip'){advance(code,b,true);return true;}
    else if(action==='stop'){b.position=0;b.playing=false;}
    else if(action==='seek'){
      if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>b.current.duration)return false;
      b.position=value;
    } else return false;
    b.updatedAt=now();emit(code);return true;
  }
  function tick() {
    for(const [code,b] of rooms){
      if(b.playing && b.current && position(b)>=b.current.duration) advance(code,b,true);
    }
  }
  function getTrack(idValue){return /^[0-9a-f]{32}$/.test(String(idValue))?tracks.get(idValue)||null:null;}
  function stats(){return {bytes,rooms:rooms.size,tracks:tracks.size};}
  return {rooms,create,authorized,upload,control,state,drop,tick,getTrack,stats};
}

function attachBotRoutes(app, bot, allowedOrigins) {
  app.use('/bot', (req,res,next)=>{
    const origin=req.get('origin');
    if(origin) {
      if(!allowedOrigins.includes(origin)) return res.status(403).end();
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Vary','Origin');
    }
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method==='OPTIONS'){
      res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Room-Bot-Token,X-Music-Title,X-Music-Duration');
      return res.status(204).end();
    }
    next();
  });
  app.post('/bot/upload',(req,res)=>{
    const code=String(req.query.code||'');
    if(!bot.authorized(code,req.get('X-Room-Bot-Token'))) return res.status(403).json({error:'unauthorized'});
    const mime=String(req.get('Content-Type')||'').split(';')[0].toLowerCase();
    const length=Number(req.get('Content-Length'));
    if(!MIME.has(mime)) return res.status(415).json({error:'unsupported-type'});
    if(!Number.isSafeInteger(length)||length<128||length>MAX_FILE_BYTES)return res.status(413).json({error:'size-limit'});
    const duration=Number(req.get('X-Music-Duration'));
    if(!Number.isFinite(duration)||duration<1||duration>7200)return res.status(400).json({error:'invalid-duration'});
    let title='Audio track';
    try{title=decodeURIComponent(req.get('X-Music-Title')||'Audio track');}catch{return res.status(400).json({error:'invalid-title'});}
    const chunks=[];let received=0;let failed=false;
    req.on('data',chunk=>{
      received+=chunk.length;
      if(received>MAX_FILE_BYTES){failed=true;req.destroy();return;}
      chunks.push(chunk);
    });
    req.on('end',()=>{
      if(failed||received!==length)return res.status(400).json({error:'incomplete-upload'});
      const result=bot.upload(code,req.get('X-Room-Bot-Token'),{data:Buffer.concat(chunks),title,mime,duration});
      res.status(result.error?(result.error==='unauthorized'?403:400):201).json(result);
    });
    req.on('error',()=>{failed=true;});
  });
  app.get('/bot/tracks/:id',(req,res)=>{
    const t=bot.getTrack(req.params.id);
    if(!t)return res.status(404).end();
    const size=t.data.length;
    res.setHeader('Content-Type',t.mime);
    res.setHeader('Accept-Ranges','bytes');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('Access-Control-Allow-Origin','*');
    const range=req.get('range');
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match || (!match[1]&&!match[2]))return res.status(416).set('Content-Range',`bytes */${size}`).end();
      let start,end;
      if(!match[1]){const length=Number(match[2]);start=Math.max(0,size-length);end=size-1;}
      else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>size-1||start>end)return res.status(416).set('Content-Range',`bytes */${size}`).end();
      res.status(206);
      res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length',end-start+1);
      return res.end(t.data.subarray(start,end+1));
    }
    res.setHeader('Content-Length',size);
    res.end(t.data);
  });
}
module.exports={createBotManager,attachBotRoutes,MAX_FILE_BYTES,MAX_TOTAL_BYTES};
