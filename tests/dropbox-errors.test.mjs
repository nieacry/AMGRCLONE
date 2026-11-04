import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,open} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DropboxTransport,dropboxError,retryDelay,RETRY_ATTEMPTS,dropboxHash} from '../core/dropbox-transport.mjs';
import {retryableNativeError} from '../core/native-host.mjs';
import {NativeProviders} from '../core/native-provider.mjs';

const account=()=>Response.json({root_info:{home_namespace_id:'home',root_namespace_id:'home'}});
const failure=(status,summary,{headers={},error={}}={})=>Response.json({error_summary:summary,error},{status,headers});
async function withFetch(handler,body){const original=globalThis.fetch;globalThis.fetch=handler;try{return await body();}finally{globalThis.fetch=original;}}
function transport(){const delays=[];const remote=new DropboxTransport({auth:async()=>'test-only',sleep:async ms=>{delays.push(ms);},random:()=>0.5});return {remote,delays};}
async function tempFile(bytes){const dir=path.resolve(import.meta.dirname,'../.runtime/dropbox-errors');await mkdir(dir,{recursive:true});const name=path.join(dir,randomUUID());await writeFile(name,bytes);return name;}
const metadata=(extra={})=>({'.tag':'file',id:'id:a',rev:'r2',size:4,path_display:'/a.txt',client_modified:'2026-11-04T10:00:00Z',...extra});

test('409 responses are classified by error_summary, not treated as one conflict',()=>{
  const cases=[
    ['path/conflict/file/..','err.nativeConflict',{versionConflict:true,retryable:false}],
    ['to/conflict/folder/..','err.nativeConflict',{versionConflict:true}],
    ['too_many_write_operations/..','err.dropboxBusy',{retryable:true,versionConflict:false}],
    ['path/too_many_write_operations/..','err.dropboxBusy',{retryable:true}],
    ['path/insufficient_space/..','err.dropboxFull',{retryable:false,versionConflict:false}],
    ['path/disallowed_name/..','err.dropboxName',{retryable:false}],
    ['path/malformed_path/..','err.dropboxName',{}],
    ['path_lookup/not_found/..','err.nativeConflict',{notFound:true,versionConflict:false}],
    ['from_lookup/not_found/..','err.nativeConflict',{notFound:true}],
    // Unknown 409s keep the conservative meaning (stop and preserve), but are not version conflicts.
    ['other/..','err.nativeConflict',{versionConflict:false,retryable:false,notFound:false}],
  ];
  for(const [summary,message,flags] of cases){const error=dropboxError(409,summary);assert.equal(error.message,message,summary);for(const [key,value] of Object.entries(flags))assert.equal(error[key],value,`${summary} ${key}`);assert.equal(error.dropboxSummary,summary);}
  assert.deepEqual([429,500,503].map(status=>dropboxError(status).retryable),[true,true,true]);
  assert.equal(dropboxError(429,'too_many_requests/..').message,'err.dropboxBusy');
  assert.equal(dropboxError(401,'expired_access_token/..').retryable,false);
  assert.equal(dropboxError(429,'',{retryAfter:7}).retryAfter,7);
  assert.equal(dropboxError(429,'',{retryAfter:100000}).retryAfter,300);
});

test('retry delay honours Retry-After, otherwise grows exponentially with jitter up to 60 s',()=>{
  assert.equal(retryDelay({retryAfter:12},1),12000);
  assert.deepEqual([1,2,3,4].map(n=>retryDelay({},n,()=>0.5)),[1000,2000,4000,8000]);
  assert.equal(retryDelay({},10,()=>0.5),60000);
  assert.equal(retryDelay({},1,()=>0),500);assert.equal(retryDelay({},1,()=>0.999),1499);
});

test('temporary Dropbox failures become retryable native errors; real conflicts do not',()=>{
  assert.equal(retryableNativeError(dropboxError(429)),true);
  assert.equal(retryableNativeError(dropboxError(409,'path/too_many_write_operations/..')),true);
  assert.equal(retryableNativeError(dropboxError(409,'path/conflict/file/..')),false);
  assert.equal(retryableNativeError(dropboxError(409,'path/insufficient_space/..')),false);
  assert.equal(retryableNativeError({nativeCode:'0x80070020'}),true);
});

