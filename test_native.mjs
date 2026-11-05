import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleRange,nativeAvailable } from './public/native-backend.mjs';
test('native export clips frames at both edges and retimes separated clips without gaps',()=>{
  assert.deepEqual(sampleRange(0.9,.2,1,2,3),{start:1,end:1.1,timestamp:3,duration:1.1-1});
  assert.deepEqual(sampleRange(1.9,.2,1,2,3),{start:1.9,end:2,timestamp:3+1.9-1,duration:2-1.9});
  assert.equal(sampleRange(.5,.5,1,2),null);
  assert.equal(sampleRange(2,.5,1,2),null);
});
test('native pipeline feature detection allows compatibility fallback without WebCodecs',()=>assert.equal(nativeAvailable(),false));
