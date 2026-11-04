import {copyFile,mkdir,readdir,rm,lstat,statfs,constants} from 'node:fs/promises';
import path from 'node:path';

// Roadmap 1B/1V decisions (2026-11-04):
//  - one synchronization cycle may delete at most T items without asking:
//    T = max(20, min(50, 10% of the account catalog));
//  - the threshold applies both to deletions arriving from Dropbox and to
//    folders deleted in Explorer; each computer's user decides on their own;
//  - a fully downloaded file is always copied to a local quarantine before its
//    placeholder is removed, and the quarantine keeps it for 30 days.
export const QUARANTINE_DAYS=30;
export function massDeletionThreshold(catalogSize){return Math.max(20,Math.min(50,Math.ceil(0.1*Math.max(0,catalogSize||0))));}
export const exceedsThreshold=(count,catalogSize)=>count>=massDeletionThreshold(catalogSize);

// Roadmap 4.9: an upload first copies the file into the profile's cache. Refuse early, with a
// clear message, when that disk cannot hold the copy plus a 256 MB margin.
export const SPACE_MARGIN=256*1024*1024;
export async function ensureSpace(directory,bytes,{probe=statfs}={}){
  let info;try{info=await probe(directory);}catch{return;} // Unknown free space: let the copy itself decide.
  const free=Number(info.bavail)*Number(info.bsize);
  if(Number.isFinite(free)&&free<Number(bytes||0)+SPACE_MARGIN)throw Object.assign(new Error('err.diskFull'),{nativeStage:String(Math.max(0,Math.floor(free/1048576)))+' MB'});
}
// A placeholder whose bytes are all on this disk: removing it would lose the only local copy.
export const fullyLocal=state=>!!state?.exists&&!state.directory&&!!state.placeholder&&!state.partial&&Number(state.onDisk)>=Number(state.size);

const day=now=>new Date(now).toISOString().slice(0,10);
export const quarantineRoot=(dataDir,accountId)=>{if(!/^[a-zA-Z0-9_-]+$/.test(accountId))throw new Error('err.account');return path.join(dataDir,'quarantine',accountId);};

// Copies <root>/<relative> to <dataDir>/quarantine/<account>/<YYYY-MM-DD>/<relative>.
// Never overwrites: a second copy of the same path on the same day gets " (2)", " (3)"...
export async function quarantineFile({dataDir,accountId,root,relative,now=Date.now()}){
  const parts=relative.split('/');if(!relative||parts.some(p=>!p||p==='.'||p==='..'))throw new Error('err.path');
  const source=path.join(root,...parts),folder=path.join(quarantineRoot(dataDir,accountId),day(now),...parts.slice(0,-1));
  await mkdir(folder,{recursive:true});
  const name=parts.at(-1),dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,extension=dot>0?name.slice(dot):'';
  for(let n=1;n<1000;n++){
    const target=path.join(folder,n===1?name:`${stem} (${n})${extension}`);
    try{await copyFile(source,target,constants.COPYFILE_EXCL);return target;}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  throw new Error('err.quarantine');
}

// Removes dated quarantine folders older than QUARANTINE_DAYS. Touches nothing else.
export async function pruneQuarantine({dataDir,accountId,now=Date.now(),days=QUARANTINE_DAYS}){
  const base=quarantineRoot(dataDir,accountId),cutoff=day(now-days*86400000),removed=[];
  const entries=await readdir(base,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  for(const entry of entries){
    if(!entry.isDirectory()||!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)||entry.name>=cutoff)continue;
    const target=path.join(base,entry.name);if((await lstat(target)).isSymbolicLink())continue;
    await rm(target,{recursive:true,force:true});removed.push(entry.name);
  }
  return removed;
}

// Summary shown to the user for a pending decision.
export function reviewSummary(items,sampleSize=5){
  const files=items.filter(i=>i.kind==='file');
  return {count:items.length,files:files.length,downloaded:files.filter(i=>i.downloaded).length,bytes:files.reduce((sum,i)=>sum+(Number(i.size)||0),0),sample:[...items].sort((a,b)=>a.path.split('/').length-b.path.split('/').length||a.path.localeCompare(b.path)).slice(0,sampleSize).map(i=>i.path)};
}
