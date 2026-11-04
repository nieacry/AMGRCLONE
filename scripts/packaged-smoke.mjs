import {_electron as electron} from 'playwright';
import {mkdir,writeFile,readFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {NativeHost} from '../core/native-host.mjs';
import {SubstDrives} from '../core/subst-drives.mjs';
import {SyncStore} from '../core/store.mjs';
const project=path.resolve(import.meta.dirname,'..'),stage=JSON.parse(await readFile(path.join(project,'.runtime/release-stage.json'),'utf8'));
const executable=path.join(stage.app||stage.binary,'AMG rclone UI.exe'),base=path.join(project,'.runtime/packaged-test',randomUUID().slice(0,8)),userData=path.join(base,'data'),remote=path.join(base,'remote'),local=path.join(base,'local'),nativeRoot=local;
await mkdir(path.join(remote,'Media'),{recursive:true});await mkdir(nativeRoot,{recursive:true});await mkdir(path.join(local,'Media'),{recursive:true});await writeFile(path.join(local,'Media','original.txt'),'absolute hierarchy');const content=randomBytes(1024*1024+17);await writeFile(path.join(remote,'Media','video.bin'),content);
const env={...process.env,CLOUDLANE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
let app=await electron.launch({executablePath:executable,env}),nativeOwner,mappingId,letter;
try{
try{
  const page=await app.firstWindow();await page.locator('main header').waitFor();const initial=await page.evaluate(()=>window.cloudlane.state());assert.equal(initial.version,stage.version);assert.equal(initial.language,'uk');assert.equal(initial.nativeProvider,true);
  const vault={language:'en',binary:path.join(stage.app||stage.binary,'resources/bin/rclone.exe'),accounts:[{id:'packaged-fixture',name:'Native test storage',config:`[cloud]\ntype = alias\nremote = ${remote}\n`,settings:{localRoot:local,rules:{Media:{selected:true,mode:'online',kind:'folder'}}}}]};
  const encrypted=await app.evaluate(async({safeStorage},data)=>(await safeStorage.encryptStringAsync(JSON.stringify(data))).toString('base64'),vault);await writeFile(path.join(userData,'vault.bin'),Buffer.from(encrypted,'base64'));
}finally{await app.close();}
app=await electron.launch({executablePath:executable,env});

try{
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:'All files',exact:true}).waitFor();await page.getByRole('button',{name:'Expand Media',exact:true}).waitFor();
  const beforeDrive=await page.evaluate(()=>window.cloudlane.state());
  await page.getByRole('button',{name:'Create drive · Media',exact:true}).click();
  const classicDialog=page.getByRole('dialog');letter=await classicDialog.getByLabel('Drive letter',{exact:true}).inputValue();
  await classicDialog.getByRole('button',{name:'Create drive',exact:true}).click();await classicDialog.waitFor({state:'hidden'});
  let classicState=await page.evaluate(()=>window.cloudlane.state());assert.deepEqual(classicState.accounts[0].settings,beforeDrive.accounts[0].settings);assert.equal(classicState.accounts[0].native.enabled,false);
  assert.equal(await readFile(letter+':\\original.txt','utf8'),'absolute hierarchy');
  const accountBlocked=await page.evaluate(async()=>{try{await window.cloudlane.removeAccount('packaged-fixture');return false;}catch{return true;}});assert.equal(accountBlocked,true);
  await page.evaluate(id=>window.cloudlane.removeDrive(id),classicState.drives[0].id);assert.equal(await readFile(path.join(local,'Media','original.txt'),'utf8'),'absolute hierarchy');letter=undefined;
  console.log('PASS: tree action creates subst from ordinary local folder, leaves absolute sync hierarchy unchanged and prevents orphaned ownership');
  // Native mode is enabled by choosing an empty root; the manual provider panel is gone.
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},local);
  await page.getByRole('button',{name:'Choose folder',exact:true}).click();await page.getByRole('alert').waitFor();
  assert.equal((await page.evaluate(()=>window.cloudlane.state())).accounts[0].native.enabled,false);
  assert.equal(await readFile(path.join(local,'Media','original.txt'),'utf8'),'absolute hierarchy');
  console.log('PASS: nonempty local root refused without changing data');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await unlink(path.join(local,'Media','original.txt'));await rmdir(path.join(local,'Media'));assert.deepEqual(await readdir(local),[]);
  await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
  await page.getByRole('button',{name:'Choose folder',exact:true}).click();
  assert.equal((await page.evaluate(()=>window.cloudlane.state())).accounts[0].settings.localRoot,local);
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},local);
  await page.getByRole('button',{name:'Choose folder',exact:true}).click();
  let populated=false;for(let i=0;i<200;i++){const state=await page.evaluate(()=>window.cloudlane.state());if(state.accounts[0].native?.status==='current'&&state.accounts[0].native.counts.online===1){populated=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(populated,true,'Native placeholder population must complete');
  const reused=await page.evaluate(()=>window.cloudlane.state());assert.equal(reused.accounts[0].native.root,local);assert.equal(reused.accounts[0].settings.localRoot,local);
  assert.equal(await page.locator('.native-panel,.native-status,.add-account').count(),0);
  await page.screenshot({path:path.join(project,`test-results/native-root-${stage.version}.png`),fullPage:true});
  console.log('PASS: choosing empty root enables native mode automatically; old manual controls removed');
  assert.deepEqual(await readFile(path.join(nativeRoot,'Media','video.bin')),content);console.log('PASS: packaged app contains rclone and native host, creates real placeholders and hydrates file');
  await page.getByRole('button',{name:'Expand Media',exact:true}).click();await page.getByRole('button',{name:'video.bin',exact:true}).click();
  await page.getByRole('button',{name:'On this computer Available without internet'}).click();await page.getByText('Rule saved',{exact:true}).first().waitFor();
  await page.getByRole('button',{name:'Online only Download when opened'}).click();
  await page.getByRole('button',{name:'Dropbox drives',exact:true}).click();await page.getByRole('button',{name:'Create drive',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('Local subfolder',{exact:true}).fill('Media');const options=await dialog.getByLabel('Drive letter',{exact:true}).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value));letter=options.at(-1);assert.ok(letter);await dialog.getByLabel('Drive letter',{exact:true}).selectOption(letter);await dialog.getByRole('button',{name:'Create drive',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  let state=await page.evaluate(()=>window.cloudlane.state());mappingId=state.drives[0].id;assert.equal(state.drives[0].letter,letter);assert.deepEqual(await readFile(letter+':\\video.bin'),content);
  const rejected=await page.evaluate(async()=>{try{await window.cloudlane.removeDrive('not-an-owned-record');return false;}catch{return true;}});assert.equal(rejected,true);assert.deepEqual(await readFile(letter+':\\video.bin'),content);console.log('PASS: selected Dropbox subfolder becomes a drive; arbitrary drive removal is rejected');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);assert.deepEqual(await readFile(letter+':\\video.bin'),content);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());console.log('PASS: closing hides the window and keeps provider and drive running in tray');
  await page.getByRole('button',{name:/^Settings/}).click();await page.getByRole('checkbox',{name:'Launch when I sign in',exact:true}).check();await page.getByRole('checkbox',{name:'Start directly in the tray',exact:true}).check();await page.getByRole('button',{name:'Close',exact:true}).click();
  state=await page.evaluate(()=>window.cloudlane.state());assert.equal(state.preferences.autoStart,true);assert.equal(state.preferences.startMinimized,true);
  const encrypted=await readFile(path.join(userData,'vault.bin'));nativeOwner=await app.evaluate(async({safeStorage},bytes)=>JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(bytes,'base64'))).result).accounts[0].native.owner,encrypted.toString('base64'));
  await page.screenshot({path:path.join(project,`test-results/native-drives-${stage.version}.png`),fullPage:true});assert.deepEqual(errors,[]);
}finally{await app.close();}
assert.deepEqual(await readFile(letter+':\\video.bin'),content);console.log('PASS: subst mapping remains after the application exits');
app=await electron.launch({executablePath:executable,env});
try{
  const page=await app.firstWindow();await page.locator('main header').waitFor();assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());let state;
  for(let tries=0;tries<100;tries++){state=await page.evaluate(()=>window.cloudlane.state());if(state.drives[0]?.status==='mounted')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(state.drives[0].status,'mounted');assert.deepEqual(await readFile(letter+':\\video.bin'),content);console.log('PASS: minimized startup, persisted settings and owned drive restoration');
  await page.evaluate(id=>window.cloudlane.removeDrive(id),mappingId);assert.equal((await page.evaluate(()=>window.cloudlane.state())).drives.length,0);console.log('PASS: removing owned drive preserves the native source files');
}finally{await app.close();}
// Unregister only this explicitly owned, randomly named test root.
const host=new NativeHost(path.join(stage.app||stage.binary,'resources/bin/amg-cloud.exe'));
try{await host.request('init',{root:nativeRoot,cache:path.join(userData,'native-cache','packaged-fixture'),owner:nativeOwner});const store=new SyncStore(path.join(userData,'sync.sqlite'));const items=store.nativeItems('packaged-fixture').sort((a,b)=>b.path.length-a.path.length);for(const item of items)await host.request('remove',{path:item.path,identity:item.identity});store.close();await host.request('unregister');}finally{await host.close();}
console.log('PASS: packaged native test profile cleaned up; no user account, disk or startup registration changed');

}finally{await app?.close().catch(()=>{});if(letter){const backend=new SubstDrives(path.join(stage.app||stage.binary,'resources/bin/amg-cloud.exe')),current=(await backend.list()).find(d=>d.letter===letter),expected=[nativeRoot,local].map(root=>'\\??\\'+path.join(root,'Media'));if(current&&!current.available&&expected.some(target=>current.target.toLowerCase()===target.toLowerCase()))await backend.remove({letter,target:current.target});}}
