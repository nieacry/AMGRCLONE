import {lstat,readFile,unlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {safeDirectory} from './sync-engine.mjs';

// Only retire markers whose exact identity is recorded in this installation's DB.
export async function cleanLegacyMarkers(acc,store,remote){
  if(!acc.native?.enabled)throw new Error('err.nativeRequired');
  const jobs=store.jobs(acc.id);
  store.retireJobs(acc.id); // Durable before any remote deletion; old bisync cannot restart.
  for(const job of jobs){
    if(!/^\.amg-access-[a-f0-9]{24}$/.test(job.marker)||job.marker!=='.amg-access-'+job.id)continue;
    const receipt=store.markerReceipt(acc.id,job.id)||{cloud:'pending',local:'pending'};
    receipt.attempted=Date.now();receipt.error=null;
    const save=()=>store.saveMarkerReceipt(acc.id,job.id,receipt);
    save();
    if(!['deleted','missing'].includes(receipt.cloud)){
      try{
        const relative=job.remote_path+'/'+job.marker;
        let item;
        try{item={path:relative,...await remote.metadata(relative)};}catch(error){if(error.code==='ENOENT'||error.notFound)receipt.cloud='missing';else throw error;}
        if(item){
          if(item.kind!=='file'||item.size!==Buffer.byteLength(job.marker))receipt.cloud='changed';
          else{
            let bytes=Buffer.alloc(0);const controller=new AbortController();
            try{for await(const chunk of await remote.download(item,{offset:0,length:item.size,signal:controller.signal})){bytes=Buffer.concat([bytes,Buffer.from(chunk)]);if(bytes.length>item.size)throw new Error('err.marker');}}finally{controller.abort();}
            if(bytes.toString('utf8')!==job.marker)receipt.cloud='changed';
            else{receipt.remoteId=item.remoteId;receipt.rev=item.rev;receipt.content=job.marker;save();await remote.remove(item);receipt.cloud='deleted';}
          }
        }
      }catch(error){receipt.cloud='error';receipt.error=error.message?.startsWith('err.')?error.message:'err.operation';}
      save();
    }
    if(!['deleted','missing'].includes(receipt.local)){
      try{
        const expected=path.join(acc.settings.localRoot,...job.remote_path.split('/'));
        if(path.resolve(expected)!==path.resolve(job.local_path))throw new Error('err.link');
        let directory;
        try{directory=await realpath(job.local_path);}catch(error){if(error.code==='ENOENT')receipt.local='missing';else throw error;}
        if(directory){
          await safeDirectory(acc.settings.localRoot,job.remote_path);
          const filename=path.join(directory,job.marker),info=await lstat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
          if(!info)receipt.local='missing';
          else if(!info.isFile()||info.isSymbolicLink()||info.size!==Buffer.byteLength(job.marker)||(await readFile(filename,'utf8'))!==job.marker)receipt.local='changed';
          else{receipt.content=job.marker;save();await unlink(filename);receipt.local='deleted';}
        }
      }catch(error){receipt.local='error';receipt.error=error.message?.startsWith('err.')?error.message:'err.operation';}
      save();
    }
  }
  return markerSummary(store.markerReceipts(acc.id));
}
export function markerSummary(receipts){return {total:receipts.length,removed:receipts.filter(r=>r.cloud==='deleted').length,pending:receipts.filter(r=>!['deleted','missing'].includes(r.cloud)||!['deleted','missing'].includes(r.local)).length};}
