import test from 'node:test';
import assert from 'node:assert/strict';
import {frameChange,stillnessRegions,combineDetections,MOTION_WIDTH,MOTION_HEIGHT} from './public/stillness.mjs';
import {detectRegions,applyOverrides,setOverride,editMasks} from './public/timeline.mjs';
const at=(regions,t)=>regions.find(r=>r.start<=t&&t<r.end);
const motion=[...Array(20).fill(0),...Array(20).fill(8),...Array(20).fill(0)];
const visual=(threshold=.8,minimum=1,padding=.2)=>stillnessRegions(motion,.1,6,threshold,minimum,padding);
test('stillness removes loud stationary footage and retains silent motion when silence is disabled',()=>{
  const regions=combineDetections([{start:0,end:6,kind:'motion',autoCut:false}],visual(),6);
  assert.equal(at(regions,1).autoCut,true);
  assert.equal(at(regions,3).autoCut,false);
  assert.equal(at(regions,5).autoCut,true);
  assert.deepEqual(regions.map(r=>[r.start,r.end,r.autoCut]),[[0,1.8,true],[1.8,4.2,false],[4.2,6,true]]);
  const silence=detectRegions([...Array(20).fill(-15),...Array(20).fill(-100),...Array(20).fill(-15)],.1,6,-35,.5,0,0);
  assert.equal(at(combineDetections(silence,visual(),6),3).autoCut,true);
});
test('stillness duration, threshold and padding filter runs independently',()=>{
  assert.ok(visual(.8,2.1).every(r=>!r.autoCut));
  assert.deepEqual(visual(9,1,0).map(r=>[r.start,r.end,r.autoCut]),[[0,6,true]]);
  assert.deepEqual(visual(.8,1,.5).filter(r=>r.autoCut).map(r=>[r.start,r.end]),[[0,1.5],[4.5,6]]);
  const interior=stillnessRegions([8,0,0,8],1,4,1,1,1.1);
  assert.ok(interior.every(r=>!r.autoCut));
});
test('manual keeps and dragged offsets survive visual slider changes and toggle combinations',()=>{
  const overrides=setOverride([],0.4,1.2,false);
  const edits=[{id:1,anchor:{start:4.2,end:6,kind:'cut'},startOffset:.15,endOffset:0}];
  for(const padding of [.2,.4]) {
    const regions=visual(.8,1,padding);
    const edited=applyOverrides(regions,editMasks(regions,overrides,edits,6));
    assert.equal(at(edited,.8).cut,false);
    assert.equal(at(edited,4+padding+.1).cut,false);
    assert.equal(at(edited,4+padding+.2).cut,true);
  }
  const disabled=applyOverrides([{start:0,end:6,kind:'motion',autoCut:false}],overrides);
  assert.equal(at(disabled,.8).cut,false);
});
test('frame scoring recognizes frozen frames and small localized movement without sound data',()=>{
  const black=new Uint8Array(MOTION_WIDTH*MOTION_HEIGHT*3),moved=black.slice();
  assert.equal(frameChange(black,black),0);
  for(let y=0;y<9;y++)for(let x=0;x<8;x++)moved.fill(255,(y*MOTION_WIDTH+x)*3,(y*MOTION_WIDTH+x)*3+3);
  assert.equal(frameChange(black,moved),100);
  assert.equal(frameChange(null,moved),100);
  const rgba=new Uint8Array(MOTION_WIDTH*MOTION_HEIGHT*4),rgba2=rgba.slice();
  for(let y=0;y<9;y++)for(let x=0;x<8;x++)rgba2.fill(255,(y*MOTION_WIDTH+x)*4,(y*MOTION_WIDTH+x)*4+3);
  assert.equal(frameChange(rgba,rgba2,4),100);
});
