// End-to-end check of roadmap stages 1-4 on the real Windows Cloud Files API.
// The "cloud" is a local folder (LocalTransport), the "other computer" a second LocalTransport on it.
// Nothing touches Dropbox or the real profile. Run: node scripts/verify-stages.mjs  (or verify-stages.cmd)
import {NativeProviders} from '../core/native-provider.mjs';
import {finishDeletions} from '../core/native-deletions.mjs';
import {LocalTransport} from '../core/dropbox-transport.mjs';
import {SyncStore} from '../core/store.mjs';
import {mkdir,writeFile,readFile,unlink,readdir,rmdir,access} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const project=path.resolve(import.meta.dirname,'..'),stamp=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
const base=path.join(project,'.runtime','verify-stages',stamp),cloud=path.join(base,'cloud'),root=path.join(base,'root'),binary=path.join(project,'native','bin','amg-cloud.exe');
const report=path.join(project,'.runtime',`verify-stages-${stamp}.txt`),lines=[];let passed=0,failed=0;
const log=line=>{console.log(line);lines.push(line);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=file=>access(file).then(()=>true,()=>false);
async function until(check,ms,label){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await sleep(100);}throw new Error('timed out: '+label);}
const local=relative=>path.join(root,...relative.split('/')),remote=relative=>path.join(cloud,...relative.split('/'));

// A download of big.bin waits for the test to open the gate: a "long" pinned download.
let gate={open(){},promise:Promise.resolve()};
class GatedTransport extends LocalTransport{async download(item,options){if(item.path.endsWith('big.bin'))await gate.promise;return super.download(item,options);}}
const closeGate=()=>{let open;const promise=new Promise(resolve=>open=resolve);gate={open,promise};};

log(`AMG rclone UI — stage 1-4 verification · ${new Date().toISOString()} · ${hostname()}`);
log(`helper: ${binary}`);log(`work folder: ${base}`);log('');
await mkdir(path.join(cloud,'Media','Shots'),{recursive:true});await mkdir(path.join(cloud,'Media','Batch'),{recursive:true});await mkdir(root,{recursive:true});
const video=randomBytes(2*1024*1024+9);await writeFile(remote('Media/video.bin'),video);await writeFile(remote('Media/frame.psd'),'cloud v1');await writeFile(remote('Media/big.bin'),randomBytes(24*1024*1024));
for(let n=0;n<40;n++)await writeFile(remote(`Media/Shots/s${String(n).padStart(2,'0')}.txt`),`shot ${n}`);
for(let n=0;n<30;n++)await writeFile(remote(`Media/Batch/b${String(n).padStart(2,'0')}.txt`),`batch ${n}`);

