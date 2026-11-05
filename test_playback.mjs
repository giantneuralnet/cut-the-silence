import test from 'node:test';
import assert from 'node:assert/strict';
import { CutPlayback, nextPlayableTime, invertCuts } from './public/playback.mjs';

class Media extends EventTarget {
  constructor(duration=10) {super();this.duration=duration;this.position=0;this.paused=true;this.seeking=false;this.ended=false;this.playbackRate=1;}
  get currentTime() {return this.position;}
  set currentTime(value) {
    this.position=value;this.seeking=true;
    queueMicrotask(()=>{this.seeking=false;this.dispatchEvent(new Event('seeked'));});
  }
  async play() {this.paused=false;this.dispatchEvent(new Event('play'));}
  pause() {this.paused=true;this.dispatchEvent(new Event('pause'));}
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cuts=[{start:0,end:1},{start:3,end:5},{start:8,end:10}];

test('removed playback plays cut intervals in source order and skips all kept footage',async()=>{
  const media=new Media(),player=new CutPlayback(media,()=>invertCuts(cuts,10),()=>10);
  await player.play(true);await wait(0);assert.equal(media.currentTime,0);
  media.position=1.1;media.dispatchEvent(new Event('timeupdate'));await wait(0);assert.equal(media.currentTime,3);
  media.position=5.1;media.dispatchEvent(new Event('timeupdate'));await wait(0);assert.equal(media.currentTime,8);
  player.pause();
});
test('removed preview handles overlapping, absent and full-video cuts',()=>{
  assert.deepEqual(invertCuts([{start:3,end:6},{start:1,end:4}],10),[{start:0,end:1},{start:6,end:10}]);
  assert.deepEqual(invertCuts([],10),[{start:0,end:10}]);
  assert.deepEqual(invertCuts([{start:0,end:10}],10),[]);
});

test('preview starts after leading silence',async()=>{
  const media=new Media(),player=new CutPlayback(media,()=>cuts,()=>10);
  await player.play(true);await wait(0);
  assert.equal(media.currentTime,1);assert.equal(media.paused,false);player.pause();
});
test('clock skips interior cuts even without animation or timeupdate events',async()=>{
  const media=new Media(),player=new CutPlayback(media,()=>cuts,()=>10);
  await player.play(true);await wait(0);media.position=3.1;
  await wait(70);assert.equal(media.currentTime,5);player.pause();
});
test('resuming and seeking from inside a cut cannot play that silence',async()=>{
  const media=new Media(),player=new CutPlayback(media,()=>cuts,()=>10);
  media.currentTime=4;await player.play();await wait(0);assert.equal(media.currentTime,5);
  player.pause();media.currentTime=3.4;await player.play();await wait(0);assert.equal(media.currentTime,5);
  media.currentTime=3.8;await wait(0);assert.equal(media.currentTime,5);player.pause();
});
test('tail silence ends playback instead of playing to the original end',async()=>{
  const media=new Media(),player=new CutPlayback(media,()=>cuts,()=>10);
  await player.play(true);await wait(0);media.position=8.1;media.dispatchEvent(new Event('timeupdate'));
  assert.equal(media.paused,true);assert.equal(media.currentTime,10);player.pause();
});
test('uninterrupted footage and chained cuts retain correct positions',()=>{
  assert.equal(nextPlayableTime(2,cuts,10),2);
  assert.equal(nextPlayableTime(2,[{start:1,end:3},{start:3,end:4}],10),4);
});