test('a rate-limited request waits for Retry-After and then succeeds',async()=>{
  let calls=0;const {remote,delays}=transport();
  const result=await withFetch(async url=>{if(url.endsWith('get_current_account'))return account();if(++calls===1)return failure(429,'too_many_requests/..',{headers:{'Retry-After':'3'}});return Response.json(metadata());},()=>remote.metadata('a.txt'));
  assert.equal(calls,2);assert.deepEqual(delays,[3000]);assert.equal(result.rev,'r2');
});

test('retries stop after a bounded number of attempts with a retryable error',async()=>{
  let calls=0;const {remote,delays}=transport();
  await withFetch(async url=>{if(url.endsWith('get_current_account'))return account();calls++;return failure(409,'too_many_write_operations/..');},
    ()=>assert.rejects(remote.metadata('a.txt'),error=>error.message==='err.dropboxBusy'&&error.retryable===true));
  assert.equal(calls,RETRY_ATTEMPTS);assert.equal(delays.length,RETRY_ATTEMPTS-1);
});

test('non-retryable errors and real conflicts are not retried',async()=>{
  for(const summary of ['path/conflict/file/..','path/insufficient_space/..','other/..']){
    let calls=0;const {remote}=transport();
    await withFetch(async url=>{if(url.endsWith('get_current_account'))return account();calls++;return failure(409,summary);},()=>assert.rejects(remote.metadata('a.txt')));
    assert.equal(calls,1,summary);
  }
});

test('a dropped connection is retried as a network error',async()=>{
  let calls=0;const {remote}=transport();
  const result=await withFetch(async url=>{if(url.endsWith('get_current_account'))return account();if(++calls<3)throw new TypeError('fetch failed');return Response.json(metadata());},()=>remote.metadata('a.txt'));
  assert.equal(calls,3);assert.equal(result.remoteId,'id:a');
});

test('cancelling during a retry pause stops immediately',async()=>{
  const controller=new AbortController();let calls=0;
  const remote=new DropboxTransport({auth:async()=>'test-only',sleep:async(_ms,signal)=>{controller.abort();signal.throwIfAborted();}});
  await withFetch(async url=>{if(url.endsWith('get_current_account'))return account();calls++;return failure(503,'');},
    ()=>assert.rejects(remote.request('files/get_metadata',{path:'/a.txt'},{signal:controller.signal})));
  assert.equal(calls,1);
});

test('a retried upload rebuilds the body and sends the whole file again',async()=>{
  const file=await tempFile('data'),bodies=[];const {remote}=transport();
  const result=await withFetch(async(url,options)=>{if(url.endsWith('get_current_account'))return account();bodies.push(Buffer.from(await new Response(options.body).arrayBuffer()).toString());if(bodies.length===1)return failure(503,'');return Response.json(metadata({rev:'r3'}));},()=>remote.upload('a.txt',file,{rev:'r2'}));
  assert.deepEqual(bodies,['data','data']);assert.equal(result.rev,'r3');
});

test('an upload whose first commit succeeded but lost its response is accepted when Dropbox holds our bytes',async()=>{
  const file=await tempFile('data'),hash=await dropboxHash(file);let uploads=0;const {remote}=transport();
  const result=await withFetch(async(url,options)=>{
    if(url.endsWith('get_current_account'))return account();
    if(url.endsWith('files/get_metadata'))return Response.json(metadata({rev:'r3',content_hash:hash}));
    await new Response(options.body).arrayBuffer();
    if(++uploads===1)throw new TypeError('connection reset');
    return failure(409,'path/conflict/file/..');
  },()=>remote.upload('a.txt',file,{rev:'r2'}));
  assert.equal(uploads,2);assert.equal(result.rev,'r3');
});

