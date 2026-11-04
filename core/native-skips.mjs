const canonical=value=>value.normalize('NFC').toLowerCase();
export const skippableMapping=error=>error.message==='err.mapping'&&['err.mappingCharacters','err.mappingEnding','err.mappingReserved','err.mappingLength'].includes(error.nativeStage);

// Keep skipped cloud paths AND their previously tracked local names protected.
// A cloud rename to an unsupported name must never look like a deletion locally.
export function mappingBlocks(skips,items){
  const paths=new Set(),ancestors=new Set(),ids=new Set([...skips.values()].map(entry=>entry.item.remoteId).filter(Boolean));
  for(const entry of skips.values())paths.add(canonical(entry.item.path));
  for(const item of items)if(ids.has(item.remoteId))paths.add(canonical(item.path));
  for(const relative of paths){const parts=relative.split('/');while(parts.length){ancestors.add(parts.join('/'));parts.pop();}ancestors.add('');}
  return {paths,ancestors};
}
export function blockedPath(ctx,relative){
  if(!ctx.mappingBlocks?.paths.size)return false;
  const parts=canonical(relative).split('/');while(parts.length){if(ctx.mappingBlocks.paths.has(parts.join('/')))return true;parts.pop();}return false;
}
export const containsSkipped=(ctx,relative)=>blockedPath(ctx,relative)||!!(ctx.mappingBlocks?.ancestors.size&&ctx.mappingBlocks.ancestors.has(canonical(relative)));
export function assertNoSkippedDeletion(ctx,relative){if(containsSkipped(ctx,relative))throw Object.assign(new Error('err.nativeSkippedDelete'),{nativePath:relative});}
