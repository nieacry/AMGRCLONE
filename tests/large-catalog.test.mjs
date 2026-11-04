import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import {DropboxTransport} from '../core/dropbox-transport.mjs';
import {NativeProviders} from '../core/native-provider.mjs';

const TOTAL=150_123,PAGE=2000;
function transport({total=TOTAL,failAt=Infinity,collision=false}={}){
  const remote=new DropboxTransport({auth:async()=>{throw new Error('No authentication/network allowed in this fixture');}}),calls=[];
  remote.request=async(endpoint,body,{signal}={})=>{
    signal?.throwIfAborted();calls.push({endpoint,body});
    const start=endpoint==='files/list_folder'?0:Number(body.cursor);
    if(start>=failAt)throw new Error('err.nativeNetwork');
    const end=Math.min(start+PAGE,total),entries=Array.from({length:end-start},(_v,n)=>{
      const i=start+n;return {'.tag':'file',id:'id:'+i,rev:'r1',path_display:'/Project/'+(collision&&i===total-1?'FILE-0.bin':`file-${i}.bin`),size:1024**3};
    });
    return {entries,has_more:end<total,cursor:String(end)};
  };
  return {remote,calls};
}
function providerFixture(remote){
  const commands=new Map(),disk=new Map(),events=[],acc={id:'large',settings:{rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,lastSync:42}};
  const provider=new NativeProviders({store:{saveNativeItem(){},deleteNativeItem(){},addFileEvent(_id,event){events.push(event);}},persist:async()=>{}});
  const ctx={acc,remote,items:new Map(),deletions:new Map(),fetches:new Map(),uploads:new Set(),operation:new AbortController(),host:{request:async(command,value={})=>{
    commands.set(command,(commands.get(command)||0)+1);
    if(command==='inspect')return disk.get(value.path)||{exists:false};
    if(command==='create')disk.set(value.path,{exists:true,placeholder:true,identity:value.identity,inSync:true,partial:!value.directory,pin:0,onDisk:0,size:value.size,directory:value.directory});
    return {};
  }}};
  remote.metadata=async relative=>{assert.equal(relative,'Project');return {kind:'folder',remoteId:'id:Project',size:0,rev:''};};
  return {provider,ctx,commands,disk,events};
}

test('Dropbox listing exceeds 150,000 entries with bounded pages, monotonic progress and no content downloads',async()=>{
  const {remote,calls}=transport(),progress=[];let count=0,pages=0,ticks=0,running=true;
  const heartbeat=(async()=>{while(running){await yieldToEventLoop();ticks++;}})();
  try{
    for await(const batch of remote.listPages('',true,{onProgress:n=>progress.push(n)})){
      assert.ok(batch.length<=PAGE);assert.equal(batch[0].path,`Project/file-${count}.bin`);count+=batch.length;pages++;
    }
    assert.equal(count,TOTAL);assert.equal(pages,Math.ceil(TOTAL/PAGE));assert.equal(progress.at(-1),TOTAL);
    assert.ok(progress.every((n,i)=>i===0||n>progress[i-1]));assert.ok(ticks>=pages,'Event loop must service UI/cancel work between pages');
    assert.equal(calls[0].body.recursive,true);assert.equal(calls.filter(c=>c.endpoint==='files/list_folder/continue').length,pages-1);
    const shallow=transport({total:100_001});assert.equal((await shallow.remote.list('',false)).length,100_001);assert.equal(shallow.calls[0].body.recursive,false);
  }finally{running=false;await heartbeat;}
});

test('native reconciliation accepts more than 150,000 online-only files without hydration and persists each creation intent',async()=>{
  const {remote}=transport(),f=providerFixture(remote);let intentions=0;
  f.provider.store.saveNativeItem=(_id,item)=>{if(item.status==='creating'&&!f.disk.has(item.path))intentions++;};
  // The provider must consume pages directly, never request a second full listing array.
  remote.list=async()=>{throw new Error('Native reconciliation must use listPages');};
  await f.provider.reconcile(f.ctx);
  assert.equal(f.ctx.items.size,TOTAL+1);assert.equal(f.disk.size,TOTAL+1);assert.equal(intentions,TOTAL+1);
  assert.equal(f.commands.get('create'),TOTAL+1);assert.equal(f.commands.get('availability')||0,0);assert.equal(f.commands.get('remove')||0,0);
  assert.equal(f.ctx.items.values().next().value.kind,'folder');assert.ok([...f.ctx.items.values()].every(i=>i.kind==='folder'||i.status==='online'));
  assert.equal(f.ctx.checkedThisRun,true);assert.equal(f.ctx.progress.completed,TOTAL+1);
  assert.equal(f.events.filter(e=>e.action==='placeholder').length,TOTAL+1);
});

test('failure after the old limit preserves the previous catalog and performs no placeholder mutations',async()=>{
  const {remote}=transport({failAt:102_000}),f=providerFixture(remote),old={key:'old',path:'keep-local.bin',remoteId:'id:old',identity:'old',kind:'file',status:'cached'};
  f.ctx.items.set(old.key,old);await assert.rejects(()=>f.provider.reconcile(f.ctx),/err.nativeNetwork/);
  assert.equal(f.ctx.items.get(old.key),old);assert.equal(f.ctx.items.size,1);assert.equal(f.commands.size,0);assert.equal(f.events.length,0);assert.equal(f.ctx.acc.native.lastSync,42);
  assert.equal(f.ctx.progress.completed,102_000);
});

test('cancel after 100,000 entries stops pagination without changes and allows a fresh retry',async()=>{
  const {remote,calls}=transport(),f=providerFixture(remote),original=remote.listPages.bind(remote);
  remote.listPages=(relative,recursive,options)=>original(relative,recursive,{...options,onProgress:n=>{options.onProgress(n);if(n>=102_000)f.ctx.operation.abort(new Error('err.canceled'));}});
  await assert.rejects(()=>f.provider.reconcile(f.ctx),/err.canceled/);assert.equal(calls.length,51);assert.equal(f.commands.size,0);assert.equal(f.ctx.items.size,0);
  remote.listPages=original;f.ctx.operation=new AbortController();const result=await f.provider.collect(f.ctx);assert.equal(result.length,TOTAL+1);
});

test('case collisions on the final page are rejected before any local changes',async()=>{
  const f=providerFixture(transport({collision:true}).remote);await assert.rejects(()=>f.provider.reconcile(f.ctx),/err.mapping/);
  assert.equal(f.commands.size,0);assert.equal(f.ctx.items.size,0);assert.equal(f.ctx.acc.native.lastSync,42);
});
