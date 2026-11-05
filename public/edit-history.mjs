const snapshot=state=>structuredClone({overrides:state.overrides,edgeEdits:state.edgeEdits});
const apply=(state,edits)=>{state.overrides=structuredClone(edits.overrides);state.edgeEdits=structuredClone(edits.edgeEdits);};
export function rememberEdit(state) {
  state.history.push(snapshot(state));
  if(state.history.length>40)state.history.shift();
  state.future=[];
}
export function undoEdit(state) {
  if(!state.history.length&&!state.edgeEdits.length)return false;
  state.future.push(snapshot(state));
  if(state.history.length)apply(state,state.history.pop());
  else state.edgeEdits.pop();
  return true;
}
export function redoEdit(state) {
  if(!state.future.length)return false;
  state.history.push(snapshot(state));
  apply(state,state.future.pop());
  return true;
}
export function clearManualEdits(state) {
  if(!state.overrides.length&&!state.edgeEdits.length)return false;
  rememberEdit(state);state.overrides=[];state.edgeEdits=[];
  return true;
}
