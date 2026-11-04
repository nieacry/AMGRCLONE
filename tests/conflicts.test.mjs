import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,unlink,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {conflictCopyPath,computerName,resolvable,resolveConflict} from '../core/conflicts.mjs';
import {dropboxError,dropboxHash} from '../core/dropbox-transport.mjs';
import {NativeProviders} from '../core/native-provider.mjs';

const base=path.resolve(import.meta.dirname,'../.runtime/conflicts');
const at=Date.parse('2026-11-04T14:05:00');

test('conflict copy names keep the folder and extension and are valid on Windows',()=>{
  assert.equal(conflictCopyPath('Shots/010/frame.psd',{computer:'ART-03',time:at}),'Shots/010/frame (конфлікт, ART-03, 2026-11-04 14-05).psd');
  assert.equal(conflictCopyPath('notes',{computer:'ART-03',time:at}),'notes (конфлікт, ART-03, 2026-11-04 14-05)');
  assert.equal(conflictCopyPath('a.tar.gz',{computer:'X',time:at,attempt:2}),'a.tar (конфлікт, X, 2026-11-04 14-05 2).gz');
  const long=conflictCopyPath('Shots/'+'x'.repeat(250)+'.psd',{computer:'ART-03',time:at});assert.ok(long.split('/').at(-1).length<=255);assert.ok(long.endsWith(').psd'));
  assert.equal(computerName('ART:03/"PC". '),'ART03PC');assert.equal(computerName(''),'PC');
});

test('only real conflicts with local data are resolved automatically',()=>{
  const item={status:'conflict',kind:'file',identity:'k@1',rev:'r1'},edited={exists:true,placeholder:true,identity:'k@1',inSync:false};
  assert.equal(resolvable(item,edited,{rev:'r2'}),true,'the cloud moved on');
  assert.equal(resolvable(item,edited,undefined),true,'deleted in Dropbox while edited here');
  assert.equal(resolvable(item,edited,{rev:'r1'}),false,'same base revision: a plain upload retry (1.4), not a conflict');
  assert.equal(resolvable(item,{exists:true,placeholder:false},{rev:'r1'}),true,'a new local file where Dropbox already has one');
  assert.equal(resolvable(item,{...edited,identity:'other'},{rev:'r2'}),false,'not our placeholder');
  assert.equal(resolvable(item,{...edited,inSync:true},{rev:'r2'}),false,'nothing edited locally');
  assert.equal(resolvable({...item,status:'dirty'},edited,{rev:'r2'}),false);
  assert.equal(resolvable({...item,kind:'folder'},edited,{rev:'r2'}),false);
  assert.equal(resolvable({...item,conflictCopy:{stage:'uploaded'}},{exists:false},undefined),true,'resume');
});

