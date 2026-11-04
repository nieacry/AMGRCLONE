import {mkdir,readdir,lstat,readFile,writeFile,unlink,utimes,realpath} from 'node:fs/promises';
import {watch} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {itemIdentity as identity,deleting,recoverPlaceholder,prepareDeletion,finishDeletions,commonFolder} from './native-deletions.mjs';
import {missingRoot} from './account-recovery.mjs';
import {NativeHost,retryableNativeError} from './native-host.mjs';
import {contains,effectivePolicy,validateLocalMapping,validateRemotePath,mappingError} from './policy.mjs';
import {dropboxHash} from './dropbox-transport.mjs';
import {nativeAvailabilityStates,nativeFileStatus} from './native-availability.mjs';
import {skippableMapping,mappingBlocks,blockedPath,containsSkipped} from './native-skips.mjs';
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import {resolvable,resolveConflict} from './conflicts.mjs';
import {ensureSpace,exceedsThreshold,fullyLocal,quarantineFile,pruneQuarantine,reviewSummary,quarantineRoot} from './deletion-guard.mjs';

// Held Explorer deletions shown as one decision per batch.
function groupConfirmations(ops){
  const groups=new Map();for(const op of ops){const key=op.batch||op.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(op);}
  return [...groups].map(([id,list])=>({id,path:commonFolder(list.map(op=>op.path)),action:list.every(op=>op.action==='recycle')?'recycle':'delete',count:list.reduce((sum,op)=>sum+(op.remoteBaseline||op.items).length,0),preparedAt:Math.min(...list.map(op=>op.preparedAt))}));
}
export const HYDRATION_LANES=2,INSPECT_BATCH=512;
const order=(a,b)=>a.path.split('/').length-b.path.split('/').length||a.path.localeCompare(b.path);
export function selectedRoots(rules){return Object.keys(rules).filter(p=>rules[p].selected).sort((a,b)=>a.length-b.length).filter((p,_i,all)=>!all.some(parent=>parent!==p&&contains(parent,p)));}
function supported(relative){validateLocalMapping(relative,'win32');return !relative.split('/').some(p=>p.toLowerCase()==='.amg-backups'||p.startsWith('.amg-access-'));}
export class NativeProviders {
  constructor({binary,dataDir,store,transport,persist,onReview}){this.binary=binary;this.dataDir=dataDir;this.store=store;this.transport=transport;this.persist=persist;this.onReview=onReview;this.contexts=new Map();this.closed=false;this.paused=false;}
  status(acc){const ctx=this.contexts.get(acc.id);if(!acc.native?.enabled)return {enabled:false};if(!ctx)return {enabled:true,root:acc.native.root,status:'error',error:'err.nativeStopped',lastSync:acc.native.lastSync||null,pending:0,transfers:0};const items=[...ctx.items.values()].filter(item=>!blockedPath(ctx,item.path)),orphans=items.filter(i=>i.status==='orphaned').length,conflicts=items.filter(i=>i.status==='conflict').length,awaiting=[...(ctx.deletions?.values()||[])].filter(op=>op.awaitingConfirmation&&!op.confirmed),pending=items.filter(i=>i.status==='dirty').length+(ctx.deletions?.size||0)-awaiting.length;return {enabled:true,shellRegistered:ctx.registration?.shellRegistered,canDisconnectUninitialized:!!ctx.failed&&!ctx.registration,registered:!!acc.native.registered,initializationFailed:!!ctx.failed&&!ctx.registration,skippedFiles:ctx.mappingSkips?.size||0,catalogItems:ctx.items.size,pendingDeletions:ctx.deletions?.size||0,canChangeRoot:!!ctx.failed&&ctx.items.size===0&&!ctx.deletions?.size,root:acc.native.root,status:ctx.error||conflicts||orphans||acc.native.resetting?'error':ctx.busy||ctx.fetches.size||ctx.hydrations?.size?'syncing':ctx.retry||ctx.suspended?'pending':pending?'syncing':ctx.lastChecked?'current':'idle',error:ctx.error||(acc.native.resetting?'err.reset':conflicts?'err.nativeConflict':orphans?'err.nativeOrphan':null),detail:ctx.detail||'',progress:ctx.progress||null,canceled:!!ctx.suspended,pending,transfers:ctx.fetches.size,lastChecked:ctx.lastChecked,lastSync:acc.native.lastSync||null,waiting:ctx.retry?.nativePath|| (ctx.retry?'':undefined),counts:{online:items.filter(i=>i.kind==='file'&&i.status==='online').length,local:items.filter(i=>i.kind==='file'&&['cached','pinned'].includes(i.status)).length,conflicts,conflictCopies:ctx.conflictCopies||0},metrics:{...ctx.metrics,cloudWatch:!!ctx.cloudWatch?.healthy},review:ctx.review&&!ctx.review.approved?{id:ctx.review.id,created:ctx.review.created,...reviewSummary(ctx.review.items)}:null,confirmations:groupConfirmations(awaiting)};}
  save(ctx,item){ctx.items.set(item.key,item);this.store.saveNativeItem(ctx.acc.id,item);return item;}
  async itemStates(acc,paths){
    const ctx=this.contexts.get(acc.id);if(!ctx||ctx.closed||ctx.failed||!ctx.host||acc.native?.resetting)return nativeAvailabilityStates([],paths);
    const items=[...ctx.items.values()],requested=new Set(paths),files=items.filter(item=>item.kind==='file'&&requested.has(item.path)&&['online','cached','pinned','dirty'].includes(item.status)),fresh=new Map();let next=0;
    // Attribute inspection reads no file contents and runs even while background sync is paused.
    await Promise.all(Array.from({length:Math.min(4,files.length)},async()=>{while(next<files.length){const item=files[next++];try{const actual=await ctx.host.request('inspect',{path:item.path});fresh.set(item.path,{...item,status:actual.exists&&actual.placeholder&&actual.identity===item.identity?nativeFileStatus(actual):'unknown'});}catch{fresh.set(item.path,{...item,status:'unknown'});}}}));
    const states=nativeAvailabilityStates(items.map(item=>fresh.get(item.path)||item),paths,[...ctx.fetches.values(),...ctx.uploads].map(controller=>controller.nativePath).filter(Boolean));for(const relative of paths)if(blockedPath(ctx,relative))states[relative]='skipped';return states;
  }
  async start(acc){
    const previous=this.contexts.get(acc.id);if(previous){if(!previous.failed)return previous.ready;await previous.host?.close();this.contexts.delete(acc.id);}
    const cache=path.join(this.dataDir,'native-cache',acc.id);
    const ctx={acc,host:null,cache,review:this.store.nativeReview?.(acc.id)||null,conflictCopies:this.store.countFileEvents?.(acc.id,'conflictCopy',new Date(Date.now()-7*86400000).toISOString())||0,remote:this.transport(acc),items:new Map(this.store.nativeItems(acc.id).map(i=>[i.key,i])),deletions:new Map(this.store.nativeDeletions(acc.id).map(op=>[op.id,op])),fetches:new Map(),uploads:new Set(),queue:Promise.resolve(),busy:true,error:null,detail:'',lastChecked:null,needsReconcile:true,retry:null,closed:false,failed:false};
    this.contexts.set(acc.id,ctx);
    ctx.ready=(async()=>{try{if(await missingRoot(acc.native.root))throw new Error('err.nativeRootMissing');await mkdir(cache,{recursive:true,mode:0o700});if(this.closed||ctx.closed)throw new Error('err.nativeStopped');ctx.host=new NativeHost(this.binary);
      ctx.host.on('event',event=>this.event(ctx,event).catch(error=>this.recordError(ctx,error)));
      ctx.host.on('stopped',()=>{if(!ctx.closed)this.recordError(ctx,new Error('err.nativeStopped'));});
      ctx.registration=await ctx.host.request('init',{root:acc.native.root,cache,owner:acc.native.owner,displayName:acc.name});ctx.shell=await ctx.host.request('checkPath',{path:acc.native.root});if(ctx.closed)throw new Error('err.nativeStopped');
      if(!(acc.native.resetting&&acc.native.resetMode==='keepDownloaded'))await finishDeletions(this,ctx,{recover:true}).catch(error=>this.recordError(ctx,error));
      ctx.watcher=watch(acc.native.root,{recursive:true},(_type,filename)=>this.noteChange(ctx,filename?String(filename).split(path.sep).join('/'):null));ctx.watcher.on('error',error=>this.recordError(ctx,error));
      ctx.timer=setInterval(()=>this.background(ctx).catch(()=>{}),5000);
      if(this.dataDir)pruneQuarantine({dataDir:this.dataDir,accountId:acc.id}).catch(()=>{});
      this.watchCloud(ctx);
      ctx.busy=false;return ctx;
    }catch(error){ctx.busy=false;ctx.failed=true;this.recordError(ctx,error);throw error;}})();
    return ctx.ready;
  }
  log(ctx,item,action,direction='none',status='succeeded',detail='',target=''){this.store.addFileEvent(ctx.acc.id,{path:item.path,kind:item.kind,size:item.size,action,direction,status,detail,target});}
  async background(ctx){
    if(ctx.busy||ctx.closed||ctx.suspended||this.paused||ctx.acc.native?.resetting)return;
    if(ctx.retryAt&&Date.now()<ctx.retryAt)return;ctx.retryAt=null;
    // Roadmap 3.5: 60-75 s between cloud checks, chosen per cycle, so five computers on one Dropbox
    // account do not list it in lockstep.
    ctx.checkEvery??=60000+Math.round(Math.random()*15000);
    // While the cloud watch (longpoll) is healthy, a change triggers the check within seconds and the
    // full listing is only a 10-15 minute safety net (roadmap 4.2).
    ctx.safetyEvery??=600000+Math.round(Math.random()*300000);
    const interval=ctx.cloudWatch?.healthy?ctx.safetyEvery:ctx.checkEvery;
    const due=ctx.needsReconcile||ctx.cloudChanged||!ctx.lastChecked||Date.now()-ctx.lastChecked>=interval;
    if(due)ctx.safetyEvery=undefined;
    if(!ctx.changed&&!due&&![...ctx.deletions.values()].some(op=>!op.awaitingConfirmation||op.confirmed))return;
    await this.serial(ctx,async()=>{ctx.changed=false;await finishDeletions(this,ctx);await this.scan(ctx);if(due){await this.reconcile(ctx);await this.resolveConflicts(ctx);}});
  }
  recordError(ctx,error){ctx.needsReconcile=true;if(error.message==='err.canceled')return;if(retryableNativeError(error)){ctx.retry=error;
    // The transport already retried a temporary Dropbox failure; back off before the next cycle.
    if(error.retryable===true)ctx.retryAt=Date.now()+(Number.isFinite(error.retryAfter)?error.retryAfter*1000:Math.round(30000*(0.5+Math.random())));return;}ctx.error=error.message?.startsWith('err.')?error.message:'err.native';ctx.detail=[error.nativeCode,error.dropboxSummary,error.nativeCommand,error.nativeStage,error.nativePath,error.nativeOtherPath].filter(Boolean).join(' · ');const signature=ctx.error+'|'+ctx.detail;if(ctx.lastErrorLog!==signature&&!error.journalRecorded){ctx.lastErrorLog=signature;this.store.addFileEvent(ctx.acc.id,{path:error.nativePath||'',action:['upload','download','delete','recycle','rename','update','local','online'].includes(error.nativeCommand)?error.nativeCommand:'sync',direction:'none',status:'failed',detail:ctx.error+(ctx.detail?' · '+ctx.detail:'')});}}
  serial(ctx,action,{user=false}={}){const generation=ctx.cancelGeneration||0,userGeneration=ctx.userCancelGeneration||0;const result=ctx.queue.then(async()=>{if(ctx.closed)throw new Error('err.nativeStopped');if((!user&&generation!==(ctx.cancelGeneration||0))||(user&&userGeneration!==(ctx.userCancelGeneration||0)))throw new Error('err.canceled');const operation=new AbortController();operation.userMutation=user;ctx.operation=operation;ctx.busy=true;ctx.error=null;ctx.detail='';ctx.retry=null;ctx.checkedThisRun=false;await ctx.host.request('providerStatus',{busy:true}).catch(()=>{});try{operation.signal.throwIfAborted();const value=await action();operation.signal.throwIfAborted();if(!ctx.error)ctx.lastErrorLog=null;await this.finishCheck(ctx);return value;}catch(error){if(operation.signal.aborted)throw new Error('err.canceled');this.recordError(ctx,error);throw error;}finally{ctx.busy=false;ctx.progress=null;ctx.operation=null;await ctx.host.request('providerStatus',{busy:false}).catch(()=>{});}});ctx.queue=result.catch(()=>{});return result;}
  async userMutation(ctx,action){
    // Explorer callbacks have a deadline. Interrupt a long scan/list/population,
    // then validate the user's operation in the same serialized mutation lane.
    // Existing on-open hydration requests are independent and remain running.
    ctx.cancelGeneration=(ctx.cancelGeneration||0)+1;
    if(!ctx.operation?.userMutation){ctx.operation?.abort(new Error('err.canceled'));for(const controller of ctx.uploads)controller.abort();}
    try{return await this.serial(ctx,action,{user:true});}finally{ctx.needsReconcile=true;}
  }
  async refresh(acc){
    const ctx=await this.start(acc);if(acc.native?.resetting)throw new Error('err.reset');
    if(ctx.refreshing){ctx.refreshAgain=true;return ctx.refreshing;}ctx.suspended=false;
    const refresh=(async()=>{do{ctx.refreshAgain=false;await this.serial(ctx,async()=>{await finishDeletions(this,ctx);await this.scan(ctx);await this.reconcile(ctx);await this.resolveConflicts(ctx);});}while(ctx.refreshAgain&&!ctx.closed&&!ctx.suspended&&!this.paused);return this.status(acc);})();ctx.refreshing=refresh;
    try{return await refresh;}catch(error){if(retryableNativeError(error))return this.status(acc);throw error;}finally{if(ctx.refreshing===refresh)ctx.refreshing=null;}
  }
  async collect(ctx,rules=ctx.acc.settings.rules){
    const roots=selectedRoots(rules),all=new Map(),skips=new Map(),cursors=new Map(),signal=ctx.operation?.signal;ctx.progress={phase:'listing',completed:0};
    const include=item=>{if(!effectivePolicy(item.path,rules).selected)return false;try{return supported(item.path);}catch(error){if(!skippableMapping(error))throw error;skips.set(item.path,{item,reason:error.nativeStage});return false;}};
    for(const relative of roots){
      signal?.throwIfAborted();validateRemotePath(relative);
      const top=relative?{path:relative,...await ctx.remote.metadata(relative,{signal})}:{kind:'folder'};if(relative&&!include(top))continue;if(relative)all.set(relative,top);
      const prior=all.size,options={signal,onProgress:count=>{ctx.progress={phase:'listing',completed:prior+count};}};
      if(top.kind!=='folder')continue;
      // Consume one page at a time, rather than retaining a second full-tree array.
      const pages=ctx.remote.listPages?ctx.remote.listPages(relative,true,{...options,onCursor:cursor=>cursors.set(relative,cursor)}):(async function*(){yield await ctx.remote.list(relative,true,options);})();
      for await(const page of pages){let processed=0;for(const item of page){signal?.throwIfAborted();if(include(item))all.set(item.path,item);if(++processed%1024===0)await yieldToEventLoop();}await yieldToEventLoop();signal?.throwIfAborted();}
    }
    // Resolve each ancestor chain once, even when a folder contains hundreds of thousands of files.
    const ancestors=new Set();let processed=0;
    for(const item of all.values()){
      signal?.throwIfAborted();if(++processed%1024===0)await yieldToEventLoop();
      const parts=item.path.split('/');parts.pop();while(parts.length){const parent=parts.join('/');if(ancestors.has(parent))break;ancestors.add(parent);if(!all.has(parent))all.set(parent,{path:parent,...await ctx.remote.metadata(parent,{signal})});parts.pop();}
    }
    // Validate the complete snapshot before reconciliation can create, update or remove placeholders.
    const seen=new Map();for(const item of all.values()){signal?.throwIfAborted();if(++processed%1024===0)await yieldToEventLoop();if(!supported(item.path))throw mappingError(item.path,'err.mappingInternal');const canonical=item.path.normalize('NFC').toLowerCase();if(seen.has(canonical))throw mappingError(item.path,'err.mappingCollision',seen.get(canonical));seen.set(canonical,item.path);}
    signal?.throwIfAborted();
    // Publish exclusions only after a complete successful listing and collision
    // check. Failed pages must not authorize removals or clear prior protection.
    for(const [relative,entry]of skips){signal?.throwIfAborted();if(ctx.mappingSkips?.get(relative)?.reason!==entry.reason)this.log(ctx,entry.item,'skipped','none','skipped',entry.reason);if(++processed%1024===0)await yieldToEventLoop();}
    ctx.mappingSkips=skips;ctx.mappingBlocks=mappingBlocks(skips,ctx.items.values());
    // A complete listing: its cursors are where the cloud watch continues from (roadmap 4.2).
    if(cursors.size===roots.length){ctx.cursors=cursors;ctx.cursorGeneration=(ctx.cursorGeneration||0)+1;}else ctx.cursors=null;
    return [...all.values()].sort(order);
  }
  async reconcile(ctx){
    const startedAt=Date.now();ctx.cloudChanged=false;
    const rules=structuredClone(ctx.acc.settings.rules),listing=await this.collect(ctx,rules),seen=new Set(),byRemoteId=new Map([...ctx.items.values()].map(item=>[item.remoteId,item]));ctx.operation?.signal.throwIfAborted();ctx.progress={phase:'placeholders',completed:0,total:listing.length};
    ctx.remoteCatalog=listing;
    // Items whose Dropbox ID disappeared, by path: a file deleted and created again under the same
    // name gets a new ID and must replace the old placeholder, not look like a conflict plus a deletion.
    const listedIds=new Set(listing.map(remote=>remote.remoteId)),canonical=value=>value.normalize('NFC').toLowerCase();
    const vanished=new Map([...ctx.items.values()].filter(item=>item.remoteId&&!listedIds.has(item.remoteId)&&!['orphaned','conflict'].includes(item.status)).map(item=>[canonical(item.path),item]));
    // Roadmap 4.6: local state for the whole listing in a few batched requests instead of one per file.
    const prefetched=await this.inspectMany(ctx,listing.filter(remote=>!blockedPath(ctx,remote.path)&&!deleting(ctx,remote.path)).map(remote=>remote.path));
    const inspect=relative=>ctx.host.request('inspect',{path:relative});
    for(const remote of listing){
      ctx.operation?.signal.throwIfAborted();ctx.progress.completed++;
      if(blockedPath(ctx,remote.path))continue;
      if(deleting(ctx,remote.path))continue;
      let existing=byRemoteId.get(remote.remoteId);
      if(!existing){const replaced=vanished.get(canonical(remote.path));
        if(replaced&&replaced.kind===remote.kind&&replaced.path===remote.path&&!seen.has(replaced.key)){const before=prefetched.get(remote.path)??await inspect(remote.path);
          if(before.exists&&before.placeholder&&before.identity===replaced.identity&&before.inSync&&!before.dirtyBytes){
            if(fullyLocal(before))await this.quarantine(ctx,replaced);
            existing=replaced;vanished.delete(canonical(remote.path));}}}
      let item=existing?{...existing}: {...remote,key:randomUUID(),status:'creating'};
      seen.add(item.key);const priorIdentity=existing?.identity;
      let touched=false;
      if(existing&&existing.path!==remote.path){
        const atNew=prefetched.get(remote.path)??await inspect(remote.path);touched=true;
        if(!atNew.exists)await ctx.host.request('moveLocal',{path:existing.path,target:remote.path,identity:existing.identity});
        else if(atNew.identity!==existing.identity){this.save(ctx,{...existing,status:'conflict'});continue;}
        item.path=remote.path;
      }
      const state=touched?await inspect(remote.path):prefetched.get(remote.path)??await inspect(remote.path);
      if(state.exists&&existing&&(!state.placeholder||!state.inSync)&&existing.status!=='creating'){
        if(remote.rev!==existing.rev)this.save(ctx,{...existing,status:'conflict'});
        // Before 0.16.6 a temporary Dropbox failure (any HTTP 409) left local edits in `conflict`
        // forever. The cloud still holds the revision these edits are based on, so retry the upload.
        else if(existing.status==='conflict'&&existing.path===remote.path&&state.placeholder&&state.identity===existing.identity&&!state.partial){this.save(ctx,{...existing,status:'dirty'});this.log(ctx,existing,'recover');ctx.changed=true;}
        continue;
      }
      item={...item,...remote};item.identity=identity(item);
      if(!existing)this.save(ctx,item); // Persist creation intent before creating an OS placeholder.
      if(!state.exists){touched=true;await ctx.host.request('create',{path:item.path,identity:item.identity,directory:item.kind==='folder',size:item.size,modified:item.modified});this.log(ctx,item,'placeholder','download');}
      else if(!state.placeholder){this.save(ctx,{...item,status:'conflict'});continue;}
      else if(state.identity!==(priorIdentity||item.identity)){this.save(ctx,{...item,status:'conflict'});continue;}
      else if(existing&&item.identity!==priorIdentity){touched=true;await ctx.host.request('update',{path:item.path,previousIdentity:priorIdentity,identity:item.identity,directory:item.kind==='folder',size:item.size,modified:item.modified});this.log(ctx,item,'updated','download');}
      item=this.save(ctx,item);
      if(item.kind==='file'){
        const desired=effectivePolicy(item.path,rules).mode;
        const current=touched?await inspect(item.path):state;let dehydrated=false;
        // Downloading a pinned file can take hours: it runs in its own lane, not in this one.
        if(desired==='local'&&(current.partial||current.pin!==1))this.hydrate(ctx,item);
        else if(desired==='online'&&current.pin===1){dehydrated=true;await ctx.host.request('availability',{path:item.path,identity:item.identity,mode:'online'});}
        const actual=dehydrated?await inspect(item.path):current;this.save(ctx,{...item,status:nativeFileStatus(actual)});
      }else this.save(ctx,{...item,status:'cached'});
    }
    // A changed selection invalidates this snapshot for removals; the queued refresh will use the new rules.
    if(JSON.stringify(rules)!==JSON.stringify(ctx.acc.settings.rules)){ctx.needsReconcile=true;ctx.refreshAgain=true;return;}
    // Removals: decide on the whole set first, then act. Edited local data is never removed (conflict).
    const removals=[],unseen=[...ctx.items.values()].filter(i=>!seen.has(i.key)&&i.status!=='orphaned'&&!deleting(ctx,i.path)&&!containsSkipped(ctx,i.path)).sort((a,b)=>order(b,a));
    const unseenStates=await this.inspectMany(ctx,unseen.map(item=>item.path));
    for(const item of unseen){
      ctx.operation?.signal.throwIfAborted();
      const state=unseenStates.get(item.path)??await inspect(item.path);
      if(state.exists&&(!state.placeholder||state.identity!==item.identity||!state.inSync||state.dirtyBytes)){this.save(ctx,{...item,status:'conflict'});continue;}
      removals.push({item,state,deselected:!effectivePolicy(item.path,rules).selected,downloaded:item.kind==='file'&&fullyLocal(state)});
    }
    // Deselected folders still exist in Dropbox: removing them locally loses nothing. Items deleted in
    // Dropbox that still exist here count against the mass-deletion threshold and wait for this user.
    const cloudDeleted=removals.filter(r=>!r.deselected&&r.state.exists),approved=new Set(ctx.review?.approved?ctx.review.keys:[]);
    const unapproved=cloudDeleted.filter(r=>!approved.has(r.item.key)),held=new Set();
    if(exceedsThreshold(unapproved.length,ctx.items.size)){
      const keys=unapproved.map(r=>r.item.key).sort();for(const key of keys)held.add(key);
      if(!ctx.review||ctx.review.approved||ctx.review.keys.join('|')!==keys.join('|')){
        const review={id:randomUUID(),created:Date.now(),keys,items:unapproved.map(({item,downloaded})=>({key:item.key,path:item.path,kind:item.kind,size:item.size||0,remoteId:item.remoteId,rev:item.rev||'',downloaded}))};
        await this.setReview(ctx,review);this.onReview?.(ctx.acc,{inbound:review});
      }
    }
    for(const {item,state,downloaded,deselected} of removals){
      ctx.operation?.signal.throwIfAborted();if(held.has(item.key))continue;
      if(state.exists){if(downloaded&&!deselected)await this.quarantine(ctx,item);await ctx.host.request('remove',{path:item.path,identity:item.identity});}
      ctx.items.delete(item.key);this.store.deleteNativeItem(ctx.acc.id,item.key);this.log(ctx,item,'delete','download');
    }
    if(!held.size&&ctx.review)await this.setReview(ctx,null);
    for(const item of ctx.items.values()){ctx.operation?.signal.throwIfAborted();if(item.kind==='folder'&&item.status!=='conflict'&&item.status!=='orphaned'&&!deleting(ctx,item.path)&&!blockedPath(ctx,item.path))await ctx.host.request('folderAvailability',{path:item.path,identity:item.identity,mode:effectivePolicy(item.path,rules).mode});}
    ctx.lastChecked=Date.now();ctx.checkEvery=undefined;ctx.checkedThisRun=true;
    ctx.metrics={...ctx.metrics,lastReconcileMs:ctx.lastChecked-startedAt,lastReconcileItems:listing.length,cloudListings:(ctx.metrics?.cloudListings||0)+1};ctx.needsReconcile=!!ctx.retry;
  }
  async finishCheck(ctx){if(ctx.checkedThisRun&&!ctx.acc.native.resetting&&!ctx.review&&!ctx.deletions?.size&&!ctx.error&&!ctx.retry&&!ctx.fetches.size&&!ctx.hydrations?.size&&!ctx.uploads.size&&![...ctx.items.values()].some(i=>!blockedPath(ctx,i.path)&&['dirty','conflict','creating','pendingRename','orphaned'].includes(i.status))){ctx.acc.native.lastSync=ctx.lastChecked;await this.persist();}}
  // Roadmap 4.4: only paths reported changed (Explorer/file-system events and the helper's close
  // notifications) are examined. Everything is walked at start-up, after an event overflow and every
  // 10-15 minutes as a safety net. Paths of a failed pass are kept for the next one.
  async scan(ctx,{full=false}={}){
    const byPath=new Map([...ctx.items.values()].map(item=>[item.path,item])),root=ctx.acc.native.root,listed=new Set(),paths=[];
    const add=relative=>{if(relative&&!listed.has(relative)){listed.add(relative);paths.push(relative);}};
    const walk=async relative=>{ctx.operation?.signal.throwIfAborted();for(const info of await readdir(path.join(root,...relative.split('/')),{withFileTypes:true})){ctx.operation?.signal.throwIfAborted();const child=relative?relative+'/'+info.name:info.name;if(info.isSymbolicLink())throw new Error('err.link');add(child);if(info.isDirectory())await walk(child);}};
    const everything=full||!(ctx.changedPaths instanceof Set)||!ctx.lastFullScan||Date.now()-ctx.lastFullScan>=(ctx.fullScanEvery??=600000+Math.round(Math.random()*300000));
    const requeue=everything?null:ctx.changedPaths;ctx.changedPaths=new Set();
    if(everything){await walk('');ctx.lastFullScan=Date.now();ctx.fullScanEvery=undefined;}
    else for(const changed of requeue){
      const parts=changed.split('/').filter(Boolean);if(!parts.length||parts.some(p=>p==='.'||p==='..'))continue;
      for(let depth=1;depth<parts.length;depth++)add(parts.slice(0,depth).join('/'));
      const relative=parts.join('/'),info=await lstat(path.join(root,...parts)).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;});
      if(!info)continue;if(info.isSymbolicLink())throw new Error('err.link');add(relative);if(info.isDirectory())await walk(relative);
    }
    ctx.metrics={...ctx.metrics,lastScanPaths:paths.length,lastScanFull:everything};
    try{
    const prefetched=await this.inspectMany(ctx,paths.filter(relative=>!deleting(ctx,relative)&&!blockedPath(ctx,relative)));
    for(const relative of paths.sort((a,b)=>a.split('/').length-b.split('/').length)){
      ctx.operation?.signal.throwIfAborted();
      if(deleting(ctx,relative)||blockedPath(ctx,relative)||!supported(relative)||!effectivePolicy(relative,ctx.acc.settings.rules).selected)continue;
      let known=byPath.get(relative);let actual=prefetched.get(relative)??await ctx.host.request('inspect',{path:relative});if(!actual.exists)continue;
      if(known?.status==='conflict'||known?.status==='orphaned')continue;
      if(known?.status==='pendingRename'){await this.finishRename(ctx,known);continue;}
      if(actual.placeholder){if(!known){known=await recoverPlaceholder(this,ctx,relative,actual);if(known.status==='orphaned')continue;}if(actual.identity!==known.identity){ctx.error='err.nativeConflict';continue;}if(actual.inSync){const status=actual.directory?'cached':nativeFileStatus(actual);if(known.status!==status)this.save(ctx,{...known,status});continue;}}
      if(known?.status==='creating')continue;
      if(actual.directory){if(!known){const remote=await ctx.remote.createFolder(relative);known={key:randomUUID(),path:relative,...remote,status:'creating'};known.identity=identity(known);this.save(ctx,known);const committed=await ctx.host.request('commit',{path:relative,identity:known.identity,stamp:actual.stamp,directory:true});if(committed.committed){this.save(ctx,{...known,status:'cached'});ctx.needsReconcile=true;this.log(ctx,known,'upload','upload');}}continue;}
      if(actual.placeholder&&(actual.partial||actual.onDisk<actual.size)){await ctx.host.request('availability',{path:relative,identity:known.identity,mode:'local'},86400000);actual=await ctx.host.request('inspect',{path:relative});if(actual.partial||actual.onDisk<actual.size)throw new Error('err.nativeConflict');}
      if(known)this.save(ctx,{...known,status:'dirty'});
      await ensureSpace(ctx.cache,actual.size);
      const file=path.join(ctx.cache,'snapshot-'+randomUUID());
      await ctx.host.request('transfer',{path:relative,identity:known?.identity||'',busy:true}).catch(()=>{});
      try{
        let snapshot;try{snapshot=await ctx.host.request('snapshot',{path:relative,file});}catch(error){if(retryableNativeError(error)){this.recordError(ctx,error);ctx.changedPaths.add(relative);continue;}throw error;}
        await utimes(file,new Date(snapshot.modified),new Date(snapshot.modified));const checksum=await dropboxHash(file),uploadAbort=new AbortController();uploadAbort.nativePath=relative;ctx.uploads.add(uploadAbort);let remote;try{remote=await ctx.remote.upload(relative,file,known,{signal:uploadAbort.signal});}catch(error){if(uploadAbort.signal.aborted)throw new Error('err.canceled');throw error;}finally{ctx.uploads.delete(uploadAbort);}
        if(remote.hash!==checksum)throw new Error('err.nativeConflict');
        const item={...known,key:known?.key||randomUUID(),path:relative,...remote,status:'dirty'};const nextIdentity=identity(item);item.identity=known?.identity||nextIdentity;this.save(ctx,item);
        const committed=await ctx.host.request('commit',{path:relative,previousIdentity:known?.identity||'',identity:nextIdentity,stamp:snapshot.stamp});this.save(ctx,{...item,identity:committed.committed?nextIdentity:item.identity,status:committed.committed?'cached':'dirty'});ctx.needsReconcile=true;this.log(ctx,item,'upload','upload');
      }catch(error){error.nativePath||=relative;error.nativeCommand||='upload';
        // Only a real version conflict stops uploads; quota, name and temporary errors keep the file dirty for the next cycle.
        if(known)this.save(ctx,{...known,status:error.message==='err.nativeConflict'&&error.versionConflict!==false?'conflict':'dirty'});
        // One file in a version conflict must not stop every other upload. A new local file whose
        // name is already taken in Dropbox is tracked as a conflict and becomes a conflict copy.
        if(error.versionConflict){
          if(!known){const remote=await ctx.remote.metadata(relative).catch(()=>null);if(remote?.kind==='file'){const entry={...remote,key:randomUUID(),path:relative,status:'conflict'};entry.identity=identity(entry);this.save(ctx,entry);}}
          this.log(ctx,{path:relative,kind:'file',size:known?.size},'upload','upload','failed','err.nativeConflict');ctx.needsReconcile=true;continue;
        }
        throw error;}
      finally{await ctx.host.request('transfer',{path:relative,busy:false}).catch(()=>{});await unlink(file).catch(()=>{});}
    }
    }catch(error){if(requeue)for(const relative of requeue)ctx.changedPaths.add(relative);else ctx.changedPaths=null;throw error;}
  }
  async event(ctx,event){
    if(event.event==='cancel'){ctx.fetches.get(event.request)?.abort();return;}
    if(event.event==='changed'){this.noteChange(ctx,event.path);return;}
    if(event.event==='completed'){if(ctx.acc.native?.resetting)return;await this.serial(ctx,()=>finishDeletions(this,ctx));return;}
    if(event.event==='nativeError'){const error=new Error('err.nativeMoveOut');error.nativeCommand=event.operation;this.recordError(ctx,error);return;}
    if(event.event==='fetch'){
      if(ctx.noDownloadReset||(ctx.acc.native?.resetting&&ctx.acc.native.resetMode==='keepDownloaded')){await ctx.host.request('fail',{request:event.request}).catch(()=>{});return;}
      const source=this.byIdentity(ctx,event.identity);if(!source){await ctx.host.request('fail',{request:event.request}).catch(()=>{});return;}
      const item={...source},controller=new AbortController();controller.nativePath=item.path;ctx.fetches.set(event.request,controller);
      try{
        const offset=Math.floor(event.offset/4096)*4096,end=Math.min(item.size,event.length<0?item.size:Math.ceil((event.offset+event.length)/4096)*4096),length=end-offset;
        const stream=await ctx.remote.download(item,{offset,length,signal:controller.signal});let buffer=Buffer.alloc(0),position=offset;
        const deliver=async(data,final)=>{const file=path.join(ctx.cache,'chunk-'+randomUUID());await writeFile(file,data,{flag:'wx',mode:0o600});try{await ctx.host.request('supply',{request:event.request,file,offset:position,final});position+=data.length;}finally{await unlink(file).catch(()=>{});}};
        for await(const value of stream){if(controller.signal.aborted)throw new Error('err.canceled');buffer=Buffer.concat([buffer,Buffer.from(value)]);while(buffer.length>=1024*1024){const chunk=buffer.subarray(0,1024*1024);buffer=buffer.subarray(1024*1024);if(position+chunk.length>end)throw new Error('err.nativeNetwork');await deliver(chunk,position+chunk.length===end);}}
        if(buffer.length){if(position+buffer.length!==end)throw new Error('err.nativeNetwork');await deliver(buffer,true);}if(position!==end)throw new Error('err.nativeNetwork');if(!ctx.lastDownloads)ctx.lastDownloads=new Map();if(!ctx.lastDownloads.has(item.identity)||Date.now()-ctx.lastDownloads.get(item.identity)>5000){this.log(ctx,item,'download','download');ctx.lastDownloads.set(item.identity,Date.now());}
      }catch(error){await ctx.host.request('fail',{request:event.request}).catch(()=>{});if(!controller.signal.aborted){error.nativePath=item.path;error.nativeCommand='download';this.recordError(ctx,error);}}
      finally{ctx.fetches.delete(event.request);if(!ctx.closed)try{const actual=await ctx.host.request('inspect',{path:item.path}),current=ctx.items.get(item.key);if(!ctx.closed&&current?.identity===item.identity&&actual.exists&&actual.placeholder&&actual.identity===item.identity&&['online','cached','pinned'].includes(current.status))this.save(ctx,{...current,status:nativeFileStatus(actual)});}catch{/* A later metadata scan can refresh a busy or closing file. */}}
      return;
    }
    if(['delete','recycle'].includes(event.event)){
      if(ctx.acc.native?.resetting){await ctx.host.request('ack',{request:event.request,allow:false});return;}
      try{await this.userMutation(ctx,()=>prepareDeletion(this,ctx,event));await ctx.host.request('ack',{request:event.request,allow:true});}catch(error){error.nativePath=event.path;error.nativeCommand=event.event;this.recordError(ctx,error);await ctx.host.request('ack',{request:event.request,allow:false}).catch(()=>{});}return;
    }
    if(event.event==='rename'){
      if(ctx.acc.native?.resetting){await ctx.host.request('ack',{request:event.request,allow:false});return;}
      try{await this.userMutation(ctx,async()=>{
        const current=[...ctx.items.values()].find(i=>i.identity===event.identity||i.path===event.path.replaceAll('\\','/'));
        if(!current)return;
        const affected=[...ctx.items.values()].filter(i=>contains(current.path,i.path));for(const item of affected){const state=await ctx.host.request('inspect',{path:item.path});const renameOnly=item.status==='pendingRename'&&!state.dirtyBytes&&state.size===item.size&&Math.abs(state.modified-item.modified)<=1000;if(state.exists&&((!state.inSync&&!renameOnly)||state.dirtyBytes))throw new Error('err.nativeConflict');}
        {const target=event.target.replaceAll('\\','/');if(!supported(target))throw new Error('err.mapping');if(!effectivePolicy(target,ctx.acc.settings.rules).selected&&!ctx.acc.settings.rules[current.path]?.selected)throw new Error('err.nativeSelection');const moved=await ctx.remote.move(current,target);this.log(ctx,current,'rename','upload','succeeded','',target);for(const item of affected){const changed={...item,...(item.key===current.key?moved:{}),path:target+item.path.slice(current.path.length),status:'pendingRename'};changed.pendingIdentity=identity(changed);this.save(ctx,changed);}const rules={};for(const [p,rule]of Object.entries(ctx.acc.settings.rules))rules[contains(current.path,p)?target+p.slice(current.path.length):p]=rule;ctx.acc.settings.rules=rules;await this.persist();}
      });await ctx.host.request('ack',{request:event.request,allow:true});}catch(error){this.recordError(ctx,error);await ctx.host.request('ack',{request:event.request,allow:false}).catch(()=>{});}
    }
  }
  // Roadmap 1B: turn real version conflicts into conflict copies. Uses the cloud listing of the
  // reconcile that just ran; nothing here overwrites or deletes data that is not already in Dropbox.
  async resolveConflicts(ctx){
    if(!ctx.remoteCatalog)return;
    const candidates=[...ctx.items.values()].filter(i=>i.status==='conflict'&&i.kind==='file'&&!blockedPath(ctx,i.path)&&!deleting(ctx,i.path));if(!candidates.length)return;
    const canonical=value=>value.normalize('NFC').toLowerCase(),byPath=new Map(ctx.remoteCatalog.map(remote=>[canonical(remote.path),remote]));
    for(const item of candidates){
      ctx.operation?.signal.throwIfAborted();
      const remote=byPath.get(canonical(item.path)),state=await ctx.host.request('inspect',{path:item.path});
      if(!resolvable(item,state,remote))continue;
      try{const result=await resolveConflict(this,ctx,item,{remote,state});if(result.resolved)ctx.conflictCopies=(ctx.conflictCopies||0)+1;}
      catch(error){error.nativePath||=item.path;error.nativeCommand||='upload';throw error;}
    }
  }
  // Roadmap 4.2: long-polls Dropbox with the cursors of the last complete listing. A change sets
  // ctx.cloudChanged, which makes the next background cycle (within 5 s) check the cloud.
  async watchCloud(ctx,{retryMs=30000,idleMs=5000}={}){
    if(!ctx.remote?.longpoll||ctx.cloudWatch)return;
    const watch=ctx.cloudWatch={healthy:false,generation:0};
    const pause=ms=>new Promise(resolve=>{const timer=setTimeout(resolve,ms);watch.wake=()=>{clearTimeout(timer);resolve();};});
    while(!ctx.closed&&!this.closed){
      const cursors=ctx.cursors;
      if(!cursors?.size||ctx.cloudChanged||ctx.suspended||this.paused){await pause(idleMs);continue;}
      const generation=ctx.cursorGeneration,controller=new AbortController();watch.controller=controller;
      try{
        const result=await Promise.race([...cursors.values()].map(cursor=>ctx.remote.longpoll(cursor,{timeout:120,signal:controller.signal})));
        watch.healthy=true;
        if(result.changes&&generation===ctx.cursorGeneration)ctx.cloudChanged=true;
        if(result.backoff)await pause(result.backoff*1000);
      }catch(error){
        if(ctx.closed||this.closed)break;
        watch.healthy=false;if(error.reset){ctx.cursors=null;ctx.cloudChanged=true;}
        await pause(retryMs);
      }finally{controller.abort();}
    }
    watch.healthy=false;
  }
  // Roadmap 4.7: identity -> item in O(1) for download callbacks. The index is rebuilt only when a
  // lookup finds a stale or missing entry, so code that edits ctx.items directly stays correct.
  byIdentity(ctx,identity){
    const check=key=>{const item=key&&ctx.items.get(key);return item?.identity===identity?item:null;};
    let found=check(ctx.identityIndex?.get(identity));if(found)return found;
    ctx.identityIndex=new Map([...ctx.items.values()].map(item=>[item.identity,item.key]));
    return check(ctx.identityIndex.get(identity));
  }
  // A changed local path. Unknown (null) or too many at once means: walk everything next time.
  noteChange(ctx,relative){ctx.changed=true;if(typeof relative!=='string'||!relative||!(ctx.changedPaths instanceof Set)||ctx.changedPaths.size>=5000){ctx.changedPaths=null;return;}ctx.changedPaths.add(relative.replaceAll('\\','/'));}
  // Batched local inspection (roadmap 4.6). Returns a Map of the states it could read; a path that
  // failed, or every path when the helper predates `inspectMany`, is left out and the caller asks
  // for it alone. Old helpers answer an unknown command with E_INVALIDARG.
  async inspectMany(ctx,paths){
    const states=new Map();if(!paths.length||ctx.batchInspect===false)return states;
    try{
      for(let start=0;start<paths.length;start+=INSPECT_BATCH){
        ctx.operation?.signal.throwIfAborted();const chunk=paths.slice(start,start+INSPECT_BATCH);
        const answer=await ctx.host.request('inspectMany',{paths:chunk},120000);
        chunk.forEach((relative,n)=>{const state=answer?.states?.[n];if(state&&!state.error)states.set(relative,state);});
        if(start+INSPECT_BATCH<paths.length)await yieldToEventLoop();
      }
    }catch(error){if(error.nativeCode?.toLowerCase()!=='0x80070057'||error.nativeCommand!=='inspectMany')throw error;ctx.batchInspect=false;states.clear();}
    return states;
  }
  // Roadmap 3.2: pinning ("always keep on this device") downloads in a separate lane with at most
  // HYDRATION_LANES files at a time. The serialized lane (scans, uploads, Explorer deletions and
  // renames) never waits for a download. A queued file is skipped if it changed meanwhile, and a
  // failed or skipped one is queued again by the next check.
  hydrate(ctx,item,{log=false}={}){
    if(!ctx.hydrations)ctx.hydrations=new Map();
    if(ctx.closed||ctx.hydrations.has(item.key))return;
    ctx.hydrations.set(item.key,{identity:item.identity,started:false,log});this.pumpHydrations(ctx);
  }
  pumpHydrations(ctx){
    ctx.hydrating??=0;
    for(const [key,job] of ctx.hydrations){
      if(ctx.hydrating>=HYDRATION_LANES)break;if(job.started)continue;job.started=true;ctx.hydrating++;
      (async()=>{
        try{
          if(ctx.closed||ctx.suspended||this.paused||ctx.acc.native?.resetting)return;
          const current=ctx.items.get(key);if(!current||current.identity!==job.identity||deleting(ctx,current.path))return;
          await ctx.host.request('availability',{path:current.path,identity:current.identity,mode:'local'},86400000);
          const actual=await ctx.host.request('inspect',{path:current.path}),latest=ctx.items.get(key);
          if(latest?.identity===current.identity&&actual.exists&&actual.identity===current.identity&&latest.status!=='conflict')this.save(ctx,{...latest,status:nativeFileStatus(actual)});
          if(job.log)this.log(ctx,current,'local','none');
        }catch(error){if(!ctx.closed&&error.message!=='err.nativeStopped'){error.nativePath||=ctx.items.get(key)?.path;error.nativeCommand||='local';this.recordError(ctx,error);}}
        finally{ctx.hydrating--;ctx.hydrations.delete(key);this.pumpHydrations(ctx);}
      })();
    }
  }
  async setReview(ctx,review){ctx.review=review;if(review)this.store.saveNativeReview?.(ctx.acc.id,review);else this.store.deleteNativeReview?.(ctx.acc.id);}
  // Copies the only local copy of a file before its placeholder is removed or replaced.
  async quarantine(ctx,item){
    const target=await quarantineFile({dataDir:this.dataDir,accountId:ctx.acc.id,root:ctx.acc.native.root,relative:item.path});
    this.log(ctx,item,'quarantine','none','succeeded','',path.relative(quarantineRoot(this.dataDir,ctx.acc.id),target).split(path.sep).join('/'));return target;
  }
  quarantinePath(acc){return quarantineRoot(this.dataDir,acc.id);}
  // The user's decision on a pending mass deletion. Inbound (from Dropbox): 'apply' removes the
  // local copies (downloaded files go to quarantine), 'restore' brings the files back in Dropbox.
  // Outbound (a folder deleted in Explorer): 'confirm' deletes it in Dropbox, 'cancel' restores it here.
  async decide(acc,action,operationId){
    const ctx=await this.start(acc);if(acc.native?.resetting)throw new Error('err.reset');
    if(action==='apply'||action==='restore'){
      const review=ctx.review;if(!review||review.approved)return this.status(acc);
      if(action==='apply'){await this.setReview(ctx,{...review,approved:true});ctx.needsReconcile=true;return this.refresh(acc);}
      await this.serial(ctx,async()=>{
        const files=review.items.filter(i=>i.kind==='file'&&i.rev),folders=review.items.filter(i=>i.kind==='folder').sort(order);let failed=0;
        for(const item of files){ctx.operation?.signal.throwIfAborted();try{await ctx.remote.restore(item);this.log(ctx,item,'restore','upload');}catch(error){if(error.message==='err.canceled')throw error;failed++;this.log(ctx,item,'restore','upload','failed',error.message?.startsWith('err.')?error.message:'err.operation');}}
        for(const item of folders){ctx.operation?.signal.throwIfAborted();try{await ctx.remote.createFolder(item.path);}catch(error){if(error.message==='err.canceled')throw error;/* Already recreated by its files. */}}
        // Anything that could not be restored is raised again by the next check if it still exceeds the threshold.
        await this.setReview(ctx,null);ctx.needsReconcile=true;if(failed)ctx.detail=String(failed);
      },{user:true});
      return this.refresh(acc);
    }
    if(action==='confirm'||action==='cancel'){
      // `operationId` names a batch (or a single operation from before batching).
      const ops=[...ctx.deletions.values()].filter(op=>op.batch===operationId||op.id===operationId);if(!ops.length)return this.status(acc);
      await this.serial(ctx,async()=>{
        if(action==='confirm'){for(const op of ops){const next={...op,confirmed:true};ctx.deletions.set(op.id,next);this.store.saveNativeDeletion(ctx.acc.id,next);}await finishDeletions(this,ctx);return;}
        for(const op of ops){
          const current=op.items.find(i=>i.path===op.path)||{kind:'folder',size:0};
          this.store.cancelNativeDeletion(ctx.acc.id,op,{path:op.path,kind:current.kind,size:current.size,action:op.action,direction:'none',status:'failed',detail:'err.nativeDeleteCanceled'});
          ctx.deletions.delete(op.id);
        }
        ctx.needsReconcile=true;
      },{user:true});
      return this.refresh(acc);
    }
    throw new Error('err.settings');
  }
  async finishRename(ctx,item){await ctx.host.request('markMetadata',{path:item.path,previousIdentity:item.identity,identity:item.pendingIdentity||item.identity,size:item.size,modified:item.modified,directory:item.kind==='folder'});const next={...item,identity:item.pendingIdentity||item.identity,status:'cached'};delete next.pendingIdentity;this.save(ctx,next);}
  async detachUninitialized(acc){
    const ctx=this.contexts.get(acc.id);
    // Old catalog/deletion records can outlive a failed init. They are archived
    // by the caller before forgetting the account, never replayed against a new root.
    if(!ctx?.failed||ctx.registration)return false;
    if(ctx.uninitializedReleased)return true;
    if(!ctx.host||ctx.host.closed)return false;
    // Use the EXISTING native releaseEmpty guard unchanged: it does nothing
    // when ownsRoot(root) is false, and releases only an empty owned root.
    await ctx.host.request('releaseEmpty');ctx.uninitializedReleased=true;ctx.closed=true;clearInterval(ctx.timer);ctx.watcher?.close();ctx.remote.cancel?.();await ctx.host.close();return true;
  }
  async forgetEmpty(acc){const ctx=this.contexts.get(acc.id);if(!ctx||!ctx.failed||ctx.items.size||ctx.deletions?.size)throw new Error('err.nativeExclusive');await ctx.host?.request('releaseEmpty');ctx.closed=true;await ctx.host?.close();this.contexts.delete(acc.id);}
  async releaseEmptyRoot(acc){
    const ctx=await this.start(acc);await this.serial(ctx,async()=>{
      if(ctx.items.size||ctx.deletions.size||ctx.fetches.size||ctx.uploads.size||this.store.nativeItems(acc.id).length||this.store.nativeDeletions(acc.id).length||(await readdir(acc.native.root)).length||(await readdir(ctx.cache)).some(name=>name!=='index-scope.txt'))throw new Error('err.accountRootBusy');
      await ctx.host.request('releaseEmpty');ctx.closed=true;clearInterval(ctx.timer);ctx.watcher?.close();
    });await ctx.host.close();ctx.remote.cancel?.();this.contexts.delete(acc.id);
  }
  async availability(acc,relative,mode){const ctx=await this.start(acc);try{return await this.serial(ctx,async()=>{await finishDeletions(this,ctx);await this.scan(ctx);await this.reconcile(ctx);for(const item of [...ctx.items.values()].filter(i=>i.kind==='file'&&contains(relative,i.path)&&!blockedPath(ctx,i.path))){if(mode==='local'){this.hydrate(ctx,item,{log:true});continue;}await ctx.host.request('availability',{path:item.path,identity:item.identity,mode},86400000);const actual=await ctx.host.request('inspect',{path:item.path});this.save(ctx,{...item,status:nativeFileStatus(actual)});this.log(ctx,item,mode,'none');}return this.status(acc);});}catch(error){if(retryableNativeError(error))return this.status(acc);throw error;}}
  async detachInactiveEmpty(acc){
    const previous=this.contexts.get(acc.id);
    if(this.store.nativeItems(acc.id).length||this.store.nativeDeletions(acc.id).length||(await readdir(acc.native.root)).length)return false;
    const cache=path.join(this.dataDir,'native-cache',acc.id),files=await readdir(cache).catch(error=>{if(error.code==='ENOENT')return [];throw error;});if(files.some(name=>name!=='index-scope.txt'))throw new Error('err.reset');if(previous&&!previous.failed)return false;
    if(previous){previous.closed=true;clearInterval(previous.timer);previous.watcher?.close();await previous.ready.catch(()=>{});await previous.host?.close();await previous.queue.catch(()=>{});this.contexts.delete(acc.id);}
    const host=new NativeHost(this.binary);try{await host.request('releaseInactiveEmpty',{root:acc.native.root,cache,owner:acc.native.owner});return true;}finally{await host.close();}
  }
  async detach(acc,{keepDownloaded=false}={}){if(await missingRoot(acc.native.root)){const stale=this.contexts.get(acc.id);if(stale){stale.closed=true;clearInterval(stale.timer);stale.watcher?.close();stale.remote.cancel?.();await stale.ready.catch(()=>{});await stale.host?.close();await stale.queue.catch(()=>{});this.contexts.delete(acc.id);}return {missing:true};}if(keepDownloaded){
      const completed=await readFile(path.join(this.dataDir,'native-cache',acc.id,'reset-complete.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(completed&&path.resolve(completed.root).toLowerCase()===path.resolve(acc.native.root).toLowerCase()&&completed.owner==='AMG.CloudFiles/'+acc.native.owner&&!await this.isManagedRoot(acc.native.root))return {missing:false};
    }
    if(await this.detachUninitialized(acc))return {uninitialized:true};
    if(await this.detachInactiveEmpty(acc))return {missing:false};const ctx=await this.start(acc);
    if(keepDownloaded){ctx.noDownloadReset=true;this.cancelAccount(acc.id);}
    await this.serial(ctx,async()=>{
      if(keepDownloaded)await ctx.host.request('freezeForReset');
      if(!keepDownloaded){await finishDeletions(this,ctx);if(ctx.deletions.size)throw new Error('err.nativePendingDeletion');}
      else{for(let attempt=0;ctx.fetches.size||ctx.uploads.size;attempt++){ctx.operation.signal.throwIfAborted();if(attempt>=600)throw new Error('err.resetBusy');await new Promise(resolve=>setTimeout(resolve,50));}}
      ctx.detachKeep=keepDownloaded;try{await ctx.host.request(keepDownloaded?'detachKeepDownloaded':'detach',{items:[...ctx.items.values()].map(({path,identity})=>({path,identity})),...(keepDownloaded?{recovery:path.join(ctx.cache,'reset-recovery')}:{})},86400000);}finally{ctx.detachKeep=false;}
    });ctx.closed=true;clearInterval(ctx.timer);ctx.watcher?.close();await ctx.host.close();ctx.remote.cancel?.();this.contexts.delete(acc.id);return {missing:false};}
  async isManagedRoot(root){const host=new NativeHost(this.binary);try{return (await host.request('checkPath',{path:root})).registered;}finally{await host.close();}}
  async drives(){const ctx=[...this.contexts.values()].find(c=>c.host&&!c.host.closed);if(ctx){await ctx.ready;return ctx.host.request('drives');}const host=new NativeHost(this.binary);try{return await host.request('drives');}finally{await host.close();}}
  setPaused(value){this.paused=value;if(value)this.cancel();else for(const ctx of this.contexts.values())ctx.suspended=false;}
  cancelAccount(id){const ctx=this.contexts.get(id);if(!ctx)return;ctx.userCancelGeneration=(ctx.userCancelGeneration||0)+1;ctx.cancelGeneration=(ctx.cancelGeneration||0)+1;ctx.suspended=true;ctx.needsReconcile=true;ctx.operation?.abort(new Error('err.canceled'));for(const controller of ctx.fetches.values())controller.abort();for(const controller of ctx.uploads)controller.abort();if(ctx.detachKeep)ctx.host.request('cancelReset').catch(()=>{});}
  cancel(){for(const id of this.contexts.keys())this.cancelAccount(id);}
  async close(){this.closed=true;this.cancel();for(const ctx of this.contexts.values()){ctx.remote.cancel?.();ctx.closed=true;await ctx.ready.catch(()=>{});clearInterval(ctx.timer);ctx.watcher?.close();await ctx.host?.close();await ctx.queue.catch(()=>{});}}
}
