// Streaming bridge: FFmpeg RGB24 on stdin, compact progress/results on stdout.
import {MotionAnalyzer,WIDTH,HEIGHT,STEP} from './public/motion.mjs';
const detector=new MotionAnalyzer(),size=WIDTH*HEIGHT*3;
let pending=Buffer.alloc(0),count=0;
for await(const chunk of process.stdin) {
  pending=Buffer.concat([pending,chunk]);
  let offset=0;
  while(offset+size<=pending.length){detector.add(pending.subarray(offset,offset+size));offset+=size;count++;if(count%5===0)process.stdout.write(JSON.stringify({progress:count*STEP})+'\n');}
  pending=Buffer.from(pending.subarray(offset));
}
if(!count||pending.length)throw new Error('Incomplete video frames.');
process.stdout.write(JSON.stringify(detector.finish(Number(process.argv[2])))+'\n');
