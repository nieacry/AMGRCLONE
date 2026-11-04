import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {NativeHost} from '../core/native-host.mjs';
const project=path.resolve(import.meta.dirname,'..'),stage=process.argv.includes('--packaged')?JSON.parse(await readFile('.runtime/release-stage.json','utf8')):null;
const base=path.join(project,'.runtime/native-resilience',randomUUID()),root=path.join(base,'root'),cache=path.join(base,'cache');await mkdir(root,{recursive:true});await mkdir(cache);
const host=new NativeHost(stage?path.join(stage.app,'resources/bin/amg-cloud.exe'):path.join(project,'native/bin/amg-cloud.exe')),items=[];let downloads=0;
const owner=randomUUID();await writeFile(path.join(base,'fixture.json'),JSON.stringify({root,cache,owner}));
host.on('event',async event=>{if(event.event==='fetch'){downloads++;await host.request('fail',{request:event.request}).catch(()=>{});}});
try{
  await host.request('init',{root,cache,owner,displayName:'Long path fixture'});
  let relative='';for(let i=0;i<7;i++){
    relative+=(relative?'/':'')+`Folder-${i}-`+'a'.repeat(30);const identity='folder-'+i;items.push({path:relative,identity});
    await host.request('create',{path:relative,identity,directory:true});
  }
  const file=relative+'/preview_metadata.json',identity='file-v1';items.push({path:file,identity});assert.ok(path.join(root,file).length>350);
  for(let i=0;i<3;i++)await host.request('create',{path:file,identity,size:0,directory:false});
  const state=await host.request('inspect',{path:file});assert.equal(state.exists,true);assert.equal(state.identity,identity);assert.equal(state.placeholder,true);
  await assert.rejects(()=>host.request('create',{path:file,identity:'foreign',size:0,directory:false}));assert.equal((await host.request('inspect',{path:file})).identity,identity);
  const update={path:file,previousIdentity:identity,identity:'file-v2',size:0,directory:false,modified:Date.now()};await host.request('update',update);items.at(-1).identity='file-v2';await host.request('update',update);
  assert.equal((await host.request('inspect',{path:file})).identity,'file-v2');assert.equal(downloads,0);
  const other=new NativeHost(stage?path.join(stage.app,'resources/bin/amg-cloud.exe'):path.join(project,'native/bin/amg-cloud.exe'));
  try{await assert.rejects(()=>other.request('init',{root,cache,owner:randomUUID()}),e=>e.message==='err.nativeRootOwnership'&&e.nativeStage==='init.ownership.registeredOther'&&e.nativePath===root);await other.request('releaseEmpty');assert.equal((await host.request('checkPath',{path:root})).registered,true);assert.equal((await host.request('inspect',{path:file})).identity,'file-v2');}finally{await other.close();}
  for(const item of [...items].reverse())await host.request('remove',item);
  console.log('PASS: real NTFS placeholders beyond 350 characters can be created/retried, inspected and updated without downloads; unrelated identities remain protected');
}catch(error){console.error('Native test failed:',error.nativeCommand,error.nativeCode,error.nativePath);throw error;}finally{try{for(const item of [...items].reverse())await host.request('remove',item).catch(()=>{});await host.request('unregister').catch(error=>console.error('Test cleanup:',error.nativeCode));}finally{await host.close();}}
