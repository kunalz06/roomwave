'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRoomHub, ROOM_LIMIT } = require('../rooms.cjs');
class Socket extends EventEmitter {
  constructor() { super(); this.readyState=1; this.out=[]; }
  send(data) { this.out.push(JSON.parse(data)); }
  close() { this.readyState=3; this.emit('close'); }
  ping() {}
  push(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  last(type) {return this.out.filter(x=>x.type===type).at(-1);}
}
function participant(hub, type, code, id, name) {
  const s = new Socket(); hub.connected(s); s.push({type,code,peerId:id,name});return s;
}
test('two participants can join without any WebRTC data connection and chat through Render', () => {
  const hub=createRoomHub();
  const host=participant(hub,'create','BCDEFG','roomwave-host-BCDEFG','Host');
  const guest=participant(hub,'join','BCDEFG','guest-123','Desktop');
  assert.equal(host.last('created').members.length,1);
  assert.equal(guest.last('joined').members.length,2);
  assert.equal(host.last('roster').members.length,2);
  guest.push({type:'chat',body:'hello from desktop'});
  assert.equal(host.last('chat').body,'hello from desktop');
  assert.equal(host.last('chat').from,'guest-123');
  host.push({type:'music',track:{title:'Demo',position:12,duration:100,playing:true}});
  assert.equal(guest.last('music').track.title,'Demo');
  guest.push({type:'music',track:{title:'Spoof'}});
  assert.equal(host.last('music'),undefined);
});
test('host departure closes the room and rejects later joins', () => {
  const hub=createRoomHub();
  const host=participant(hub,'create','BCDEFG','roomwave-host-BCDEFG','Host');
  const guest=participant(hub,'join','BCDEFG','guest-123','Guest');
  host.push({type:'leave'});
  assert.equal(guest.last('room-closed').type,'room-closed');
  const third=participant(hub,'join','BCDEFG','guest-456','Third');
  assert.equal(third.last('error').reason,'room-not-found');
  assert.equal(hub.rooms.size,0);
});
test('duplicate rooms, invalid codes, duplicate peers and room capacity are rejected', () => {
  const hub=createRoomHub();
  const host=participant(hub,'create','BCDEFG','roomwave-host-BCDEFG','Host');
  assert.equal(participant(hub,'create','BCDEFG','roomwave-host-BCDEFG','other').last('error').reason,'room-exists');
  assert.equal(participant(hub,'join','BCDEFG','roomwave-host-BCDEFG','host spoof').last('error').reason,'duplicate-peer');
  assert.equal(participant(hub,'join','B0D123','guest-1','bad').last('error').reason,'invalid-room');
  for(let i=1;i<ROOM_LIMIT;i++) participant(hub,'join','BCDEFG',`guest-${i}`,`User ${i}`);
  assert.equal(host.last('roster').members.length,ROOM_LIMIT);
  assert.equal(participant(hub,'join','BCDEFG','guest-9','last').last('error').reason,'room-full');
});
test('guest departure updates the host roster and leaves room open', () => {
  const hub=createRoomHub();
  const host=participant(hub,'create','BCDEFG','roomwave-host-BCDEFG','Host');
  const guest=participant(hub,'join','BCDEFG','guest-123','Guest');
  guest.push({type:'leave'});
  assert.deepEqual(host.last('roster').members.map(p=>p.id),['roomwave-host-BCDEFG']);
  assert.equal(hub.rooms.size,1);
});

test('collaborative YouTube queue broadcasts from guests and preserves playback for late joiners', () => {
  const hub=createRoomHub();
  const host=participant(hub,'create','BCDEFG','roomwave-host-BCDEFG','Host');
  const guest=participant(hub,'join','BCDEFG','guest-123','Guest');
  const videoId='M7lc1UVf-VE';
  guest.push({type:'youtube-add',videoId});
  assert.equal(host.last('youtube-state').youtube.videoId,videoId);
  assert.equal(host.last('youtube-state').youtube.playing,false);
  assert.equal(guest.last('youtube-state').queue.length,0);
  guest.push({type:'youtube-add',videoId:'dQw4w9WgXcQ'});
  assert.equal(host.last('youtube-state').queue.length,1);
  const late=participant(hub,'join','BCDEFG','guest-456','Late');
  assert.equal(late.last('joined').youtube.videoId,videoId);
  assert.equal(late.last('joined').youtubeQueue.length,1);
  const before=hub.youtubeQueue.snapshot('BCDEFG');
  guest.push({type:'youtube-next'});
  guest.push({type:'youtube-mode',mode:'shuffle'});
  guest.push({type:'youtube',youtube:{videoId:'dQw4w9WgXcQ',position:0,playing:false}});
  assert.equal(hub.youtubeQueue.snapshot('BCDEFG').youtube.videoId,before.youtube.videoId);
  assert.equal(hub.youtubeQueue.snapshot('BCDEFG').mode,'sequential');
  host.push({type:'youtube',youtube:{videoId,playing:false,position:25}});
  assert.equal(guest.last('youtube-state').youtube.playing,false);
  host.push({type:'youtube-next'});
  assert.equal(guest.last('youtube-state').youtube.videoId,'dQw4w9WgXcQ');
  assert.equal(guest.last('youtube-state').queue.length,0);
  host.push({type:'youtube',youtube:null});
  assert.equal(guest.last('youtube-state').youtube,null);
  assert.equal(hub.youtubeQueue.snapshot('BCDEFG').youtube,null);
});
test('rejects invalid YouTube state and queue IDs', () => {
  const hub=createRoomHub();
  const host=participant(hub,'create','BCDEFG','roomwave-host-BCDEFG','Host');
  host.push({type:'youtube',youtube:{videoId:'javascript:bad',playing:true,position:0}});
  host.push({type:'youtube',youtube:{videoId:'M7lc1UVf-VE',playing:true,position:Infinity}});
  host.push({type:'youtube',youtube:{videoId:'M7lc1UVf-VE',playing:true,position:-1}});
  host.push({type:'youtube-add',videoId:'https://www.youtube.com/watch?v=M7lc1UVf-VE'});
  assert.equal(hub.youtubeQueue.snapshot('BCDEFG').youtube,null);
  assert.equal(hub.youtubeQueue.snapshot('BCDEFG').queue.length,0);
});

test('temporary host and guest disconnects resume securely without losing the room',()=>{
  const hub=createRoomHub();
  const host=participant(hub,'create','BCDEFG','roomwave-host-BCDEFG','Host');
  const guest=participant(hub,'join','BCDEFG','guest-123','Guest');
  const hostToken=host.last('created').resumeToken;
  const guestToken=guest.last('joined').resumeToken;
  assert.match(hostToken,/^[a-f0-9]{48}$/);
  guest.push({type:'youtube-add',videoId:'M7lc1UVf-VE'});
  host.close();
  assert.equal(hub.rooms.size,1);
  assert.equal(guest.last('room-closed'),undefined);
  const attacker=participant(hub,'resume','BCDEFG','roomwave-host-BCDEFG','Imposter');
  assert.equal(attacker.last('error').reason,'invalid-resume');
  const hostBack=participantResume(hub,'BCDEFG','roomwave-host-BCDEFG',hostToken);
  assert.equal(hostBack.last('resumed').youtube.videoId,'M7lc1UVf-VE');
  assert.equal(hostBack.last('resumed').botToken,host.last('created').botToken);
  guest.close();
  const guestBack=participantResume(hub,'BCDEFG','guest-123',guestToken);
  assert.equal(guestBack.last('resumed').members.length,2);
  assert.equal(guestBack.last('resumed').botToken,undefined);
  hostBack.push({type:'leave'});
  assert.equal(guestBack.last('room-closed').type,'room-closed');
});
function participantResume(hub,code,id,resumeToken){
  const s=new Socket();hub.connected(s);s.push({type:'resume',code,peerId:id,resumeToken});
  return s;
}
