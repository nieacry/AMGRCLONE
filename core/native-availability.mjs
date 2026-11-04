import {validateRemotePath} from './policy.mjs';

export const nativeFileStatus=actual=>!actual.inSync?'dirty':actual.partial?'online':actual.pin===1?'pinned':'cached';

export function validateAvailabilityPaths(paths){
  if(!Array.isArray(paths)||paths.length>1000||paths.some(p=>typeof p!=='string'||p.length>32767))throw new Error('err.settings');
  for(const relative of paths)validateRemotePath(relative);
  return [...new Set(paths)];
}

// Folder availability describes its selected local subtree, never the desired rule.
export function nativeAvailabilityStates(items,paths,transfers=[]){
  const requested=new Set(paths),known=new Map(),groups=new Map(),moving=new Set(transfers);
  for(const item of items){
    if(requested.has(item.path))known.set(item.path,item);
    if(item.kind!=='file'&&!['conflict','orphaned','dirty','creating','pendingRename'].includes(item.status))continue;
    const status=moving.has(item.path)?'syncing':item.status;
    let parent=item.path;
    while(parent.includes('/')){parent=parent.slice(0,parent.lastIndexOf('/'));if(requested.has(parent)){if(!groups.has(parent))groups.set(parent,new Set());groups.get(parent).add(status);}}
    if(requested.has('')&&item.path){if(!groups.has(''))groups.set('',new Set());groups.get('').add(status);}
  }
  return Object.fromEntries(paths.map(relative=>{
    const item=known.get(relative);if(!item)return [relative,'unknown'];
    if(moving.has(relative))return [relative,'syncing'];
    if(item.kind==='file'||['conflict','orphaned','dirty','creating','pendingRename'].includes(item.status))return [relative,item.status];
    const states=groups.get(relative)||new Set();
    for(const status of ['conflict','orphaned','dirty','pendingRename','syncing','creating','unknown'])if(states.has(status))return [relative,status];
    if(!states.size)return [relative,'empty'];
    if(states.size===1&&states.has('online'))return [relative,'online'];
    if(states.size===1&&states.has('pinned'))return [relative,'pinned'];
    if([...states].every(s=>s==='pinned'||s==='cached'))return [relative,'cached'];
    return [relative,'mixed'];
  }));
}
