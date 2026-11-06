import { Input, BlobSource, ALL_FORMATS, AudioSampleSink, VideoSampleSink,
  Output, BufferTarget, Mp4OutputFormat, AudioSampleSource, VideoSampleSource,
  canEncodeAudio, canEncodeVideo, QUALITY_HIGH, Quality } from './vendor/mediabunny/mediabunny.mjs';

import { videoProfile } from './video-profile.mjs';

// Hardware acceleration is a preference; browsers decide which codec implementation to use.
export const nativeAvailable=()=>typeof VideoEncoder!=='undefined'&&typeof VideoDecoder!=='undefined';
export function sampleRange(timestamp,duration,start,end,offset=0) {
  const a=Math.max(timestamp,start),b=Math.min(timestamp+duration,end);
  return b>a?{start:a,end:b,timestamp:offset+a-start,duration:b-a}:null;
}
async function averageVideoBitrate(video) {
  return await video.getAverageBitrate()||(await video.computePacketStats()).averageBitrate||null;
}
async function open(file) {
  const input=new Input({source:new BlobSource(file),formats:ALL_FORMATS});
  try {
    const video=await input.getPrimaryVideoTrack(),audio=await input.getPrimaryAudioTrack();
    if(!video)throw new Error('No video track.');
    return {input,video,audio};
  }catch(error){input.dispose();throw error;}
}
export async function analyzeNative(file,job) {
  if(!nativeAvailable())throw new Error('Native codecs unavailable.');
  const {input,video,audio}=await open(file);
  try {
    if(audio&&!await audio.canDecode())throw new Error('Native audio decoder unavailable.');
    const duration=await input.computeDuration();
    if(!Number.isFinite(duration)||duration<=0)throw new Error('Invalid video duration.');
    const step=0.02,sums=new Float64Array(Math.ceil(duration/step)),counts=new Uint32Array(sums.length);
    if(audio)for await(const sample of new AudioSampleSink(audio).samples()) {
      try {
        const buffer=sample.toAudioBuffer(),channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
        for(let i=0;i<buffer.length;i++) {
          const bin=Math.floor((sample.timestamp+i/buffer.sampleRate)/step);
          if(bin<0||bin>=sums.length)continue;
          let value=0;for(const channel of channels)value+=channel[i];value/=channels.length;
          sums[bin]+=value*value;counts[bin]++;
        }
        job.progress=Math.min(90,10+80*(sample.timestamp+sample.duration)/duration);
      }finally{sample.close();}
    }
    return {duration,hasAudio:!!audio,width:await video.getDisplayWidth(),height:await video.getDisplayHeight(),step,
      sourceVideoCodec:await video.getCodec(),sourceVideoBitrate:await averageVideoBitrate(video),
      levels:audio?Array.from(sums,(sum,i)=>Math.round(20*Math.log10(Math.max(Math.sqrt(sum/(counts[i]||1)),0.00001))*100)/100):[],processing:'native'};
  }finally{input.dispose();}
}
export async function renderNative(file,segments,job) {
  if(!nativeAvailable())throw new Error('Native codecs unavailable.');
  const {input,video,audio}=await open(file);
  let output;
  try {
    job.phase='Checking native codecs…';
    const width=await video.getDisplayWidth(),height=await video.getDisplayHeight();
    const profile=videoProfile(await video.getCodec(),await averageVideoBitrate(video));
    const quality=profile.bitrate?new Quality({bitrate:profile.bitrate}):QUALITY_HIGH;
    if(!await video.canDecode()||!await canEncodeVideo(profile.codec,{width,height,quality,hardwareAcceleration:'prefer-hardware'}))throw new Error('Native video codec unavailable.');
    if(audio&&(!await audio.canDecode()||!await canEncodeAudio('aac',{sampleRate:48000,numberOfChannels:Math.min(2,await audio.getNumberOfChannels())})))throw new Error('Native audio codec unavailable.');
    const target=new BufferTarget();output=new Output({format:new Mp4OutputFormat({fastStart:'in-memory'}),target});
    const vSource=new VideoSampleSource({codec:profile.codec,quality,hardwareAcceleration:'prefer-hardware',keyFrameInterval:2});
    // The source applies each decoded sample's rotation before encoding.
    output.addVideoTrack(vSource);
    const aSource=audio?new AudioSampleSource({codec:'aac',bitrate:192000,transform:{sampleRate:48000,numberOfChannels:Math.min(2,await audio.getNumberOfChannels())}}):null;
    if(aSource)output.addAudioTrack(aSource);
    job.phase='Preparing native export…';await output.start();
    job.phase='Exporting video…';
    const vSink=new VideoSampleSink(video,{hardwareAcceleration:'prefer-hardware'}),aSink=audio?new AudioSampleSink(audio):null;
    let offset=0,failed=false;
    for(const segment of segments) {
      const videoTask=async()=>{
        for await(const sample of vSink.samples(segment.start,segment.end)) {
          try {
            if(failed)break;
            const range=sampleRange(sample.timestamp,sample.duration,segment.start,segment.end,offset);
            if(!range)continue;
            sample.setTimestamp(range.timestamp);sample.setDuration(range.duration);
            await vSource.add(sample);
            job.progress=Math.min(99,(range.timestamp+range.duration)/job.duration*100);
          }finally{sample.close();}
        }
      };
      const audioTask=async()=>{
        if(!aSink)return;
        for await(const sample of aSink.samples(segment.start,segment.end)) {
          let trimmed;
          try {
            if(failed)break;
            const range=sampleRange(sample.timestamp,sample.duration,segment.start,segment.end,offset);
            if(!range)continue;
            const first=Math.max(0,Math.round((range.start-sample.timestamp)*sample.sampleRate));
            const last=Math.min(sample.numberOfFrames,Math.round((range.end-sample.timestamp)*sample.sampleRate));
            if(last<=first)continue;
            trimmed=sample.trim(first,last);trimmed.setTimestamp(offset+sample.timestamp+first/sample.sampleRate-segment.start);
            await aSource.add(trimmed);
          }finally{trimmed?.close();sample.close();}
        }
      };
      const results=await Promise.allSettled([videoTask().catch(e=>{failed=true;throw e;}),audioTask().catch(e=>{failed=true;throw e;})]);
      const error=results.find(r=>r.status==='rejected');if(error)throw error.reason;
      offset+=segment.end-segment.start;
    }
    job.phase='Finishing export…';vSource.close();aSource?.close();await output.finalize();
    job.videoCodec=profile.codec;job.targetVideoBitrate=profile.bitrate;
    return new Blob([target.buffer],{type:'video/mp4'});
  }catch(error){if(output)try{await output.cancel();}catch{}throw error;}
  finally{input.dispose();}
}
