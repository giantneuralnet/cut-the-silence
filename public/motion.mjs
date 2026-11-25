// Local displacement from zero-mean normalized cross correlation (ZNCC).
// Both the CPU and WebGL implementations use these dimensions and acceptance rules.
export const WIDTH=320, HEIGHT=180, STEP=.2, VERSION=2;
export const STRIDE=8, BORDER=8, COLS=38, ROWS=21, RADIUS=3;
export function grayscale(data,channels=3) {
  if(!data)return null;
  const gray=new Float32Array(WIDTH*HEIGHT);
  for(let i=0;i<gray.length;i++)gray[i]=(data[i*channels]*.299+data[i*channels+1]*.587+data[i*channels+2]*.114)/255;
  // A small symmetric low-pass suppresses sensor/compression noise, without
  // reducing the image to the old detector's 64x36 pixels.
  const out=new Float32Array(gray.length);
  for(let y=1;y<HEIGHT-1;y++)for(let x=1;x<WIDTH-1;x++) {
    const i=y*WIDTH+x;
    out[i]=(gray[i]*4+(gray[i-1]+gray[i+1]+gray[i-WIDTH]+gray[i+WIDTH])*2+gray[i-WIDTH-1]+gray[i-WIDTH+1]+gray[i+WIDTH-1]+gray[i+WIDTH+1])/16;
  }
  return out;
}
export function soften(gray) {
  const tmp=new Float32Array(gray.length),out=new Float32Array(gray.length),weights=[1,4,6,4,1];
  for(let y=0;y<HEIGHT;y++)for(let x=2;x<WIDTH-2;x++)for(let i=-2;i<=2;i++)tmp[y*WIDTH+x]+=gray[y*WIDTH+x+i]*weights[i+2]/16;
  for(let y=2;y<HEIGHT-2;y++)for(let x=2;x<WIDTH-2;x++)for(let i=-2;i<=2;i++)out[y*WIDTH+x]+=tmp[(y+i)*WIDTH+x]*weights[i+2]/16;
  return out;
}
function correlation(a,b,x,y,dx,dy) {
  let sa=0,sb=0,aa=0,bb=0,ab=0;
  for(let j=-3;j<=3;j++)for(let i=-3;i<=3;i++) {
    const p=a[(y+j)*WIDTH+x+i],q=b[(y+j+dy)*WIDTH+x+i+dx];
    sa+=p;sb+=q;aa+=p*p;bb+=q*q;ab+=p*q;
  }
  const va=aa-sa*sa/49,vb=bb-sb*sb/49;
  if(va<.0049||vb<.0049)return -1; // Flat patches cannot establish motion.
  return (ab-sa*sb/49)/Math.sqrt(va*vb);
}
export function trackCPU(a,b) {
  const result=new Float32Array(COLS*ROWS*4),softA=soften(a),softB=soften(b);
  for(let gy=0;gy<ROWS;gy++)for(let gx=0;gx<COLS;gx++) {
    const x=BORDER+gx*STRIDE,y=BORDER+gy*STRIDE,k=(gy*COLS+gx)*4;
    let zero=correlation(a,b,x,y,0,0);
    if(zero<.975)zero=Math.max(zero,correlation(softA,b,x,y,0,0),correlation(a,softB,x,y,0,0));
    let best=zero,dx=0,dy=0;
    if(zero<.975)for(let j=-RADIUS;j<=RADIUS;j++)for(let i=-RADIUS;i<=RADIUS;i++) {
      const score=correlation(a,b,x,y,i,j);
      if(score>best+1e-6){best=score;dx=i;dy=j;}
    }
    result[k]=dx;result[k+1]=dy;result[k+2]=best;result[k+3]=zero;
  }
  return result;
}
export function flowScore(flow,seconds) {
  let score=0,textured=0,lost=0;
  const valid=k=>flow[k+3]>-1&&flow[k+2]>.85&&flow[k+2]-flow[k+3]>.025;
  for(let gy=0;gy<ROWS;gy++)for(let gx=0;gx<COLS;gx++) {
    const k=(gy*COLS+gx)*4;
    if(flow[k+3]>-1){textured++;if(flow[k+2]<.5)lost++;}
    if(!valid(k))continue;
    const dx=flow[k],dy=flow[k+1],length=Math.hypot(dx,dy);
    if(!length)continue;
    // Require neighboring evidence with a compatible direction. A single
    // unstable patch (noise, focus breathing, ambiguous texture) is insufficient.
    for(let j=Math.max(0,gy-2);j<=Math.min(ROWS-1,gy+2);j++)for(let i=Math.max(0,gx-2);i<=Math.min(COLS-1,gx+2);i++) {
      const n=(j*COLS+i)*4;
      if(n===k||!valid(n))continue;
      const other=Math.hypot(flow[n],flow[n+1]);
      if(other&&dx*flow[n]+dy*flow[n+1]>.75*length*other&&Math.abs(length-other)<=1.5)
        score=Math.max(score,Math.min(length,other)/seconds);
    }
  }
  // A scene change or widespread untrackable motion must not become a cut.
  if(textured>20&&lost/textured>.6)return 100;
  return Math.round(score*1000)/1000;
}
export class MotionAnalyzer {
  constructor(track=trackCPU){this.track=track;this.frames=[];this.scores=[];this.processing='cpu';}
  add(data,channels=3) {
    const current=grayscale(data,channels),index=this.frames.length;
    this.frames.push(current);
    if(index) {
      const previous=this.frames[index-1];
      let score=current&&previous?flowScore(this.track(previous,current),STEP):100;
      if(index>=5&&current&&this.frames[index-5]) {
        const longScore=flowScore(this.track(this.frames[index-5],current),1);
        // Only extend reliable small motion across the longer baseline. Fast
        // motion/scene changes use the short comparison to avoid long tails.
        if(longScore>0&&longScore<4)for(let i=index-5;i<index-1;i++)this.scores[i]=Math.max(this.scores[i],longScore);
        if(longScore<4)score=Math.max(score,longScore);
      }
      this.scores.push(score);
    }
    if(index>=5)this.frames[index-5]=null;
  }
  finish(duration) {
    const count=Math.ceil(duration/STEP),scores=this.scores.slice();
    scores.push(scores.at(-1)??100);
    while(scores.length<count)scores.push(100);
    return {stillnessScores:scores.slice(0,count),stillnessStep:STEP,stillnessVersion:VERSION,stillnessProcessing:this.processing};
  }
  dispose(){}
}
