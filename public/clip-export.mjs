import { planExport } from './export-plan.mjs';

export function clipExports(cuts,duration,mode='edited') {
  const prefix=mode==='removed'?'removed':'clip';
  return planExport(cuts,duration,mode).map((segment,i)=>({
    // Export this exact source interval using the existing removed-interval API.
    mode:'removed',cuts:[segment],filename:`${prefix}-${String(i+1).padStart(3,'0')}.mp4`
  }));
}

const crcTable=Uint32Array.from({length:256},(_,n)=>{
  for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;
  return n>>>0;
});
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
function header(length){const bytes=new Uint8Array(length);return {bytes,view:new DataView(bytes.buffer)};}
// MP4 is already compressed. Store it directly in a ZIP, avoiding recompression
// and the mobile browser's multiple-download permission prompts.
export async function clipsZip(files) {
  if(!files.length)throw new Error('There are no clips to export.');
  if(files.length>65535)throw new Error('Too many clips for one ZIP.');
  const parts=[],directory=[];let offset=0,directorySize=0;
  for(const {filename,blob} of files) {
    const name=new TextEncoder().encode(filename),data=new Uint8Array(await blob.arrayBuffer()),crc=crc32(data);
    if(name.length>65535||offset+30+name.length+data.length>0xffffffff)throw new Error('The clips are too large for one ZIP. Export a shorter selection.');
    const local=header(30),central=header(46);
    local.view.setUint32(0,0x04034b50,true);local.view.setUint16(4,20,true);local.view.setUint16(6,0x800,true);
    local.view.setUint16(12,0x21,true);local.view.setUint32(14,crc,true);
    local.view.setUint32(18,data.length,true);local.view.setUint32(22,data.length,true);local.view.setUint16(26,name.length,true);
    central.view.setUint32(0,0x02014b50,true);central.view.setUint16(4,20,true);central.view.setUint16(6,20,true);central.view.setUint16(8,0x800,true);
    central.view.setUint16(14,0x21,true);central.view.setUint32(16,crc,true);central.view.setUint32(20,data.length,true);central.view.setUint32(24,data.length,true);
    central.view.setUint16(28,name.length,true);central.view.setUint32(42,offset,true);
    parts.push(local.bytes,name,blob);directory.push(central.bytes,name);
    offset+=30+name.length+data.length;directorySize+=46+name.length;
  }
  if(offset+directorySize+22>0xffffffff)throw new Error('The clips are too large for one ZIP. Export a shorter selection.');
  const end=header(22);end.view.setUint32(0,0x06054b50,true);end.view.setUint16(8,files.length,true);end.view.setUint16(10,files.length,true);
  end.view.setUint32(12,directorySize,true);end.view.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end.bytes],{type:'application/zip'});
}
