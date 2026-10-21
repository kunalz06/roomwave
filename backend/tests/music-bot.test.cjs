'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createBotManager,MAX_FILE_BYTES}=require('../music-bot.cjs');

const sample=(size=1024)=>Buffer.alloc(size,0x7a);
const audio=(title='A', duration=5)=>({data:sample(),title,mime:'audio/mpeg',duration});
test('host uploads an independent room-wide track and guests receive state',()=>{
  let time=1_000, broadcasts=[];
  const b=createBotManager({now:()=>time,onUpdate:(code,state)=>broadcasts.push({code,state})});
  const token=b.create('BCDEFG');
  assert.equal(token.length,48);
  assert.equal(b.upload('BCDEFG','wrong',audio()).error,'unauthorized');
  const one=b.upload('BCDEFG',token,audio('First',30));
  assert.ok(one.track.id);
  assert.equal(b.state('BCDEFG').current.title,'First');
  assert.equal(b.getTrack(one.track.id).data.length,1024);
  assert.ok(broadcasts.some(x=>x.code==='BCDEFG'&&x.state.current.title==='First'));
  assert.equal(b.control('BCDEFG','play'),true);
  time+=7000;
  assert.equal(b.state('BCDEFG').position,7);
  assert.equal(b.control('BCDEFG','pause'),true);
  time+=2000;
  assert.equal(b.state('BCDEFG').position,7);
  assert.equal(b.control('BCDEFG','seek',11),true);
  assert.equal(b.state('BCDEFG').position,11);
  assert.equal(b.control('BCDEFG','seek',-4),false);
  assert.equal(b.control('BCDEFG','play'),true);
  time+=5000;
  assert.equal(b.state('BCDEFG').position,16);
  b.drop('BCDEFG');
  assert.equal(b.getTrack(one.track.id),null);
  assert.equal(b.stats().bytes,0);
});

test('bot advances automatically and disposes old tracks',()=>{
  let time=1000;
  const b=createBotManager({now:()=>time});
  const token=b.create('BCDEFG');
  const first=b.upload('BCDEFG',token,audio('One',3)).track;
  const second=b.upload('BCDEFG',token,audio('Two',7)).track;
  b.control('BCDEFG','play');
  time+=4000;b.tick();
  assert.equal(b.state('BCDEFG').current.id,second.id);
  assert.equal(b.state('BCDEFG').playing,true);
  assert.equal(b.getTrack(first.id),null);
  time+=9000;b.tick();
  assert.equal(b.state('BCDEFG').current,null);
  assert.equal(b.state('BCDEFG').playing,false);
  assert.equal(b.stats().bytes,0);
});

test('no SSRF, oversized audio or unauthorized control/upload, queue caps',()=>{
  const b=createBotManager();const token=b.create('BCDEFG');
  assert.equal(b.upload('BCDEFG',token,{...audio(),mime:'text/html'}).error,'invalid-track');
  assert.equal(b.upload('BCDEFG',token,{...audio(),data:sample(MAX_FILE_BYTES+1)}).error,'size-limit');
  assert.equal(b.upload('BCDEFG',token,{...audio(),duration:Infinity}).error,'invalid-track');
  for(let i=0;i<5;i++) assert.ok(b.upload('BCDEFG',token,audio('Track '+i)).track);
  assert.equal(b.upload('BCDEFG',token,audio('Overflow')).error,'queue-full');
  assert.equal(b.control('BCDEFG','seek',NaN),false);
  assert.equal(b.control('BCDEFG','fake'),false);
});
