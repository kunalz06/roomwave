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
  host.close();
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
  guest.close();
  assert.deepEqual(host.last('roster').members.map(p=>p.id),['roomwave-host-BCDEFG']);
  assert.equal(hub.rooms.size,1);
});
