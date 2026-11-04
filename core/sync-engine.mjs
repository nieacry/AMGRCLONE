import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, realpath, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import {rcloneFileEvent} from './file-events.mjs';
import { makePlan, contains, validateLocalMapping } from './policy.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function settingsHash(settings) { return hash({localRoot:settings.localRoot,rules:Object.fromEntries(Object.entries(settings.rules).sort(([a],[b])=>a.localeCompare(b)))}); }
export function remoteSpec(job,suffix=''){return `cloud:${job.remote_root||''}${job.remote_path}${suffix}`;}
export function syncArguments(job,workdir,options) {
  const args=['bisync',remoteSpec(job),job.local_path,'--workdir',workdir,'--compare','size,modtime,checksum','--modify-window','1s','--conflict-resolve','none','--max-delete','10','--backup-dir1',options.backupRemote,'--backup-dir2',options.backupLocal,'--create-empty-src-dirs','--use-json-log','--stats','1s','--stats-log-level','NOTICE','--verbose'];
  if(options.dryRun)args.push('--dry-run');
  if(options.initial)args.push('--resync','--resync-mode',options.strategy==='local'?'path2':'path1');
  if(!options.initial||!options.dryRun)args.push('--check-access','--check-filename',job.marker);
  return args;
}
export async function safeDirectory(root,relative,{create=false,deep=false}={}) {
  validateLocalMapping(relative,process.platform);
  const canonical=await realpath(root);
  if(path.resolve(root)!==canonical) throw new Error('err.link');
  let current=canonical;
  for(const segment of relative.split('/').filter(Boolean)) {
    current=path.join(current,segment);
    let info=await lstat(current).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
    if(!info&&create){await mkdir(current);info=await lstat(current);}
    if(!info||info.isSymbolicLink()||!info.isDirectory())throw new Error('err.link');
  }
  if(deep) {
    const scan=async dir=>{for(const item of await readdir(dir,{withFileTypes:true})){if(item.isSymbolicLink())throw new Error('err.link');if(item.isDirectory())await scan(path.join(dir,item.name));}};
    await scan(current);
  }
  return current;
}
function displayLog(output) {
  return (output.stdout+'\n'+output.stderr).split(/\r?\n/).filter(Boolean).map(line=>{try {const v=JSON.parse(line);return `${v.time||''} ${v.level||''} ${v.msg||''}`;}catch{return line;}}).join('\n').replace(/\x1b\[[0-9;]*m/g,'');
}
export class SyncEngine {
  constructor({store,dataDir,connection,run,rootGuard=async()=>false}) {this.store=store;this.dataDir=dataDir;this.connection=connection;this.run=run;this.rootGuard=rootGuard;this.plans=new Map();this.activity=null;this.cancelled=false;}
  cancel(){this.cancelled=true;}
  checkCancelled(){if(this.cancelled)throw new Error('err.canceled');}
  async snapshot(job,flags) {
    const read=async fs=>{
      this.checkCancelled();
      const result=await this.run(['lsjson',fs,'--recursive','--no-mimetype',...flags]);
      const items=JSON.parse(result.stdout);
      const names=new Set();
      for(const item of items){validateLocalMapping(item.Path,process.platform);const key=item.Path.normalize('NFC').toLocaleLowerCase();if(names.has(key))throw new Error('err.mapping');names.add(key);}
      const canonical=items.map(i=>[i.Path,i.IsDir,i.Size,i.ModTime,i.ID||'']).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
      return hash(canonical);
    };
    return hash([await read(remoteSpec(job)),await read(job.local_path)]);
  }
  async identity(job,flags) {
    this.checkCancelled();
    // rclone --stat on a configured directory root synthesizes a directory without ID.
    // Read the actual entry from its parent instead, retaining Dropbox folder identity.
    const parts=job.remote_path.split('/'),name=parts.pop(),parent=parts.join('/');
    const {stdout}=await this.run(['lsjson',`cloud:${job.remote_root||''}${parent}`,'--dirs-only','--no-mimetype',...flags]);
    const item=JSON.parse(stdout).find(entry=>entry.Name===name);
    if(!item?.IsDir||(job.item_id&&item.ID!==job.item_id))throw new Error('err.identity');
  }
  async markers(job,flags,create=false) {
    this.checkCancelled();
    const local=path.join(job.local_path,job.marker);
    if(create) {
      await writeFile(local,job.marker,{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      if((await readFile(local,'utf8'))!==job.marker)throw new Error('err.marker');
      await this.run(['copyto',local,remoteSpec(job,'/'+job.marker),'--immutable',...flags]);
    }
    try {
      if((await readFile(local,'utf8'))!==job.marker)throw new Error('err.marker');
      const {stdout}=await this.run(['cat',remoteSpec(job,'/'+job.marker),...flags]);
      if(stdout!==job.marker)throw new Error('err.marker');
    }catch{throw new Error('err.marker');}
  }
  async preview(acc,options={}) {
    if(this.activity)throw new Error('err.busy');
    if(!acc.settings.localRoot)throw new Error('err.root');
    if(await this.rootGuard(acc.settings.localRoot))throw new Error('err.link');
    const strategy=options.strategy==='local'?'local':'remote';
    const policy=makePlan(acc.settings);
    this.cancelled=false;this.activity={accountId:acc.id,status:'preview',path:'',stats:null};
    try {
      const prepared=[];const logs=[];
      for(const candidate of policy.jobs) {
        if(acc.scope==='team'&&!candidate.path.includes('/')){policy.deferred.push({path:candidate.path,reason:'deferred_team'});continue;}
        this.checkCancelled();this.activity.path=candidate.path;
        const localPath=await safeDirectory(acc.settings.localRoot,candidate.path,{create:true,deep:true});
        const id=hash([acc.id,acc.scope||'personal',candidate.path,localPath]).slice(0,24);
        for(const previous of this.store.jobs(acc.id)) if(previous.id!==id&&(contains(previous.remote_path,candidate.path)||contains(candidate.path,previous.remote_path)))throw new Error('err.overlap');
        const itemId=acc.settings.rules[candidate.path]?.itemId;
        const job=this.store.addJob({id,accountId:acc.id,path:candidate.path,localPath,itemId,remoteRoot:acc.scope==='team'?'/':'',marker:'.amg-access-'+id});
        if(job.status==='retired')throw new Error('err.legacyRetired');
        if(job.status==='needsReview'&&!options.recovery)throw new Error('err.recovery');
        const initial=!job.initialized||job.status==='needsReview';
        const workdir=job.status==='needsReview'?path.join(this.dataDir,'sync',id,'reconcile-'+randomUUID().slice(0,8)):job.workdir||path.join(this.dataDir,'sync',id);
        // A separate state directory means previews cannot commit a new baseline.
        const previewDir=path.join(this.dataDir,'previews',randomUUID());
        if(initial)await mkdir(previewDir,{recursive:true});
        else {await cp(workdir,previewDir,{recursive:true}).catch(()=>{this.store.mark(job.id,'needsReview');throw new Error('err.recovery');});}
        const runKey=randomUUID();
        const backupRemote=`cloud:${acc.scope==='team'?'/'+candidate.path.split('/')[0]+'/':''}.amg-backups/${acc.id}/${id}/${runKey}`;
        const backupLocal=path.join(acc.settings.localRoot,'.amg-backups',id,runKey);
        const detail=await this.connection(acc,async flags=>{
          await this.identity(job,flags);
          if(!initial)await this.markers(job,flags);
          const snapshot=await this.snapshot(job,flags);
          const output=await this.run([...syncArguments(job,previewDir,{dryRun:true,initial,strategy,backupRemote,backupLocal}),...flags],{timeout:1800000});
          if(snapshot!==await this.snapshot(job,flags))throw new Error('err.plan');
          logs.push(`${candidate.path}\n${displayLog(output)}`);
          return {snapshot};
        }).catch(error=>{this.store.previewFailure(acc.id,job,error);if(job.initialized&&error.message!=='err.plan'&&error.message!=='err.canceled')this.store.mark(job.id,'needsReview');throw error;});
        prepared.push({id,path:candidate.path,localPath,initialization:initial,recovery:job.status==='needsReview',generation:job.generation,workdir,backupRemote,backupLocal,...detail});
      }
      const token=randomUUID(),created=Date.now();
      const plan={token,accountId:acc.id,scope:acc.scope||'personal',created,expires:created+600000,strategy,settingsHash:settingsHash(acc.settings),jobs:prepared,deferred:policy.deferred,log:logs.join('\n\n')};
      this.plans.clear();this.plans.set(token,plan);
      return plan;
    }finally{this.activity=null;}
  }
  async execute(acc,token,confirmed) {
    if(this.activity)throw new Error('err.busy');
    const plan=this.plans.get(token);this.plans.delete(token);
    if(confirmed!==true)throw new Error('err.confirm');
    if(!plan||plan.accountId!==acc.id||plan.scope!==(acc.scope||'personal')||plan.expires<Date.now()||plan.settingsHash!==settingsHash(acc.settings))throw new Error('err.plan');
    if(!plan.jobs.length)throw new Error('err.empty');
    if(await this.rootGuard(acc.settings.localRoot))throw new Error('err.link');
    this.cancelled=false;this.activity={accountId:acc.id,status:'checking',path:'',stats:null};
    try {
      // Validate all branches before transferring the first one.
      for(const prepared of plan.jobs) {
        this.checkCancelled();const job=this.store.job(prepared.id);
        if(!job||job.generation!==prepared.generation)throw new Error('err.plan');
        await safeDirectory(acc.settings.localRoot,prepared.path,{deep:true});
        await this.connection(acc,async flags=>{await this.identity(job,flags);if(prepared.snapshot!==await this.snapshot(job,flags))throw new Error('err.plan');});
      }
      for(const prepared of plan.jobs) {
        this.checkCancelled();const job=this.store.job(prepared.id);
        const kind=prepared.recovery?'reconcile':prepared.initialization?'initial':'incremental';
        const runId=this.store.startRun(acc.id,job,kind,prepared.backupRemote,prepared.backupLocal);
        this.store.setWorkdir(job.id,prepared.workdir);
        this.activity={accountId:acc.id,status:'running',path:prepared.path,stats:null};
        let log='';
        try {
          await safeDirectory(acc.settings.localRoot,`.amg-backups/${job.id}/${path.basename(prepared.backupLocal)}`,{create:true});
          await this.connection(acc,async flags=>{
            await this.markers(job,flags,prepared.initialization);
            this.checkCancelled();
            const output=await this.run([...syncArguments(job,prepared.workdir,{dryRun:false,initial:prepared.initialization,strategy:plan.strategy,backupRemote:prepared.backupRemote,backupLocal:prepared.backupLocal}),...flags],{
              timeout:86400000,onLog:line=>{try{const event=JSON.parse(line);if(event.stats)this.activity.stats=event.stats;const file=rcloneFileEvent(event,prepared.path);if(file)this.store.addFileEvent(acc.id,file);}catch{/* Non-JSON output. */}}
            });log=displayLog(output);
          });
          this.store.mark(job.id,'idle',true);this.store.finishRun(runId,'succeeded',log);
        }catch(error){this.store.mark(job.id,'needsReview');this.store.finishRun(runId,error.message==='err.canceled'?'interrupted':'failed',log+'\n'+(error.safeLog||error.message));throw error;}
      }
      return {completed:plan.jobs.length};
    }finally{this.activity=null;}
  }
}
