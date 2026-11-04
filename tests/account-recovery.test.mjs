import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {archiveMissingRoot,archiveResetRoot,missingRoot} from '../core/account-recovery.mjs';
import {NativeProviders} from '../core/native-provider.mjs';

test('missing root recovery preserves cache and catalog without storing credentials or recreating folders',async()=>{
  const dataDir=path.resolve('.runtime/recovery-tests',randomUUID()),root=path.join(dataDir,'deleted-root');await mkdir(path.join(dataDir,'native-cache','account'),{recursive:true});await writeFile(path.join(dataDir,'native-cache','account','snapshot'),'unsent bytes');
  const account={id:'account',name:'Fixture',config:'SECRET MUST NOT BE COPIED',native:{enabled:true,root,owner:randomUUID()}};
  const directory=await archiveMissingRoot({dataDir,account,items:[{key:'file',path:'Project/file.bin'}],jobs:[]});
  assert.equal(await missingRoot(root),true);assert.equal(await readFile(path.join(directory,'cached-files','snapshot'),'utf8'),'unsent bytes');
  const metadata=await readFile(path.join(directory,'metadata.json'),'utf8');assert.ok(!metadata.includes('SECRET'));assert.equal(JSON.parse(metadata).items.length,1);assert.equal(await stat(path.join(dataDir,'native-cache','account')).catch(()=>null),null);
});
test('existing roots are not treated as missing or archived',async()=>{
  const dataDir=path.resolve('.runtime/recovery-tests',randomUUID()),root=path.join(dataDir,'existing');await mkdir(root,{recursive:true});await writeFile(path.join(root,'keep.txt'),'keep');
  assert.equal(await missingRoot(root),false);await assert.rejects(()=>archiveMissingRoot({dataDir,account:{id:'account',native:{root}},items:[],jobs:[]}),/err.reset/);assert.equal(await readFile(path.join(root,'keep.txt'),'utf8'),'keep');
});

test('a never-initialized failed account disconnects without enumerating or downloading a foreign root, leaving the other account active',async()=>{
  const root=path.resolve('.runtime/recovery-tests',randomUUID());await mkdir(root,{recursive:true});await writeFile(path.join(root,'foreign.txt'),'foreign data');let releases=0;
  const acc={id:'mix',native:{enabled:true,root}},other={items:new Map([['animagrad',{}]])},providers=new NativeProviders({store:{nativeItems:()=>[],nativeDeletions:()=>[]}}),ctx={failed:true,items:new Map(),deletions:new Map(),host:{request:async command=>{assert.equal(command,'releaseEmpty');releases++;},close:async()=>{}},remote:{cancel(){}}};providers.contexts.set('mix',ctx);providers.contexts.set('animagrad',other);
  assert.deepEqual(await providers.detach(acc),{uninitialized:true});assert.deepEqual(await providers.detach(acc),{uninitialized:true});assert.equal(releases,1);assert.equal(providers.contexts.get('animagrad'),other);assert.equal(await readFile(path.join(root,'foreign.txt'),'utf8'),'foreign data');
});

test('saved catalog and pending intent do not prevent forgetting a failed initialization; all records remain available for recovery',async()=>{
  const root=path.resolve('.runtime/recovery-tests',randomUUID());await mkdir(root,{recursive:true});const item={key:'old',path:'old.bin',status:'dirty'},op={id:'pending',items:[item]},acc={id:'mix',native:{enabled:true,registered:true,root}};let released=0;
  const providers=new NativeProviders({dataDir:root,store:{nativeItems:()=>[item],nativeDeletions:()=>[op]}}),ctx={failed:true,items:new Map([['old',item]]),deletions:new Map([['pending',op]]),host:{request:async name=>{assert.equal(name,'releaseEmpty');released++;},close:async()=>{}},remote:{cancel(){}}};providers.contexts.set(acc.id,ctx);
  assert.deepEqual(await providers.detach(acc,{keepDownloaded:true}),{uninitialized:true});assert.equal(released,1);assert.equal(ctx.items.get('old'),item);assert.equal(ctx.deletions.get('pending'),op);
});

test('no-download reset archives partial bytes, snapshots and pending metadata outside cleared caches without credentials',async()=>{
  const dataDir=path.resolve('.runtime/recovery-tests',randomUUID()),cache=path.join(dataDir,'native-cache','account'),root=path.join(dataDir,'project');await mkdir(path.join(cache,'reset-recovery'),{recursive:true});await mkdir(root);await writeFile(path.join(cache,'reset-recovery','file.partial'),'downloaded range');await writeFile(path.join(cache,'snapshot'),'unsent snapshot');await writeFile(path.join(root,'kept.txt'),'ordinary local data');
  const directory=await archiveResetRoot({dataDir,account:{id:'account',config:'SECRET MUST NOT BE COPIED',native:{root,owner:'fixture'}},items:[{path:'partial.bin'}],jobs:[],deletions:[{path:'pending-delete.bin'}]});
  assert.equal(await readFile(path.join(directory,'cached-files/reset-recovery/file.partial'),'utf8'),'downloaded range');assert.equal(await readFile(path.join(directory,'cached-files/snapshot'),'utf8'),'unsent snapshot');assert.equal(await readFile(path.join(root,'kept.txt'),'utf8'),'ordinary local data');const text=await readFile(path.join(directory,'metadata.json'),'utf8');assert.ok(!text.includes('SECRET'));assert.equal(JSON.parse(text).deletions[0].path,'pending-delete.bin');assert.equal(await stat(cache).catch(()=>null),null);
});
test('a missing native root reports an actionable error and can detach without a helper or server changes',async()=>{
  const dataDir=path.resolve('.runtime/recovery-tests',randomUUID()),root=path.join(dataDir,'missing'),account={id:'account',native:{enabled:true,root,owner:randomUUID()}};let writes=0;
  const providers=new NativeProviders({binary:'must-not-launch',dataDir,store:{nativeItems:()=>[],nativeDeletions:()=>[],addFileEvent(){}},transport:()=>({cancel(){},upload(){writes++;}}),persist:async()=>{}});
  await assert.rejects(()=>providers.start(account),/err.nativeRootMissing/);assert.equal(providers.status(account).error,'err.nativeRootMissing');assert.deepEqual(await providers.detach(account),{missing:true});assert.equal(writes,0);assert.equal(await missingRoot(root),true);await providers.close();
});

test('a completed native reset can retry profile cleanup without registering a nonempty local folder again',async()=>{
  const dataDir=path.resolve('.runtime/recovery-tests',randomUUID()),root=path.join(dataDir,'project'),cache=path.join(dataDir,'native-cache','account'),owner=randomUUID();await mkdir(root,{recursive:true});await mkdir(cache,{recursive:true});await writeFile(path.join(root,'kept.txt'),'downloaded data');await writeFile(path.join(cache,'reset-complete.json'),JSON.stringify({root,owner:'AMG.CloudFiles/'+owner}));
  const providers=new NativeProviders({binary:'must-not-launch',dataDir,store:{},transport:()=>{throw new Error('Network must not run');},persist:async()=>{}});providers.isManagedRoot=async()=>false;
  assert.deepEqual(await providers.detach({id:'account',native:{enabled:true,root,owner}},{keepDownloaded:true}),{missing:false});assert.equal(await readFile(path.join(root,'kept.txt'),'utf8'),'downloaded data');await providers.close();
});
