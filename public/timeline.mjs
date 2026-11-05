// Silence cuts define whole retained clips. The minimum clip duration applies
// only to those complete islands, never to individual syllables inside them.
export function detectRegions(levels, step, duration, threshold, minimumSilence, minimumAudio, padding=0.04) {
  if(!duration)return [];
  if(!levels.length)return [{start:0,end:duration,kind:'audio',autoCut:false}];
  const silences=[];let start=null;
  const close=end=>{
    if(start!==null&&end-start+1e-6>=minimumSilence) {
      const a=start===0?0:start+padding;
      const b=end>=duration-0.000001?duration:end-padding;
      if(b-a>1e-6)silences.push({start:a,end:b,kind:'silence',autoCut:true});
    }
    start=null;
  };
  for(let i=0;i<levels.length;i++) {
    if(levels[i]<threshold){if(start===null)start=i*step;}
    else close(Math.min(duration,i*step));
  }
  close(duration);
  const regions=[];let cursor=0;
  const addClip=end=>{
    if(end-cursor>1e-6)regions.push({start:cursor,end,kind:'audio',autoCut:end-cursor+1e-6<minimumAudio});
  };
  for(const silence of silences){addClip(silence.start);regions.push(silence);cursor=silence.end;}
  addClip(duration);
  return regions;
}

// Manual choices are masks in source time, independent of automatic detection.
// Slider changes can split or merge detected regions without losing these masks.
export function applyOverrides(regions, overrides) {
  const result=[];
  for(const region of regions) {
    const boundaries=new Set([region.start,region.end]);
    for(const mask of overrides) {
      if(mask.start>region.start&&mask.start<region.end)boundaries.add(mask.start);
      if(mask.end>region.start&&mask.end<region.end)boundaries.add(mask.end);
    }
    const points=[...boundaries].sort((a,b)=>a-b);
    for(let i=0;i<points.length-1;i++) {
      const start=points[i],end=points[i+1],mid=(start+end)/2;
      if(end-start<1e-6)continue;
      const mask=overrides.find(mask=>mid>=mask.start&&mid<mask.end);
      const cut=mask?mask.cut:region.autoCut;
      const last=result.at(-1);
      if(last&&last.kind===region.kind&&last.cut===cut&&last.manual===!!mask&&Math.abs(last.end-start)<1e-6)last.end=end;
      else result.push({...region,start,end,cut,manual:!!mask});
    }
  }
  return result;
}

export function removeShortClips(regions, minimum) {
  const result=regions.map(region=>({...region}));
  for(let i=0;i<result.length;) {
    if(result[i].cut){i++;continue;}
    const first=i;
    while(i<result.length&&!result[i].cut)i++;
    const clip=result.slice(first,i);
    if(clip.at(-1).end-clip[0].start+1e-6<minimum&&!clip.some(region=>region.manual)) {
      for(let j=first;j<i;j++)result[j].cut=true;
    }
  }
  return result;
}

export function setOverride(overrides, start, end, cut) {
  if(end-start<1e-6)return overrides.map(mask=>({...mask}));
  const masks=[];
  for(const mask of overrides) {
    if(mask.end<=start||mask.start>=end)masks.push({...mask});
    else {
      if(mask.start<start)masks.push({...mask,end:start});
      if(mask.end>end)masks.push({...mask,start:end});
    }
  }
  masks.push({start,end,cut});masks.sort((a,b)=>a.start-b.start);
  const merged=[];
  for(const mask of masks) {
    const last=merged.at(-1);
    if(last&&last.cut===mask.cut&&mask.start<=last.end+1e-6)last.end=Math.max(last.end,mask.end);
    else merged.push(mask);
  }
  return merged;
}


export function mergedAutomaticCuts(regions) {
  const merged=[];
  for(const region of regions)if(region.cut??region.autoCut) {
    const last=merged.at(-1);
    if(last&&region.start<=last.end+1e-6)last.end=Math.max(last.end,region.end);
    else merged.push({start:region.start,end:region.end,kind:'cut'});
  }
  return merged;
}
export function resolveEdgeEdits(regions, edits, duration) {
  return edits.map(edit=>{
    const anchor=edit.anchor,mid=(anchor.start+anchor.end)/2;
    const candidates=(anchor.kind==='cut'?mergedAutomaticCuts(regions):regions).filter(r=>r.kind===anchor.kind&&r.end>anchor.start&&r.start<anchor.end);
    const base=candidates.find(r=>mid>=r.start&&mid<r.end)||candidates.sort((a,b)=>Math.min(b.end,anchor.end)-Math.max(b.start,anchor.start)-(Math.min(a.end,anchor.end)-Math.max(a.start,anchor.start)))[0]||anchor;
    const start=Math.max(0,Math.min(duration-0.02,base.start+(edit.startOffset||0)));
    const end=Math.max(start+0.02,Math.min(duration,base.end+(edit.endOffset||0)));
    return {...edit,base,start,end};
  });
}
export function editMasks(regions, overrides, edits, duration, minimum=0) {
  let masks=overrides.map(mask=>({...mask}));
  for(const edit of resolveEdgeEdits(removeShortClips(applyOverrides(regions,overrides),minimum),edits,duration)) {
    masks=setOverride(masks,edit.base.start,edit.base.end,false);
    masks=setOverride(masks,edit.start,edit.end,true);
  }
  return masks;
}
export function timelineGesture(start,end,duration,delta,zoom,anchor=0.5,minimum=0.1) {
  const width=end-start;
  if(zoom) {
    const nextWidth=Math.max(Math.min(minimum,duration),Math.min(duration,width*Math.exp(Math.max(-1,Math.min(1,delta*0.01)))));
    const pivot=start+width*anchor;
    const nextStart=Math.max(0,Math.min(duration-nextWidth,pivot-nextWidth*anchor));
    return {start:nextStart,end:nextStart+nextWidth};
  }
  const nextStart=Math.max(0,Math.min(duration-width,start+delta));
  return {start:nextStart,end:nextStart+width};
}