test('the same lost-response case with different cloud bytes stays a version conflict',async()=>{
  const file=await tempFile('data');let uploads=0;const {remote}=transport();
  await withFetch(async(url,options)=>{
    if(url.endsWith('get_current_account'))return account();
    if(url.endsWith('files/get_metadata'))return Response.json(metadata({rev:'r3',content_hash:'someone-else'}));
    await new Response(options.body).arrayBuffer();
    if(++uploads===1)throw new TypeError('connection reset');
    return failure(409,'path/conflict/file/..');
  },()=>assert.rejects(remote.upload('a.txt',file,{rev:'r2'}),error=>error.versionConflict===true));
});

test('a first-attempt conflict is reported without looking for a lost response',async()=>{
  const file=await tempFile('data');let metadataCalls=0;const {remote}=transport();
  await withFetch(async(url,options)=>{if(url.endsWith('get_current_account'))return account();if(url.endsWith('files/get_metadata')){metadataCalls++;return Response.json(metadata());}await new Response(options.body).arrayBuffer();return failure(409,'path/conflict/file/..');},
    ()=>assert.rejects(remote.upload('a.txt',file,{rev:'r2'}),error=>error.versionConflict===true));
  assert.equal(metadataCalls,0);
});

test('a retried session append that Dropbox already stored is not sent twice',async()=>{
  const name=await tempFile('');const handle=await open(name,'r+');await handle.truncate(141*1024*1024);await handle.close();
  const calls=[];let failedOnce=false;const {remote}=transport();
  const result=await withFetch(async(url,options)=>{
    if(url.endsWith('get_current_account'))return account();
    const endpoint=url.split('/files/')[1],arg=JSON.parse(options.headers['Dropbox-API-Arg']);calls.push({endpoint,offset:arg.cursor?.offset});
    if(endpoint==='upload_session/start')return Response.json({session_id:'s1'});
    if(endpoint==='upload_session/append_v2'&&arg.cursor.offset===8*1024*1024&&!failedOnce){failedOnce=true;throw new TypeError('connection reset');}
    if(endpoint==='upload_session/append_v2'&&arg.cursor.offset===8*1024*1024&&calls.filter(c=>c.offset===8*1024*1024).length===2)return failure(409,'incorrect_offset/..',{error:{'.tag':'incorrect_offset',correct_offset:16*1024*1024}});
    if(endpoint==='upload_session/finish')return Response.json(metadata({rev:'r9',size:141*1024*1024}));
    return Response.json(null);
  },()=>remote.upload('big.mov',name,null));
  assert.equal(result.rev,'r9');
  const appends=calls.filter(c=>c.endpoint==='upload_session/append_v2').map(c=>c.offset/(8*1024*1024));
  assert.deepEqual(appends.slice(0,3),[1,1,2]);assert.equal(calls.at(-1).endpoint,'upload_session/finish');assert.equal(calls.at(-1).offset,141*1024*1024);
});

function providerFixture(remote){
  const events=[],saved=new Map(),disk=new Map(),acc={id:'fixture',settings:{rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,root:path.resolve(import.meta.dirname,'../.runtime/dropbox-errors/root')}};
  const providers=new NativeProviders({store:{addFileEvent(_id,event){events.push(event);},saveNativeItem(_id,item){saved.set(item.key,item);},deleteNativeItem(_id,key){saved.delete(key);}},persist:async()=>{}});
  const host={request:async(command,value={})=>{
    if(command==='inspect')return disk.get(value.path)||{exists:false};
    if(command==='snapshot'){await writeFile(value.file,'data');return {modified:Date.now(),stamp:'s1'};}
    if(command==='commit')return {committed:true};
    return {};
  }};
  const ctx={acc,remote,host,items:new Map(),deletions:new Map(),fetches:new Map(),uploads:new Set(),queue:Promise.resolve(),cache:path.resolve(import.meta.dirname,'../.runtime/dropbox-errors')};
  return {providers,ctx,events,saved,disk};
}
const edited={exists:true,placeholder:true,inSync:false,identity:'k1@x',partial:false,onDisk:4,size:4,directory:false,pin:0};

