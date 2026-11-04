import {open,readFile,rename,copyFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';

// vault.bin holds every account, its Dropbox token, folders and rules, encrypted with the
// Windows user's key (DPAPI via Electron safeStorage). Losing it used to stop the app from
// starting at all. Roadmap 2.1-2.3:
//  - writes go to vault.next, are flushed to disk, and only then replace vault.bin;
//  - the previous vault.bin is kept as vault.bak;
//  - everything except tokens is mirrored to settings-backup.json (plain JSON), so a vault that
//    cannot be decrypted (another Windows user, reinstalled Windows) costs a Dropbox sign-in,
//    not the whole setup.
export const VAULT='vault.bin',VAULT_NEXT='vault.next',VAULT_BACKUP='vault.bak',SETTINGS_BACKUP='settings-backup.json';

async function writeDurable(filename,bytes){const handle=await open(filename,'w',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
const nonEmpty=filename=>stat(filename).then(info=>info.isFile()&&info.size>0).catch(()=>false);

// The plain copy: no `config` (rclone config with the token) and no binary path.
export function settingsMirror(vault){
  return {format:1,saved:new Date().toISOString(),language:vault.language,preferences:vault.preferences,drives:vault.drives||[],
    accounts:(vault.accounts||[]).map(({config:_secret,...account})=>({...account,dropbox:/^type\s*=\s*dropbox$/m.test(_secret||'')}))};
}

export async function writeVault({dataDir,vault,encrypt}){
  const bytes=await encrypt(JSON.stringify(vault)),current=path.join(dataDir,VAULT),next=path.join(dataDir,VAULT_NEXT);
  await writeDurable(next,bytes);
  // Keep the last good vault. Only a non-empty file is worth keeping.
  if(await nonEmpty(current))await copyFile(current,path.join(dataDir,VAULT_BACKUP));
  await rename(next,current);
  const mirror=path.join(dataDir,SETTINGS_BACKUP),mirrorNext=mirror+'.next';
  await writeDurable(mirrorNext,JSON.stringify(settingsMirror(vault),null,2));await rename(mirrorNext,mirror);
}

const validVault=value=>value&&typeof value==='object'&&Array.isArray(value.accounts);
async function attempt(filename,decrypt){
  const bytes=await readFile(filename);if(!bytes.length)throw Object.assign(new Error('empty'),{reason:'empty'});
  let text;try{text=await decrypt(bytes);}catch{throw Object.assign(new Error('decrypt'),{reason:'decrypt'});}
  let value;try{value=JSON.parse(text);}catch{throw Object.assign(new Error('parse'),{reason:'parse'});}
  if(!validVault(value))throw Object.assign(new Error('shape'),{reason:'shape'});
  return value;
}

// Returns {vault, source}: source is 'vault', 'backup' (vault.bin was damaged), 'mirror' (no
// usable encrypted copy: accounts come back without tokens and need a new sign-in), or 'new'.
// `problem` names what was wrong with vault.bin. Damaged files are renamed, never deleted.
export async function readVault({dataDir,decrypt,now=Date.now()}){
  const current=path.join(dataDir,VAULT),backup=path.join(dataDir,VAULT_BACKUP);
  let problem=null;
  try{return {vault:await attempt(current,decrypt),source:'vault'};}
  catch(error){if(error.code==='ENOENT'&&!await nonEmpty(backup))return {vault:null,source:'new'};problem=error.code==='ENOENT'?'missing':error.reason||'read';}
  const keep=async filename=>{if(await nonEmpty(filename))await rename(filename,filename.replace(/\.(bin|bak)$/,`.damaged-${now}.$1`)).catch(()=>{});};
  try{
    const vault=await attempt(backup,decrypt);
    await keep(current);await writeFile(current,await readFile(backup),{mode:0o600});
    return {vault,source:'backup',problem};
  }catch{/* Fall through to the plain mirror. */}
  let mirror=null;try{mirror=JSON.parse(await readFile(path.join(dataDir,SETTINGS_BACKUP),'utf8'));}catch{/* No mirror. */}
  await keep(current);await keep(backup);
  if(!mirror||!Array.isArray(mirror.accounts))return {vault:null,source:'new',problem};
  const vault={language:mirror.language,preferences:mirror.preferences,drives:mirror.drives||[],
    accounts:mirror.accounts.map(({dropbox:_dropbox,...account})=>({...account,config:'',needsLogin:true}))};
  return {vault,source:'mirror',problem};
}
