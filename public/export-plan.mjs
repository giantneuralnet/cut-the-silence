export function planExport(cuts,duration,mode='edited') {
  if(!['edited','removed'].includes(mode))throw new Error('Invalid export mode.');
  const merged=[];
  for(const cut of [...cuts].sort((a,b)=>a.start-b.start)) {
    if(!Number.isFinite(cut.start)||!Number.isFinite(cut.end))throw new Error('Invalid cut timestamps.');
    const start=Math.max(0,cut.start),end=Math.min(duration,cut.end);
    if(end<=start)continue;
    const last=merged.at(-1);
    if(last&&start<=last.end+1e-6)last.end=Math.max(last.end,end);
    else merged.push({start,end});
  }
  if(mode==='removed')return merged.filter(c=>c.end-c.start>0.001);
  const kept=[];let cursor=0;
  for(const cut of merged){if(cut.start-cursor>0.001)kept.push({start:cursor,end:cut.start});cursor=cut.end;}
  if(duration-cursor>0.001)kept.push({start:cursor,end:duration});
  return kept;
}
export function exportGraph(segments,audio) {
  const count=segments.length;
  if(!count)throw new Error('There is no footage to export.');
  const filters=[`[0:v:0]split=${count}`+segments.map((_,i)=>`[vin${i}]`).join('')];
  if(audio)filters.push(`[0:a:0]asplit=${count}`+segments.map((_,i)=>`[ain${i}]`).join(''));
  const inputs=[];
  segments.forEach(({start,end},i)=>{
    filters.push(`[vin${i}]trim=start=${start.toFixed(6)}:end=${end.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`);inputs.push(`[v${i}]`);
    if(audio){filters.push(`[ain${i}]atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`);inputs.push(`[a${i}]`);}
  });
  filters.push(inputs.join('')+`concat=n=${count}:v=1:a=${audio?1:0}[vout]`+(audio?'[aout]':''));
  filters.push('[vout]scale=trunc(iw/2)*2:trunc(ih/2)*2[vfinal]');
  return filters.join(';\n');
}
