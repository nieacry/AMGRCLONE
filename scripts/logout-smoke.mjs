import {_electron as electron} from 'playwright';
import {mkdir,writeFile,readFile,readdir,stat} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {SyncStore} from '../core/store.mjs';
import {NativeHost} from '../core/native-host.mjs';
import {SubstDrives} from '../core/subst-drives.mjs';
const project=path.resolve(import.meta.dirname,'..'),stage=process.argv.includes('--packaged')?JSON.parse(await readFile(path.join(project,'.runtime/release-stage.json'),'utf8')):null;
const base=path.join(project,'.runtime/logout-test',randomUUID().slice(0,8)),data=path.join(base,'data'),remote=path.join(base,'remote'),local=path.join(base,'local');await mkdir(path.join(remote,'Project'),{recursive:true});await mkdir(local,{recursive:true});
const content=randomBytes(1024*1024+11);await writeFile(path.join(remote,'Project','sample.bin'),content);await writeFile(path.join(remote,'Project','online.bin'),content);
const helper=stage?path.join(stage.app||stage.binary,'resources/bin/amg-cloud.exe'):path.join(project,'native/bin/amg-cloud.exe'),binary=stage?path.join(stage.app||stage.binary,'resources/bin/rclone.exe'):path.join(project,'.runtime/tools/rclone.exe');
const env={...process.env,CLOUDLANE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;const launch=()=>electron.launch(stage?{executablePath:path.join(stage.app||stage.binary,'AMG rclone UI.exe'),env}:{args:[project],env});
let app=await launch(),letter;const backend=new SubstDrives(helper);
try{
  try{await (await app.firstWindow()).locator('main header').waitFor();const accounts=['gone','normal','reset-gone'].map(id=>({id,name:id,config:`[cloud]\ntype = alias\nremote = ${remote}\n`,settings:{localRoot:'',rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,registered:true,root:id==='normal'?local:path.join(base,id+'-deleted'),owner:randomUUID()}}));
    const encoded=await app.evaluate(async({safeStorage},value)=>(await safeStorage.encryptStringAsync(JSON.stringify(value))).toString('base64'),{language:'en',binary,accounts});await writeFile(path.join(data,'vault.bin'),Buffer.from(encoded,'base64'));
  }finally{await app.close();}
  const store=new SyncStore(path.join(data,'sync.sqlite'));for(const id of ['gone','reset-gone']){store.saveNativeItem(id,{key:'old-file',path:'Project/file.txt',identity:'old-identity',kind:'file',status:'dirty'});await mkdir(path.join(data,'native-cache',id),{recursive:true});await writeFile(path.join(data,'native-cache',id,'snapshot'),'cached unsent '+id);}store.close();
  app=await launch();const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
  const waitState=async predicate=>{for(let i=0;i<200;i++){const current=await page.evaluate(()=>window.cloudlane.state());if(predicate(current))return current;await new Promise(r=>setTimeout(r,100));}throw new Error('State did not converge');};
  await waitState(s=>s.accounts.find(a=>a.id==='gone')?.native?.error==='err.nativeRootMissing'&&s.accounts.find(a=>a.id==='normal')?.native?.status==='current');
  assert.equal(await stat(path.join(base,'gone-deleted')).catch(()=>null),null);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Disconnect account · gone',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Disconnect account',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  let state=await page.evaluate(()=>window.cloudlane.state());assert.deepEqual(state.accounts.map(a=>a.id),['normal','reset-gone']);assert.deepEqual(await readFile(path.join(remote,'Project','sample.bin')),content);
  const archives=await readdir(path.join(data,'recovery')),goneArchive=archives.find(name=>name.startsWith('gone-'));assert.ok(goneArchive);assert.equal(await readFile(path.join(data,'recovery',goneArchive,'cached-files','snapshot'),'utf8'),'cached unsent gone');
  console.log('PASS: missing local root no longer blocks sign-out; cache/catalog preserved, other account and cloud data intact');
  assert.deepEqual(await readFile(path.join(local,'Project','sample.bin')),content);
  letter=(await backend.list()).filter(d=>d.available).at(-1).letter;await page.evaluate(letter=>window.cloudlane.createDrive('normal','Project',letter),letter);await page.evaluate(()=>window.cloudlane.setPreferences({pauseSync:true}));await writeFile(path.join(local,'Project','unsent.txt'),'unsent local data');
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Disconnect account · normal',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Disconnect account',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden',timeout:60000});
  state=await page.evaluate(()=>window.cloudlane.state());assert.deepEqual(state.accounts.map(a=>a.id),['reset-gone']);assert.deepEqual(await readFile(path.join(local,'Project','sample.bin')),content);assert.equal(await readFile(path.join(local,'Project','unsent.txt'),'utf8'),'unsent local data');assert.equal(await stat(path.join(remote,'Project','unsent.txt')).catch(()=>null),null);assert.equal((await backend.list()).find(d=>d.letter===letter).available,true);letter=undefined;
  const h=new NativeHost(helper);try{assert.equal((await h.request('checkPath',{path:local})).registered,false);}finally{await h.close();}
  assert.equal(await stat(path.join(local,'Project','online.bin')).catch(()=>null),null);assert.deepEqual(await readFile(path.join(remote,'Project','online.bin')),content);console.log('PASS: native sign-out keeps cached files and edits without downloading online-only files and disconnects only its owned drive');
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Reset application',exact:true}).click();await page.getByRole('dialog').getByRole('checkbox',{name:'I confirm resetting settings and signing out without downloading the project.',exact:true}).check();await page.getByRole('dialog').getByRole('button',{name:'Reset all settings and sign out of all accounts',exact:true}).click();await waitState(s=>s.accounts.length===0);
  const resetArchive=(await readdir(path.join(data,'recovery'))).find(name=>name.startsWith('reset-gone-'));assert.ok(resetArchive);assert.equal(await readFile(path.join(data,'recovery',resetArchive,'cached-files','snapshot'),'utf8'),'cached unsent reset-gone');assert.deepEqual(await readFile(path.join(remote,'Project','sample.bin')),content);assert.deepEqual(errors,[]);
  console.log('PASS: full reset with a manually deleted root completes and keeps recovery bytes outside cleared caches');
}finally{await app?.close().catch(()=>{});if(letter){const current=(await backend.list()).find(d=>d.letter===letter);if(current?.target.toLowerCase()===('\\??\\'+path.join(local,'Project')).toLowerCase())await backend.remove(current);}}
