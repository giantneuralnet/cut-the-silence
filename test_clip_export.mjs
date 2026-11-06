import test from 'node:test';
import assert from 'node:assert/strict';
import { clipExports,clipsZip } from './public/clip-export.mjs';
test('separate kept exports preserve each whole source interval and never concatenate them',()=>{
  assert.deepEqual(clipExports([{start:1,end:2},{start:3,end:4}],5),[
    {mode:'removed',cuts:[{start:0,end:1}],filename:'clip-001.mp4'},
    {mode:'removed',cuts:[{start:2,end:3}],filename:'clip-002.mp4'},
    {mode:'removed',cuts:[{start:4,end:5}],filename:'clip-003.mp4'}
  ]);
  assert.deepEqual(clipExports([],5).map(x=>x.cuts),[[{start:0,end:5}]]);
  assert.deepEqual(clipExports([{start:0,end:5}],5),[]);
});
test('removed clip exports merge overlaps and use distinct numbered filenames',()=>{
  assert.deepEqual(clipExports([{start:1,end:3},{start:2,end:4},{start:5,end:6}],8,'removed'),[
    {mode:'removed',cuts:[{start:1,end:4}],filename:'removed-001.mp4'},
    {mode:'removed',cuts:[{start:5,end:6}],filename:'removed-002.mp4'}
  ]);
});
test('ZIP stores each file separately with valid CRC, filenames and directory offsets',async()=>{
  const zip=await clipsZip([{filename:'clip-001.mp4',blob:new Blob(['123456789'])},{filename:'clip-002.mp4',blob:new Blob(['second clip'])}]);
  const bytes=new Uint8Array(await zip.arrayBuffer()),view=new DataView(bytes.buffer),decode=new TextDecoder();
  assert.equal(zip.type,'application/zip');
  assert.equal(view.getUint32(0,true),0x04034b50);
  assert.equal(view.getUint32(14,true),0xcbf43926); // Standard CRC-32 test vector.
  const end=bytes.length-22;assert.equal(view.getUint32(end,true),0x06054b50);
  assert.equal(view.getUint16(end+10,true),2);
  let central=view.getUint32(end+16,true);
  for(const [filename,contents] of [['clip-001.mp4','123456789'],['clip-002.mp4','second clip']]) {
    assert.equal(view.getUint32(central,true),0x02014b50);
    const length=view.getUint16(central+28,true),offset=view.getUint32(central+42,true);
    assert.equal(decode.decode(bytes.slice(central+46,central+46+length)),filename);
    const start=offset+30+length,size=view.getUint32(offset+18,true);
    assert.equal(decode.decode(bytes.slice(start,start+size)),contents);
    assert.equal(view.getUint32(central+16,true),view.getUint32(offset+14,true));
    central+=46+length;
  }
  assert.equal(central,end);
  await assert.rejects(clipsZip([]),/no clips/);
});
