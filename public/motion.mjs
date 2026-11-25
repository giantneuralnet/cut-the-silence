// Compare colors at fixed pixel positions. No tracking, displacement, or speed.
export const WIDTH=640, HEIGHT=360, STEP=.2, VERSION=4;
export const TILE=16, STRIDE=8, COLS=(WIDTH-TILE)/STRIDE+1, ROWS=(HEIGHT-TILE)/STRIDE+1;
export const NOISE=3, DEFAULT_THRESHOLD=2.5;
export function prepareFrame(data,channels=3) {
  if(!data)return null;
  const out=new Uint8Array(WIDTH*HEIGHT*4);
  // Mild symmetric blur suppresses compression/sensor noise without discarding
  // the small gripper edges. RGB is retained, including equal-luminance changes.
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++) {
    const left=Math.max(0,x-1),right=Math.min(WIDTH-1,x+1),up=Math.max(0,y-1),down=Math.min(HEIGHT-1,y+1),p=(y*WIDTH+x)*4;
    for(let c=0;c<3;c++)out[p+c]=Math.round((4*data[(y*WIDTH+x)*channels+c]+2*(data[(y*WIDTH+left)*channels+c]+data[(y*WIDTH+right)*channels+c]+data[(up*WIDTH+x)*channels+c]+data[(down*WIDTH+x)*channels+c])+data[(up*WIDTH+left)*channels+c]+data[(up*WIDTH+right)*channels+c]+data[(down*WIDTH+left)*channels+c]+data[(down*WIDTH+right)*channels+c])/16);
    out[p+3]=255;
  }
  return out;
}
export function exposureOffset(a,b) {
  // Robust global brightness offset: a uniform exposure shift should
  // not keep an otherwise stationary shot. Local changes remain measurable.
  const hist=[new Uint16Array(511),new Uint16Array(511),new Uint16Array(511)];let count=0;
  for(let y=8;y<HEIGHT;y+=32)for(let x=8;x<WIDTH;x+=32){const p=(y*WIDTH+x)*4;for(let c=0;c<3;c++)hist[c][b[p+c]-a[p+c]+255]++;count++;}
  const shifts=hist.map(h=>{let total=0;for(let i=0;i<h.length;i++){total+=h[i];if(total>count/2)return i-255;}return 0;}).sort((a,b)=>a-b);
  return [shifts[1],shifts[1],shifts[1]];
}
export function differenceCPU(a,b,offset=exposureOffset(a,b)) {
  const differences=new Float32Array(WIDTH*HEIGHT),scores=new Float32Array(COLS*ROWS);
  for(let i=0;i<differences.length;i++){
    const p=i*4;
    differences[i]=Math.max(0,Math.abs(b[p]-a[p]-offset[0])-NOISE,Math.abs(b[p+1]-a[p+1]-offset[1])-NOISE,Math.abs(b[p+2]-a[p+2]-offset[2])-NOISE);
  }
  // Summed-area table makes overlapping tile sums inexpensive on the CPU.
  const integral=new Float64Array((WIDTH+1)*(HEIGHT+1)),pitch=WIDTH+1;
  for(let y=0;y<HEIGHT;y++){let row=0;for(let x=0;x<WIDTH;x++){row+=differences[y*WIDTH+x];integral[(y+1)*pitch+x+1]=integral[y*pitch+x+1]+row;}}
  for(let gy=0;gy<ROWS;gy++)for(let gx=0;gx<COLS;gx++){
    const x=gx*STRIDE,y=gy*STRIDE;
    scores[gy*COLS+gx]=(integral[(y+TILE)*pitch+x+TILE]-integral[y*pitch+x+TILE]-integral[(y+TILE)*pitch+x]+integral[y*pitch+x])*100/(TILE*TILE*255);
  }
  return scores;
}
export class MotionAnalyzer {
  constructor(compare=differenceCPU){this.compare=compare;this.frames=[];this.scores=[];this.processing='cpu';}
  add(data,channels=3) {
    const current=prepareFrame(data,channels),index=this.frames.length;
    this.frames.push(current);
    if(index) {
      let score=0;
      if(!current||!this.frames[index-1])score=100;
      else for(const lag of [1,3,5]) {
        const reference=this.frames[index-lag];if(!reference)continue;
        const tiles=this.compare(reference,current,exposureOffset(reference,current));
        for(const value of tiles)score=Math.max(score,value);
      }
      // Each score belongs to the interval immediately before this frame.
      // Do not smear a single match backward across a confirmation window.
      this.scores.push(Math.round(score*1000)/1000);
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
