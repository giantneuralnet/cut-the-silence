import test from 'node:test';
import assert from 'node:assert/strict';
import {MotionAnalyzer,prepareFrame,differenceCPU,WIDTH,HEIGHT,DEFAULT_THRESHOLD,VERSION} from './public/motion.mjs';
function fixture(shift=0,brightness=0){
  const out=new Uint8Array(WIDTH*HEIGHT*3);
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++){
    let v=65+10*Math.sin(x*.12)*Math.sin(y*.1);
    for(const edge of [320+shift,336+shift])if(y>=160&&y<192)v+=Math.max(0,Math.min(x+1,edge+5)-Math.max(x,edge))*(100+20*Math.cos(y*.3));
    const p=(y*WIDTH+x)*3;out.fill(Math.round(v+brightness),p,p+3);
  }
  return out;
}
const maximum=values=>values.reduce((a,b)=>Math.max(a,b),0);
const score=(a,b)=>maximum(differenceCPU(prepareFrame(a),prepareFrame(b)));
test('identical frames, low-level noise, and uniform brightness shifts remain still',()=>{
  const a=fixture(),noisy=a.map((v,i)=>v+(i%5)-2);
  assert.equal(score(a,a),0);assert.equal(score(a,noisy),0);assert.equal(score(a,fixture(0,30)),0);
});
test('small localized changes are retained even with an unchanged background',()=>{
  assert.ok(score(fixture(),fixture(2))>DEFAULT_THRESHOLD);
});
test('RGB differences detect color changes, not just luminance',()=>{
  const a=new Uint8Array(WIDTH*HEIGHT*3),b=a.slice();
  for(let y=100;y<116;y++)for(let x=200;x<216;x++){const p=(y*WIDTH+x)*3;a[p]=200;b[p+1]=102;}
  assert.ok(score(a,b)>10);
});
test('solid color scene changes are not normalized away as exposure',()=>{
  const a=new Uint8Array(WIDTH*HEIGHT*3),b=a.slice();
  for(let i=0;i<a.length;i+=3){a[i]=200;b[i+1]=200;}
  assert.ok(score(a,b)>50);
});
test('multiple baselines expose gradual changes that adjacent frames barely register',()=>{
  const d=new MotionAnalyzer();for(let i=0;i<6;i++)d.add(fixture(i*.2));
  const result=d.finish(1.2);
  assert.equal(result.stillnessVersion,VERSION);assert.equal(result.stillnessScores.length,6);
  assert.ok(result.stillnessScores[4]>score(fixture(.8),fixture(1))*2);
});
test('a change does not mark earlier still intervals as moving or persist indefinitely',()=>{
  const d=new MotionAnalyzer(),a=fixture(),b=fixture(3);
  for(let i=0;i<8;i++)d.add(a);for(let i=0;i<8;i++)d.add(b);
  const s=d.finish(3.2).stillnessScores;
  assert.ok(s.slice(0,7).every(v=>v===0));assert.ok(s[7]>DEFAULT_THRESHOLD);
  assert.ok(s.slice(12).every(v=>v===0));
});
test('missing frames and undecoded tails stay conservatively kept',()=>{
  const d=new MotionAnalyzer();d.add(fixture());d.add(null);
  assert.deepEqual(d.finish(.8).stillnessScores,[100,100,100,100]);
});
test('localized differences at image boundaries are covered by tiles',()=>{
  const a=new Uint8Array(WIDTH*HEIGHT*3),b=a.slice();
  for(let y=HEIGHT-8;y<HEIGHT;y++)for(let x=WIDTH-8;x<WIDTH;x++)b.fill(180,(y*WIDTH+x)*3,(y*WIDTH+x)*3+3);
  assert.ok(score(a,b)>DEFAULT_THRESHOLD);
});
