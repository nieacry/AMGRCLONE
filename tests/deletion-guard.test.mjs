import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,rm,utimes} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {massDeletionThreshold,exceedsThreshold,quarantineFile,pruneQuarantine,fullyLocal,reviewSummary} from '../core/deletion-guard.mjs';
import {NativeProviders} from '../core/native-provider.mjs';
import {finishDeletions} from '../core/native-deletions.mjs';
import {trayStatus} from '../electron/tray-icons.mjs';

const base=path.resolve(import.meta.dirname,'../.runtime/deletion-guard');
async function folder(){const dir=path.join(base,randomUUID());await mkdir(dir,{recursive:true});return dir;}

test('threshold is max(20, min(50, 10% of the catalog))',()=>{
  assert.deepEqual([0,10,150,200,300,499,1000,100000].map(massDeletionThreshold),[20,20,20,20,30,50,50,50]);
  assert.equal(exceedsThreshold(19,100),false);assert.equal(exceedsThreshold(20,100),true);
  assert.equal(exceedsThreshold(49,30000),false);assert.equal(exceedsThreshold(50,30000),true);
});

test('only a placeholder with all bytes on disk counts as the local copy',()=>{
  assert.equal(fullyLocal({exists:true,placeholder:true,partial:false,onDisk:10,size:10}),true);
  assert.equal(fullyLocal({exists:true,placeholder:true,partial:true,onDisk:0,size:10}),false);
  assert.equal(fullyLocal({exists:true,placeholder:true,partial:false,onDisk:4,size:10}),false);
  assert.equal(fullyLocal({exists:true,placeholder:true,directory:true,partial:false,onDisk:0,size:0}),false);
});

test('quarantine keeps the folder structure and never overwrites an earlier copy',async()=>{
  const dataDir=await folder(),root=await folder();await mkdir(path.join(root,'Shots','010'),{recursive:true});
  await writeFile(path.join(root,'Shots','010','frame.psd'),'v1');
  const now=Date.parse('2026-11-04T12:00:00Z');
  const first=await quarantineFile({dataDir,accountId:'acc',root,relative:'Shots/010/frame.psd',now});
  await writeFile(path.join(root,'Shots','010','frame.psd'),'v2');
  const second=await quarantineFile({dataDir,accountId:'acc',root,relative:'Shots/010/frame.psd',now});
  assert.equal(first,path.join(dataDir,'quarantine','acc','2026-11-04','Shots','010','frame.psd'));
  assert.equal(second,path.join(dataDir,'quarantine','acc','2026-11-04','Shots','010','frame (2).psd'));
  assert.equal(await readFile(first,'utf8'),'v1');assert.equal(await readFile(second,'utf8'),'v2');
  await assert.rejects(quarantineFile({dataDir,accountId:'acc',root,relative:'../outside'}),/err.path/);
  await assert.rejects(quarantineFile({dataDir,accountId:'../x',root,relative:'a'}),/err.account/);
});

test('quarantine pruning removes only dated folders older than 30 days',async()=>{
  const dataDir=await folder(),q=path.join(dataDir,'quarantine','acc');
  for(const name of ['2026-09-01','2026-10-04','2026-10-05','2026-11-04','notes'])await mkdir(path.join(q,name),{recursive:true});
  await writeFile(path.join(q,'readme.txt'),'keep');
  const removed=await pruneQuarantine({dataDir,accountId:'acc',now:Date.parse('2026-11-04T12:00:00Z')});
  assert.deepEqual(removed.sort(),['2026-09-01','2026-10-04']);
  assert.deepEqual((await readdir(q)).sort(),['2026-10-05','2026-11-04','notes','readme.txt']);
  assert.deepEqual(await pruneQuarantine({dataDir,accountId:'missing'}),[]);
});

test('review summary counts files, downloaded copies and shows the shallowest paths',()=>{
  const summary=reviewSummary([{path:'A/b/c.psd',kind:'file',size:5,downloaded:true},{path:'A',kind:'folder'},{path:'A/b',kind:'folder'},{path:'A/x.png',kind:'file',size:7,downloaded:false}],3);
  assert.deepEqual(summary,{count:4,files:2,downloaded:1,bytes:12,sample:['A','A/b','A/x.png']});
});

