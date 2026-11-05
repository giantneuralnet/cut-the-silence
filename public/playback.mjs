// Playback must not depend on animation frames: browsers throttle them when the
// video or timeline is offscreen. Media events plus a clock guard both routes.
export function invertCuts(cuts, duration) {
  const skipped=[];let cursor=0;
  for(const cut of [...cuts].sort((a,b)=>a.start-b.start)) {
    const start=Math.max(0,Math.min(duration,cut.start)),end=Math.max(0,Math.min(duration,cut.end));
    if(end<=start)continue;
    if(start>cursor)skipped.push({start:cursor,end:start});
    cursor=Math.max(cursor,end);
  }
  if(cursor<duration)skipped.push({start:cursor,end:duration});
  return skipped;
}
export function nextPlayableTime(time, cuts, duration) {
  let target = Math.max(0, Math.min(duration, time));
  for (const cut of cuts) {
    if (target >= cut.start - 0.012 && target < cut.end - 0.002) target = cut.end;
  }
  return Math.min(duration, target);
}

export class CutPlayback {
  constructor(video, cuts, duration, onChange = () => {}) {
    this.video = video; this.cuts = cuts; this.duration = duration; this.onChange = onChange;
    this.enabled = false; this.clock = null; this.boundary = null;
    for (const type of ['timeupdate', 'seeked', 'ratechange']) video.addEventListener(type, () => this.check());
    video.addEventListener('play', () => {
      this.enabled = true; this.watch(); this.check(); this.onChange(true);
    });
    for (const type of ['pause', 'ended']) video.addEventListener(type, () => {
      this.clear(); this.onChange(false);
    });
  }
  async play(restart = false) {
    this.enabled = true;
    const duration = this.duration();
    let start = restart || this.video.ended || this.video.currentTime >= duration - 0.02 ? 0 : this.video.currentTime;
    start = nextPlayableTime(start, this.cuts(), duration);
    if (start >= duration - 0.002) { this.pause(); return; }
    if (Math.abs(this.video.currentTime-start) > 0.002) this.video.currentTime = start;
    await this.video.play();
    this.watch(); this.check();
  }
  pause() { this.video.pause(); this.clear(); this.onChange(false); }
  clear() { clearInterval(this.clock); clearTimeout(this.boundary); this.clock = this.boundary = null; }
  watch() {
    this.clear();
    this.clock = setInterval(() => this.check(), 25);
  }
  check() {
    const video = this.video;
    if (!this.enabled || video.paused || video.seeking) return;
    const cuts = this.cuts(), duration = this.duration(), current = video.currentTime;
    const target = nextPlayableTime(current, cuts, duration);
    if (target >= duration - 0.002) {
      this.pause(); video.currentTime = Math.min(duration, Number.isFinite(video.duration) ? video.duration : duration); return;
    }
    if (target > current + 0.002) {
      video.currentTime = target;
      return;
    }
    clearTimeout(this.boundary);
    const next = cuts.find(cut => cut.start > current + 0.012);
    if (next) this.boundary = setTimeout(() => this.check(), Math.max(8, (next.start-current-0.008)/Math.max(0.1,video.playbackRate)*1000));
  }
}
