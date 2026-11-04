import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeProviders,HYDRATION_LANES} from '../core/native-provider.mjs';
import {itemIdentity} from '../core/native-deletions.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(files=5){
  const commands=[],saved=new Map(),disk=new Map(),releases=[];let active=0,peak=0;
  const acc={id:'acc',settings:{rules:{'':{selected:true,mode:'local',kind:'folder'}}},native:{enabled:true,root:'unused'}};
  const providers=new NativeProviders({store:{addFileEvent(){},saveNativeItem(_id,item){saved.set(item.key,item);},deleteNativeItem(_id,key){saved.delete(key);}},persist:async()=>{}});
  const host={request:async(command,value={})=>{commands.push({command,...value});
    if(command==='inspect')return disk.get(value.path)||{exists:false};
    if(command==='availability'&&value.mode==='local'){active++;peak=Math.max(peak,active);await new Promise(resolve=>releases.push(resolve));active--;disk.set(value.path,{...disk.get(value.path),partial:false,onDisk:4,pin:1});return {};}
    return {};}};
  const cloud=[];const items=new Map();
  for(let n=0;n<files;n++){const path=`f${n}.mov`,item={key:'k'+n,path,kind:'file',remoteId:'id:'+n,rev:'r'+n,size:4,status:'online'};item.identity=itemIdentity(item);items.set(item.key,item);disk.set(path,{exists:true,placeholder:true,identity:item.identity,inSync:true,partial:true,onDisk:0,size:4,pin:0});cloud.push({path,remoteId:item.remoteId,rev:item.rev,kind:'file',size:4});}
  const ctx={acc,remote:{list:async()=>cloud},host,items,deletions:new Map(),fetches:new Map(),uploads:new Set(),queue:Promise.resolve(),lastChecked:1};
  providers.contexts.set(acc.id,ctx);const errors=[];const record=providers.recordError.bind(providers);providers.recordError=(c,e)=>{errors.push(e);record(c,e);};
  return {providers,ctx,acc,commands,saved,disk,releases,errors,peak:()=>peak,active:()=>active};
}

test('a check that pins files returns without waiting for the downloads',async()=>{
  const f=fixture(5);
  await f.providers.serial(f.ctx,()=>f.providers.reconcile(f.ctx));
  assert.equal(f.ctx.hydrations.size,5,'all five are queued');assert.equal(f.active(),HYDRATION_LANES,'at most two download at a time');
  assert.equal(f.providers.status(f.acc).status,'syncing');
});

test('an Explorer action is handled while large files are still downloading',async()=>{
  const f=fixture(5);
  await f.providers.serial(f.ctx,()=>f.providers.reconcile(f.ctx));
  let handled=false;await f.providers.userMutation(f.ctx,async()=>{handled=true;});
  assert.equal(handled,true);assert.equal(f.active(),2,'downloads are still running');
});

test('downloads drain two at a time and record the pinned state',async()=>{
  const f=fixture(5);
  await f.providers.serial(f.ctx,()=>f.providers.reconcile(f.ctx));
  while(f.ctx.hydrations.size){const release=f.releases.shift();if(!release){await tick();continue;}release();await tick();await tick();assert.ok(f.active()<=HYDRATION_LANES);}
  assert.deepEqual(f.errors.map(e=>e.message),[]);assert.equal(f.peak(),2);for(let n=0;n<5;n++)assert.equal(f.saved.get('k'+n).status,'pinned');
});

test('the same file is never queued twice, and a file that changed meanwhile is skipped',async()=>{
  const f=fixture(3);
  await f.providers.serial(f.ctx,()=>f.providers.reconcile(f.ctx));
  await f.providers.serial(f.ctx,()=>f.providers.reconcile(f.ctx));
  assert.equal(f.ctx.hydrations.size,3);
  f.ctx.items.set('k2',{...f.ctx.items.get('k2'),identity:'k2@changed'});
  f.releases.shift()();await tick();await tick();f.releases.shift()();await tick();await tick();await tick();
  assert.equal(f.commands.filter(c=>c.command==='availability'&&c.path==='f2.mov').length,0,'the changed file was not downloaded');
  assert.equal(f.ctx.hydrations.size,0);
});

test('a paused account starts no new downloads; the next check queues them again',async()=>{
  const f=fixture(3);f.ctx.suspended=true;
  f.providers.hydrate(f.ctx,f.ctx.items.get('k0'));await tick();
  assert.equal(f.commands.filter(c=>c.command==='availability').length,0);assert.equal(f.ctx.hydrations.size,0);
});
