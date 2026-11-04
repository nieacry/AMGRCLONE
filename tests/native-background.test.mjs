import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeProviders} from '../core/native-provider.mjs';
import {DropboxTransport} from '../core/dropbox-transport.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(remote){
  const events=[],commands=[],disk=new Map(),acc={id:'fixture',settings:{rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,lastSync:42}},saved=new Map();
  const providers=new NativeProviders({store:{addFileEvent(_id,event){events.push(event);},saveNativeItem(_id,item){saved.set(item.key,item);},deleteNativeItem(_id,key){saved.delete(key);}},persist:async()=>{}});
  const ctx={acc,remote,items:new Map(),deletions:new Map(),fetches:new Map(),uploads:new Set(),queue:Promise.resolve(),lastChecked:42,host:{request:async(command,value={})=>{commands.push({command,...value});if(command==='inspect')return disk.get(value.path)||{exists:false};if(command==='create'){disk.set(value.path,{exists:true,placeholder:true,identity:value.identity,inSync:true,partial:true,pin:0,onDisk:0,size:value.size});}return {};}}};ctx.ready=Promise.resolve(ctx);providers.contexts.set(acc.id,ctx);providers.scan=async()=>{};
  return {providers,ctx,acc,events,commands,disk,saved};
}

test('cancel interrupts a paginated cloud listing; an incomplete snapshot never removes local data and retry uses the same transport',async()=>{
  const original=globalThis.fetch,waiting=deferred();let delayed=true,downloads=0;
  const existing={'.tag':'file',id:'id:existing',rev:'r1',path_display:'/existing.bin',size:100*1024**3},next={...existing,id:'id:new',path_display:'/new.bin'};
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('get_current_account'))return Response.json({root_info:{home_namespace_id:'home',root_namespace_id:'home'}});
    if(url.endsWith('files/list_folder'))return Response.json({entries:[existing],has_more:true,cursor:'next'});
    if(url.endsWith('files/list_folder/continue')){if(delayed){waiting.resolve();await new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});options.signal.throwIfAborted();});}return Response.json({entries:[next],has_more:false});}
    if(url.includes('download'))downloads++;
    throw new Error('Unexpected request');
  };
  try{
    const remote=new DropboxTransport({auth:async()=>'fixture'}),f=fixture(remote),known={key:'old',remoteId:'id:existing',rev:'r1',identity:'old',path:'existing.bin',kind:'file',size:existing.size,status:'online'};f.ctx.items.set(known.key,known);f.disk.set(known.path,{exists:true,placeholder:true,inSync:true,identity:known.identity,partial:true,pin:0});
    const first=assert.rejects(f.providers.refresh(f.acc),/err.canceled/);await waiting.promise;f.providers.cancel();await first;
    assert.equal(f.ctx.items.get('old'),known);assert.equal(f.commands.filter(c=>['create','remove','availability'].includes(c.command)).length,0);assert.equal(f.acc.native.lastSync,42);assert.equal(f.providers.status(f.acc).status,'pending');assert.equal(f.providers.status(f.acc).canceled,true);assert.equal(f.events.length,0);
    delayed=false;await f.providers.refresh(f.acc);assert.equal(f.ctx.items.size,2);assert.equal(f.providers.status(f.acc).status,'current');assert.equal(f.providers.status(f.acc).canceled,false);assert.equal(downloads,0);assert.equal(f.commands.filter(c=>c.command==='availability').length,0);
  }finally{globalThis.fetch=original;}
});

