import {createHash,randomUUID} from 'node:crypto';
import {contains} from './policy.mjs';
import {nativeFileStatus} from './native-availability.mjs';

export const itemIdentity=item=>item.key+'@'+createHash('sha256').update(item.rev||item.remoteId).digest('hex').slice(0,24);
const absent=error=>error.notFound||error.code==='ENOENT';
export const deleting=(ctx,relative)=>[...ctx.deletions.values()].some(op=>contains(op.path,relative));

export async function recoverPlaceholder(provider,ctx,relative,actual){
  const key=actual.identity?.split('@')[0];if(!/^[a-f0-9-]{36}$/.test(key||''))throw new Error('err.nativeConflict');
  let remote;try{remote=await ctx.remote.metadata(relative);}catch(error){if(!absent(error))throw error;}
  if(remote&&itemIdentity({...remote,key})!==actual.identity)throw new Error('err.nativeConflict');
  const item={...remote,key,path:relative,identity:actual.identity,kind:actual.directory?'folder':'file',size:actual.size,remoteId:remote?.remoteId||null,status:remote?(actual.directory?'cached':nativeFileStatus(actual)):'orphaned'};
  provider.save(ctx,item);provider.log(ctx,item,'recover','none',remote?'succeeded':'failed',remote?'':'err.nativeOrphan');return item;
}

export async function prepareDeletion(provider,ctx,event){
  const relative=event.path.replaceAll('\\','/');
  if(event.event==='delete'&&(event.flags&2)){for(const op of ctx.deletions.values())if(op.path===relative){ctx.deletions.delete(op.id);provider.store.deleteNativeDeletion(ctx.acc.id,op.id);}return;}
  let current=[...ctx.items.values()].find(i=>i.path===relative&&i.identity===event.identity);
  const actual=await ctx.host.request('inspect',{path:relative});
  if(!actual.exists||!actual.placeholder||actual.identity!==event.identity)throw new Error('err.nativeConflict');
  if(!current)current=await recoverPlaceholder(provider,ctx,relative,actual);
  const items=[...ctx.items.values()].filter(i=>contains(current.path,i.path));
  for(const item of items){const state=await ctx.host.request('inspect',{path:item.path});if(!state.exists&&deleting(ctx,item.path))continue;const renameOnly=item.status==='pendingRename'&&!state.dirtyBytes&&(item.kind==='folder'||(state.size===item.size&&Math.abs(state.modified-item.modified)<=1000));if(item.status==='conflict'||!state.exists||state.identity!==item.identity||(!state.inSync&&!renameOnly)||state.dirtyBytes)throw new Error('err.nativeConflict');
    if(!item.remoteId){try{await ctx.remote.metadata(item.path);throw new Error('err.nativeConflict');}catch(error){if(!absent(error))throw error;}if(state.partial)throw new Error('err.nativeOrphan');}}
  if(deleting(ctx,relative))return;
  const op={id:randomUUID(),path:current.path,action:event.event==='recycle'?'recycle':'delete',items,preparedAt:Date.now()};
  provider.store.saveNativeDeletion(ctx.acc.id,op);ctx.deletions.set(op.id,op);
}

export async function finishDeletions(provider,ctx,{recover=false}={}){
  for(const op of [...ctx.deletions.values()].sort((a,b)=>b.path.length-a.path.length)){
    if(op.action==='delete'&&Date.now()-op.preparedAt<3000)continue;
    const source=await ctx.host.request('inspect',{path:op.path});
    if(source.exists&&source.identity===op.items.find(i=>i.path===op.path)?.identity){if(recover){provider.store.deleteNativeDeletion(ctx.acc.id,op.id);ctx.deletions.delete(op.id);}continue;}
    const current=op.items.find(i=>i.path===op.path);
    try{if(current.remoteId){if(current.kind==='folder'){
      const root=await ctx.remote.metadata(current.path);if(root.remoteId!==current.remoteId)throw new Error('err.nativeConflict');
      const remote=await ctx.remote.list(current.path),expected=new Map(op.items.filter(i=>i.path!==current.path).map(i=>[i.remoteId,{rev:i.rev,path:i.path}]));
      if(remote.some(i=>!expected.has(i.remoteId)||expected.get(i.remoteId).rev!==i.rev||expected.get(i.remoteId).path!==i.path))throw new Error('err.nativeConflict');
    }await ctx.remote.remove(current);}}catch(error){if(!absent(error)){error.nativePath=op.path;error.nativeCommand='delete';throw error;}}
    provider.store.finishNativeDeletion(ctx.acc.id,op);for(const item of op.items)ctx.items.delete(item.key);ctx.deletions.delete(op.id);ctx.needsReconcile=true;
  }
}
