import {NativeHost} from '../core/native-host.mjs';
import {mkdir,writeFile,readFile,unlink,open,opendir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
const exec=promisify(execFile),project=path.resolve(import.meta.dirname,'..'),base=path.join(project,'.runtime/native-smoke',randomUUID().slice(0,8)),root=path.join(base,'root'),cache=path.join(base,'cache');
await mkdir(root,{recursive:true});await mkdir(cache,{recursive:true});
const owner=randomUUID();await writeFile(path.join(base,'fixture.json'),JSON.stringify({root,cache,owner}));
const host=new NativeHost(path.join(project,'native/bin/amg-cloud.exe')),content=randomBytes(2*1024*1024+7);let mapped,failNextFetch=false;
host.on('event',async event=>{
  try{
    if(event.event==='fetch'){
      if(failNextFetch){failNextFetch=false;await host.request('fail',{request:event.request});return;}
      const start=event.offset,end=Math.min(content.length,event.length<0?content.length:start+event.length);
      for(let offset=start;offset<end;offset+=65536){const endChunk=Math.min(end,offset+65536),file=path.join(cache,'chunk-'+randomUUID());await writeFile(file,content.subarray(offset,endChunk));try{await host.request('supply',{request:event.request,file,offset,final:endChunk===end});}finally{await unlink(file);}}
    }else if(event.event==='delete'||event.event==='rename')await host.request('ack',{request:event.request,allow:false});
  }catch(error){console.error('Callback failed',error.nativeCode||error.message);await host.request('fail',{request:event.request}).catch(()=>{});}
});
try{
  const probe=await host.request('probe');console.log('Platform',probe);assert.equal(probe.supported,true);
  const registration=await host.request('init',{root,cache,owner});assert.equal(registration.shellRegistered,true);assert.equal(registration.indexed,true);console.log('PASS: native root registration and connection');assert.equal((await host.request('checkPath',{path:root})).registered,true);assert.equal((await host.request('checkPath',{path:cache})).registered,false);
  await host.request('create',{path:'Cloud.bin',identity:'fixture-v1',size:content.length,modified:Date.now(),directory:false});
  const before=await host.request('inspect',{path:'Cloud.bin'});console.log('Placeholder',before);assert.equal(before.placeholder,true);assert.equal(before.onDisk,0);
  const script="const fs=require('node:fs'),crypto=require('node:crypto'); const b=fs.readFileSync(process.argv[1]);process.stdout.write(crypto.createHash('sha256').update(b).digest('hex'));";
  const actual=await exec(process.execPath,['-e',script,path.join(root,'Cloud.bin')],{windowsHide:true,timeout:30000});assert.equal(actual.stdout,createHash('sha256').update(content).digest('hex'));console.log('PASS: external process reads actual placeholder; bytes hydrated through CfExecute');
  await host.request('availability',{path:'Cloud.bin',identity:'fixture-v1',mode:'online'});const freed=await host.request('inspect',{path:'Cloud.bin'});assert.equal(freed.onDisk,0);console.log('PASS: clean file dehydration');
  await host.request('availability',{path:'Cloud.bin',identity:'fixture-v1',mode:'local'});const pinned=await host.request('inspect',{path:'Cloud.bin'});assert.equal(pinned.pin,1);assert.equal(pinned.partial,false);console.log('PASS: pinned hydration');
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal((await host.request('transfer',{path:'Cloud.bin',identity:'fixture-v1',busy:true})).shellResult,0);assert.equal((await host.request('shellState',{path:path.join(root,'Cloud.bin')})).transfer,'4');await host.request('transfer',{path:'Cloud.bin',identity:'fixture-v1',busy:false});assert.equal((await host.request('shellState',{path:path.join(root,'Cloud.bin')})).transfer,'0');console.log('PASS: Explorer receives active and completed per-file transfer states');
  await writeFile(path.join(root,'Cloud.bin'),'edited locally');await assert.rejects(()=>host.request('availability',{path:'Cloud.bin',identity:'fixture-v1',mode:'online'}));console.log('PASS: dirty file cannot be dehydrated');
  const snapshot=await host.request('snapshot',{path:'Cloud.bin',file:path.join(cache,'snapshot-a')});assert.equal(await readFile(path.join(cache,'snapshot-a'),'utf8'),'edited locally');
  const committed=await host.request('commit',{path:'Cloud.bin',previousIdentity:'fixture-v1',identity:'fixture-v2',stamp:snapshot.stamp});assert.equal(committed.committed,true);
  await host.request('create',{path:'Mapped',identity:'mapped-folder',directory:true,size:0,modified:Date.now()});
  const openFolder=await opendir(path.join(root,'Mapped')),openFile=await open(path.join(root,'Cloud.bin'),'r');try{for(const mode of ['online','local','local','online'])await host.request('folderAvailability',{path:'Mapped',identity:'mapped-folder',mode});await host.request('availability',{path:'Cloud.bin',identity:'fixture-v2',mode:'local'});}finally{await openFolder.close();await openFile.close();}console.log('PASS: folder pin changes and file hydration coexist with Explorer-style open handles');
  await host.request('remove',{path:'Cloud.bin',identity:'fixture-v2'});await host.request('remove',{path:'Mapped',identity:'mapped-folder'});
  await host.request('create',{path:'Detach.bin',identity:'detach-fixture',size:content.length,modified:Date.now(),directory:false});failNextFetch=true;
  await assert.rejects(()=>host.request('detach',{items:[{path:'Detach.bin',identity:'detach-fixture'}]}));assert.equal((await host.request('inspect',{path:'Detach.bin'})).placeholder,true);assert.equal((await host.request('checkPath',{path:root})).registered,true);
  await host.request('detach',{items:[{path:'Detach.bin',identity:'detach-fixture'}]});assert.deepEqual(await readFile(path.join(root,'Detach.bin')),content);assert.equal((await host.request('checkPath',{path:root})).registered,false);console.log('PASS: failed detach preserves placeholders and registration; retry hydrates all bytes and leaves ordinary local files');
}finally{await host.close();}
