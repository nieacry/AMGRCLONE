import {lstat,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function missingRoot(root){
  try{await lstat(root);return false;}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return true;throw error;}
}

// Keep enough non-secret metadata and cached bytes to recover a manually moved/deleted root.
// Never touch an unknown registration or create an empty replacement sync tree.
export async function archiveMissingRoot({dataDir,account,items,jobs}){
  if(!account.native?.root||!await missingRoot(account.native.root))throw new Error('err.reset');
  if(!/^[a-zA-Z0-9_-]+$/.test(account.id))throw new Error('err.account');
  const directory=path.resolve(dataDir,'recovery',account.id+'-'+randomUUID());
  const cache=path.resolve(dataDir,'native-cache',account.id);
  if(!path.relative(path.resolve(dataDir),directory).startsWith('recovery'+path.sep)||path.relative(path.resolve(dataDir),cache)!==path.join('native-cache',account.id))throw new Error('err.reset');
  await mkdir(directory,{recursive:true,mode:0o700});
  const metadata={created:new Date().toISOString(),reason:'missing-root',accountId:account.id,name:account.name,native:account.native,items,jobs};
  await writeFile(path.join(directory,'metadata.json'),JSON.stringify(metadata,null,2),{mode:0o600,flag:'wx'});
  const info=await lstat(cache).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(info){if(!info.isDirectory()||info.isSymbolicLink())throw new Error('err.link');await rename(cache,path.join(directory,'cached-files'));}
  return directory;
}

// Reset preserves partial ranges, unfinished snapshots and operation metadata outside cleared caches.
export async function archiveResetRoot({dataDir,account,items,jobs,deletions}){
  if(!/^[a-zA-Z0-9_-]+$/.test(account.id))throw new Error('err.account');
  const directory=path.resolve(dataDir,'recovery',account.id+'-reset-'+randomUUID()),cache=path.resolve(dataDir,'native-cache',account.id);
  if(!path.relative(path.resolve(dataDir),directory).startsWith('recovery'+path.sep)||path.relative(path.resolve(dataDir),cache)!==path.join('native-cache',account.id))throw new Error('err.reset');
  const info=await lstat(cache).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw new Error('err.link');
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(path.join(directory,'metadata.json'),JSON.stringify({created:new Date().toISOString(),reason:'reset-keep-downloaded',accountId:account.id,name:account.name,native:account.native,items,jobs,deletions},null,2),{mode:0o600,flag:'wx'});
  if(info)await rename(cache,path.join(directory,'cached-files'));return directory;
}
