import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeProviders,INSPECT_BATCH} from '../core/native-provider.mjs';
import {itemIdentity} from '../core/native-deletions.mjs';
import {DropboxTransport} from '../core/dropbox-transport.mjs';
import {ensureSpace} from '../core/deletion-guard.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(files=1200,{batch=true}={}){
  const root=path.resolve(import.meta.dirname,'../.runtime/performance',randomUUID());await mkdir(root,{recursive:true});
  const counts={},batches=[],disk=new Map(),items=new Map(),cloud=[];
  for(let n=0;n<files;n++){const item={key:'k'+n,path:`f${n}.bin`,kind:'file',remoteId:'id:'+n,rev:'r1',size:4,status:'online'};item.identity=itemIdentity(item);items.set(item.key,item);disk.set(item.path,{exists:true,placeholder:true,identity:item.identity,inSync:true,partial:true,onDisk:0,size:4,pin:0});cloud.push({path:item.path,remoteId:item.remoteId,rev:'r1',kind:'file',size:4});await writeFile(path.join(root,item.path),'');}
  const host={request:async(command,value={})=>{counts[command]=(counts[command]||0)+1;
    if(command==='inspect')return disk.get(value.path)||{exists:false};
    if(command==='inspectMany'){if(!batch)throw Object.assign(new Error('err.native'),{nativeCode:'0x80070057',nativeCommand:'inspectMany'});batches.push(value.paths.length);return {states:value.paths.map(p=>disk.get(p)||{exists:false})};}
    return {};}};
  const acc={id:'p',settings:{rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,root}};
  const providers=new NativeProviders({store:{addFileEvent(){},saveNativeItem(){},deleteNativeItem(){}},persist:async()=>{}});
  const ctx={acc,host,items,deletions:new Map(),fetches:new Map(),uploads:new Set(),queue:Promise.resolve(),remote:{list:async()=>cloud}};
  const reset=()=>{for(const key in counts)delete counts[key];batches.length=0;};
  return {providers,ctx,counts,batches,disk,root,reset};
}

test('an idle cloud check reads local state in batches, not one request per file',async()=>{
  const f=await fixture(1200);await f.providers.reconcile(f.ctx);
  assert.deepEqual(f.batches,[INSPECT_BATCH,INSPECT_BATCH,1200-2*INSPECT_BATCH]);assert.equal(f.counts.inspect,undefined,'no single inspections');
});

test('a full local scan also reads in batches; an unchanged project costs nothing afterwards',async()=>{
  const f=await fixture(1200);await f.providers.scan(f.ctx);
  assert.equal(f.counts.inspectMany,3);assert.equal(f.counts.inspect,undefined);
  f.reset();await f.providers.scan(f.ctx);assert.deepEqual(f.counts,{},'nothing changed, nothing inspected');
});

test('after one local change only that path and its folders are examined',async()=>{
  const f=await fixture(50);await f.providers.scan(f.ctx);await mkdir(path.join(f.root,'Shots','010'),{recursive:true});await writeFile(path.join(f.root,'Shots','010','new.psd'),'x');
  f.reset();f.providers.noteChange(f.ctx,'Shots\\010\\new.psd');
  await f.providers.scan(f.ctx).catch(()=>{});
  assert.deepEqual(f.batches,[3],'Shots, Shots/010, Shots/010/new.psd');assert.equal(f.ctx.metrics.lastScanFull,false);
});

test('an unknown or flooding change list falls back to a full scan',async()=>{
  const f=await fixture(20);await f.providers.scan(f.ctx);
  f.providers.noteChange(f.ctx,null);f.reset();await f.providers.scan(f.ctx);assert.equal(f.ctx.metrics.lastScanFull,true);assert.equal(f.ctx.metrics.lastScanPaths,20);
  for(let n=0;n<5001;n++)f.providers.noteChange(f.ctx,`x${n}`);assert.equal(f.ctx.changedPaths,null);
});

test('a full scan still happens every 10-15 minutes as a safety net',async()=>{
  const f=await fixture(10);await f.providers.scan(f.ctx);
  f.ctx.lastFullScan=Date.now()-16*60000;f.reset();await f.providers.scan(f.ctx);assert.equal(f.ctx.metrics.lastScanFull,true);
});

test('a failed incremental pass keeps its paths for the next pass',async()=>{
  const f=await fixture(10);await f.providers.scan(f.ctx);f.providers.noteChange(f.ctx,'f3.bin');
  f.ctx.host.request=async command=>{if(command==='inspectMany')throw Object.assign(new Error('err.native'),{nativeCode:'0x8007001f'});return {};};
  await assert.rejects(f.providers.scan(f.ctx));assert.deepEqual([...f.ctx.changedPaths],['f3.bin']);
});

test('an older helper without inspectMany is detected once and single inspections are used',async()=>{
  const f=await fixture(30,{batch:false});await f.providers.reconcile(f.ctx);
  assert.equal(f.counts.inspectMany,1);assert.equal(f.counts.inspect,30);assert.equal(f.ctx.batchInspect,false);
  f.reset();await f.providers.reconcile(f.ctx);assert.equal(f.counts.inspectMany,undefined,'not asked again');
});

