import { detectRegions } from './timeline.mjs';

export function stillnessRegions(scores,step,duration,threshold,minimum,padding) {
  return detectRegions(scores,step,duration,threshold,minimum,0,padding)
    .map(region=>({...region,kind:region.autoCut?'stillness':'motion'}));
}
// Combine detectors before applying manual masks; an explicit keep wins over both.
export function combineDetections(audio,visual,duration) {
  if(!visual)return audio;
  const points=[...new Set([0,duration,...audio.flatMap(r=>[r.start,r.end]),...visual.flatMap(r=>[r.start,r.end])])].sort((a,b)=>a-b);
  const result=[];let ai=0,vi=0;
  for(let i=0;i<points.length-1;i++) {
    const start=points[i],end=points[i+1],mid=(start+end)/2;
    if(end-start<1e-6)continue;
    while(ai<audio.length&&audio[ai].end<=mid)ai++;
    while(vi<visual.length&&visual[vi].end<=mid)vi++;
    const a=audio[ai],v=visual[vi],autoCut=!!(a?.autoCut||v?.autoCut);
    const kind=v?.autoCut?'stillness':a?.kind||'motion',last=result.at(-1);
    if(last&&last.kind===kind&&last.autoCut===autoCut)last.end=end;
    else result.push({start,end,kind,autoCut});
  }
  return result;
}
