import { detectRegions } from './timeline.mjs';

export const MOTION_WIDTH=64, MOTION_HEIGHT=36, MOTION_STEP=0.1;
// Mean RGB change in the most active 8x9 tile, as a percentage of full scale.
// Small moving subjects should not disappear into a large static background.
export function frameChange(previous,current,channels=3) {
  if(!previous||!current)return 100;
  let maximum=0;
  for(let y=0;y<MOTION_HEIGHT;y+=9)for(let x=0;x<MOTION_WIDTH;x+=8) {
    let sum=0;
    for(let dy=0;dy<9;dy++)for(let dx=0;dx<8;dx++) {
      const offset=((y+dy)*MOTION_WIDTH+x+dx)*channels;
      for(let c=0;c<3;c++)sum+=Math.abs(previous[offset+c]-current[offset+c]);
    }
    maximum=Math.max(maximum,sum/(8*9*3*255)*100);
  }
  return Math.round(maximum*1000)/1000;
}
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