async function fixture({content='local edit',placeholder=true,taken={},failUpload=null,failDiscard=0}={}){
  const dir=path.join(base,randomUUID()),root=path.join(dir,'root'),cache=path.join(dir,'cache');await mkdir(path.join(root,'Shots'),{recursive:true});await mkdir(cache,{recursive:true});
  await writeFile(path.join(root,'Shots','frame.psd'),content);
  const events=[],saved=new Map(),commands=[],uploads=[],disk=new Map();let discards=0;
  disk.set('Shots/frame.psd',placeholder?{exists:true,placeholder:true,identity:'k1@x',inSync:false,partial:false,onDisk:content.length,size:content.length,modified:at}:{exists:true,placeholder:false,size:content.length,modified:at});
  const acc={id:'acc',settings:{rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,root}};
  const providers=new NativeProviders({dataDir:dir,store:{addFileEvent(_id,e){events.push(e);},saveNativeItem(_id,i){saved.set(i.key,structuredClone(i));},deleteNativeItem(_id,k){saved.delete(k);}},persist:async()=>{}});
  const host={request:async(command,value={})=>{commands.push({command,...value});
    if(command==='inspect')return disk.get(value.path)||{exists:false};
    if(command==='snapshot'){await copyFile(path.join(root,...value.path.split('/')),value.file);return {modified:at,size:content.length,stamp:'s'};}
    if(command==='availability'){disk.set(value.path,{...disk.get(value.path),partial:false,onDisk:content.length});return {};}
    if(command==='discard'){if(discards++<failDiscard)throw Object.assign(new Error('err.native'),{nativeCode:'0x80070020'});disk.delete(value.path);await unlink(path.join(root,...value.path.split('/')));return {};}
    return {};}};
  const remote={async upload(target,file,previous){const bytes=await readFile(file,'utf8');uploads.push({target,bytes,previous});if(failUpload)throw failUpload;if(taken[target])throw dropboxError(409,'path/conflict/file/..');return {remoteId:'id:'+target,rev:'rc',kind:'file',size:bytes.length,hash:await dropboxHash(file)};},
    async metadata(target){if(taken[target])return {kind:'file',remoteId:'id:taken',rev:'rt',hash:taken[target]};throw Object.assign(new Error('err.nativeConflict'),{notFound:true});}};
  const ctx={acc,remote,host,cache,items:new Map(),deletions:new Map(),fetches:new Map(),uploads:new Set(),queue:Promise.resolve()};
  const item={key:'k1',path:'Shots/frame.psd',kind:'file',remoteId:'id:1',rev:'r1',identity:'k1@x',size:4,status:'conflict'};ctx.items.set(item.key,item);
  const quarantined=()=>path.join(dir,'quarantine','acc',new Date().toISOString().slice(0,10),'Shots','frame.psd');
  return {providers,ctx,item,events,saved,commands,uploads,disk,root,dir,quarantined};
}
const run=(f,{remote={rev:'r2'},state}={})=>resolveConflict(f.providers,f.ctx,f.item,{remote,state:state||f.disk.get(f.item.path),computer:'ART-03',now:at});

test('edits that lost to a newer cloud version are uploaded as a conflict copy; the original returns to the cloud version',async()=>{
  const f=await fixture();const result=await run(f);
  assert.deepEqual(f.uploads,[{target:'Shots/frame (конфлікт, ART-03, 2026-11-04 14-05).psd',bytes:'local edit',previous:null}],'uploaded with mode add, never overwriting');
  assert.equal(await readFile(f.quarantined(),'utf8'),'local edit','one more local copy is kept');
  const discard=f.commands.find(c=>c.command==='discard');assert.equal(discard.identity,'k1@x');
  assert.equal(f.ctx.items.has('k1'),false);assert.equal(f.saved.has('k1'),false);assert.equal(f.ctx.needsReconcile,true);
  assert.equal(f.events.find(e=>e.action==='conflictCopy').target,result.copy);
  const order=f.commands.map(c=>c.command);assert.ok(order.indexOf('snapshot')<order.indexOf('discard'));
});

test('the copy name is never overwritten: a name taken by someone else gets a number',async()=>{
  const f=await fixture({taken:{'Shots/frame (конфлікт, ART-03, 2026-11-04 14-05).psd':'other-bytes'}});const result=await run(f);
  assert.equal(result.copy,'Shots/frame (конфлікт, ART-03, 2026-11-04 14-05 2).psd');assert.equal(f.uploads.length,2);
});

test('a copy already uploaded by an interrupted attempt (same bytes) is reused, not duplicated',async()=>{
  const name='Shots/frame (конфлікт, ART-03, 2026-11-04 14-05).psd',f=await fixture();
  const file=path.join(f.dir,'probe');await writeFile(file,'local edit');const hash=await dropboxHash(file);
  const g=await fixture({taken:{[name]:hash}});const result=await run(g);
  assert.equal(result.copy,name);assert.equal(g.uploads.length,1,'one failed add, no second copy');
});

test('if the upload fails, nothing local is touched and the intent survives for the next attempt',async()=>{
  const f=await fixture({failUpload:dropboxError(503,'')});
  await assert.rejects(run(f));
  assert.equal(f.commands.some(c=>c.command==='discard'),false);assert.equal(existsSync(path.join(f.root,'Shots','frame.psd')),true);
  assert.equal(f.saved.get('k1').conflictCopy.stage,'uploading');assert.equal(f.ctx.items.has('k1'),true);
});