test('a path that fails inside a batch is inspected alone',async()=>{
  const f=await fixture(5),original=f.ctx.host.request;
  f.ctx.host.request=async(command,value)=>{if(command==='inspectMany'){const answer=await original(command,value);answer.states[2]={error:'0x80070005'};return answer;}return original(command,value);};
  const states=await f.providers.inspectMany(f.ctx,['f0.bin','f1.bin','f2.bin','f3.bin','f4.bin']);
  assert.deepEqual([...states.keys()],['f0.bin','f1.bin','f3.bin','f4.bin']);
});

test('the cloud watch long-polls without a token and reports changes and cursor resets',async()=>{
  const original=globalThis.fetch,calls=[];
  try{
    globalThis.fetch=async(url,options)=>{calls.push({url,headers:options.headers,body:JSON.parse(options.body)});return Response.json({changes:true,backoff:7});};
    const remote=new DropboxTransport({auth:async()=>{throw new Error('no token needed');}});
    assert.deepEqual(await remote.longpoll('cursor-1',{timeout:120}),{changes:true,backoff:7});
    assert.equal(calls[0].url,'https://notify.dropboxapi.com/2/files/list_folder/longpoll');assert.equal(calls[0].headers.Authorization,undefined);assert.deepEqual(calls[0].body,{cursor:'cursor-1',timeout:120});
    globalThis.fetch=async()=>Response.json({error_summary:'reset/..'},{status:409});
    await assert.rejects(remote.longpoll('old'),error=>error.reset===true);
  }finally{globalThis.fetch=original;}
});

test('a complete listing hands its final cursor to the cloud watch',async()=>{
  const remote=new DropboxTransport({auth:async()=>'t'});let page=0;
  remote.request=async endpoint=>endpoint==='files/list_folder'?{entries:[{'.tag':'file',id:'id:a',rev:'r',path_display:'/a',size:1}],has_more:true,cursor:'c1'}:{entries:[{'.tag':'file',id:'id:b',rev:'r',path_display:'/b',size:1}],has_more:false,cursor:'c2'};
  let final=null;for await(const _ of remote.listPages('',true,{onCursor:cursor=>{final=cursor;}}))page++;
  assert.equal(page,2);assert.equal(final,'c2');
  const f=await fixture(0);f.ctx.remote=remote;await f.providers.collect(f.ctx);
  assert.deepEqual([...f.ctx.cursors],[['','c2']]);assert.equal(f.ctx.cursorGeneration,1);
});

test('a change seen by the long poll triggers a check; a healthy watch slows the safety check to 10-15 minutes',async()=>{
  const f=await fixture(0);let checks=0;f.providers.scan=async()=>{};f.providers.reconcile=async ctx=>{checks++;ctx.cloudChanged=false;ctx.lastChecked=Date.now();ctx.needsReconcile=false;};
  f.ctx.lastChecked=Date.now()-5*60000;f.ctx.needsReconcile=false;f.ctx.cloudWatch={healthy:true};
  await f.providers.background(f.ctx);assert.equal(checks,0,'5 minutes old, watch healthy: not due');
  f.ctx.cloudChanged=true;await f.providers.background(f.ctx);assert.equal(checks,1);
  f.ctx.cloudWatch.healthy=false;f.ctx.lastChecked=Date.now()-80000;await f.providers.background(f.ctx);assert.equal(checks,2,'without the watch: the 60-75 s rule');
});

test('the watch loop marks changes, survives errors and drops a reset cursor',async()=>{
  const f=await fixture(0),answers=[{changes:false},{changes:true},'error','reset'];let polls=0;
  f.ctx.cursors=new Map([['','c']]);f.ctx.cursorGeneration=1;
  f.ctx.remote={longpoll:async()=>{const answer=answers[polls++];if(answer==='error')throw new Error('err.nativeNetwork');if(answer==='reset')throw Object.assign(new Error('err.nativeConflict'),{reset:true});if(answer===undefined){f.ctx.closed=true;return {changes:false};}return answer;}};
  const loop=f.providers.watchCloud(f.ctx,{retryMs:1,idleMs:1});
  while(!f.ctx.cloudChanged)await tick();assert.equal(f.ctx.cloudWatch.healthy,true);
  f.ctx.cloudChanged=false;while(polls<4)await tick();await tick();await tick();
  assert.equal(f.ctx.cursors,null);assert.equal(f.ctx.cloudChanged,true);assert.equal(f.ctx.cloudWatch.healthy,false);
  f.ctx.closed=true;await loop;
});

test('download callbacks find their file by identity without scanning the catalog',async()=>{
  const f=await fixture(3),item=f.ctx.items.get('k1');
  assert.equal(f.providers.byIdentity(f.ctx,item.identity),item);
  const changed={...item,identity:'k1@new'};f.ctx.items.set('k1',changed);
  assert.equal(f.providers.byIdentity(f.ctx,'k1@new'),changed);assert.equal(f.providers.byIdentity(f.ctx,item.identity),null);
});

test('an upload stops early with a clear error when the profile disk is nearly full',async()=>{
  await assert.rejects(ensureSpace('x',100*1024*1024,{probe:async()=>({bavail:200,bsize:1024*1024})}),/err.diskFull/);
  await ensureSpace('x',10*1024*1024,{probe:async()=>({bavail:400,bsize:1024*1024})});
  await ensureSpace('x',10**12,{probe:async()=>{throw new Error('unsupported');}});
});
