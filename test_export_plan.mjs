import test from 'node:test';
import assert from 'node:assert/strict';
import { planExport, exportGraph } from './public/export-plan.mjs';

test('browser exports merge and clamp cuts before selecting kept or removed intervals',()=>{
  const cuts=[{start:2,end:4},{start:1,end:3},{start:8,end:12}];
  assert.deepEqual(planExport(cuts,10,'removed'),[{start:1,end:4},{start:8,end:10}]);
  assert.deepEqual(planExport(cuts,10),[{start:0,end:1},{start:4,end:8}]);
});
test('browser exports handle no cuts, all cuts and invalid modes',()=>{
  assert.deepEqual(planExport([],5),[{start:0,end:5}]);
  assert.deepEqual(planExport([],5,'removed'),[]);
  assert.deepEqual(planExport([{start:0,end:5}],5),[]);
  assert.throws(()=>planExport([],5,'invalid'));
});
test('browser filter graph handles sources with and without audio',()=>{
  const parts=[{start:0,end:1},{start:2,end:3}];
  const graph=exportGraph(parts,true);
  assert.match(graph,/asplit=2/);assert.match(graph,/concat=n=2:v=1:a=1/);
  assert.doesNotMatch(exportGraph(parts,false),/atrim|asplit|aout/);
});
