import test from 'node:test';
import assert from 'node:assert/strict';
import {videoProfile,softwareVideoOptions} from './public/video-profile.mjs';
test('HEVC and H.264 profiles retain original codec and positive source bitrate',()=>{
  assert.deepEqual(videoProfile('hevc',28632195),{codec:'hevc',bitrate:28632195});
  assert.deepEqual(videoProfile('h264','12000000'),{codec:'avc',bitrate:12000000});
  const args=softwareVideoOptions(videoProfile('hevc',28632195));
  assert.equal(args[args.indexOf('-c:v')+1],'libx265');
  assert.equal(args[args.indexOf('-b:v')+1],'28632195');
  assert.equal(args[args.indexOf('-tag:v')+1],'hvc1');
  assert.ok(!args.includes('-crf'));
});
test('missing bitrates use a quality default without inventing a source bitrate',()=>{
  for(const value of [null,undefined,'N/A',0,-1,Infinity])assert.equal(videoProfile('hevc',value).bitrate,null);
  assert.ok(softwareVideoOptions(videoProfile('h264',null)).includes('-crf'));
});
test('unsupported codecs are rejected rather than silently converted to H.264',()=>{
  assert.throws(()=>videoProfile('prores',100000000),/not supported/);
});
