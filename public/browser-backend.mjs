import { videoProfile, softwareVideoOptions } from './video-profile.mjs';
import { FFmpeg } from './vendor/ffmpeg/index.js';
import { planExport, exportGraph } from './export-plan.mjs';
import { analyzeNative, renderNative } from './native-backend.mjs?v=20261106-2';

const jobs=new Map();
const MAX_SIZE=512*1024*1024;
let enginePromise=null,source=null,mountedId=null,activeProgress=null,dbPromise=null;
const outputUrls=[];
const core='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

function database() {
  if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open('cut-the-silence-media',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('media');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  return dbPromise;
}
async function cacheSource(job,previewBlob=null) {
  const file=source.file;
  try {
    const db=await database(),data={...job};delete data.previewURL;
    await new Promise((resolve,reject)=>{
      const transaction=db.transaction('media','readwrite');
      transaction.objectStore('media').put({id:job.id,file,job:data,previewBlob},'last');
      transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);
    });
  }catch{/* Browser storage may be full or disabled. Processing still works. */}
}
async function restoreSource(id) {
  try {
    const db=await database();
    const saved=await new Promise((resolve,reject)=>{const request=db.transaction('media').objectStore('media').get('last');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    if(saved?.id!==id)return null;
    source={id,file:saved.file,input:null};
    const job={...saved.job,previewURL:URL.createObjectURL(saved.previewBlob||saved.file)};
    jobs.set(id,job);return job;
  }catch{return null;}
}
async function blobURL(url,type) {
  const response=await fetch(url);
  if(!response.ok)throw new Error('Could not download the browser video engine. Check your connection and try again.');
  return URL.createObjectURL(new Blob([await response.arrayBuffer()],{type}));
}
async function engine() {
  if(!enginePromise)enginePromise=(async()=>{
    const ffmpeg=new FFmpeg();
    const urls=await Promise.all([blobURL(core+'/ffmpeg-core.js','text/javascript'),blobURL(core+'/ffmpeg-core.wasm','application/wasm')]);
    await ffmpeg.load({coreURL:urls[0],wasmURL:urls[1]});
    ffmpeg.on('progress',({time})=>{if(activeProgress)activeProgress.progress=Math.max(0,Math.min(99,time/1e6/activeProgress.duration*100));});
    return ffmpeg;
  })().catch(error=>{enginePromise=null;throw error;});
  return enginePromise;
}
async function mountSource() {
  const ffmpeg=await engine();
  if(mountedId!==source.id) {
    if(mountedId){try{await ffmpeg.unmount('/input');}catch{}try{await ffmpeg.deleteFile('/input/source');}catch{}}
    try{await ffmpeg.createDir('/input');}catch{}
    // WORKERFS reads the File directly, avoiding a full input copy in WASM RAM.
    const file=new File([source.file],'source',{type:source.file.type});
    if(!await ffmpeg.mount('WORKERFS',{files:[file]},'/input'))await ffmpeg.writeFile('/input/source',new Uint8Array(await file.arrayBuffer()));
    mountedId=source.id;source.input='/input/source';
  }
  return ffmpeg;
}
async function execute(ffmpeg,args) {
  if(await ffmpeg.exec(['-v','error','-y',...args])!==0)throw new Error('The browser could not process this video. Try an MP4 or use the local app for this file.');
}
function canPlay(url) {
  return new Promise(resolve=>{
    const video=document.createElement('video');video.preload='metadata';
    let timer;
    const finish=ok=>{clearTimeout(timer);video.removeAttribute('src');video.load();resolve(ok);};
    video.onloadedmetadata=()=>finish(Number.isFinite(video.duration)&&video.videoWidth>0);
    video.onerror=()=>finish(false);timer=setTimeout(()=>finish(false),5000);video.src=url;
  });
}
async function analyze(job) {
  const scratch=[];
  try {
    job.progress=5;job.phase='Analyzing audio…';
    try {
      const metadata=await analyzeNative(source.file,job);
      const previewURL=URL.createObjectURL(source.file);
      if(await canPlay(previewURL)) {
        Object.assign(job,metadata,{previewURL,previewMode:'original',status:'ready',progress:100,previewStatus:'ready'});
        await cacheSource(job);return;
      }
      URL.revokeObjectURL(previewURL);
    }catch{/* Unsupported codecs use the compatible WebAssembly engine. */}
    job.progress=5;job.phase='Loading video engine…';
    const ffmpeg=await mountSource();job.progress=20;job.phase='Analyzing audio…';
    const probeFile=`probe-${job.id}.json`;scratch.push(probeFile);
    // core 0.12.10 reports -1 even after a successful probe (upstream #817).
    // Validate the produced JSON and media fields instead of its return code.
    await ffmpeg.ffprobe(['-v','error','-show_format','-show_streams','-of','json','-o',probeFile,source.input]);
    const probe=JSON.parse(await ffmpeg.readFile(probeFile,'utf8'));
    const video=probe.streams.find(s=>s.codec_type==='video'),audio=probe.streams.some(s=>s.codec_type==='audio');
    const duration=Number(probe.format.duration||video?.duration);
    if(!video||!Number.isFinite(duration)||duration<=0)throw new Error('Choose a file containing a video track.');
    const rotation=video.side_data_list?.find(s=>'rotation'in s)?.rotation||0;
    const rotated=Math.abs(rotation)%180===90;
    Object.assign(job,{duration,hasAudio:audio,width:rotated?video.height:video.width,height:rotated?video.width:video.height,sourceVideoCodec:video.codec_name,sourceVideoBitrate:Number(video.bit_rate)||null,step:0.02,levels:[]});
    if(audio) {
      const pcmFile=`audio-${job.id}.pcm`;scratch.push(pcmFile);
      await execute(ffmpeg,['-i',source.input,'-map','0:a:0','-vn','-ac','1','-ar','8000','-f','s16le',pcmFile]);
      const bytes=await ffmpeg.readFile(pcmFile),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      for(let offset=0;offset+1<bytes.length;offset+=320) {
        const end=Math.min(bytes.length,offset+320);let sum=0,count=0;
        for(let i=offset;i+1<end;i+=2){const value=view.getInt16(i,true);sum+=value*value;count++;}
        job.levels.push(Math.round(20*Math.log10(Math.max(Math.sqrt(sum/count)/32768,0.00001))*100)/100);
      }
    }
    job.progress=70;job.phase='Preparing preview…';
    let previewBlob=null;job.previewURL=URL.createObjectURL(source.file);job.previewMode='original';
    if(!await canPlay(job.previewURL)) {
      URL.revokeObjectURL(job.previewURL);
      const preview=`preview-${job.id}.mp4`;scratch.push(preview);
      await execute(ffmpeg,['-i',source.input,'-map','0:v:0','-map','0:a:0?','-vf',"scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-c:v','libx264','-preset','ultrafast','-crf','25','-threads','1','-g','15','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',preview]);
      previewBlob=new Blob([await ffmpeg.readFile(preview)],{type:'video/mp4'});
      job.previewURL=URL.createObjectURL(previewBlob);job.previewMode='proxy';
    }
    Object.assign(job,{status:'ready',progress:100,previewStatus:'ready'});
    await cacheSource(job,previewBlob);
  }catch(error){job.status='error';job.error=error.message||'Browser processing failed. Try a smaller video or use the local app.';}
  finally {
    if(enginePromise)try{const ffmpeg=await enginePromise;for(const file of scratch)try{await ffmpeg.deleteFile(file);}catch{}}catch{}
  }
}
export async function upload(file) {
  if(file.size>MAX_SIZE)throw new Error('Browser processing supports files up to 512 MB. Use the local app for larger videos (see the GitHub README).');
  for(const job of jobs.values())if(job.previewURL)URL.revokeObjectURL(job.previewURL);
  jobs.clear();const id=crypto.randomUUID();source={id,file,input:null};
  const job={id,status:'analyzing',progress:0,filename:file.name};jobs.set(id,job);
  analyze(job);return {id};
}
function rememberOutput(url){outputUrls.push(url);if(outputUrls.length>3)URL.revokeObjectURL(outputUrls.shift());}
async function render(job,body) {
  const scratch=[];
  try {
    const original=jobs.get(body.id);
    if(!original||source?.id!==body.id)throw new Error('Choose the video again to export it.');
    const segments=planExport(body.cuts,original.duration,body.mode||'edited');
    if(!segments.length)throw new Error(body.mode==='removed'?'There are no removed clips to export.':'The cuts cover the entire video. Keep some footage to render.');
    job.duration=segments.reduce((total,c)=>total+c.end-c.start,0);
    job.phase='Exporting video…';
    try {
      const blob=await renderNative(source.file,segments,job);
      const outputURL=URL.createObjectURL(blob);rememberOutput(outputURL);
      Object.assign(job,{status:'ready',progress:100,outputURL,processing:'native'});return;
    }catch{/* Try the software engine if the native codec is unavailable or fails. */}
    job.progress=0;job.phase='Exporting with compatibility engine…';
    const ffmpeg=await mountSource();
    let codec=original.sourceVideoCodec,bitrate=original.sourceVideoBitrate;
    // Older saved sessions did not record the source codec. Probe the original,
    // never the preview proxy, before choosing an encoder.
    if(!codec) {
      const probeFile=`export-probe-${job.id}.json`;scratch.push(probeFile);
      await ffmpeg.ffprobe(['-v','error','-select_streams','v:0','-show_streams','-of','json','-o',probeFile,source.input]);
      const video=JSON.parse(await ffmpeg.readFile(probeFile,'utf8')).streams[0];
      codec=video.codec_name;bitrate=Number(video.bit_rate)||null;
    }
    const profile=videoProfile(codec,bitrate);
    const filter=`filter-${job.id}.txt`,output=`export-${job.id}.mp4`;scratch.push(filter,output);
    await ffmpeg.writeFile(filter,new TextEncoder().encode(exportGraph(segments,original.hasAudio)));
    const args=['-i',source.input,'-filter_complex_threads','1','-filter_complex_script',filter,'-map','[vfinal]'];
    if(original.hasAudio)args.push('-map','[aout]','-c:a','aac','-b:a','192k');
    args.push(...softwareVideoOptions(profile),'-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',output);
    activeProgress=job;
    try{await execute(ffmpeg,args);}catch{throw new Error(`This browser cannot export the original ${profile.codec==='hevc'?'HEVC':profile.codec.toUpperCase()} codec. Use the local app to preserve it.`);}
    activeProgress=null;
    const outputURL=URL.createObjectURL(new Blob([await ffmpeg.readFile(output)],{type:'video/mp4'}));
    rememberOutput(outputURL);
    Object.assign(job,{status:'ready',progress:100,outputURL,processing:'wasm',videoCodec:profile.codec,targetVideoBitrate:profile.bitrate});
  }catch(error){job.status='error';job.error=error.message||'Export failed. Try a shorter video or use the local app.';}
  finally {activeProgress=null;if(enginePromise)try{const ffmpeg=await enginePromise;for(const file of scratch)try{await ffmpeg.deleteFile(file);}catch{}}catch{}}
}
export async function request(url,options) {
  if(url.startsWith('/api/jobs/')) {
    const id=url.split('/').at(-1),job=jobs.get(id)||await restoreSource(id);
    if(!job)throw new Error('Choose the video again to continue.');
    return job;
  }
  const body=JSON.parse(options?.body||'{}');
  if(url==='/api/preview') {
    const job=jobs.get(body.id);if(!job)throw new Error('Choose the video again to continue.');
    job.previewStatus='ready';return {id:body.id};
  }
  if(url==='/api/render') {
    const id=crypto.randomUUID(),job={id,status:'rendering',progress:0};jobs.set(id,job);render(job,body);return {id};
  }
  throw new Error('Unknown browser action.');
}
