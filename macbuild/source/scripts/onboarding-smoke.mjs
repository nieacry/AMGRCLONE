import {_electron as electron} from 'playwright';
import {mkdir,writeFile,readFile,stat,rename} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {SyncStore} from '../core/store.mjs';
import {NativeHost} from '../core/native-host.mjs';
import {SubstDrives} from '../core/subst-drives.mjs';
const project=path.resolve(import.meta.dirname,'..'),stage=process.argv.includes('--packaged')?JSON.parse(await readFile(path.join(project,'.runtime/release-stage.json'),'utf8')):null;
const helper=stage?path.join(stage.app||stage.binary,'resources/bin/amg-cloud.exe'):path.join(project,'native/bin/amg-cloud.exe');
const binary=stage?path.join(stage.app||stage.binary,'resources/bin/rclone.exe'):path.join(project,'.runtime/tools/rclone.exe');
const base=path.join(project,'.runtime/onboarding-test',randomUUID().slice(0,8)),userData=path.join(base,'data'),remote=path.join(base,'remote'),fresh=path.join(base,'fresh'),legacyNative=path.join(base,'legacy-native'),legacyLocal=path.join(base,'legacy-local');
for(const root of [remote,legacyLocal]){await mkdir(path.join(root,'Project','Nested'),{recursive:true});}
for(const root of [fresh,legacyNative])await mkdir(root,{recursive:true});
const bytes=randomBytes(1024*1024+37);await writeFile(path.join(remote,'Project','video.bin'),bytes);await writeFile(path.join(remote,'Project','Nested','text.txt'),'cloud text');
const jobId='c'.repeat(24),marker='.amg-access-'+jobId,foreign='.amg-access-'+('d'.repeat(24));
for(const root of [remote,legacyLocal])await writeFile(path.join(root,'Project',marker),marker);
await writeFile(path.join(remote,'Project',foreign),foreign);
const env={...process.env,CLOUDLANE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch(stage?{executablePath:path.join(stage.app||stage.binary,'AMG rclone UI.exe'),env}:{args:[project],env});
let app=await launch(),letter;
try{
  try{await (await app.firstWindow()).locator('main header').waitFor();const vault={language:'en',binary,accounts:[
    {id:'fresh',name:'Fresh account',config:`[cloud]\ntype = alias\nremote = ${remote}\n`,settings:{localRoot:'',rules:{}}},
    {id:'legacy',name:'Migrated account',config:`[cloud]\ntype = alias\nremote = ${remote}\n`,settings:{localRoot:legacyLocal,rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,root:legacyNative,owner:randomUUID()}}
  ]};const encoded=await app.evaluate(async({safeStorage},data)=>(await safeStorage.encryptStringAsync(JSON.stringify(data))).toString('base64'),vault);await writeFile(path.join(userData,'vault.bin'),Buffer.from(encoded,'base64'));}finally{await app.close();}
  const store=new SyncStore(path.join(userData,'sync.sqlite'));store.addJob({id:jobId,accountId:'legacy',path:'Project',localPath:path.join(legacyLocal,'Project'),marker});store.mark(jobId,'idle',true);store.close();
  app=await launch();const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:'Expand Project',exact:true}).waitFor();
  const waitState=async predicate=>{for(let i=0;i<200;i++){const current=await page.evaluate(()=>window.cloudlane.state());if(predicate(current))return current;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('State did not converge');};
  await waitState(s=>s.accounts.find(a=>a.id==='legacy')?.maintenance?.removed===1);
  assert.equal(await stat(path.join(remote,'Project',marker)).catch(()=>null),null);assert.equal(await readFile(path.join(remote,'Project',foreign),'utf8'),foreign);
  console.log('PASS: migrated account automatically retires old bisync and removes only its verified marker');
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},fresh);
  await page.getByRole('button',{name:'Choose folder',exact:true}).click();
  await waitState(s=>s.accounts.find(a=>a.id==='fresh')?.native?.status==='current');
  let state=await page.evaluate(()=>window.cloudlane.state()),account=state.accounts.find(a=>a.id==='fresh');assert.equal(account.native.enabled,true);assert.equal(account.native.shellRegistered,true);assert.deepEqual(account.settings.rules,{'':{selected:true,mode:'online',kind:'folder'}});
  assert.equal(await page.getByRole('checkbox',{name:'Select Project',exact:true}).isChecked(),true);assert.equal(account.native.counts.online,2);assert.ok(account.native.lastSync);await page.waitForFunction(()=>document.querySelector('footer .last-sync')?.textContent.includes(':')&&!document.querySelector('footer .last-sync')?.textContent.endsWith('—'));
  assert.equal(await page.locator('.eyebrow,.page-heading h1,.sidebar .version,.language-toggle svg,.native-panel,.native-status,.native-default-note,.add-account').count(),0);assert.ok(await page.locator('.brand-version').isVisible());
  console.log('PASS: first folder choice automatically enables native provider; all project files start online only, Explorer registration succeeds');
  await page.getByRole('button',{name:'Settings',exact:true}).click();const dialog=page.getByRole('dialog'),before=await dialog.boundingBox();
  for(const label of ['Launch when I sign in','Start directly in the tray','Pause background synchronization']){
    await dialog.getByRole('checkbox',{name:label,exact:true}).check();const during=await dialog.boundingBox();assert.ok(Math.abs(during.y-before.y)<1&&Math.abs(during.height-before.height)<1,'Settings dialog must not jump while saving');
    await page.waitForFunction(()=>!document.querySelector('.preference-options input:disabled'));
  }
  await page.screenshot({path:path.join(project,'test-results/settings-stable-0.14.2.png'),fullPage:true});
  console.log('PASS: settings checkbox saves keep dialog position and size stable');
  const backend=new SubstDrives(helper);letter=(await backend.list()).filter(d=>d.available).at(-1).letter;await page.evaluate(({letter})=>window.cloudlane.createDrive('fresh','Project',letter),{letter});
  await page.evaluate(()=>localStorage.setItem('reset-fixture','present'));
  await app.evaluate(async({session})=>session.defaultSession.cookies.set({url:'https://fixture.invalid',name:'reset-test',value:'present'}));
  // Background sync is paused; this ordinary, unsent local file must survive reset too.
  await writeFile(path.join(fresh,'Project','unsent.txt'),'unsent local change');
  const rejected=await page.evaluate(async()=>{try{await window.cloudlane.resetApp(false);return false;}catch{return true;}});assert.equal(rejected,true);
  // Download one file per root before reset; other files must stay online and disappear locally on reset.
  assert.deepEqual(await readFile(path.join(fresh,'Project','video.bin')),bytes);assert.deepEqual(await readFile(path.join(legacyNative,'Project','video.bin')),bytes);
  await dialog.getByRole('button',{name:'Reset application',exact:true}).click();let confirmation=page.getByRole('dialog');
  const resetButton=()=>page.getByRole('dialog').getByRole('button',{name:'Reset all settings and sign out of all accounts',exact:true});assert.equal(await resetButton().isDisabled(),true);await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await page.evaluate(()=>window.cloudlane.state())).accounts.length,2);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Reset application',exact:true}).click();confirmation=page.getByRole('dialog');await confirmation.getByRole('checkbox',{name:'I confirm resetting settings and signing out without downloading the project.',exact:true}).check();
  // Simulate an unavailable cloud: reset must not try to download, list, upload or delete remotely.
  await rename(remote,remote+'-offline');await resetButton().click();
  for(let i=0;i<300;i++){const result=await page.evaluate(()=>window.cloudlane.state());if(!result.accounts.length)break;if(await page.getByRole('dialog').getByRole('alert').isVisible().catch(()=>false)){console.log('RESET DIAGNOSTIC',result.accounts.map(a=>({id:a.id,native:a.native})));await page.screenshot({path:path.join(project,'test-results/reset-error.png'),fullPage:true});throw new Error('Reset returned an error');}await new Promise(resolve=>setTimeout(resolve,100));}
  await page.getByRole('heading',{name:'Підключення Dropbox',exact:true}).waitFor({timeout:3000});
  state=await page.evaluate(()=>window.cloudlane.state());assert.equal(state.accounts.length,0);assert.equal(state.drives.length,0);assert.equal(state.language,'uk');assert.deepEqual(state.preferences,{autoStart:false,startMinimized:false,pauseSync:false});
  assert.equal(await page.evaluate(()=>localStorage.getItem('reset-fixture')),null);assert.deepEqual(await app.evaluate(async({session})=>session.defaultSession.cookies.get({name:'reset-test'})),[]);
  await rename(remote+'-offline',remote);assert.deepEqual(await readFile(path.join(fresh,'Project','video.bin')),bytes);assert.deepEqual(await readFile(path.join(legacyNative,'Project','video.bin')),bytes);assert.equal(await readFile(path.join(fresh,'Project','unsent.txt'),'utf8'),'unsent local change');assert.equal(await stat(path.join(remote,'Project','unsent.txt')).catch(()=>null),null);for(const local of [fresh,legacyNative])assert.equal(await stat(path.join(local,'Project','Nested','text.txt')).catch(()=>null),null);assert.equal(await readFile(path.join(remote,'Project','Nested','text.txt'),'utf8'),'cloud text');
  assert.equal((await backend.list()).find(d=>d.letter===letter).available,true);letter=undefined;
  const host=new NativeHost(helper);try{for(const root of [fresh,legacyNative])assert.equal((await host.request('checkPath',{path:root})).registered,false);}finally{await host.close();}
  assert.deepEqual(errors,[]);console.log('PASS: confirmed reset works with the cloud offline, keeps downloaded files and unsent edits, removes only local undownloaded placeholders, detaches own roots/drives and clears accounts, preferences, cookies and storage');
}finally{await app?.close().catch(()=>{});if(letter){const backend=new SubstDrives(helper),current=(await backend.list()).find(d=>d.letter===letter);if(current?.target.toLowerCase()===('\\??\\'+path.join(fresh,'Project')).toLowerCase())await backend.remove(current);}}

