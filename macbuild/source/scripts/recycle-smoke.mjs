import {NativeProviders} from '../core/native-provider.mjs';
import {finishDeletions} from '../core/native-deletions.mjs';
import {LocalTransport} from '../core/dropbox-transport.mjs';
import {SyncStore} from '../core/store.mjs';
import {mkdir,writeFile,readFile,unlink,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const project=path.resolve(import.meta.dirname,'..'),stage=process.argv.includes('--packaged')?JSON.parse(await readFile(path.join(project,'.runtime/release-stage.json'),'utf8')):null;
const binary=stage?path.join(stage.app,'resources/bin/amg-cloud.exe'):path.join(project,'native/bin/amg-cloud.exe');
const base=path.join(project,'.runtime/recycle-test',randomUUID()),root=path.join(base,'root'),remote=path.join(base,'remote'),dataDir=path.join(base,'data');
for(const folder of [root,dataDir,path.join(remote,'Folder','Nested')])await mkdir(folder,{recursive:true});
for(const file of ['Pinned.txt','Online.txt','Permanent.txt','Orphan.txt','Retry.txt','Folder/Nested/Child.txt'])await writeFile(path.join(remote,file),'Disposable fixture: '+file);
const store=new SyncStore(path.join(dataDir,'sync.sqlite')),acc={id:'recycle',name:'Recycle test',settings:{localRoot:root,rules:{'':{selected:true,mode:'online',kind:'folder'},'Pinned.txt':{selected:true,mode:'local',kind:'file'},'Orphan.txt':{selected:true,mode:'local',kind:'file'}}},native:{enabled:true,root,owner:randomUUID()}};
await writeFile(path.join(base,'fixture.json'),JSON.stringify(acc));
let offline=false;const create=()=>new NativeProviders({binary,dataDir,store,transport:()=>{const transport=new LocalTransport(remote),remove=transport.remove.bind(transport);transport.remove=async item=>{if(offline)throw new Error('err.nativeNetwork');return remove(item);};return transport;},persist:async()=>{}});
let providers=create(),ctx;
const recycle=relative=>promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/recycle-fixture.ps1'),path.join(root,relative)],{windowsHide:true,timeout:30000});
async function settle(){for(let i=0;i<150;i++){await providers.serial(ctx,()=>finishDeletions(providers,ctx));if(!ctx.deletions.size)return;await new Promise(r=>setTimeout(r,100));}throw new Error('Deletion did not finish');}
try{
  await providers.refresh(acc);ctx=providers.contexts.get(acc.id);clearInterval(ctx.timer);
  for(const relative of ['Pinned.txt','Online.txt','Folder']){await recycle(relative);assert.equal(await stat(path.join(root,relative)).catch(()=>null),null);await settle();assert.equal(await stat(path.join(remote,relative)).catch(()=>null),null);assert.ok(store.fileEvents(acc.id).entries.some(e=>e.path===relative&&['recycle','delete'].includes(e.action)&&e.status==='succeeded'));console.log('PASS: Windows Recycle Bin completes and confirms cloud deletion: '+relative);}
  await unlink(path.join(root,'Permanent.txt'));assert.ok(await stat(path.join(remote,'Permanent.txt')));await settle();assert.equal(await stat(path.join(remote,'Permanent.txt')).catch(()=>null),null);console.log('PASS: permanent deletion waits past provisional Windows delete/undelete notifications');
  const orphan=[...ctx.items.values()].find(i=>i.path==='Orphan.txt');await unlink(path.join(remote,'Orphan.txt'));ctx.items.delete(orphan.key);store.deleteNativeItem(acc.id,orphan.key);await recycle('Orphan.txt');await settle();assert.equal(await stat(path.join(root,'Orphan.txt')).catch(()=>null),null);console.log('PASS: fully downloaded orphan left by older failed deletion can be recycled without uploading it again');
  offline=true;await recycle('Retry.txt');await assert.rejects(settle,/err.nativeNetwork/);assert.ok(store.nativeDeletions(acc.id).length);assert.ok(await stat(path.join(remote,'Retry.txt')));await providers.close();providers=create();ctx=await providers.start(acc);assert.equal(ctx.failed,false);assert.ok(ctx.timer);await assert.rejects(()=>providers.refresh(acc),/err.nativeNetwork/);offline=false;await providers.refresh(acc);clearInterval(ctx.timer);await settle();assert.equal(await stat(path.join(remote,'Retry.txt')).catch(()=>null),null);console.log('PASS: failed cloud deletion is persisted, logged and safely retried after restart');
  const events=store.fileEvents(acc.id).entries;assert.ok(events.some(e=>e.status==='failed'));assert.ok(events.some(e=>e.action==='download'));assert.equal(store.nativeDeletions(acc.id).length,0);await providers.detach(acc);console.log('PASS: persistent per-file history records actual downloads, deletions, errors and timestamps; own fixture root detached');
}finally{await providers.close();store.close();}