for(const [summary,expected] of [['path/too_many_write_operations/..','dirty'],['path/insufficient_space/..','dirty'],['other/..','dirty'],['path/conflict/file/..','conflict']]){
  test(`upload failure "${summary}" leaves the edited file ${expected}`,async()=>{
    await mkdir(path.resolve(import.meta.dirname,'../.runtime/dropbox-errors/root'),{recursive:true});
    const f=providerFixture({upload:async()=>{throw dropboxError(409,summary);}}),known={key:'k1',path:'a.txt',kind:'file',remoteId:'id:a',rev:'r1',identity:'k1@x',size:4,status:'cached'};
    f.ctx.items.set(known.key,known);f.disk.set('a.txt',edited);
    f.ctx.acc.native.root=path.resolve(import.meta.dirname,'../.runtime/dropbox-errors/root');await writeFile(path.join(f.ctx.acc.native.root,'a.txt'),'data');
    await assert.rejects(f.providers.scan(f.ctx));
    assert.equal(f.saved.get('k1').status,expected);
  });
}

test('a retryable Dropbox failure is shown as pending with a back-off, not as an error',()=>{
  const f=providerFixture({});f.ctx.acc.native.root='unused';
  f.providers.recordError(f.ctx,dropboxError(429,'too_many_requests/..',{retryAfter:20}));
  assert.equal(f.ctx.error,undefined);assert.ok(f.ctx.retry);assert.ok(f.ctx.retryAt-Date.now()>15000);assert.equal(f.events.length,0);
  const busy=providerFixture({});busy.providers.recordError(busy.ctx,dropboxError(409,'path/insufficient_space/..'));
  assert.equal(busy.ctx.error,'err.dropboxFull');assert.equal(busy.ctx.retry,undefined);assert.match(busy.ctx.detail,/insufficient_space/);
});

test('background sync waits for the back-off before the next cycle',async()=>{
  const f=providerFixture({});let cycles=0;f.providers.scan=async()=>{cycles++;};f.providers.reconcile=async()=>{};
  f.ctx.changed=true;f.ctx.retryAt=Date.now()+60000;await f.providers.background(f.ctx);assert.equal(cycles,0);
  f.ctx.retryAt=Date.now()-1;await f.providers.background(f.ctx);assert.equal(cycles,1);assert.equal(f.ctx.retryAt,null);
});

for(const [cloudRev,expected] of [['r1','dirty'],['r2','conflict']]){
  test(`a file stuck in conflict is ${expected==='dirty'?'released for upload':'kept'} when the cloud revision is ${cloudRev==='r1'?'unchanged':'newer'}`,async()=>{
    const f=providerFixture({list:async()=>[{path:'a.txt',remoteId:'id:a',rev:cloudRev,kind:'file',size:4,modified:0}]});
    const stuck={key:'k1',path:'a.txt',kind:'file',remoteId:'id:a',rev:'r1',identity:'k1@x',size:4,status:'conflict'};f.ctx.items.set(stuck.key,stuck);f.disk.set('a.txt',edited);
    await f.providers.reconcile(f.ctx);
    assert.equal(f.saved.get('k1').status,expected);
    if(expected==='dirty'){assert.equal(f.ctx.changed,true);assert.equal(f.events.at(-1).action,'recover');}
  });
}

test('a partially downloaded file in conflict is not released (its local data is incomplete)',async()=>{
  const f=providerFixture({list:async()=>[{path:'a.txt',remoteId:'id:a',rev:'r1',kind:'file',size:4,modified:0}]});
  f.ctx.items.set('k1',{key:'k1',path:'a.txt',kind:'file',remoteId:'id:a',rev:'r1',identity:'k1@x',size:4,status:'conflict'});f.disk.set('a.txt',{...edited,partial:true});
  await f.providers.reconcile(f.ctx);assert.equal(f.ctx.items.get('k1').status,'conflict');
});