test('cancel between placeholder creations retains creation intent and rejects already queued work',async()=>{
  const entered=deferred(),release=deferred(),f=fixture({list:async()=>Array.from({length:5},(_v,n)=>({path:`file-${n}`,remoteId:`id:${n}`,rev:'r1',size:1024,kind:'file'}))}),original=f.ctx.host.request;let creates=0;
  f.ctx.host.request=async(command,value)=>{const result=await original(command,value);if(command==='create'&&++creates===1){entered.resolve();await release.promise;}return result;};
  const first=assert.rejects(f.providers.refresh(f.acc),/err.canceled/);await entered.promise;let ran=false;const queued=assert.rejects(f.providers.serial(f.ctx,async()=>{ran=true;}),/err.canceled/);f.providers.cancel();release.resolve();await first;await queued;
  assert.equal(creates,1);assert.equal(ran,false);assert.equal(f.ctx.items.size,1);assert.equal(f.saved.size,1);assert.equal(f.acc.native.lastSync,42);await f.providers.refresh(f.acc);assert.equal(f.ctx.items.size,5);assert.equal(f.providers.status(f.acc).status,'current');
});

test('an unchanged project is not scanned every five seconds; local changes and the periodic cloud check still run',async()=>{
  const f=fixture({});let scans=0,checks=0;f.ctx.lastChecked=Date.now();f.ctx.needsReconcile=false;f.providers.scan=async()=>{scans++;};f.providers.reconcile=async()=>{checks++;f.ctx.lastChecked=Date.now();f.ctx.needsReconcile=false;};
  await f.providers.background(f.ctx);assert.equal(scans,0);assert.equal(f.commands.length,0);
  f.ctx.changed=true;await f.providers.background(f.ctx);assert.equal(scans,1);assert.equal(checks,0);await f.providers.background(f.ctx);assert.equal(scans,1);
  f.ctx.lastChecked=1;await f.providers.background(f.ctx);assert.equal(scans,2);assert.equal(checks,1);
  f.ctx.changed=true;f.providers.setPaused(true);await f.providers.background(f.ctx);assert.equal(scans,2);f.providers.setPaused(false);await f.providers.background(f.ctx);assert.equal(scans,3);
  f.providers.scan=async()=>{scans++;f.ctx.changed=true;};f.ctx.changed=true;await f.providers.background(f.ctx);assert.equal(f.ctx.changed,true,'Changes arriving during a scan must schedule the next check');
});

test('Explorer mutation interrupts a stalled cloud listing without canceling independent file hydration',async()=>{
  const entered=deferred(),f=fixture({list:async(_path,_recursive,{signal})=>{entered.resolve();await new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}}),hydration=new AbortController();
  f.ctx.fetches.set('open-file',hydration);const first=assert.rejects(()=>f.providers.refresh(f.acc),/err.canceled/);await entered.promise;
  let handled=false;await f.providers.userMutation(f.ctx,async()=>{handled=true;});await first;
  assert.equal(handled,true);assert.equal(hydration.signal.aborted,false);assert.equal(f.ctx.suspended,false);assert.equal(f.ctx.needsReconcile,true);assert.equal(f.commands.filter(c=>c.command==='create').length,0);
});

test('multiple queued Explorer operations stay ordered and never cancel each other',async()=>{
  const f=fixture({}),entered=deferred(),release=deferred(),order=[];
  const first=f.providers.userMutation(f.ctx,async()=>{order.push('first');entered.resolve();await release.promise;assert.equal(f.ctx.operation.signal.aborted,false);order.push('first-finished');});
  await entered.promise;const second=f.providers.userMutation(f.ctx,async()=>order.push('second'));release.resolve();await Promise.all([first,second]);assert.deepEqual(order,['first','first-finished','second']);
});

test('explicit cancel/reset still cancels running and queued Explorer mutations',async()=>{
  const f=fixture({}),entered=deferred(),release=deferred();let ran=false;
  const first=assert.rejects(()=>f.providers.userMutation(f.ctx,async()=>{entered.resolve();await release.promise;}),/err.canceled/);await entered.promise;
  const second=assert.rejects(()=>f.providers.userMutation(f.ctx,async()=>{ran=true;}),/err.canceled/);f.providers.cancelAccount(f.acc.id);release.resolve();await Promise.all([first,second]);assert.equal(ran,false);assert.equal(f.ctx.suspended,true);
});
