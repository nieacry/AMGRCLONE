import {NativeHost} from '../core/native-host.mjs';
import {mkdir,readFile,writeFile,readdir,stat,open,unlink} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
const project=path.resolve(import.meta.dirname,'..'),stage=process.argv.includes('--packaged')?JSON.parse(await readFile('.runtime/release-stage.json','utf8')):null,base=path.join(project,'.runtime/reset-test',randomUUID()),root=path.join(base,'root'),cache=path.join(base,'cache');
await mkdir(root,{recursive:true});await mkdir(cache);const host=new NativeHost(stage?path.join(stage.app,'resources/bin/amg-cloud.exe'):path.join(project,'native/bin/amg-cloud.exe')),content=randomBytes(4*1024*1024),known=[];let fetches=0,resetting=false;
host.on('event',async event=>{try{if(event.event==='fetch'){fetches++;if(resetting){await host.request('fail',{request:event.request});return;}const end=Math.min(event.size,event.length<0?event.size:event.offset+event.length),partial=event.identity==='partial';let position=event.offset;while(position<end){const stop=Math.min(end,position+65536),file=path.join(cache,'chunk-'+randomUUID());await writeFile(file,content.subarray(position,stop));try{await host.request('supply',{request:event.request,file,offset:position,final:stop===end});}finally{await unlink(file);}position=stop;if(partial&&position<end){await host.request('fail',{request:event.request});break;}}}else if(['delete','rename'].includes(event.event))await host.request('ack',{request:event.request,allow:false});}catch(error){await host.request('fail',{request:event.request}).catch(()=>{});}});
try{
  await host.request('init',{root,cache,owner:randomUUID(),displayName:'Reset fixture'});
  const create=async(relative,identity,size,directory=false)=>{await host.request('create',{path:relative,identity,size,directory,modified:Date.now()});known.push({path:relative,identity});};
  await create('Project','project',0,true);await create('Empty','empty',0,true);await create('Project/Online.bin','online',100*1024**3);await create('Project/Cached.bin','cached',65536);await create('Project/Dirty.bin','dirty',65536);await create('Project/Partial.bin','partial',content.length);await create('Zero.txt','zero',0);
  for(const relative of ['Project/Cached.bin','Project/Dirty.bin'])await host.request('availability',{path:relative,identity:relative.includes('Cached')?'cached':'dirty',mode:'local'});
  await writeFile(path.join(root,'Project/Dirty.bin'),'unsent local edit');await writeFile(path.join(root,'Project/New.txt'),'ordinary unsent local file');
  // Ask Windows to hydrate a range, not the complete file, to exercise preservation of partial data.
  const ps=path.join(base,'range.ps1');await writeFile(ps,`param([string]$File)
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class RangeFixture {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("cldapi.dll")] public static extern int CfHydratePlaceholder(SafeFileHandle h,long start,long length,uint flags,IntPtr overlapped);
 public static int Run(string p){using(var h=CreateFile(p,0x80000080,7,IntPtr.Zero,3,0x00300000,IntPtr.Zero)){if(h.IsInvalid)throw new System.ComponentModel.Win32Exception();return CfHydratePlaceholder(h,4096,4096,0,IntPtr.Zero);}}
}
'@
[RangeFixture]::Run($File)
`);
  await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',ps,'-File',path.join(root,'Project/Partial.bin')],{windowsHide:true,timeout:30000});
  const partial=await host.request('inspect',{path:'Project/Partial.bin'});assert.ok(partial.onDisk>0&&partial.onDisk<content.length,JSON.stringify(partial));
  // An unknown cloud identity must block the whole reset before any local removal.
  await host.request('create',{path:'Unknown.bin',identity:'unknown',size:42,directory:false,modified:Date.now()});resetting=true;await host.request('freezeForReset');const before=fetches;
  await assert.rejects(()=>host.request('detachKeepDownloaded',{items:known,recovery:path.join(cache,'reset-recovery')}));assert.equal((await host.request('inspect',{path:'Project/Online.bin'})).exists,true);assert.equal(fetches,before);await host.request('remove',{path:'Unknown.bin',identity:'unknown'});
  await host.request('cancelReset');await assert.rejects(()=>host.request('detachKeepDownloaded',{items:known,recovery:path.join(cache,'reset-recovery')}));assert.equal((await host.request('checkPath',{path:root})).registered,true);
  await host.request('freezeForReset');await host.request('detachKeepDownloaded',{items:known,recovery:path.join(cache,'reset-recovery')});assert.equal(fetches,before,'Reset must not request hydration, even for a 100 GiB online-only file or partial file');assert.equal((await host.request('checkPath',{path:root})).registered,false);
  assert.deepEqual(await readFile(path.join(root,'Project/Cached.bin')),content.subarray(0,65536));assert.equal(await readFile(path.join(root,'Project/Dirty.bin'),'utf8'),'unsent local edit');assert.equal(await readFile(path.join(root,'Project/New.txt'),'utf8'),'ordinary unsent local file');assert.equal((await stat(path.join(root,'Zero.txt'))).size,0);
  for(const relative of ['Project/Online.bin','Project/Partial.bin','Empty'])assert.equal(await stat(path.join(root,relative)).catch(()=>null),null);
  const recovery=path.join(cache,'reset-recovery'),manifests=(await readdir(recovery)).filter(name=>name.endsWith('.json'));assert.equal(manifests.length,1);const metadata=JSON.parse(await readFile(path.join(recovery,manifests[0]),'utf8'));assert.equal(metadata.path,'Project\\Partial.bin');assert.ok(metadata.ranges.some(range=>range.offset<=4096&&range.offset+range.length>=8192),'The originally downloaded range must be preserved');assert.equal(metadata.complete,false);const saved=await open(path.join(recovery,metadata.file),'r');try{for(const range of metadata.ranges){const bytes=Buffer.alloc(range.length);assert.equal((await saved.read(bytes,0,bytes.length,range.offset)).bytesRead,bytes.length);assert.deepEqual(bytes,content.subarray(range.offset,range.offset+range.length));}}finally{await saved.close();}
  console.log('PASS: no-download reset removes a 100 GiB online-only placeholder locally, preserves cached/dirty/ordinary/zero-byte files, backs up only downloaded partial ranges, rejects unknown identities, honors cancellation and unregisters its root without any fetch');
}finally{await host.close();}
