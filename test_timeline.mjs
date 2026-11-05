import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRegions, applyOverrides, setOverride, resolveEdgeEdits, editMasks, timelineGesture, removeShortClips } from './public/timeline.mjs';

const levels=Array.from({length:300},(_,i)=>i>=100&&i<125?-15:-60);
const detect=(minimumAudio=0,threshold=-35,silence=0.5)=>detectRegions(levels,0.01,3,threshold,silence,minimumAudio);
const cutAt=(regions,time)=>regions.find(r=>time>=r.start&&time<r.end)?.cut;

test('minimum audio duration removes an isolated audible blip',()=>{
  assert.equal(cutAt(applyOverrides(detect(0),[]),1.1),false);
  assert.equal(cutAt(applyOverrides(detect(0.5),[]),1.1),true);
});
test('tapping audio toggles an entire contiguous take without affecting another take',()=>{
  const regions=[{start:0,end:3,kind:'audio',autoCut:false},{start:3,end:4,kind:'silence',autoCut:true},{start:4,end:7,kind:'audio',autoCut:false}];
  let masks=setOverride([],0,3,true);
  assert.equal(cutAt(applyOverrides(regions,masks),2),true);
  assert.equal(cutAt(applyOverrides(regions,masks),5),false);
  masks=setOverride(masks,0,3,false);
  assert.equal(cutAt(applyOverrides(regions,masks),2),false);
});
test('manual audio cuts survive slider changes that merge all detected audio',()=>{
  const masks=setOverride([],1.04,1.21,true);
  for(const regions of [detect(0),detect(0,-65),detect(0,-35,3)]) {
    const result=applyOverrides(regions,masks);
    assert.equal(cutAt(result,1.1),true);
    assert.ok(result.some(r=>r.manual&&r.start===1.04&&r.end===1.21));
  }
});
test('individually kept silence survives every slider including minimum audible duration',()=>{
  const masks=setOverride([],0,0.96,false);
  for(const regions of [detect(),detect(3),detect(3,-10),detect(0,-65),detect(3,-35,3)]) {
    assert.equal(cutAt(applyOverrides(regions,masks),0.4),false);
  }
});
test('overlapping manual toggles retain independent choices outside the tapped region',()=>{
  let masks=setOverride([],0,3,true);
  masks=setOverride(masks,1,2,false);
  const regions=[{start:0,end:3,kind:'audio',autoCut:false}];
  const result=applyOverrides(regions,masks);
  assert.equal(cutAt(result,0.5),true);assert.equal(cutAt(result,1.5),false);assert.equal(cutAt(result,2.5),true);
});

