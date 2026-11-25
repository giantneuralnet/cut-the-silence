import test from 'node:test';
import assert from 'node:assert/strict';
import {MotionAnalyzer,grayscale,trackCPU,flowScore,WIDTH,HEIGHT} from './public/motion.mjs';
export function fixture(shift=0,brightness=0,gain=1) {
  const data=new Uint8Array(WIDTH*HEIGHT*3);
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++) {
    let value=75+10*Math.sin(x*.15)*Math.sin(y*.2);
    // A tiny pair of gripper fingers, under 0.5% of the frame, moves slowly.
    for(const edge of [140+shift,148+shift]) {
      const coverage=Math.max(0,Math.min(x+1,edge+3)-Math.max(x,edge));
      if(y>=80&&y<96)value+=coverage*(70+20*Math.cos(y*.6));
    }
    data.fill(Math.max(0,Math.min(255,Math.round(value*gain+brightness))),(y*WIDTH+x)*3,(y*WIDTH+x)*3+3);
  }
  return data;
}
export function blur(data) {
  const out=data.slice();
  for(let y=2;y<HEIGHT-2;y++)for(let x=2;x<WIDTH-2;x++) {
    let sum=0;for(let j=-2;j<=2;j++)for(let i=-2;i<=2;i++)sum+=data[((y+j)*WIDTH+x+i)*3];
    const at=(y*WIDTH+x)*3;out.fill(Math.round(sum/25),at,at+3);
  }
  return out;
}
const score=(a,b)=>flowScore(trackCPU(grayscale(a),grayscale(b)),1);
test('normalized tracking ignores additive exposure and contrast changes',()=>{
  const original=fixture();
  assert.equal(score(original,original),0);
  assert.ok(score(original,fixture(0,35,1.25))<.5);
});
test('stationary blur changes do not count as coherent translation',()=>{
  assert.ok(score(fixture(),blur(fixture()))<.5);
});
test('small moving gripper survives a still background and changing exposure',()=>{
  assert.ok(score(fixture(),fixture(2,25,1.1))>=1);
});
test('one-second baseline detects slow subpixel movement and keeps its interval',()=>{
  const detector=new MotionAnalyzer();
  for(let i=0;i<11;i++)detector.add(fixture(i*.2));
  const result=detector.finish(2.2);
  assert.equal(result.stillnessVersion,2);assert.equal(result.stillnessScores.length,11);
  assert.ok(result.stillnessScores.slice(0,10).every(s=>s>=.5),JSON.stringify(result.stillnessScores));
});
test('missing frames and undecoded tails are kept conservatively',()=>{
  const detector=new MotionAnalyzer();detector.add(fixture());detector.add(null);
  assert.deepEqual(detector.finish(.8).stillnessScores,[100,100,100,100]);
});