test('a pending decision shows the tray as needing attention',()=>{
  const account={native:{enabled:true},settings:{rules:{'':{selected:true}}}};
  assert.equal(trayStatus({accounts:[account],activity:null,paused:false,dirty:new Set(),native:()=>({status:'current',review:{count:30}})}),'error');
  assert.equal(trayStatus({accounts:[account],activity:null,paused:false,dirty:new Set(),native:()=>({status:'current',confirmations:[{id:'x'}]})}),'error');
  assert.equal(trayStatus({accounts:[account],activity:null,paused:false,dirty:new Set(),native:()=>({status:'current',review:null,confirmations:[]})}),'current');
});

// --- provider-level behaviour with a fake Cloud Files host and a fake Dropbox -------------------

async function fixture({files=30,downloaded=[],rules}={}){
  const dataDir=await folder(),root=await folder(),events=[],commands=[],reviews=[],disk=new Map(),deletions=new Map(),saved=new Map();let review=null;
  const acc={id:'acc',name:'Test',settings:{rules:rules||{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,root}};
  const store={addFileEvent(_id,event){events.push(event);},saveNativeItem(_id,item){saved.set(item.key,item);},deleteNativeItem(_id,key){saved.delete(key);},
    nativeReview:()=>review,saveNativeReview(_id,value){review=value;},deleteNativeReview(){review=null;},
    saveNativeDeletion(_id,op){deletions.set(op.id,op);},deleteNativeDeletion(_id,id){deletions.delete(id);},
    cancelNativeDeletion(_id,op,event){events.push(event);deletions.delete(op.id);},finishNativeDeletion(_id,op){deletions.delete(op.id);}};
  const providers=new NativeProviders({dataDir,store,persist:async()=>{},onReview:(_acc,value)=>reviews.push(value)});
  const host={request:async(command,value={})=>{commands.push({command,...value});
    if(command==='inspect')return disk.get(value.path)||{exists:false};
    if(command==='remove'){disk.delete(value.path);return {};}
    if(command==='create'){disk.set(value.path,{exists:true,placeholder:true,identity:value.identity,inSync:true,partial:!value.directory,directory:!!value.directory,size:value.size||0,onDisk:0,pin:0});return {};}
    if(command==='update'){disk.set(value.path,{...disk.get(value.path),identity:value.identity,partial:!value.directory,onDisk:0,size:value.size||0});return {};}
    return {};}};
  const cloud=[],items=new Map();
  await mkdir(path.join(root,'Shots'),{recursive:true});
  const folderItem={key:'k-folder',path:'Shots',kind:'folder',remoteId:'id:folder',rev:'',identity:'k-folder@f',status:'cached'};
  items.set(folderItem.key,folderItem);disk.set('Shots',{exists:true,placeholder:true,directory:true,identity:folderItem.identity,inSync:true,partial:false,size:0,onDisk:0});cloud.push({path:'Shots',remoteId:'id:folder',rev:'',kind:'folder',size:0});
  for(let n=0;n<files;n++){
    const relative=`Shots/f${String(n).padStart(2,'0')}.psd`,local=downloaded.includes(n),item={key:'k'+n,path:relative,kind:'file',remoteId:'id:'+n,rev:'r'+n,identity:`k${n}@x`,size:4,status:local?'pinned':'online'};
    items.set(item.key,item);disk.set(relative,{exists:true,placeholder:true,identity:item.identity,inSync:true,partial:!local,size:4,onDisk:local?4:0,pin:local?1:0});cloud.push({path:relative,remoteId:item.remoteId,rev:item.rev,kind:'file',size:4});
    if(local)await writeFile(path.join(root,...relative.split('/')),'data');
  }
  // Like Dropbox: a recursive listing of a folder includes the folder itself.
  const remote={list:async(relative='')=>cloud.filter(c=>!c.deleted&&(relative===''||c.path===relative||c.path.startsWith(relative+'/'))),restored:[],removed:[],folders:[],
    async restore(item){this.restored.push(item.path);const entry=cloud.find(c=>c.path===item.path);entry.deleted=false;return entry;},
    async createFolder(relative){this.folders.push(relative);return {};},
    async remove(item){this.removed.push(item.path);},async metadata(relative){const entry=cloud.find(c=>c.path===relative&&!c.deleted);if(!entry)throw Object.assign(new Error('err.nativeConflict'),{notFound:true});return entry;}};
  const ctx={acc,remote,host,items,deletions:new Map(),fetches:new Map(),uploads:new Set(),queue:Promise.resolve(),cache:dataDir,review:null,lastChecked:1};
  ctx.ready=Promise.resolve(ctx);providers.contexts.set(acc.id,ctx);
  const deleteInCloud=paths=>{for(const entry of cloud)if(paths.includes(entry.path))entry.deleted=true;};
  return {providers,ctx,acc,events,commands,reviews,disk,deletions,cloud,remote,dataDir,root,deleteInCloud,store,getReview:()=>review};
}
const removedPaths=f=>f.commands.filter(c=>c.command==='remove').map(c=>c.path);

test('a cloud deletion above the threshold removes nothing and waits for this user',async()=>{
  const f=await fixture({files:30,downloaded:[1,2]});
  f.deleteInCloud(f.cloud.filter(c=>c.kind==='file').map(c=>c.path).slice(0,25));
  await f.providers.reconcile(f.ctx);
  assert.deepEqual(removedPaths(f),[]);assert.equal(f.ctx.items.size,31);
  assert.equal(f.reviews.length,1);assert.equal(f.getReview().keys.length,25);
  const status=f.providers.status(f.acc);
  assert.equal(status.review.count,25);assert.equal(status.review.files,25);assert.equal(status.review.downloaded,2);
  assert.equal(existsSync(path.join(f.dataDir,'quarantine')),false);
  await f.providers.reconcile(f.ctx);
  assert.equal(f.reviews.length,1,'the same pending set is not announced twice');assert.deepEqual(removedPaths(f),[]);
});

test('a cloud deletion below the threshold proceeds, and downloaded copies go to quarantine first',async()=>{
  const f=await fixture({files:30,downloaded:[0]});
  f.deleteInCloud(['Shots/f00.psd','Shots/f01.psd','Shots/f02.psd']);
  await f.providers.reconcile(f.ctx);
  assert.deepEqual(removedPaths(f).sort(),['Shots/f00.psd','Shots/f01.psd','Shots/f02.psd']);
  assert.equal(f.reviews.length,0);assert.equal(f.getReview(),null);
  const quarantined=f.events.filter(e=>e.action==='quarantine');
  assert.equal(quarantined.length,1);assert.equal(quarantined[0].path,'Shots/f00.psd');
  const copy=path.join(f.dataDir,'quarantine','acc',new Date().toISOString().slice(0,10),'Shots','f00.psd');
  assert.equal(await readFile(copy,'utf8'),'data');
  const order=f.commands.findIndex(c=>c.command==='remove'&&c.path==='Shots/f00.psd');assert.ok(order>=0);
});

test('a downloaded file that cannot be copied to quarantine is not removed',async()=>{
  const f=await fixture({files:30,downloaded:[0]});await rm(path.join(f.root,'Shots','f00.psd'));
  f.deleteInCloud(['Shots/f00.psd']);
  await assert.rejects(f.providers.reconcile(f.ctx));
  assert.deepEqual(removedPaths(f),[]);assert.ok(f.ctx.items.has('k0'));
});

test('"Remove here too" removes the held items, with quarantine, and clears the decision',async()=>{
  const f=await fixture({files:30,downloaded:[3]});
  f.deleteInCloud(f.cloud.filter(c=>c.kind==='file').map(c=>c.path).slice(0,25));
  await f.providers.reconcile(f.ctx);assert.equal(removedPaths(f).length,0);
  await f.providers.decide(f.acc,'apply');
  assert.equal(removedPaths(f).length,25);assert.equal(f.getReview(),null);assert.equal(f.ctx.review,null);
  assert.equal(f.events.filter(e=>e.action==='quarantine').map(e=>e.path).join(),'Shots/f03.psd');
  assert.equal(f.providers.status(f.acc).review,null);
});

test('"Restore in Dropbox" restores the deleted files at their last known revision and keeps local copies',async()=>{
  const f=await fixture({files:30});
  const gone=f.cloud.filter(c=>c.kind==='file').map(c=>c.path).slice(0,25);f.deleteInCloud(gone);
  await f.providers.reconcile(f.ctx);
  await f.providers.decide(f.acc,'restore');
  assert.deepEqual(f.remote.restored.sort(),gone.sort());assert.deepEqual(removedPaths(f),[]);
  assert.equal(f.getReview(),null);assert.equal(f.ctx.items.size,31);
  assert.equal(f.events.filter(e=>e.action==='restore').length,25);
});

test('deselecting a folder is not a cloud deletion: no threshold, no quarantine',async()=>{
  const f=await fixture({files:30,downloaded:[0,1]});
  f.acc.settings.rules={'':{selected:true,mode:'online',kind:'folder'},Shots:{selected:false,mode:'online',kind:'folder'}};
  await f.providers.reconcile(f.ctx);
  assert.equal(removedPaths(f).length,31);assert.equal(f.reviews.length,0);
  assert.equal(f.events.filter(e=>e.action==='quarantine').length,0);
});

test('edited local files are never removed by a cloud deletion, even after approval',async()=>{
  const f=await fixture({files:30});
  f.disk.set('Shots/f05.psd',{...f.disk.get('Shots/f05.psd'),inSync:false,dirtyBytes:4});
  f.deleteInCloud(['Shots/f05.psd']);
  await f.providers.reconcile(f.ctx);
  assert.deepEqual(removedPaths(f),[]);assert.equal(f.ctx.items.get('k5').status,'conflict');
});

test('a file deleted and created again with the same name replaces the placeholder in place',async()=>{
  const f=await fixture({files:30,downloaded:[7]});
  const entry=f.cloud.find(c=>c.path==='Shots/f07.psd');entry.remoteId='id:new';entry.rev='r-new';
  await f.providers.reconcile(f.ctx);
  assert.deepEqual(removedPaths(f),[]);
  const update=f.commands.find(c=>c.command==='update'&&c.path==='Shots/f07.psd');assert.ok(update);assert.equal(update.previousIdentity,'k7@x');
  const item=f.ctx.items.get('k7');assert.equal(item.remoteId,'id:new');assert.notEqual(item.status,'conflict');
  assert.equal(f.events.filter(e=>e.action==='quarantine').map(e=>e.path).join(),'Shots/f07.psd','the replaced local copy is kept');
});

function folderDeletion(f,count){
  const items=[...f.ctx.items.values()].filter(i=>i.path==='Shots'||i.path.startsWith('Shots/')).slice(0,count+1);
  const op={id:randomUUID(),path:'Shots',action:'delete',items,remoteBaseline:items.map(({path,remoteId,rev})=>({path,remoteId,rev})),preparedAt:Date.now()-10000};
  f.ctx.deletions.set(op.id,op);for(const item of items)f.disk.delete(item.path);return op;
}

test('a large folder deleted in Explorer waits for confirmation before Dropbox is touched',async()=>{
  const f=await fixture({files:30});const op=folderDeletion(f,30);
  await finishDeletions(f.providers,f.ctx);
  assert.deepEqual(f.remote.removed,[]);assert.equal(f.ctx.deletions.get(op.id).awaitingConfirmation,true);assert.equal(f.reviews.length,1);
  await finishDeletions(f.providers,f.ctx);assert.equal(f.reviews.length,1);
  const status=f.providers.status(f.acc);assert.equal(status.confirmations.length,1);assert.equal(status.confirmations[0].count,31);assert.equal(status.pending,0);
  await f.providers.decide(f.acc,'confirm',op.id);
  assert.deepEqual(f.remote.removed,['Shots']);assert.equal(f.ctx.deletions.size,0);
});

test('cancelling a large Explorer deletion keeps Dropbox intact and brings the placeholders back',async()=>{
  const f=await fixture({files:30});const op=folderDeletion(f,30);
  await finishDeletions(f.providers,f.ctx);
  await f.providers.decide(f.acc,'cancel',op.id);
  assert.deepEqual(f.remote.removed,[]);assert.equal(f.ctx.deletions.size,0);
  assert.equal(f.commands.filter(c=>c.command==='create').length,31);assert.equal(f.disk.get('Shots/f00.psd').exists,true);
});

test('a small Explorer deletion still goes straight to Dropbox',async()=>{
  const f=await fixture({files:5});const op=folderDeletion(f,5);
  await finishDeletions(f.providers,f.ctx);
  assert.deepEqual(f.remote.removed,['Shots']);assert.equal(f.reviews.length,0);assert.equal(f.ctx.deletions.has(op.id),false);
});

function fileByFileDeletion(f,count){
  // Shift+Delete or rm -rf: Windows reports one deletion per file, each a separate operation.
  const files=[...f.ctx.items.values()].filter(i=>i.kind==='file').slice(0,count),ops=[];
  for(const item of files){const op={id:randomUUID(),path:item.path,action:'delete',items:[item],remoteBaseline:[{path:item.path,remoteId:item.remoteId,rev:item.rev}],preparedAt:Date.now()-10000};f.ctx.deletions.set(op.id,op);f.disk.delete(item.path);ops.push(op);}
  return ops;
}

test('Shift+Delete of 30 files one by one is held as one batch, not sent file by file',async()=>{
  const f=await fixture({files:30});fileByFileDeletion(f,30);
  await finishDeletions(f.providers,f.ctx);
  assert.deepEqual(f.remote.removed,[],'nothing reached Dropbox');assert.equal(f.reviews.length,1,'one notification');
  const [confirmation,...rest]=f.providers.status(f.acc).confirmations;assert.equal(rest.length,0,'one decision, not thirty');
  assert.equal(confirmation.count,30);assert.equal(confirmation.path,'Shots');
  await f.providers.decide(f.acc,'confirm',confirmation.id);
  assert.equal(f.remote.removed.length,30);assert.equal(f.ctx.deletions.size,0);
});

test('cancelling a file-by-file batch brings every file back',async()=>{
  const f=await fixture({files:30});fileByFileDeletion(f,25);
  await finishDeletions(f.providers,f.ctx);const [confirmation]=f.providers.status(f.acc).confirmations;
  await f.providers.decide(f.acc,'cancel',confirmation.id);
  assert.deepEqual(f.remote.removed,[]);assert.equal(f.ctx.deletions.size,0);assert.equal(f.commands.filter(c=>c.command==='create').length,25);
});

test('a few files deleted one by one still go straight to Dropbox',async()=>{
  const f=await fixture({files:30});fileByFileDeletion(f,4);
  await finishDeletions(f.providers,f.ctx);
  assert.equal(f.remote.removed.length,4);assert.equal(f.reviews.length,0);
});

test('deletions arriving after a batch is held join the same batch',async()=>{
  const f=await fixture({files:40});const first=fileByFileDeletion(f,25);
  await finishDeletions(f.providers,f.ctx);
  const later=[...f.ctx.items.values()].filter(i=>i.kind==='file').slice(25,30);
  for(const item of later){const op={id:randomUUID(),path:item.path,action:'delete',items:[item],remoteBaseline:[{path:item.path,remoteId:item.remoteId,rev:item.rev}],preparedAt:Date.now()-10000};f.ctx.deletions.set(op.id,op);}
  await finishDeletions(f.providers,f.ctx);
  const confirmations=f.providers.status(f.acc).confirmations;assert.equal(confirmations.length,1);assert.equal(confirmations[0].count,30);
  assert.equal(f.reviews.length,1,'still one notification');assert.deepEqual(f.remote.removed,[]);assert.ok(first.length);
});