test('a discard blocked by an open file is retried later without uploading a second copy',async()=>{
  const f=await fixture({failDiscard:1});
  await assert.rejects(run(f),error=>error.nativeCode==='0x80070020');
  assert.equal(f.uploads.length,1);assert.equal(f.saved.get('k1').conflictCopy.stage,'uploaded');assert.equal(existsSync(path.join(f.root,'Shots','frame.psd')),true);
  f.item.conflictCopy=f.saved.get('k1').conflictCopy;
  await run(f);
  assert.equal(f.uploads.length,1,'no duplicate upload on resume');assert.equal(f.ctx.items.has('k1'),false);assert.equal(existsSync(path.join(f.root,'Shots','frame.psd')),false);
});

test('a new local file whose name already exists in Dropbox becomes a copy; the plain file is replaced',async()=>{
  const f=await fixture({placeholder:false});await run(f,{remote:{rev:'r1'}});
  assert.equal(f.uploads.length,1);assert.equal(f.commands.some(c=>c.command==='discard'),false,'not a placeholder: removed directly');
  assert.equal(existsSync(path.join(f.root,'Shots','frame.psd')),false);assert.equal(await readFile(f.quarantined(),'utf8'),'local edit');
});

test('an edited placeholder that is only partly on disk is completed before the copy is made',async()=>{
  const f=await fixture();f.disk.set('Shots/frame.psd',{...f.disk.get('Shots/frame.psd'),partial:true,onDisk:2});
  await run(f);const order=f.commands.map(c=>c.command);
  assert.ok(order.indexOf('availability')>=0&&order.indexOf('availability')<order.indexOf('snapshot'));assert.equal(f.uploads.length,1);
});

test('provider: a name clash on a new file does not block other uploads, and the clash is resolved after the cloud check',async()=>{
  const f=await fixture({placeholder:false});await writeFile(path.join(f.root,'Shots','other.png'),'png');
  f.ctx.items.clear();f.disk.set('Shots',{exists:true,placeholder:true,directory:true,identity:'kf@f',inSync:true});f.ctx.items.set('kf',{key:'kf',path:'Shots',kind:'folder',remoteId:'id:f',rev:'',identity:'kf@f',status:'cached'});
  f.disk.set('Shots/other.png',{exists:true,placeholder:false,size:3,modified:at});
  const cloudFrame={path:'Shots/frame.psd',remoteId:'id:cloud',rev:'r9',kind:'file',size:5,hash:'cloud'};
  f.ctx.remote.upload=async(target,file,previous)=>{f.uploads.push({target,previous});if(target==='Shots/frame.psd')throw dropboxError(409,'path/conflict/file/..');return {remoteId:'id:'+target,rev:'rn',kind:'file',size:3,hash:await dropboxHash(file)};};
  f.ctx.remote.metadata=async target=>{if(target==='Shots/frame.psd')return cloudFrame;throw Object.assign(new Error('x'),{notFound:true});};
  await f.providers.scan(f.ctx);
  assert.deepEqual(f.uploads.map(u=>u.target).sort(),['Shots/frame.psd','Shots/other.png'],'the clash did not stop the scan');
  const tracked=[...f.ctx.items.values()].find(i=>i.path==='Shots/frame.psd');assert.equal(tracked.status,'conflict');assert.equal(tracked.remoteId,'id:cloud');
  f.ctx.remoteCatalog=[{path:'Shots',remoteId:'id:f',kind:'folder'},cloudFrame];
  await f.providers.resolveConflicts(f.ctx);
  assert.ok(f.uploads.some(u=>u.target.startsWith('Shots/frame (конфлікт, ')));assert.equal(f.ctx.conflictCopies,1);
  assert.equal([...f.ctx.items.values()].some(i=>i.path==='Shots/frame.psd'),false,'the cloud version comes back on the next check');
});
