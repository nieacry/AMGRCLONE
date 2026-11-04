import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SyncStore} from '../core/store.mjs';
import {LocalTransport} from '../core/dropbox-transport.mjs';
import {cleanLegacyMarkers} from '../core/legacy-markers.mjs';

async function fixture(){
  const base=path.resolve('.runtime/marker-tests',randomUUID()),local=path.join(base,'local'),cloud=path.join(base,'cloud');
  await mkdir(path.join(local,'Project'),{recursive:true});await mkdir(path.join(cloud,'Project'),{recursive:true});
  const id=randomUUID().replaceAll('-','').slice(0,24),marker='.amg-access-'+id,store=new SyncStore(':memory:');
  const acc={id:'account',settings:{localRoot:local},native:{enabled:true}};
  store.addJob({id,accountId:acc.id,path:'Project',localPath:path.join(local,'Project'),marker});store.mark(id,'idle',true);
  for(const root of [local,cloud]){await writeFile(path.join(root,'Project',marker),marker);await writeFile(path.join(root,'Project','user.txt'),'keep me');}
  return {acc,store,id,marker,local,cloud,remote:new LocalTransport(cloud)};
}
test('native migration retires old jobs and deletes only exact recorded markers; repeated cleanup is safe',async()=>{
  const f=await fixture();try{
    const foreign='.amg-access-'+('b'.repeat(24));await writeFile(path.join(f.cloud,'Project',foreign),foreign);
    const result=await cleanLegacyMarkers(f.acc,f.store,f.remote);assert.deepEqual(result,{total:1,removed:1,pending:0});assert.equal(f.store.job(f.id).status,'retired');
    for(const root of [f.local,f.cloud]){assert.equal(await stat(path.join(root,'Project',f.marker)).catch(()=>null),null);assert.equal(await readFile(path.join(root,'Project','user.txt'),'utf8'),'keep me');}
    assert.equal(await readFile(path.join(f.cloud,'Project',foreign),'utf8'),foreign);
    assert.deepEqual(await cleanLegacyMarkers(f.acc,f.store,f.remote),result);
  }finally{f.store.close();}
});
test('changed marker contents are preserved on both sides',async()=>{
  const f=await fixture();try{for(const root of [f.local,f.cloud])await writeFile(path.join(root,'Project',f.marker),'x'.repeat(f.marker.length));
    const result=await cleanLegacyMarkers(f.acc,f.store,f.remote);assert.equal(result.pending,1);assert.equal(result.removed,0);
    for(const root of [f.local,f.cloud])assert.equal(await readFile(path.join(root,'Project',f.marker),'utf8'),'x'.repeat(f.marker.length));
  }finally{f.store.close();}
});
test('cloud cleanup checks the revision again at deletion and preserves a concurrent change',async()=>{
  const f=await fixture();try{const original=f.remote.remove.bind(f.remote);f.remote.remove=async item=>{await writeFile(path.join(f.cloud,'Project',f.marker),'concurrent user change');return original(item);};
    const result=await cleanLegacyMarkers(f.acc,f.store,f.remote);assert.equal(result.pending,1);assert.equal(await readFile(path.join(f.cloud,'Project',f.marker),'utf8'),'concurrent user change');
    assert.equal(f.store.markerReceipt(f.acc.id,f.id).cloud,'error');
  }finally{f.store.close();}
});
test('active classic pairs cannot be cleaned',async()=>{
  const f=await fixture();try{f.acc.native.enabled=false;await assert.rejects(()=>cleanLegacyMarkers(f.acc,f.store,f.remote),/err.nativeRequired/);assert.equal(f.store.job(f.id).status,'idle');assert.equal(await readFile(path.join(f.cloud,'Project',f.marker),'utf8'),f.marker);}finally{f.store.close();}
});
test('reset clears metadata, history, native catalog and cleanup receipts',()=>{
  const store=new SyncStore(':memory:');store.addJob({id:'a',accountId:'x',path:'P',localPath:'/P',marker:'m'});store.saveNativeItem('x',{key:'file',path:'P'});store.saveMarkerReceipt('x','a',{cloud:'deleted'});store.reset();assert.deepEqual(store.jobs('x'),[]);assert.deepEqual(store.nativeItems('x'),[]);assert.deepEqual(store.markerReceipts('x'),[]);assert.deepEqual(store.history('x'),[]);store.close();
});
