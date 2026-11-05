import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberEdit, undoEdit, redoEdit, clearManualEdits } from './public/edit-history.mjs';

const create=()=>({overrides:[{start:2,end:3,cut:false}],edgeEdits:[{id:'edge',startOffset:0.1,endOffset:0}],history:[],future:[],padding:0.2,threshold:-35});
test('clearing manual edits is reversible and leaves automatic settings alone',()=>{
  const state=create(),before=structuredClone(state);
  assert.equal(clearManualEdits(state),true);
  assert.deepEqual(state.overrides,[]);assert.deepEqual(state.edgeEdits,[]);
  assert.equal(state.padding,0.2);assert.equal(state.threshold,-35);
  assert.equal(undoEdit(state),true);
  assert.deepEqual(state.overrides,before.overrides);assert.deepEqual(state.edgeEdits,before.edgeEdits);
  assert.equal(redoEdit(state),true);assert.deepEqual(state.overrides,[]);assert.deepEqual(state.edgeEdits,[]);
});
test('undo and redo preserve independent snapshots for cut toggles and edge drags',()=>{
  const state=create();rememberEdit(state);state.overrides[0].cut=true;
  rememberEdit(state);state.edgeEdits[0].startOffset=0.3;
  undoEdit(state);assert.equal(state.edgeEdits[0].startOffset,0.1);assert.equal(state.overrides[0].cut,true);
  undoEdit(state);assert.equal(state.overrides[0].cut,false);
  redoEdit(state);assert.equal(state.overrides[0].cut,true);assert.equal(state.edgeEdits[0].startOffset,0.1);
  redoEdit(state);assert.equal(state.edgeEdits[0].startOffset,0.3);
});
test('a new edit after undo discards the obsolete redo branch',()=>{
  const state=create();rememberEdit(state);state.overrides=[];undoEdit(state);
  assert.equal(state.future.length,1);rememberEdit(state);state.overrides[0].end=4;
  assert.equal(redoEdit(state),false);assert.equal(state.overrides[0].end,4);
});
test('persisted edge edits can be undone and redone even without older history',()=>{
  const state=create();undoEdit(state);assert.deepEqual(state.edgeEdits,[]);
  redoEdit(state);assert.equal(state.edgeEdits[0].id,'edge');
});
test('clearing an empty edit layer creates no history entry',()=>{
  const state=create();state.overrides=[];state.edgeEdits=[];
  assert.equal(clearManualEdits(state),false);assert.equal(state.history.length,0);
});
