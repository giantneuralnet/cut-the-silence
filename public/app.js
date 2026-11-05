import { rememberEdit, undoEdit, redoEdit, clearManualEdits } from './edit-history.mjs';
import { CutPlayback, invertCuts } from './playback.mjs';
import { detectRegions, applyOverrides, setOverride, resolveEdgeEdits, editMasks, timelineGesture, mergedAutomaticCuts, removeShortClips } from './timeline.mjs';

const $ = id => document.getElementById(id);
const video = $('video');
const browserMode=!['127.0.0.1','localhost','[::1]'].includes(location.hostname)||new URLSearchParams(location.search).has('browser');
const browserBackend=browserMode?await import('./browser-backend.mjs'):null;
const SESSION_KEY=browserMode?'cut-the-silence-browser-session':'video-editor-session';
const state = {id:null,name:'',duration:0,levels:[],step:0.02,cuts:[],selected:null,
  preview:false,playbackMode:'edited',busy:false,followPlayback:true,history:[],future:[],viewStart:0,viewEnd:0,previewMode:null,regions:[],overrides:[],edgeEdits:[],autoRegions:[]};
let cutId=0,drag=null,zoomDrag=null,frame=0,saveTimer=null,fallbackAttempted=false;
const icon = name => `<svg><use href="#i-${name}"/></svg>`;
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const span = () => Math.max(0.001,state.viewEnd-state.viewStart);
const minimumWindow = () => Math.min(state.duration,Math.max(0.5,state.duration*28/Math.max(28,$('zoom-bar').clientWidth)));
function time(value,decimals=true) {
  const scale=decimals?100:1, seconds=Math.round(Math.max(0,Number(value)||0)*scale)/scale;
  return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${(seconds%60).toFixed(decimals?2:0).padStart(decimals?5:2,'0')}`;
}
function message(text='') {$('error').textContent=text;$('error').hidden=!text;}
function sortedCuts() {return [...state.cuts].sort((a,b)=>a.start-b.start);}
function mergedCuts() {
  const merged=[];
  for(const c of sortedCuts()) {
    const last=merged.at(-1);
    if(last&&c.start<=last.end+0.000001)last.end=Math.max(last.end,c.end);
    else merged.push({start:c.start,end:c.end});
  }
  return merged;
}
const removedDuration=()=>mergedCuts().reduce((sum,c)=>sum+c.end-c.start,0);
function writeSession() {
  if(!state.id)return;
  try {localStorage.setItem(SESSION_KEY,JSON.stringify({id:state.id,name:state.name,
    threshold:$('threshold').value,silence:$('silence').value,minimumAudio:$('minimum-audio').value,padding:$('padding').value,
    overrides:state.overrides,edgeEdits:state.edgeEdits,history:state.history,future:state.future,viewStart:state.viewStart,viewEnd:state.viewEnd}));}catch{}
}
function saveSession() {clearTimeout(saveTimer);if(state.id)saveTimer=setTimeout(writeSession,150);}
window.addEventListener('pagehide',()=>{clearTimeout(saveTimer);writeSession();});
function remember() {rememberEdit(state);}
function dirty() {$('render-result').hidden=true;saveSession();}
function refreshButtons() {
  const ready=!!state.id&&!state.busy,allCut=removedDuration()>=state.duration-0.002;
  for(const id of ['threshold','silence','minimum-audio','padding','zoom-start','zoom-end'])$(id).disabled=!ready;
  for(const id of ['preview','render'])$(id).disabled=!ready||allCut;
  const hasRemoved=removedDuration()>0.002;
  $('play').disabled=!ready||(state.playbackMode==='removed'?!hasRemoved:allCut);
  for(const id of ['preview-removed','export-removed'])$(id).disabled=!ready||!hasRemoved;
  $('replace').disabled=state.busy;$('undo').disabled=state.busy||(!state.history.length&&!state.edgeEdits.length);
  $('redo').disabled=state.busy||!state.future.length;
  $('clear-manual').disabled=state.busy||(!state.overrides.length&&!state.edgeEdits.length);
  $('zoom-bar').classList.toggle('disabled',!ready);
  $('timeline').inert=state.busy;$('inspector').inert=state.busy;
  document.body.classList.toggle('busy',state.busy);syncPlay();
  updateCurrentClip();
}
function currentClip() {
  const position=Math.max(0,Math.min(video.currentTime,state.duration));
  return state.regions.find(region=>position>=region.start&&position<region.end)||(position>=state.duration?state.regions.at(-1):null);
}
function updateCurrentClip() {
  const clip=currentClip(),button=$('toggle-current');
  button.disabled=state.busy||!state.id||!clip;
  const label=clip?.cut?'Keep current clip':'Cut current clip';
  if(button.textContent!==label)button.textContent=label;
  button.title=clip?`${time(clip.start)} → ${time(clip.end)}`:'Toggle the section at the playhead';
}
function syncSliders() {
  for(const id of ['threshold','silence','minimum-audio','padding']) {const e=$(id);e.style.setProperty('--fill',`${(e.value-e.min)/(e.max-e.min)*100}%`);}
  $('threshold-value').innerHTML=`−${Math.abs(Number($('threshold').value))} <span>dB</span>`;
  $('silence-value').innerHTML=`${Number($('silence').value).toFixed(2)} <span>s</span>`;
  $('minimum-audio-value').innerHTML=`${Number($('minimum-audio').value).toFixed(2)} <span>s</span>`;
  $('padding-value').innerHTML=`${Number($('padding').value).toFixed(2)} <span>s</span>`;
}
function rebuildRegions(selectionTime=null) {
  state.regions=removeShortClips(applyOverrides(state.autoRegions,editMasks(state.autoRegions,state.overrides,state.edgeEdits,state.duration,Number($('minimum-audio').value))),Number($('minimum-audio').value)).map(region=>({...region,id:++cutId}));
  state.cuts=state.regions.filter(region=>region.cut);
  state.selected=selectionTime===null?null:state.regions.find(region=>selectionTime>=region.start&&selectionTime<region.end)?.id??null;
}
function detect() {
  if(!state.id)return;
  playback.pause();
  state.autoRegions=detectRegions(state.levels,state.step,state.duration,Number($('threshold').value),Number($('silence').value),0,Number($('padding').value));
  rebuildRegions();dirty();drawCuts();drawOverview();drawWaveform();
}
function toggleRegion(region) {
  if(!region||state.busy)return;
  remember();playback.pause();
  const resolved=resolveEdgeEdits(removeShortClips(applyOverrides(state.autoRegions,state.overrides),Number($('minimum-audio').value)),state.edgeEdits,state.duration);
  state.edgeEdits=state.edgeEdits.filter(edit=>!resolved.some(r=>r.id===edit.id&&r.end>region.start&&r.start<region.end));
  state.overrides=setOverride(state.overrides,region.start,region.end,!region.cut);
  rebuildRegions((region.start+region.end)/2);dirty();drawCuts();drawOverview();
}
function updateStats() {
  const removed=removedDuration();
  const count=mergedCuts().length;$('cut-count').textContent=`${count} cut${count===1?'':'s'}`;
  $('removed').textContent=`${removed.toFixed(2)}s removed`;
}
function updateSelection() {
  const c=state.regions.find(c=>c.id===state.selected);
  $('inspector').hidden=!c;$('inspector-row').hidden=!c;
  if(c){const bounds=c.cut?mergedCuts().find(u=>c.start>=u.start-1e-6&&c.end<=u.end+1e-6)||c:c;$('selection-label').textContent=`${c.cut?'Cut':c.kind==='audio'?'Audio':'Silence'} · ${time(bounds.start)} → ${time(bounds.end)}${c.manual?' · manual':''}`;$('delete').hidden=!c.cut;}
}
function selectCut(id) {
  state.selected=id;
  for(const el of $('cuts').children)el.classList.toggle('selected',Number(el.dataset.id)===id);
  updateSelection();
}
function drawCuts() {
  const holder=$('cuts');holder.replaceChildren();
  const unions=mergedCuts();
  for(const c of state.regions) {
    if(c.end<state.viewStart||c.start>state.viewEnd)continue;
    const el=document.createElement('div');
    el.className=`region ${c.kind}${c.cut?' cut':' kept'}${c.id===state.selected?' selected':''}`;
    el.style.left=`${(c.start-state.viewStart)/span()*100}%`;
    el.style.width=`${(c.end-c.start)/span()*100}%`;
    el.dataset.id=c.id;el.tabIndex=0;el.setAttribute('role','button');
    el.setAttribute('aria-label',`${c.kind==='audio'?'Audio':'Silence'} from ${c.start.toFixed(2)} to ${c.end.toFixed(2)} seconds, ${c.cut?'cut':'kept'}`);el.setAttribute('aria-pressed',String(c.cut));
    el.title=`${time(c.start)} → ${time(c.end)}${c.manual?' · Manually '+(c.cut?'cut':'kept'):''}`;el.dataset.manual=String(c.manual);
    el.innerHTML=c.cut?`<button class="cut-handle start" data-edge="start" aria-label="Drag cut start" title="${time(c.start)}" tabindex="-1"></button><button class="cut-handle end" data-edge="end" aria-label="Drag cut end" title="${time(c.end)}" tabindex="-1"></button>`:'';
    if(c.cut){const union=unions.find(u=>c.start>=u.start-1e-6&&c.end<=u.end+1e-6);if(union){if(c.start>union.start+1e-6)el.querySelector('.start').remove();if(c.end<union.end-1e-6)el.querySelector('.end').remove();}}
    holder.append(el);
  }
  updateStats();updateSelection();refreshButtons();
}
function canvasContext(id) {
  const canvas=$(id),w=canvas.clientWidth,h=canvas.clientHeight,dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);return {ctx,w,h};
}
function paintWaveform(ctx,w,h,start,end,overview=false) {
  ctx.strokeStyle='#41384c';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  if(!state.id||!state.levels.length){$('threshold-upper').hidden=$('threshold-lower').hidden=true;return;}
  const spacing=overview?2.8:3.5,bars=Math.floor(w/spacing);
  let maximum=-100;
  for(let i=Math.max(0,Math.floor(start/state.step));i<Math.min(state.levels.length,Math.ceil(end/state.step));i++)maximum=Math.max(maximum,state.levels[i]);
  if(maximum<=-99)maximum=0;
  const fullHeight=Math.max(0,h-4),ratio=db=>Math.min(1,Math.pow(10,(db-maximum)/40));
  if(!overview) {
    const threshold=ratio(Number($('threshold').value)),center=27+h/2,offset=threshold*fullHeight/2;
    for(const [id,y] of [['threshold-upper',center-offset],['threshold-lower',center+offset]]) {$(id).hidden=false;$(id).style.top=`${y}px`;}
    $('threshold-upper').querySelector('span').textContent=`${$('threshold').value} dB`;
  }
  for(let i=0;i<bars;i++) {
    const a=Math.floor((start+i/bars*(end-start))/state.step);
    const b=Math.max(a+1,Math.floor((start+(i+1)/bars*(end-start))/state.step));
    let peak=-100;for(let j=a;j<Math.min(b,state.levels.length);j++)peak=Math.max(peak,state.levels[j]);
    const height=Math.max(1.5,ratio(peak)*fullHeight);
    ctx.fillStyle=overview?'#746481':'#b59bc9';ctx.beginPath();ctx.roundRect(i*spacing+1,(h-height)/2,overview?1.2:1.8,height,1);ctx.fill();
  }
}
function drawWaveform() {
  const {ctx,w,h}=canvasContext('waveform');paintWaveform(ctx,w,h,state.viewStart,state.viewEnd);
  drawRuler();
}
function drawOverview() {
  const {ctx,w,h}=canvasContext('overview');paintWaveform(ctx,w,h,0,state.duration,true);
  if(state.duration)for(const c of state.regions.filter(region=>!region.cut)) {ctx.fillStyle='#4ac79450';ctx.fillRect(c.start/state.duration*w,0,Math.max(1,(c.end-c.start)/state.duration*w),h);}
}
function drawRuler() {
  $('ruler').replaceChildren();if(!state.duration)return;
  const count=Math.max(2,Math.floor($('timeline').clientWidth/100));
  for(let i=0;i<count;i++) {const el=document.createElement('span');el.className='tick';el.style.left=`${i/count*100}%`;el.textContent=time(state.viewStart+i/count*span(),span()<10);$('ruler').append(el);}
}
function drawZoom() {
  const duration=state.duration||1;
  $('zoom-window').style.left=`${state.viewStart/duration*100}%`;
  $('zoom-window').style.width=`${state.id?span()/duration*100:100}%`;
  for(const edge of ['start','end']) {
    const el=$('zoom-'+edge),value=edge==='start'?state.viewStart:state.viewEnd;
    el.setAttribute('aria-valuemax',String(state.duration));el.setAttribute('aria-valuenow',value.toFixed(2));
    el.setAttribute('aria-valuetext',time(value));
  }
}
function updatePlayhead(follow=false) {
  $('current').textContent=time(video.currentTime);
  updateCurrentClip();
  if(follow&&state.followPlayback&&!video.paused&&state.id&&(video.currentTime<state.viewStart||video.currentTime>state.viewEnd)) {
    const width=span();state.viewStart=clamp(video.currentTime-width*0.1,0,state.duration-width);state.viewEnd=state.viewStart+width;
    drawWaveform();drawCuts();drawZoom();
  }
  const visible=state.id&&video.currentTime>=state.viewStart&&video.currentTime<=state.viewEnd;
  $('playhead').style.display=visible?'block':'none';
  $('playhead').style.left=`${clamp((video.currentTime-state.viewStart)/span()*100,0,100)}%`;
}
function redrawTimeline() {drawWaveform();drawCuts();drawZoom();updatePlayhead();saveSession();}
function syncPlay() {
  const playing=!video.paused&&!video.ended;
  $('play').innerHTML=icon(playing?'pause':'play');$('play').classList.toggle('paused',playing);
  $('play').setAttribute('aria-label',playing?'Pause video':'Play video');
  $('stage-play').hidden=playing||!state.id||state.busy;
  $('fullscreen').hidden=!state.id||state.busy;
}

function inFullscreen() {
  return document.fullscreenElement===$('stage')||document.webkitFullscreenElement===$('stage')||video.webkitDisplayingFullscreen||$('stage').classList.contains('expanded');
}
function syncFullscreen() {
  const full=!!inFullscreen(),button=$('fullscreen');
  button.innerHTML=icon(full?'exit-fullscreen':'fullscreen');
  button.setAttribute('aria-label',full?'Exit fullscreen':'Enter fullscreen');
  button.setAttribute('aria-pressed',String(full));button.title=full?'Exit fullscreen (Esc)':'Fullscreen';
  document.body.classList.toggle('preview-expanded',$('stage').classList.contains('expanded'));
}
$('fullscreen').onclick=async()=>{
  const stage=$('stage');
  try {
    if(inFullscreen()) {
      if(stage.classList.contains('expanded'))stage.classList.remove('expanded');
      else if(document.fullscreenElement)await document.exitFullscreen();
      else if(document.webkitFullscreenElement)document.webkitExitFullscreen();
      else if(video.webkitExitFullscreen)video.webkitExitFullscreen();
    }else if(stage.requestFullscreen)await stage.requestFullscreen();
    else if(stage.webkitRequestFullscreen)stage.webkitRequestFullscreen();
    else if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();
    else stage.classList.add('expanded');
  }catch{stage.classList.add('expanded');}
  syncFullscreen();
};
for(const event of ['fullscreenchange','webkitfullscreenchange'])document.addEventListener(event,syncFullscreen);
for(const event of ['webkitbeginfullscreen','webkitendfullscreen'])video.addEventListener(event,syncFullscreen);
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||!inFullscreen())return;
  event.stopPropagation();
  if($('stage').classList.contains('expanded')){$('stage').classList.remove('expanded');syncFullscreen();}
},{capture:true});
const playback=new CutPlayback(video,()=>state.playbackMode==='removed'?invertCuts(mergedCuts(),state.duration):mergedCuts(),()=>state.duration,active=>{
  state.preview=active;
  const removed=state.playbackMode==='removed';
  $('preview-badge').hidden=!active||!state.cuts.length;
  $('preview-badge').innerHTML='<span></span>'+(removed?'Previewing removed clips':'Previewing cuts');
  $('preview').innerHTML=icon(active&&!removed?'pause':'play')+`<span>${active&&!removed?'Stop preview':'Preview'}</span>`;
  $('preview-removed').innerHTML=icon(active&&removed?'pause':'play')+`<span>${active&&removed?'Stop preview':'Preview removed clips'}</span>`;
  syncPlay();
});
async function play(restart=false,mode=state.playbackMode) {
  if(!state.id||state.busy)return;
  if(mode==='removed'?removedDuration()<=0.002:removedDuration()>=state.duration-0.002)return;
  if(mode!==state.playbackMode)playback.pause();
  state.playbackMode=mode;refreshButtons();
  message();
  state.followPlayback=true;
  try {await playback.play(restart);}catch(error){playback.pause();message('Could not play the video. Try choosing it again.');}
}
function togglePlay() {if(video.paused)play(false);else playback.pause();}
function animate() {updatePlayhead(true);if(!video.paused)frame=requestAnimationFrame(animate);}
video.addEventListener('play',()=>{syncPlay();cancelAnimationFrame(frame);frame=requestAnimationFrame(animate);});
video.addEventListener('pause',()=>{syncPlay();cancelAnimationFrame(frame);updatePlayhead();});
video.addEventListener('timeupdate',()=>updatePlayhead(true));video.addEventListener('seeked',()=>updatePlayhead(true));
$('play').onclick=togglePlay;$('stage-play').onclick=togglePlay;video.onclick=togglePlay;
$('preview').onclick=()=>{if(!video.paused&&state.playbackMode==='edited')playback.pause();else play(true,'edited');};
$('preview-removed').onclick=()=>{if(!video.paused&&state.playbackMode==='removed')playback.pause();else play(true,'removed');};

async function request(url,options) {if(browserBackend)return browserBackend.request(url,options);const response=await fetch(url,options),data=await response.json();if(!response.ok)throw new Error(data.error||'The request failed.');return data;}
function nativeHevc() {return !!video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"');}
function uploadFile(file) {
  if(browserBackend)return browserBackend.upload(file);
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST','/api/upload');xhr.setRequestHeader('X-Filename',encodeURIComponent(file.name));xhr.setRequestHeader('X-Native-Hevc',nativeHevc()?'1':'0');
    xhr.upload.onprogress=e=>{if(e.lengthComputable)$('upload-progress').style.width=`${e.loaded/e.total*100}%`;};
    xhr.onload=()=>{try{const data=JSON.parse(xhr.responseText);if(xhr.status>=400)reject(new Error(data.error));else resolve(data);}catch{reject(new Error('Upload failed. Is the local server running?'));}};
    xhr.onerror=()=>reject(new Error('Could not reach the local server. Run python3 server.py.'));xhr.send(file);
  });
}
function showProcessing(label) {
  state.busy=true;playback.pause();video.hidden=true;$('upload').hidden=true;$('processing').hidden=false;
  $('stage').classList.remove('has-video');$('processing-label').textContent=label;$('upload-progress').style.width='0%';refreshButtons();
}
async function waitForJob(id,previewOnly=false) {
  while(true) {
    const data=await request(`/api/jobs/${id}`);
    if(data.status==='error'||data.previewStatus==='error')throw new Error(data.previewError||data.error);
    $('upload-progress').style.width=`${data.progress||65}%`;
    if(data.phase)$('processing-label').textContent=data.phase;else if(data.progress>=65)$('processing-label').textContent='Preparing preview…';
    if(data.status==='ready'&&(!previewOnly||data.previewStatus==='ready'))return data;
    await delay(200);
  }
}
function attachPreview(data) {
  state.previewMode=data.previewMode;
  $('processing').hidden=true;video.hidden=false;$('stage').classList.add('has-video');
  video.src=data.previewURL||`/media/${state.id}/preview?v=${encodeURIComponent(data.previewMode||'cached')}`;video.load();
  state.busy=false;refreshButtons();saveSession();
}
function loadAnalysis(id,data,name,saved=null) {
  state.id=id;state.name=name||data.filename||'Video';state.duration=data.duration;state.levels=data.levels;state.step=data.step;
  state.viewStart=clamp(saved?.viewStart||0,0,Math.max(0,data.duration-0.5));
  state.viewEnd=clamp(saved?.viewEnd||data.duration,state.viewStart+Math.min(0.5,data.duration),data.duration);
  $('duration').textContent=time(data.duration);$('empty-timeline').hidden=true;
  state.overrides=Array.isArray(saved?.overrides)?saved.overrides.filter(mask=>Number.isFinite(mask.start)&&Number.isFinite(mask.end)&&mask.end-mask.start>=0.005&&typeof mask.cut==='boolean'):[];
  state.edgeEdits=Array.isArray(saved?.edgeEdits)?saved.edgeEdits.filter(edit=>edit.anchor&&Number.isFinite(edit.anchor.start)&&Number.isFinite(edit.anchor.end)&&Number.isFinite(edit.startOffset)&&Number.isFinite(edit.endOffset)):[];
  state.history=Array.isArray(saved?.history)?saved.history.filter(entry=>Array.isArray(entry.overrides)&&Array.isArray(entry.edgeEdits)):[];
  state.future=Array.isArray(saved?.future)?saved.future.filter(entry=>Array.isArray(entry.overrides)&&Array.isArray(entry.edgeEdits)):[];
  detect();
  if(saved&&Array.isArray(saved.cuts)&&!Array.isArray(saved.overrides)) {
    // Preserve only differences from automatic cuts when migrating an old session.
    const boundaries=[...new Set([0,data.duration,...state.autoRegions.flatMap(r=>[r.start,r.end]),...saved.cuts.flatMap(r=>[r.start,Math.min(data.duration,r.end)])])].sort((a,b)=>a-b);
    for(let i=0;i<boundaries.length-1;i++) {
      const start=boundaries[i],end=boundaries[i+1],mid=(start+end)/2;
      const wasCut=saved.cuts.some(c=>mid>=c.start&&mid<c.end);
      const autoCut=state.autoRegions.some(c=>c.autoCut&&mid>=c.start&&mid<c.end);
      if(wasCut!==autoCut&&end-start>=0.005)state.overrides=setOverride(state.overrides,start,end,wasCut);
    }
    rebuildRegions();drawCuts();
  }
  drawWaveform();drawOverview();drawZoom();updatePlayhead();
}
async function refreshPreview(useNative=nativeHevc()) {
  showProcessing('Preparing preview…');
  await request('/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:state.id,nativeHevc:useNative})});
  const data=await waitForJob(state.id,true);attachPreview(data);
}
video.addEventListener('error',async()=>{
  if(!state.id||state.busy)return;
  if(!fallbackAttempted&&state.previewMode==='remux') {
    fallbackAttempted=true;
    try {await refreshPreview(false);}catch(error){state.busy=false;message(error.message);refreshButtons();}
  }else message('The browser could not play this video. Choose another format.');
});
async function upload(file) {
  if(state.busy)return;if(!file.size){message('Choose a nonempty video file.');return;}
  message();showProcessing('Uploading video…');state.id=null;state.duration=0;state.levels=[];state.cuts=[];state.regions=[];state.autoRegions=[];state.overrides=[];state.edgeEdits=[];state.selected=null;state.history=[];state.future=[];state.viewStart=state.viewEnd=0;fallbackAttempted=false;
  video.removeAttribute('src');video.load();$('render-result').hidden=true;$('empty-timeline').hidden=false;
  $('current').textContent=$('duration').textContent='00:00.00';redrawTimeline();drawOverview();
  try {
    const {id}=await uploadFile(file);$('processing-label').textContent='Analyzing audio…';
    const data=await waitForJob(id);loadAnalysis(id,data,file.name);attachPreview(data);
  }catch(error){state.busy=false;state.id=null;$('processing').hidden=true;$('upload').hidden=false;message(error.message);refreshButtons();}
}
$('replace').onclick=()=>$('file').click();
$('file').onchange=()=>{const file=$('file').files[0];if(file)upload(file);$('file').value='';};
['dragenter','dragover'].forEach(type=>document.addEventListener(type,e=>{e.preventDefault();if(!state.busy&&e.dataTransfer.types.includes('Files'))$('stage').classList.add('dragging');}));
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)$('stage').classList.remove('dragging');});
document.addEventListener('drop',e=>{e.preventDefault();$('stage').classList.remove('dragging');if(!state.busy&&e.dataTransfer.files[0])upload(e.dataTransfer.files[0]);});
for(const id of ['threshold','silence','minimum-audio','padding']) {
  $(id).addEventListener('input',()=>{syncSliders();detect();});
}
function positionTime(x) {const rect=$('timeline').getBoundingClientRect();return clamp(state.viewStart+(x-rect.left)/rect.width*span(),0,state.duration);}
function seek(x) {video.currentTime=positionTime(x);updatePlayhead();}
$('timeline').addEventListener('pointerdown',e=>{
  if(!state.id||state.busy||e.button!==0)return;
  const regionEl=e.target.closest('.region');
  if(regionEl) {
    e.preventDefault();const id=Number(regionEl.dataset.id),region=state.regions.find(c=>c.id===id);
    selectCut(id);let edge=e.target.dataset.edge;
    if(edge) {
      const rect=regionEl.getBoundingClientRect();
      if(rect.width<24)edge=e.clientX<rect.left+rect.width/2?'start':'end';
    }
    const union=edge?mergedCuts().find(c=>region.start>=c.start-1e-6&&region.end<=c.end+1e-6):null;
    const target=union?{...region,...union,kind:'cut'}:region;
    playback.pause();
    drag={region:{...target},edge,x:e.clientX,original:edge?target[edge]:0,changed:false,
      overrides:structuredClone(state.overrides),edgeEdits:structuredClone(state.edgeEdits),current:edge?target[edge]:null};
    $('timeline').setPointerCapture(e.pointerId);
    if(edge)$('timeline').classList.add('editing');
    return;
  }
  selectCut(null);seek(e.clientX);drag={seek:true};$('timeline').setPointerCapture(e.pointerId);
});
$('timeline').addEventListener('pointermove',e=>{
  if(!drag)return;if(drag.seek){seek(e.clientX);return;}
  if(!drag.edge){if(Math.abs(e.clientX-drag.x)>5)drag.moved=true;return;}
  if(!drag.changed){if(Math.abs(e.clientX-drag.x)<1)return;remember();drag.changed=true;}
  const rect=$('timeline').getBoundingClientRect();
  const t=clamp(drag.original+(e.clientX-drag.x)/rect.width*span(),0,state.duration);
  const region={...drag.region};
  region[drag.edge]=drag.edge==='start'?Math.min(t,region.end-0.02):Math.max(t,region.start+0.02);
  drag.current=region[drag.edge];
  state.edgeEdits=structuredClone(drag.edgeEdits);
  const resolved=resolveEdgeEdits(removeShortClips(applyOverrides(state.autoRegions,state.overrides),Number($('minimum-audio').value)),state.edgeEdits,state.duration);
  const matching=resolved.find(edit=>(drag.region.start+drag.region.end)/2>=edit.start&&(drag.region.start+drag.region.end)/2<edit.end);
  let edit,base;
  if(matching) {edit=state.edgeEdits.find(e=>e.id===matching.id);base=matching.base;}
  else {
    const mid=(drag.region.start+drag.region.end)/2;
    const baseline=removeShortClips(applyOverrides(state.autoRegions,state.overrides),Number($('minimum-audio').value));
    base=(drag.region.kind==='cut'?mergedAutomaticCuts(baseline):baseline).find(r=>r.kind===drag.region.kind&&mid>=r.start&&mid<r.end)||drag.region;
    edit={id:crypto.randomUUID(),anchor:{start:base.start,end:base.end,kind:base.kind},startOffset:drag.region.start-base.start,endOffset:drag.region.end-base.end};
    state.edgeEdits.push(edit);
  }
  edit[drag.edge+'Offset']=region[drag.edge]-base[drag.edge];
  rebuildRegions((region.start+region.end)/2);dirty();drawCuts();drawOverview();
});
function endDrag(e) {
  if(drag?.changed)video.currentTime=drag.current;
  else if(drag?.region&&!drag.moved&&e?.type!=='pointercancel')toggleRegion(drag.region);
  drag=null;$('timeline').classList.remove('editing');
}
$('timeline').addEventListener('pointerup',endDrag);$('timeline').addEventListener('pointercancel',endDrag);
$('cuts').addEventListener('keydown',e=>{
  const el=e.target.closest('.region');if(!el)return;
  if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();toggleRegion(state.regions.find(region=>region.id===Number(el.dataset.id)));}
});
$('zoom-bar').addEventListener('pointerdown',e=>{
  if(!state.id||state.busy||e.button!==0)return;
  e.preventDefault();
  const edge=e.target.closest('.zoom-handle')?.id==='zoom-start'?'start':e.target.closest('.zoom-handle')?.id==='zoom-end'?'end':null;
  state.followPlayback=false;
  zoomDrag={edge,x:e.clientX,start:state.viewStart,end:state.viewEnd};
  if(!edge&&!e.target.closest('.zoom-window')) {
    const rect=$('zoom-bar').getBoundingClientRect(),width=span(),center=(e.clientX-rect.left)/rect.width*state.duration;
    state.viewStart=clamp(center-width/2,0,state.duration-width);state.viewEnd=state.viewStart+width;
    zoomDrag.start=state.viewStart;zoomDrag.end=state.viewEnd;redrawTimeline();
  }
  $('zoom-bar').setPointerCapture(e.pointerId);
});
$('zoom-bar').addEventListener('pointermove',e=>{
  if(!zoomDrag)return;
  const rect=$('zoom-bar').getBoundingClientRect(),delta=(e.clientX-zoomDrag.x)/rect.width*state.duration;
  const minimum=minimumWindow();
  if(zoomDrag.edge==='start')state.viewStart=clamp(zoomDrag.start+delta,0,state.viewEnd-minimum);
  else if(zoomDrag.edge==='end')state.viewEnd=clamp(zoomDrag.end+delta,state.viewStart+minimum,state.duration);
  else {const width=zoomDrag.end-zoomDrag.start;state.viewStart=clamp(zoomDrag.start+delta,0,state.duration-width);state.viewEnd=state.viewStart+width;}
  redrawTimeline();
});
for(const type of ['pointerup','pointercancel'])$('zoom-bar').addEventListener(type,()=>{zoomDrag=null;});
for(const edge of ['start','end'])$('zoom-'+edge).addEventListener('keydown',e=>{
  if(!state.id||state.busy)return;
  const minimum=minimumWindow(),step=Math.max(0.02,span()/20);
  let delta=0;
  if(['ArrowLeft','ArrowDown'].includes(e.key))delta=-step;
  if(['ArrowRight','ArrowUp'].includes(e.key))delta=step;
  if(e.key==='Home')delta=-state.duration;if(e.key==='End')delta=state.duration;
  if(!delta)return;e.preventDefault();
  if(edge==='start')state.viewStart=clamp(state.viewStart+delta,0,state.viewEnd-minimum);
  else state.viewEnd=clamp(state.viewEnd+delta,state.viewStart+minimum,state.duration);
  redrawTimeline();
});
$('zoom-bar').addEventListener('dblclick',()=>{if(state.busy)return;state.viewStart=0;state.viewEnd=state.duration;redrawTimeline();});
function deleteCut() {
  const region=state.regions.find(region=>region.id===state.selected);
  if(region?.cut)toggleRegion(region);
}
$('delete').onclick=deleteCut;
function finishHistoryChange() {playback.pause();rebuildRegions();dirty();drawCuts();drawOverview();drawWaveform();}
function undo() {if(!state.busy&&undoEdit(state))finishHistoryChange();}
function redo() {if(!state.busy&&redoEdit(state))finishHistoryChange();}
$('undo').onclick=undo;$('redo').onclick=redo;
$('clear-manual').onclick=()=>{if(!state.busy&&clearManualEdits(state))finishHistoryChange();};
$('toggle-current').onclick=()=>{const clip=currentClip();if(clip&&!state.busy)toggleRegion(clip);};
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey)redo();else undo();return;}
  if(e.ctrlKey&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}
  if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
  if(e.code==='Space'&&!e.target.closest('button,a')){e.preventDefault();togglePlay();}
  if((e.key==='Delete'||e.key==='Backspace')&&state.selected!==null){e.preventDefault();deleteCut();}
  if(e.key==='Escape'){selectCut(null);playback.pause();}
});
async function exportVideo(mode='edited') {
  if(!state.id||state.busy)return;
  if(mode==='removed'&&removedDuration()<=0.002)return;
  const button=$(mode==='removed'?'export-removed':'render');
  playback.pause();message();state.busy=true;refreshButtons();$('render-result').hidden=true;
  try {
    const {id}=await request('/api/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:state.id,mode,cuts:state.cuts.map(({start,end})=>({start,end}))})});
    let data;
    do {
      data=await request(`/api/jobs/${id}`);if(data.status==='error')throw new Error(data.error);
      button.innerHTML=`<span class="button-spinner"></span><span>${Math.round(data.progress)}%</span>`;
      if(data.status!=='ready')await delay(500);
    }while(data.status!=='ready');
    $('download').href=data.outputURL||`/media/${id}/output`;$('download').download=mode==='removed'?'removed-clips.mp4':'edited-video.mp4';$('result-label').textContent=mode==='removed'?'Removed clips ready':'Video ready';$('render-result').hidden=false;$('download').click();
  }catch(error){message(error.message);}
  finally{state.busy=false;button.innerHTML=icon('download')+`<span>${mode==='removed'?'Export removed clips':'Render'}</span>`;refreshButtons();}
}
$('render').onclick=()=>exportVideo('edited');
$('export-removed').onclick=()=>exportVideo('removed');
new ResizeObserver(()=>{drawWaveform();drawOverview();}).observe($('timeline'));
syncSliders();drawWaveform();drawOverview();drawZoom();refreshButtons();
async function restore() {
  let saved;
  try {
    const fragment=new URLSearchParams(location.hash.slice(1)).get('session');
    saved=JSON.parse(fragment||localStorage.getItem(SESSION_KEY)||'null');
    if(fragment)history.replaceState(null,'',location.pathname+location.search);
  }catch{return;}
  if(!saved?.id)return;
  try {
    showProcessing('Opening video…');
    const data=await request(`/api/jobs/${saved.id}`);
    if(data.status!=='ready')throw new Error('Choose the video again to continue.');
    $('threshold').value=saved.threshold||-35;$('silence').value=saved.silence||0.5;$('minimum-audio').value=saved.minimumAudio??0;$('padding').value=saved.padding??0.04;syncSliders();
    loadAnalysis(saved.id,data,saved.name,saved);await refreshPreview();
  }catch(error){state.busy=false;state.id=null;$('processing').hidden=true;$('upload').hidden=false;message(error.message);refreshButtons();}
}
restore();

// Native trackpad pinch is a ctrl-wheel event in Chromium and a gesture event
// in WebKit. Route both to the timeline rather than the page zoom controller.
let viewportFrame=0,gestureScale=1;
function redrawViewportSoon() {
  state.followPlayback=false;
  if(!viewportFrame)viewportFrame=requestAnimationFrame(()=>{viewportFrame=0;redrawTimeline();});
}
function moveViewport(delta,zoom,clientX) {
  if(!state.id||state.busy)return;
  const rect=$('timeline').getBoundingClientRect();
  const anchor=clamp(((clientX??(rect.left+rect.width/2))-rect.left)/rect.width,0,1);
  const next=timelineGesture(state.viewStart,state.viewEnd,state.duration,delta,zoom,anchor,minimumWindow());
  state.viewStart=next.start;state.viewEnd=next.end;redrawViewportSoon();
}
document.querySelector('.timeline-section').addEventListener('wheel',event=>{
  event.preventDefault();
  const units=event.deltaMode===1?16:event.deltaMode===2?$('timeline').clientWidth:1;
  if(event.ctrlKey||event.metaKey)moveViewport(event.deltaY*units,true,event.clientX);
  else {
    const pixels=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;
    moveViewport(pixels*units/$('timeline').clientWidth*span(),false,event.clientX);
  }
},{passive:false});
document.addEventListener('wheel',event=>{if(event.ctrlKey)event.preventDefault();},{capture:true,passive:false});
document.addEventListener('gesturestart',event=>{event.preventDefault();gestureScale=1;},{passive:false});
document.addEventListener('gesturechange',event=>{
  event.preventDefault();
  if(event.target.closest('.timeline-section')&&event.scale>0)moveViewport(Math.log(gestureScale/event.scale)*100,true,event.clientX);
  gestureScale=event.scale||1;
},{passive:false});
document.addEventListener('gestureend',event=>event.preventDefault(),{passive:false});
document.addEventListener('keydown',event=>{
  if(!(event.metaKey||event.ctrlKey)||!['+','=','-','0'].includes(event.key))return;
  event.preventDefault();
  if(event.key==='0'){state.viewStart=0;state.viewEnd=state.duration;redrawViewportSoon();}
  else moveViewport(event.key==='-'?22:-22,true);
},{capture:true});
document.addEventListener('selectstart',event=>event.preventDefault());

// Disclosure preferences affect layout only; slider values and edits stay live.
try {$('slider-group').open=localStorage.getItem('video-editor-sliders-open')!=='false';}catch{}
$('slider-group').addEventListener('toggle',()=>{
  $('slider-group').querySelector('summary').setAttribute('aria-expanded',String($('slider-group').open));
  try {localStorage.setItem('video-editor-sliders-open',String($('slider-group').open));}catch{}
});
$('advanced').addEventListener('toggle',()=>{
  $('advanced').querySelector('summary').setAttribute('aria-expanded',String($('advanced').open));
});
document.addEventListener('click',event=>{if($('advanced').open&&!$('advanced').contains(event.target))$('advanced').open=false;});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&$('advanced').open){event.stopPropagation();$('advanced').open=false;$('advanced').querySelector('summary').focus();}
},{capture:true});
