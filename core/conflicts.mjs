import {hostname} from 'node:os';
import {unlink,utimes} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {dropboxHash} from './dropbox-transport.mjs';
import {validateLocalMapping} from './policy.mjs';
import {fullyLocal,ensureSpace} from './deletion-guard.mjs';

// Roadmap 1B: when local edits cannot be uploaded because Dropbox holds a different version
// (two artists edited the same file, both created the same name, or the file was deleted in
// Dropbox while edited here), the local version is uploaded next to it as
//   "name (конфлікт, PC-NAME, 2026-11-04 14-05).ext"
// and the original path goes back to the cloud version. Nothing is overwritten and both
// versions are visible to everyone.

// Windows and Dropbox safe: no ':' or other reserved characters; trimmed to keep names short.
export function computerName(value=hostname()){return String(value||'PC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').replace(/[. ]+$/,'').slice(0,32)||'PC';}
const stamp=time=>{const d=new Date(time),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;};
export function conflictCopyPath(relative,{computer=computerName(),time=Date.now(),attempt=1}={}){
  const slash=relative.lastIndexOf('/'),folder=slash>=0?relative.slice(0,slash+1):'',name=relative.slice(slash+1),dot=name.lastIndexOf('.');
  const stem=dot>0?name.slice(0,dot):name,extension=dot>0?name.slice(dot):'',suffix=` (конфлікт, ${computer}, ${stamp(time)}${attempt>1?' '+attempt:''})`;
  const result=folder+stem.slice(0,Math.max(1,255-suffix.length-extension.length))+suffix+extension;
  validateLocalMapping(result,'win32');return result;
}

// Which conflicts this computer can resolve on its own. `remote` is the current cloud entry at
// the item's path (undefined when the file was deleted in Dropbox), `state` the local inspection.
export function resolvable(item,state,remote){
  if(item.status!=='conflict'||item.kind!=='file')return false;
  if(item.conflictCopy?.stage==='uploaded')return true; // resume after a crash or a failed discard
  if(!state?.exists||state.directory)return false;
  if(!state.placeholder)return true;                   // a new local file where Dropbox already has one
  if(state.identity!==item.identity||state.inSync)return false; // not our file, or nothing edited
  return !remote||remote.rev!==item.rev;                // the cloud moved on (or deleted it): a real conflict
}

export async function resolveConflict(provider,ctx,item,{remote,state,computer=computerName(),now=Date.now()}){
  const root=ctx.acc.native.root,local=path.join(root,...item.path.split('/'));
  let current={...item};
  if(current.conflictCopy?.stage!=='uploaded'){
    // A partially downloaded edited placeholder is completed from its original revision first.
    if(state.placeholder&&(state.partial||state.onDisk<state.size)){
      await ctx.host.request('availability',{path:item.path,identity:item.identity,mode:'local'},86400000);
      state=await ctx.host.request('inspect',{path:item.path});
      if(state.partial||state.onDisk<state.size)return {resolved:false};
    }
    current={...current,conflictCopy:{path:current.conflictCopy?.path||conflictCopyPath(item.path,{computer,time:now}),stage:'uploading'}};
    provider.save(ctx,current); // Persist the intent before anything reaches Dropbox.
    await ensureSpace(ctx.cache,state.size);
    const file=path.join(ctx.cache,'conflict-'+randomUUID());
    try{
      const snapshot=await ctx.host.request('snapshot',{path:item.path,file});
      await utimes(file,new Date(snapshot.modified),new Date(snapshot.modified));
      const checksum=await dropboxHash(file);let uploaded;
      for(let attempt=1;!uploaded;attempt++){
        const target=attempt===1?current.conflictCopy.path:conflictCopyPath(item.path,{computer,time:now,attempt});
        try{uploaded={path:target,...await ctx.remote.upload(target,file,null)};}
        catch(error){
          if(!error.versionConflict||attempt>=20)throw error;
          // The name is taken. If it holds exactly our bytes (an earlier attempt that crashed), reuse it.
          const existing=await ctx.remote.metadata(target).catch(()=>null);
          if(existing?.kind==='file'&&existing.hash===checksum)uploaded={path:target,...existing};
        }
      }
      if(uploaded.hash&&uploaded.hash!==checksum)throw Object.assign(new Error('err.nativeConflict'),{nativePath:item.path});
      current={...current,conflictCopy:{path:uploaded.path,stage:'uploaded',remoteId:uploaded.remoteId,rev:uploaded.rev}};provider.save(ctx,current);
      provider.log(ctx,{...item,size:snapshot.size},'conflictCopy','upload','succeeded','',uploaded.path);
    }finally{await unlink(file).catch(()=>{});}
  }
  // The edits are in Dropbox now. Keep one more local copy, then clear the original path.
  state=await ctx.host.request('inspect',{path:item.path});
  if(state.exists){
    if(!state.placeholder||fullyLocal(state)||!state.inSync)await provider.quarantine(ctx,item);
    if(state.placeholder)await ctx.host.request('discard',{path:item.path,identity:item.identity});
    else await unlink(local);
  }
  // The cloud version (if any) and the conflict copy arrive as fresh placeholders on the next check.
  ctx.items.delete(item.key);provider.store.deleteNativeItem(ctx.acc.id,item.key);ctx.needsReconcile=true;
  return {resolved:true,copy:current.conflictCopy.path,remote:!!remote};
}
