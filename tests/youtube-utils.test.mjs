import test from 'node:test';
import assert from 'node:assert/strict';
import {parseYouTubeId,normalizeYouTubeState} from '../youtube-utils.mjs';
const id='M7lc1UVf-VE';
test('parses normal, mobile, Music, short and live YouTube video URLs',()=>{
  for(const url of [
    id,`https://www.youtube.com/watch?v=${id}&t=60`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
  ]) assert.equal(parseYouTubeId(url),id,url);
});
test('rejects untrusted hosts, arbitrary URLs and playlist-only links',()=>{
  for(const value of [
    'https://youtube.com.evil.example/watch?v='+id,
    'https://example.com/watch?v='+id,
    'javascript:alert(1)',
    'https://www.youtube.com/playlist?list=PLabcdefgh',
    'https://youtu.be/invalid',
    'https://evil.example/?url=https://youtu.be/'+id,
    'ftp://youtu.be/'+id
  ]) assert.equal(parseYouTubeId(value),null,value);
});
test('rejects bad room video ids and bounds playback position',()=>{
  assert.equal(normalizeYouTubeState(null),null);
  assert.equal(normalizeYouTubeState({videoId:'<script>',position:0,playing:true}),null);
  assert.deepEqual(normalizeYouTubeState({videoId:id,position:90000,playing:1}),{videoId:id,position:86400,playing:false});
  assert.deepEqual(normalizeYouTubeState({videoId:id,position:13.5,playing:true}),{videoId:id,position:13.5,playing:true});
});
