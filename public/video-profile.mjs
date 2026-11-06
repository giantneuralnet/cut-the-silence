export function videoProfile(codec,bitrate) {
  const normalized={h264:'avc',avc:'avc',h265:'hevc',hevc:'hevc',vp9:'vp9',av1:'av1'}[codec];
  if(!normalized)throw new Error(`Preserving the ${codec||'unknown'} codec in MP4 is not supported.`);
  const rate=Number(bitrate);
  return {codec:normalized,bitrate:Number.isFinite(rate)&&rate>0?Math.round(rate):null};
}
export function softwareVideoOptions(profile) {
  const encoder={avc:'libx264',hevc:'libx265',vp9:'libvpx-vp9',av1:'libaom-av1'}[profile.codec];
  const args=['-c:v',encoder];
  if(['avc','hevc'].includes(profile.codec))args.push('-preset','ultrafast');
  if(profile.bitrate)args.push('-b:v',String(profile.bitrate));
  else args.push('-crf',profile.codec==='avc'?'20':'23');
  if(profile.codec==='hevc')args.push('-tag:v','hvc1');
  return args;
}
