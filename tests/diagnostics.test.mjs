import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateLocalMapping} from '../core/policy.mjs';
import {NativeProviders} from '../core/native-provider.mjs';
import {SyncStore} from '../core/store.mjs';
import {diagnosticReport} from '../core/diagnostics.mjs';

test('mapping failures preserve the exact path and distinguish prohibited characters, endings and device names',()=>{
  for(const [path,reason] of [['Project/bad?.pdf','err.mappingCharacters'],['Project/trailing /clip.mov','err.mappingEnding'],['Project/file.','err.mappingEnding'],['Project/AUX.pdf','err.mappingReserved']]){
    assert.throws(()=>validateLocalMapping(path,'win32'),e=>e.message==='err.mapping'&&e.nativePath===path&&e.nativeStage===reason);
  }
});

test('collision diagnostics persist both original paths in the journal and support report without credentials',async()=>{
  const store=new SyncStore(':memory:');try{
    const acc={id:'fixture',name:'Studio',scope:'team',native:{enabled:true},settings:{rules:{'':{selected:true,kind:'folder',mode:'online'}}}},provider=new NativeProviders({store}),ctx={acc,items:new Map(),deletions:new Map(),fetches:new Map(),uploads:new Set(),remote:{list:async()=>[{path:'Scene.ma',kind:'file'},{path:'scene.ma',kind:'file'}]}};
    let failure;try{await provider.collect(ctx);}catch(error){failure=error;}
    assert.equal(failure.nativePath,'scene.ma');assert.equal(failure.nativeOtherPath,'Scene.ma');assert.equal(failure.nativeStage,'err.mappingCollision');provider.recordError(ctx,failure);
    const entry=store.fileEvents(acc.id).entries[0];assert.equal(entry.path,'scene.ma');assert.match(entry.detail,/scene.ma · Scene.ma/);
    const secret='SENSITIVE-FIXTURE-TOKEN',state={version:'0.16.1',platform:'win32',rcloneVersion:'rclone v1.75.2',config:secret,cookies:secret,accounts:[{...acc,config:secret,access_token:secret,native:{enabled:true,error:ctx.error,detail:ctx.detail},settings:{...acc.settings,secret}}]};
    const report=diagnosticReport({state,store,arch:'x64',osVersion:'test',now:new Date('2026-11-03T12:00:00Z')}),json=JSON.stringify(report);
    assert.equal(json.includes(secret),false);assert.equal(report.accounts[0].recentErrors[0].path,'scene.ma');assert.match(report.accounts[0].recentErrors[0].explanation,/Windows treats these two paths/);assert.match(json,/Scene.ma/);assert.equal(report.application.version,'0.16.1');
    store.close();const reopened=JSON.parse(json);assert.equal(reopened.accounts[0].recentErrors[0].detail,entry.detail);
  }finally{try{store.close();}catch{}}
});

test('diagnostic export requests bounded errors and skips and retains empty accounts',()=>{
  let calls=0;const report=diagnosticReport({state:{accounts:[{id:'empty',name:'Empty',scope:'personal'}]},store:{fileEvents(id,options){calls++;assert.equal(id,'empty');assert.ok(['failed','skipped'].includes(options.status));assert.equal(options.limit,100);return {entries:[]};}}});
  assert.equal(calls,2);assert.deepEqual(report.accounts[0].recentErrors,[]);assert.equal(report.accounts[0].provider.enabled,false);
});

test('a report names the computer and Windows user it came from (five computers share one Dropbox)',async()=>{
  const {currentDevice}=await import('../core/diagnostics.mjs');
  const store=new SyncStore(':memory:');
  const report=diagnosticReport({state:{version:'0.17.0',platform:'win32',rcloneVersion:'rclone v1.70.0',accounts:[]},store,arch:'x64',osVersion:'10.0',device:{computer:'ART-03',user:'anna'}});
  assert.deepEqual(report.device,{computer:'ART-03',user:'anna'});
  const own=currentDevice();assert.equal(typeof own.computer,'string');assert.ok(own.computer.length>0);assert.doesNotMatch(own.computer,/[<>:"\/\\|?*]/);
});
