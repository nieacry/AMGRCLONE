import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeProviders} from '../core/native-provider.mjs';
import {prepareDeletion} from '../core/native-deletions.mjs';
import {validateLocalMapping} from '../core/policy.mjs';
import {SyncStore} from '../core/store.mjs';

const folder={path:'Project',kind:'folder',remoteId:'project',rev:'',size:0};
const file=(path,id=path)=>({path,kind:'file',remoteId:id,rev:'r1',size:42,modified:1});
function fixture(entries){
  const store=new SyncStore(':memory:'),commands=[],disk=new Map(),acc={id:'A',native:{enabled:true},settings:{rules:{'':{selected:true,kind:'folder',mode:'online'}}}},provider=new NativeProviders({store,persist:async()=>{}});
  const ctx={acc,items:new Map(),deletions:new Map(),fetches:new Map(),uploads:new Set(),operation:new AbortController(),remote:{list:async()=>[folder,...entries],metadata:async()=>folder},host:{request:async(command,value)=>{commands.push([command,value?.path]);if(command==='inspect')return disk.get(value.path)||{exists:false};if(command==='create')disk.set(value.path,{exists:true,placeholder:true,identity:value.identity,inSync:true,partial:!value.directory,pin:0,onDisk:0,size:value.size,directory:value.directory});return {};}}};
  provider.contexts.set(acc.id,ctx);return {provider,ctx,store,disk,commands};
}

test('invalid Windows names and descendants are skipped while valid siblings become online placeholders',async()=>{
  const f=fixture([file('Project/Bad?.ma'),file('Project/Bad?/child.ma'),file('Project/AUX.pdf'),file('Project/end.'),file('Project/end /clip.mov'),file('Project/'+ 'x'.repeat(256)),file('Project/good.ma')]);
  try{await f.provider.reconcile(f.ctx);await f.provider.finishCheck(f.ctx);assert.equal(f.disk.size,2);assert.ok(f.disk.has('Project/good.ma'));assert.equal(f.ctx.mappingSkips.size,6);assert.equal(f.ctx.checkedThisRun,true);assert.ok(f.ctx.acc.native.lastSync);assert.equal(f.provider.status(f.ctx.acc).skippedFiles,6);assert.equal(f.commands.some(([c])=>['availability','remove','download','upload'].includes(c)),false);
    const rows=f.store.fileEvents('A',{status:'skipped'}).entries;assert.equal(rows.length,6);assert.ok(rows.some(e=>e.path==='Project/Bad?.ma'&&e.detail==='err.mappingCharacters'));
    await f.provider.reconcile(f.ctx);assert.equal(f.store.fileEvents('A',{status:'skipped'}).entries.length,6);
    const states=await f.provider.itemStates(f.ctx.acc,['Project/Bad?.ma','Project/good.ma']);assert.equal(states['Project/Bad?.ma'],'skipped');assert.equal(states['Project/good.ma'],'online');
    await assert.rejects(()=>prepareDeletion(f.provider,f.ctx,{event:'recycle',path:'Project'}),/err.nativeSkippedDelete/);assert.equal(f.ctx.deletions.size,0);
  }finally{f.store.close();}
});

test('cloud rename to an invalid name preserves the old local subtree, ancestors and catalog',async()=>{
  const f=fixture([{path:'Bad?',kind:'folder',remoteId:'renamed',size:0},file('Bad?/child.ma','child'),file('Project/good.ma')]);
  try{const old={key:'old',path:'Old/Folder',remoteId:'renamed',kind:'folder',status:'cached',identity:'owned'},child={key:'child',path:'Old/Folder/child.ma',remoteId:'child',kind:'file',status:'cached',identity:'child'},parent={key:'parent',path:'Old',remoteId:'parent',kind:'folder',status:'cached',identity:'parent'};for(const i of [parent,old,child]){f.ctx.items.set(i.key,i);f.store.saveNativeItem('A',i);f.disk.set(i.path,{exists:true,placeholder:true,identity:i.identity,inSync:true});}
    await f.provider.reconcile(f.ctx);assert.equal(f.commands.some(([c])=>c==='remove'||c==='moveLocal'),false);assert.equal(f.ctx.items.get('child'),child);assert.equal(f.ctx.items.get('parent'),parent);assert.ok(f.disk.has('Project/good.ma'));
    await assert.rejects(()=>prepareDeletion(f.provider,f.ctx,{event:'recycle',path:'Old'}),/err.nativeSkippedDelete/);
    f.ctx.remote.list=async()=>[folder,file('Project/fixed.ma','child')];await f.provider.collect(f.ctx);assert.equal(f.ctx.mappingSkips.size,0);assert.equal(f.ctx.mappingBlocks.paths.size,0);
  }finally{f.store.close();}
});

test('failed pagination preserves prior exclusions; valid names resume on the next complete snapshot',async()=>{
  const f=fixture([file('Project/Bad?.ma','rename')]);try{await f.provider.reconcile(f.ctx);const prior=f.ctx.mappingBlocks,events=f.store.fileEvents('A').entries.length;f.commands.length=0;
    f.ctx.remote.listPages=async function*(){yield [folder,file('Project/good.ma')];throw new Error('err.nativeNetwork');};await assert.rejects(()=>f.provider.reconcile(f.ctx),/err.nativeNetwork/);assert.equal(f.ctx.mappingBlocks,prior);assert.equal(f.commands.length,0);assert.equal(f.store.fileEvents('A').entries.length,events);
    f.ctx.remote.listPages=async function*(){yield [folder,file('Project/fixed.ma','rename')];};await f.provider.reconcile(f.ctx);assert.equal(f.ctx.mappingSkips.size,0);assert.ok(f.disk.has('Project/fixed.ma'));
  }finally{f.store.close();}
});

test('unselected bad names produce no warnings; collisions and unsafe paths still stop before mutations',async()=>{
  const f=fixture([file('Project/Bad?.ma'),file('Project/good.ma')]);try{f.ctx.acc.settings.rules['Project/Bad?.ma']={selected:false,mode:'online',kind:'file'};await f.provider.reconcile(f.ctx);assert.equal(f.ctx.mappingSkips.size,0);assert.equal(f.store.fileEvents('A',{status:'skipped'}).entries.length,0);
    f.commands.length=0;f.ctx.remote.list=async()=>[file('A.ma'),file('a.ma')];await assert.rejects(()=>f.provider.reconcile(f.ctx),e=>e.nativeStage==='err.mappingCollision');assert.equal(f.commands.length,0);
    f.ctx.remote.list=async()=>[file('../outside')];await assert.rejects(()=>f.provider.reconcile(f.ctx),/err.path/);assert.equal(f.commands.length,0);
  }finally{f.store.close();}
});

test('Windows component limits count UTF-16 code units and reject control characters',()=>{
  assert.equal(validateLocalMapping('a'.repeat(255),'win32'),'a'.repeat(255));for(const p of ['a'.repeat(256),'😀'.repeat(128)])assert.throws(()=>validateLocalMapping(p,'win32'),e=>e.nativeStage==='err.mappingLength');assert.throws(()=>validateLocalMapping('Bad\x01.txt','win32'),e=>e.nativeStage==='err.mappingCharacters');
});
