'use strict';
const {randomBytes,randomInt}=require('node:crypto');
const ID=/^[A-Za-z0-9_-]{11}$/;
const MODES=new Set(['sequential','shuffle','repeat-one','manual']);
const MAX_QUEUE=40;
const cleanText=v=>String(v||'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,24);
function createYouTubeQueue({now=()=>Date.now(),random=n=>randomInt(n)}={}) {
  const rooms=new Map();
  function setup(code){rooms.set(code,{current:null,queue:[],mode:'sequential'});}
  function removeRoom(code){rooms.delete(code);}
  function snapshot(code){
    const r=rooms.get(code);if(!r)return null;
    let y=null;
    if(r.current) {
      const c=r.current;
      y={videoId:c.videoId,position:Math.min(86400,c.position+(c.playing?Math.max(0,(now()-c.updatedAt)/1000):0)),playing:c.playing};
    }
    return {youtube:y,queue:r.queue.map(({id,videoId,by})=>({id,videoId,by})),mode:r.mode};
  }
  function setPlayback(code,youtube) {
    const r=rooms.get(code);if(!r)return false;
    if(youtube===null){r.current=null;return true;}
    if(!youtube||typeof youtube!=='object'||Array.isArray(youtube)||
        !ID.test(youtube.videoId)||
        typeof youtube.position!=='number'||!Number.isFinite(youtube.position)||youtube.position<0||youtube.position>86400||
        typeof youtube.playing!=='boolean')return false;
    r.current={videoId:youtube.videoId,position:youtube.position,playing:youtube.playing,updatedAt:now()};
    return true;
  }
  function add(code,videoId,by) {
    const r=rooms.get(code);
    if(!r||typeof videoId!=='string'||!ID.test(videoId)||r.queue.length>=MAX_QUEUE)return false;
    // Queue even if nothing is playing so the host chooses when to start.
    r.queue.push({id:randomBytes(9).toString('hex'),videoId,by:cleanText(by)});
    // The first valid contribution becomes the current video automatically.
    // Playback still depends on YouTube's visible-player/autoplay permissions.
    if(!r.current){
      const first=r.queue.shift();
      r.current={videoId:first.videoId,position:0,playing:true,updatedAt:now()};
    }
    return true;
  }
  function setMode(code,mode){const r=rooms.get(code);if(!r||!MODES.has(mode))return false;r.mode=mode;return true;}
  function select(code,id){
    const r=rooms.get(code);if(!r||typeof id!=='string')return false;
    const index=r.queue.findIndex(e=>e.id===id);if(index<0)return false;
    const item=r.queue.splice(index,1)[0];
    r.current={videoId:item.videoId,position:0,playing:false,updatedAt:now()};
    return true;
  }
  function next(code,ended=false){
    const r=rooms.get(code);if(!r)return false;
    if(ended && r.mode==='manual'){
      if(r.current){
        const c=r.current;
        c.position=Math.min(86400,c.position+(c.playing?Math.max(0,(now()-c.updatedAt)/1000):0));
        c.playing=false;c.updatedAt=now();
      }
      return true;
    }
    if(ended && r.mode==='repeat-one' && r.current) {
      r.current={...r.current,position:0,playing:true,updatedAt:now()};
      return true;
    }
    if(!r.queue.length){r.current=null;return true;}
    const ix=r.mode==='shuffle'?Math.max(0,Math.min(r.queue.length-1,random(r.queue.length))):0;
    const item=r.queue.splice(ix,1)[0];
    r.current={videoId:item.videoId,position:0,playing:true,updatedAt:now()};
    return true;
  }
  function remove(code,id){const r=rooms.get(code);if(!r||typeof id!=='string')return false;const i=r.queue.findIndex(e=>e.id===id);if(i<0)return false;r.queue.splice(i,1);return true;}
  function move(code,id,direction){
    const r=rooms.get(code);if(!r||![-1,1].includes(direction)||typeof id!=='string')return false;
    const i=r.queue.findIndex(e=>e.id===id);const j=i+direction;
    if(i<0||j<0||j>=r.queue.length)return false;
    [r.queue[i],r.queue[j]]=[r.queue[j],r.queue[i]];
    return true;
  }
  return {setup,removeRoom,snapshot,setPlayback,add,setMode,select,next,remove,move,rooms};
}
module.exports={createYouTubeQueue,MAX_QUEUE};
