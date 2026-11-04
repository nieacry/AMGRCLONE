import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,readFile,writeFile,rename,copyFile,readdir,lstat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,mkdirSync,copyFileSync,writeFileSync,renameSync,rmdirSync,openSync,readSync,closeSync,createReadStream} from 'node:fs';
import path from 'node:path';
import {DATABASE_SCHEMA} from './store.mjs';

export const PROFILE_FORMAT=1;
export const MINIMUM_APP_VERSION='0.15.0';
const profileFiles=['vault.bin','sync.sqlite','sync.sqlite-wal','sync.sqlite-shm','Local State','profile-state.json','sync','native-cache','recovery','profile-backups'];
function hashFileSync(filename){const hash=createHash('sha256'),file=openSync(filename,'r'),buffer=Buffer.alloc(1024*1024);try{let size;while((size=readSync(file,buffer))>0)hash.update(buffer.subarray(0,size));return hash.digest('hex');}finally{closeSync(file);}}
async function hashFile(filename){const hash=createHash('sha256');for await(const bytes of createReadStream(filename))hash.update(bytes);return hash.digest('hex');}
// Called before Chromium/safeStorage initialize. The old profile's singleton lock is held.
export function migrateLegacyProfile({legacyDir,dataDir}){
  const source=path.resolve(legacyDir),destination=path.resolve(dataDir);
  if(source===destination)return false;
  const within=(parent,child)=>{const relative=path.relative(parent,child);return !relative.startsWith('..')&&!path.isAbsolute(relative);};
  if(within(source,destination)||within(destination,source))throw new Error('err.profileDestination');
  if(['vault.bin','sync.sqlite','profile-state.json'].some(name=>existsSync(path.join(destination,name))))return false;
  if(!['vault.bin','sync.sqlite'].some(name=>existsSync(path.join(source,name))))return false;
  if(lstatSync(source).isSymbolicLink())throw new Error('err.profileDestination');
  if(existsSync(destination)&&(lstatSync(destination).isSymbolicLink()||!lstatSync(destination).isDirectory()||readdirSync(destination).length))throw new Error('err.profileDestination');
  const temporary=destination+'.migrating-'+randomUUID(),files={};mkdirSync(temporary,{recursive:true,mode:0o700});
  const copy=(from,to,relative)=>{const state=lstatSync(from);if(state.isSymbolicLink())throw new Error('err.profileDestination');if(state.isDirectory()){mkdirSync(to,{recursive:true});for(const name of readdirSync(from))copy(path.join(from,name),path.join(to,name),path.join(relative,name));}else if(state.isFile()){copyFileSync(from,to);const expected=hashFileSync(from);if(hashFileSync(to)!==expected)throw new Error('err.profileBackup');files[relative.replaceAll('\\','/')]=expected;}};
  try{for(const name of profileFiles)if(existsSync(path.join(source,name)))copy(path.join(source,name),path.join(temporary,name),name);writeFileSync(path.join(temporary,'migration.json'),JSON.stringify({from:source,created:new Date().toISOString(),files},null,2),{mode:0o600});if(existsSync(destination))rmdirSync(destination);renameSync(temporary,destination);return true;}catch(error){throw new Error(error.message?.startsWith('err.')?error.message:'err.profileBackup');}
}
const validVersion=value=>typeof value==='string'&&/^\d+\.\d+\.\d+$/.test(value);
export function compareVersions(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;}
const info=filename=>lstat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
async function copyTree(source,destination,files,relative=''){
  for(const entry of await readdir(source,{withFileTypes:true})){const name=path.join(relative,entry.name),from=path.join(source,entry.name),to=path.join(destination,entry.name);if(entry.isSymbolicLink())throw new Error('err.profileBackup');if(entry.isDirectory()){await mkdir(to,{recursive:true});await copyTree(from,to,files,name);}else if(entry.isFile()){await copyFile(from,to);files.push(name);}}
}
export async function prepareProfile({dataDir,version}){
  if(!validVersion(version))throw new Error('err.profile');
  let previous;try{previous=JSON.parse(await readFile(path.join(dataDir,'profile-state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('err.profile');}
  if(previous){if(previous.format>PROFILE_FORMAT||previous.databaseSchema>DATABASE_SCHEMA||(validVersion(previous.minimumAppVersion)&&compareVersions(version,previous.minimumAppVersion)<0))throw new Error('err.profileNewer');if(previous.format!==PROFILE_FORMAT||!validVersion(previous.appVersion)||!validVersion(previous.minimumAppVersion))throw new Error('err.profile');}
  const database=path.join(dataDir,'sync.sqlite'),databaseInfo=await info(database);
  if(databaseInfo){if(!databaseInfo.isFile()||databaseInfo.isSymbolicLink())throw new Error('err.profile');const db=new DatabaseSync(database,{readOnly:true});try{if(db.prepare('PRAGMA user_version').get().user_version>DATABASE_SCHEMA)throw new Error('err.profileNewer');}finally{db.close();}}
  if(previous?.appVersion===version)return {previous,backup:null};
  if(!databaseInfo&&!await info(path.join(dataDir,'vault.bin')))return {previous,backup:null};
  const name=new Date().toISOString().replaceAll(':','-')+'-to-'+version+'-'+randomUUID().slice(0,8),pending=path.join(dataDir,'profile-backups',name+'.pending'),destination=path.join(dataDir,'profile-backups',name),files=[];
  try{
    await mkdir(pending,{recursive:true,mode:0o700});
    for(const name of ['vault.bin','Local State','profile-state.json']){const source=path.join(dataDir,name),state=await info(source);if(!state)continue;if(!state.isFile()||state.isSymbolicLink())throw new Error('err.profileBackup');await copyFile(source,path.join(pending,name));files.push(name);}
    if(databaseInfo){const db=new DatabaseSync(database,{readOnly:true});try{await backup(db,path.join(pending,'sync.sqlite'));files.push('sync.sqlite');}finally{db.close();}}
    for(const name of ['sync','native-cache']){const source=path.join(dataDir,name),state=await info(source);if(!state)continue;if(!state.isDirectory()||state.isSymbolicLink())throw new Error('err.profileBackup');await mkdir(path.join(pending,name));const nested=[];await copyTree(source,path.join(pending,name),nested);files.push(...nested.map(relative=>path.join(name,relative)));}
    const checksums={};for(const name of files)checksums[name.replaceAll('\\','/')]=await hashFile(path.join(pending,name));
    await writeFile(path.join(pending,'backup.json'),JSON.stringify({format:PROFILE_FORMAT,fromVersion:previous?.appVersion||'legacy',toVersion:version,created:new Date().toISOString(),files:checksums},null,2),{mode:0o600});
    await rename(pending,destination);return {previous,backup:destination};
  }catch{throw new Error('err.profileBackup');}
}
export async function commitProfile({dataDir,version,upgrade}){
  const minimum=upgrade.previous?.minimumAppVersion||MINIMUM_APP_VERSION,temporary=path.join(dataDir,'profile-state-'+randomUUID()+'.next');
  await writeFile(temporary,JSON.stringify({format:PROFILE_FORMAT,appVersion:version,minimumAppVersion:minimum,databaseSchema:DATABASE_SCHEMA,lastBackup:upgrade.backup?path.relative(dataDir,upgrade.backup):upgrade.previous?.lastBackup||null,updated:new Date().toISOString()},null,2),{mode:0o600});await rename(temporary,path.join(dataDir,'profile-state.json'));
}
export async function relocateProfileWorkdirs({store,dataDir}){
  let migration;try{migration=JSON.parse(await readFile(path.join(dataDir,'migration.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return;throw new Error('err.profile');}
  if(typeof migration.from!=='string'||!path.isAbsolute(migration.from))throw new Error('err.profile');
  const source=path.join(migration.from,'sync'),destination=path.join(dataDir,'sync'),changes=[];
  for(const job of store.db.prepare('SELECT id,workdir FROM jobs WHERE workdir IS NOT NULL').all()){
    const relative=path.relative(source,job.workdir);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))continue;
    const target=path.join(destination,relative),state=await info(target);if(!state?.isDirectory()||state.isSymbolicLink())throw new Error('err.profile');changes.push({id:job.id,target});
  }
  store.db.exec('BEGIN IMMEDIATE');try{for(const change of changes)store.setWorkdir(change.id,change.target);store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}
}
export function bundledBinaryMode(vault,currentBinary){if(vault.binaryMode==='custom')return 'custom';if(vault.binaryMode==='bundled'||!vault.binary||vault.binary==='rclone')return 'bundled';const normalized=vault.binary.replaceAll('\\','/').toLowerCase();return normalized===currentBinary.replaceAll('\\','/').toLowerCase()||/\/(?:resources\/bin|\.runtime\/tools)\/rclone(?:\.exe)?$/.test(normalized)?'bundled':'custom';}
