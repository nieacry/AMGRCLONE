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