test('short sounds inside a long clip are retained when neighboring pauses are not cuts',()=>{
  const samples=Array.from({length:500},(_,i)=>i<200||(i>=230&&i<270)||i>=300?-15:-60);
  for(const pause of [0.5,1,3])for(const pad of [0,0.04,0.5,1]) {
    const result=applyOverrides(detectRegions(samples,0.01,5,-35,pause,1,pad),[]);
    assert.equal(cutAt(result,2.5),false,`speech damaged: pause=${pause}, padding=${pad}`);
    assert.equal(cutAt(result,1),false);assert.equal(cutAt(result,4),false);
    assert.equal(result.length,1);
  }
});
test('an isolated 0.4 second um between silence cuts is removed as one whole clip',()=>{
  const samples=Array.from({length:640},(_,i)=>i<200||(i>=300&&i<340)||i>=440?-15:-60);
  const baseline=detectRegions(samples,0.01,6.4,-35,0.5,0,0.1);
  const filtered=detectRegions(samples,0.01,6.4,-35,0.5,1,0.1);
  assert.equal(cutAt(applyOverrides(baseline,[]),3.2),false);
  const clip=filtered.find(r=>r.kind==='audio'&&r.start<3.2&&r.end>3.2);
  assert.equal(clip.autoCut,true);assert.ok(Math.abs(clip.start-2.9)<1e-6);assert.ok(Math.abs(clip.end-3.5)<1e-6);
  assert.equal(cutAt(applyOverrides(filtered,[]),1),false);assert.equal(cutAt(applyOverrides(filtered,[]),5),false);
});
test('short leading and trailing clips obey the same clip-duration rule',()=>{
  const samples=Array.from({length:400},(_,i)=>i<30||(i>=130&&i<270)||i>=370?-15:-60);
  const regions=applyOverrides(detectRegions(samples,0.01,4,-35,0.5,1,0),[]);
  assert.equal(cutAt(regions,0.2),true);assert.equal(cutAt(regions,2),false);assert.equal(cutAt(regions,3.8),true);
});
test('clip duration uses the actual padded interval remaining between cuts',()=>{
  const samples=Array.from({length:240},(_,i)=>i>=100&&i<140?-15:-60);
  assert.equal(cutAt(applyOverrides(detectRegions(samples,0.01,2.4,-35,0.5,1,0.1),[]),1.2),true);
  assert.equal(cutAt(applyOverrides(detectRegions(samples,0.01,2.4,-35,0.5,1,0.35),[]),1.2),false);
});
test('manual cuts can create short remaining clips, but explicit keep choices still win',()=>{
  const base=[{start:0,end:5,kind:'audio',autoCut:false}];
  const cuts=[{start:0.4,end:2,cut:true}];
  const result=removeShortClips(applyOverrides(base,cuts),1);
  assert.equal(cutAt(result,0.2),true);assert.equal(cutAt(result,3),false);
  const kept=removeShortClips(applyOverrides(base,[{start:0,end:0.4,cut:false},...cuts]),1);
  assert.equal(cutAt(kept,0.2),false);
});
test('the clip filter never treats an internal short pause as a cut boundary',()=>{
  const regions=[{start:0,end:2,kind:'audio',cut:false},{start:2,end:2.3,kind:'silence',cut:false},{start:2.3,end:2.7,kind:'audio',cut:false},{start:2.7,end:5,kind:'audio',cut:false}];
  assert.ok(removeShortClips(regions,1).every(region=>!region.cut));
});
test('keeping a neighboring pause recomputes the clip boundary before minimum-duration filtering',()=>{
  const samples=Array.from({length:640},(_,i)=>i<200||(i>=300&&i<340)||i>=440?-15:-60);
  const silenceCuts=detectRegions(samples,0.01,6.4,-35,0.5,0,0);
  const isolated=removeShortClips(applyOverrides(silenceCuts,[]),1);
  assert.equal(cutAt(isolated,3.2),true);
  const joined=removeShortClips(applyOverrides(silenceCuts,[{start:2,end:3,cut:false}]),1);
  assert.equal(cutAt(joined,3.2),false);
});
test('padding changes both boundaries of retained clips',()=>{
  const samples=Array.from({length:300},(_,i)=>i>=100&&i<200?-15:-60);
  const a=detectRegions(samples,0.01,3,-35,0.5,0,0);
  const b=detectRegions(samples,0.01,3,-35,0.5,0,0.2);
  assert.equal(a.find(r=>r.kind==='audio').start,1);
  assert.equal(b.find(r=>r.kind==='audio').start,0.8);
  assert.equal(b.find(r=>r.kind==='audio').end,2.2);
});
test('manual edge offsets follow new detected boundaries and survive padding changes',()=>{
  const edits=[{id:'cut',anchor:{start:2,end:4,kind:'silence'},startOffset:0.15,endOffset:-0.1}];
  const regions=[{start:2.2,end:3.8,kind:'silence',autoCut:true}];
  const [adjusted]=resolveEdgeEdits(regions,edits,10);
  assert.ok(Math.abs(adjusted.start-2.35)<1e-9);assert.ok(Math.abs(adjusted.end-3.7)<1e-9);
  const effective=applyOverrides(regions,editMasks(regions,[],edits,10));
  assert.equal(cutAt(effective,2.25),false);assert.equal(cutAt(effective,2.5),true);assert.equal(cutAt(effective,3.75),false);
});
test('pinch zoom preserves its time anchor and horizontal pan clamps to source bounds',()=>{
  const zoomed=timelineGesture(10,30,60,-50,true,0.25,1);
  assert.ok(Math.abs((zoomed.start+(zoomed.end-zoomed.start)*0.25)-15)<1e-9);
  assert.ok(zoomed.end-zoomed.start<20);
  assert.deepEqual(timelineGesture(10,30,60,100,false),{start:40,end:60});
  assert.deepEqual(timelineGesture(10,30,60,-100,false),{start:0,end:20});
});

test('relative edge edits do not erase an individually kept section inside an automatic cut',()=>{
  const regions=[{start:2,end:6,kind:'silence',autoCut:true}];
  const overrides=[{start:4,end:4.5,cut:false}];
  const edges=[{id:'left',anchor:{start:2,end:4,kind:'cut'},startOffset:0,endOffset:-0.1}];
  const effective=applyOverrides(regions,editMasks(regions,overrides,edges,10));
  assert.equal(cutAt(effective,3),true);assert.equal(cutAt(effective,3.95),false);
  assert.equal(cutAt(effective,4.25),false);assert.equal(cutAt(effective,5),true);
});