const store=new SyncStore(path.join(base,'state.sqlite')),reviews=[];
const acc={id:'verify',name:'Verify',settings:{localRoot:'',rules:{Media:{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,root,owner:randomUUID()}};
const transport=new GatedTransport(cloud),other=new LocalTransport(cloud);
const providers=new NativeProviders({binary,dataDir:base,store,transport:()=>transport,persist:async()=>{},onReview:(_acc,review)=>reviews.push(review)});
let ctx=null;
const refresh=async(times=1)=>{for(let n=0;n<times;n++)await providers.refresh(acc);};
const item=relative=>[...ctx.items.values()].find(i=>i.path===relative);
const diag=()=>ctx?`      state: error=${ctx.error||'-'} detail=${ctx.detail||'-'} items=${ctx.items.size} deletions=${ctx.deletions.size} review=${ctx.review?ctx.review.keys.length:0}`:'      (provider not started)';
async function step(name,body){
  const started=Date.now();
  try{await body();passed++;log(`PASS  ${name}  (${Date.now()-started} ms)`);}
  catch(error){failed++;log(`FAIL  ${name}: ${error.message}`);log(diag());}
}
const quarantined=async relative=>{const day=new Date().toISOString().slice(0,10);return exists(path.join(providers.quarantinePath(acc),day,...relative.split('/')));};

try{
  await step('1. helper starts; placeholders are created for the cloud folder',async()=>{
    await providers.refresh(acc);ctx=providers.contexts.get(acc.id);clearInterval(ctx.timer);
    const state=await ctx.host.request('inspect',{path:'Media/Shots/s00.txt'});assert.equal(state.placeholder,true);assert.ok(ctx.items.size>=75,`catalog has ${ctx.items.size} items`);
  });
  await step('2. helper answers inspectMany (helper rebuilt with stage 4)',async()=>{
    const states=await providers.inspectMany(ctx,['Media/frame.psd','Media/video.bin','Media/Shots/s01.txt']);
    assert.notEqual(ctx.batchInspect,false,'helper does not know inspectMany: run npm run build:native');assert.equal(states.size,3);
  });
  await step('3. reading an online-only file downloads it on demand',async()=>{assert.deepEqual(await readFile(local('Media/video.bin')),video);});
  await step('4. a new local file is reported by the file watcher and uploaded',async()=>{
    await writeFile(local('Media/new-local.txt'),'made here');
    await until(()=>ctx.changedPaths===null||ctx.changedPaths?.has('Media/new-local.txt'),5000,'watcher event');
    await refresh();assert.equal(await readFile(remote('Media/new-local.txt'),'utf8'),'made here');
  });
  await step('5. a delete in Explorer is handled while a pinned 24 MB file is still downloading',async()=>{
    closeGate();
    const started=Date.now();await providers.availability(acc,'Media/big.bin','local');assert.ok(Date.now()-started<20000,'"keep on this device" waited for the download');
    await until(()=>ctx.hydrations?.size>0,5000,'download queued');
    const deleteStarted=Date.now();await unlink(local('Media/Shots/s39.txt'));const took=Date.now()-deleteStarted;
    assert.ok(took<5000,`delete took ${took} ms`);
    gate.open();await until(()=>!ctx.hydrations?.size,90000,'download finished');
    const big=await ctx.host.request('inspect',{path:'Media/big.bin'});assert.equal(big.partial,false);assert.equal(big.pin,1);
    await sleep(3200);await providers.serial(ctx,()=>finishDeletions(providers,ctx));assert.equal(await exists(remote('Media/Shots/s39.txt')),false,'single delete reached the cloud');
  });
  await step('6. an edit that lost to a newer cloud version becomes a conflict copy (needs helper "discard")',async()=>{
    await writeFile(local('Media/frame.psd'),'local edit');await sleep(300);await writeFile(remote('Media/frame.psd'),'cloud v2');
    await refresh(2);
    const copies=(await readdir(path.join(cloud,'Media'))).filter(name=>/^frame \(конфлікт, .+\)\.psd$/.test(name));
    assert.equal(copies.length,1,`conflict copies in cloud: ${copies.join(', ')||'none'}`);
    assert.equal(await readFile(path.join(cloud,'Media',copies[0]),'utf8'),'local edit');assert.equal(await readFile(remote('Media/frame.psd'),'utf8'),'cloud v2');
    assert.equal(await readFile(local('Media/frame.psd'),'utf8'),'cloud v2','original path has the cloud version');assert.ok(await quarantined('Media/frame.psd'),'local copy in quarantine');
  });
  await step('7. a new local file whose name already exists in the cloud becomes a conflict copy',async()=>{
    await writeFile(remote('Media/clash.txt'),'cloud clash');await writeFile(local('Media/clash.txt'),'local clash');
    await refresh(2);
    const copies=(await readdir(path.join(cloud,'Media'))).filter(name=>/^clash \(конфлікт, .+\)\.txt$/.test(name));
    assert.equal(copies.length,1);assert.equal(await readFile(path.join(cloud,'Media',copies[0]),'utf8'),'local clash');assert.equal(await readFile(local('Media/clash.txt'),'utf8'),'cloud clash');
  });
  const shots=range=>range.map(n=>`Media/Shots/s${String(n).padStart(2,'0')}.txt`);
  await step('8. 25 files deleted in the cloud: nothing removed here until decided; "Restore in Dropbox" brings them back',async()=>{
    await providers.availability(acc,'Media/Shots/s00.txt','local');await providers.availability(acc,'Media/Shots/s01.txt','local');await until(()=>!ctx.hydrations?.size,30000,'pins');
    for(const relative of shots([...Array(25).keys()]))await other.remove(item(relative));
    await refresh();
    for(const relative of shots([0,12,24]))assert.equal(await exists(local(relative)),true,`${relative} was removed without asking`);
    const review=providers.status(acc).review;assert.equal(review?.count,25);assert.ok(reviews.some(r=>r.inbound));
    await providers.decide(acc,'restore');await refresh();
    for(const relative of shots([0,12,24]))assert.equal(await exists(remote(relative)),true,`${relative} not restored in the cloud`);
    assert.equal(providers.status(acc).review,null);
  });
  await step('9. 25 files deleted in the cloud, "Remove here too": removed here, downloaded ones kept in quarantine',async()=>{
    await providers.availability(acc,'Media/Shots/s02.txt','local');await until(()=>!ctx.hydrations?.size,30000,'pin');
    for(const relative of shots([...Array(25).keys()]))await other.remove(item(relative));
    await refresh();assert.equal(providers.status(acc).review?.count,25);
    await providers.decide(acc,'apply');
    for(const relative of shots([0,2,24]))assert.equal(await exists(local(relative)),false,`${relative} still here`);
    assert.ok(await quarantined('Media/Shots/s02.txt'),'pinned s02 is in quarantine');
  });
  await step('10. 3 files deleted in the cloud go through without asking',async()=>{
    for(const relative of shots([25,26,27]))await other.remove(item(relative));
    await refresh();for(const relative of shots([25,26,27]))assert.equal(await exists(local(relative)),false);assert.equal(providers.status(acc).review,null);
  });
  const batch=[...Array(30).keys()].map(n=>`Media/Batch/b${String(n).padStart(2,'0')}.txt`);
  await step('11. 30 files deleted one by one (Shift+Delete / script): held as one batch; "Bring back" restores them',async()=>{
    for(const relative of batch)await unlink(local(relative));
    await sleep(3200);await providers.serial(ctx,()=>finishDeletions(providers,ctx));
    for(const relative of batch.slice(0,3))assert.equal(await exists(remote(relative)),true,`${relative} reached the cloud without asking`);
    const confirmations=providers.status(acc).confirmations;assert.equal(confirmations.length,1,`${confirmations.length} decisions`);assert.equal(confirmations[0].count,30);
    await providers.decide(acc,'cancel',confirmations[0].id);await refresh();
    for(const relative of batch.slice(0,3))assert.equal(await readFile(local(relative),'utf8'),`batch ${Number(relative.slice(-6,-4))}`);
  });
  await step('12. the same batch confirmed: deleted in the cloud',async()=>{
    for(const relative of batch)await unlink(local(relative));await rmdir(local('Media/Batch'));
    await sleep(3200);await providers.serial(ctx,()=>finishDeletions(providers,ctx));
    const confirmations=providers.status(acc).confirmations;assert.equal(confirmations.length,1);
    await providers.decide(acc,'confirm',confirmations[0].id);assert.equal(await exists(path.join(cloud,'Media','Batch')),false);
  });
}finally{
  // Leave nothing registered: remove our placeholders and unregister the test root.
  try{
    if(ctx){
      for(const entry of [...ctx.items.values()].sort((a,b)=>b.path.length-a.path.length)){
        const state=await ctx.host.request('inspect',{path:entry.path}).catch(()=>({exists:false}));if(!state.exists)continue;
        if(state.placeholder)await ctx.host.request(entry.kind==='file'?'discard':'remove',{path:entry.path,identity:entry.identity}).catch(()=>ctx.host.request('remove',{path:entry.path,identity:entry.identity}).catch(()=>{}));
      }
      const leftovers=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])){const full=path.join(dir,entry.name);if(entry.isDirectory()){await leftovers(full);await rmdir(full).catch(()=>{});}else await unlink(full).catch(()=>{});}};
      await leftovers(root);await ctx.host.request('unregister').then(()=>log('\ncleanup: test root unregistered'),error=>log(`\ncleanup: unregister failed (${error.nativeCode||error.message}); the folder stays in .runtime\\verify-stages`));
    }
  }catch(error){log(`cleanup error: ${error.message}`);}
  await providers.close();store.close();
  log(`\n${passed} passed, ${failed} failed`);
  await writeFile(report,lines.join('\r\n')+'\r\n');console.log(`\nreport: ${report}`);
  process.exitCode=failed?1:0;
}
