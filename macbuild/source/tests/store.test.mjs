import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {SyncStore} from '../core/store.mjs';
import {messages,translate} from '../core/i18n.mjs';
import {settingsHash,syncArguments,safeDirectory,remoteSpec,SyncEngine} from '../core/sync-engine.mjs';

test('both languages contain exactly the same non-empty UI and error keys',()=>{
  assert.deepEqual(Object.keys(messages.uk).sort(),Object.keys(messages.en).sort());
  for(const lang of ['uk','en'])for(const [key,value]of Object.entries(messages[lang]))assert.ok(typeof value==='string'&&value.length,key);
  assert.equal(translate('uk','items',{count:7}),'7 елементів');
});
test('job state and logs survive reopening, interrupted runs require reconciliation',async()=>{
  const root=path.resolve(import.meta.dirname,'../.runtime/store-tests');await mkdir(root,{recursive:true});
  const dir=await mkdtemp(path.join(root,'state-'));let store=new SyncStore(path.join(dir,'sync.sqlite'));
  const job=store.addJob({id:'one',accountId:'account',path:'Projects',localPath:'/test',marker:'.amg-access-one'});
  const run=store.startRun('account',job,'initial','cloud:.amg-backups','/backups');store.close();
  store=new SyncStore(path.join(dir,'sync.sqlite'));
  assert.equal(store.job('one').status,'needsReview');assert.equal(store.run('account',run).status,'interrupted');assert.equal(store.run('other-account',run),undefined);store.close();
});
test('catalog detects stable-ID moves without treating a failed listing as deletion',()=>{
  const store=new SyncStore(':memory:');
  assert.deepEqual(store.observe('A',[{id:'id:1',path:'Old',kind:'folder',size:-1}]),[]);
  assert.deepEqual(store.observe('A',[{id:'id:1',path:'New',kind:'folder',size:-1}]),[{from:'Old',to:'New',id:'id:1'}]);
  assert.deepEqual(store.observe('B',[{id:'id:1',path:'Elsewhere',kind:'folder',size:-1}]),[]);store.close();
});
test('settings fingerprints are independent of rule insertion order',()=>{
  const a={localRoot:'/local',rules:{A:{mode:'local',selected:true,kind:'folder'},B:{mode:'online',selected:true,kind:'folder'}}};
  assert.equal(settingsHash(a),settingsHash({...a,rules:{B:a.rules.B,A:a.rules.A}}));
  assert.notEqual(settingsHash(a),settingsHash({...a,localRoot:'/other'}));
});
test('normal run never silently resyncs; every actual run has backups and access checks',()=>{
  const job={remote_path:'Projects',local_path:'/local',marker:'.amg-access-id'};
  const options={dryRun:false,initial:false,strategy:'remote',backupRemote:'cloud:.amg-backups',backupLocal:'/backups'};
  const args=syncArguments(job,'/work',options);assert.ok(!args.includes('--resync'));assert.ok(!args.includes('--force'));assert.ok(args.includes('--check-access'));assert.ok(args.includes('--backup-dir1'));assert.ok(args.includes('--backup-dir2'));
  const initial=syncArguments(job,'/work',{...options,initial:true,strategy:'local'});assert.equal(initial[initial.indexOf('--resync-mode')+1],'path2');
});
test('local directory creation rejects traversal and nested junctions',async()=>{
  const root=path.resolve(import.meta.dirname,'../.runtime/path-tests');await mkdir(root,{recursive:true});
  const dir=await mkdtemp(path.join(root,'root-')),outside=await mkdtemp(path.join(root,'outside-'));
  await safeDirectory(dir,'normal/child',{create:true});await assert.rejects(()=>safeDirectory(dir,'../outside',{create:true}),/err.path/);
  await symlink(outside,path.join(dir,'junction'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>safeDirectory(dir,'junction/child',{create:true}),/err.link/);
  await assert.rejects(()=>safeDirectory(dir,'',{deep:true}),/err.link/);
});
test('team-root paths retain their leading slash for all rclone operations',()=>{
  const job={remote_root:'/',remote_path:'Studio/Projects',local_path:'/local',marker:'.amg-access-id'};
  assert.equal(remoteSpec(job),'cloud:/Studio/Projects');assert.equal(remoteSpec(job,'/'+job.marker),'cloud:/Studio/Projects/.amg-access-id');
  assert.equal(syncArguments(job,'/work',{dryRun:true,initial:true,strategy:'remote',backupRemote:'cloud:/Studio/.amg-backups',backupLocal:'/backups'})[1],'cloud:/Studio/Projects');
});
test('whole team roots are deferred before creating files or issuing any command',async()=>{
  const store=new SyncStore(':memory:');const engine=new SyncEngine({store,dataDir:'/unused',connection:()=>{throw new Error('must not call');},run:()=>{throw new Error('must not call');}});
  const plan=await engine.preview({id:'test',scope:'team',settings:{localRoot:'/unused',rules:{Studio:{selected:true,mode:'local',kind:'folder'}}}});
  assert.equal(plan.jobs.length,0);assert.equal(plan.deferred[0].reason,'deferred_team');store.close();
});
test('expired and cross-account plans are rejected before any filesystem or network access',async()=>{
  const store=new SyncStore(':memory:'),engine=new SyncEngine({store,dataDir:'/unused',connection:()=>{throw new Error('must not call');},run:()=>{throw new Error('must not call');}});
  const acc={id:'A',settings:{localRoot:'/local',rules:{}}};
  engine.plans.set('expired',{accountId:'A',scope:'personal',expires:0,settingsHash:settingsHash(acc.settings),jobs:[{}]});
  await assert.rejects(()=>engine.execute(acc,'expired',true),/err.plan/);
  engine.plans.set('other',{accountId:'B',scope:'personal',expires:Date.now()+600000,settingsHash:settingsHash(acc.settings),jobs:[{}]});
  await assert.rejects(()=>engine.execute(acc,'other',true),/err.plan/);store.close();
});
test('folder identity comes from its parent listing because root stat may omit the ID',async()=>{
  const store=new SyncStore(':memory:');let args;
  const engine=new SyncEngine({store,dataDir:'/unused',connection:()=>{},run:async value=>{args=value;return {stdout:JSON.stringify([{Name:'Projects',IsDir:true,ID:'id:folder'}])};}});
  await engine.identity({remote_root:'/',remote_path:'Studio/Projects',item_id:'id:folder'},[]);
  assert.equal(args[1],'cloud:/Studio');assert.ok(!args.includes('--stat'));
  await assert.rejects(()=>engine.identity({remote_path:'Projects',item_id:'id:other'},[]),/err.identity/);store.close();
});
