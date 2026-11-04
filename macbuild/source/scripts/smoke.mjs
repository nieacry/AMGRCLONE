import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
await mkdir(path.join(root,'test-results'),{recursive:true});
const demoApp=await electron.launch({args:[path.join(root,'scripts/preview.cjs')],env});
try{
  const page=await demoApp.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('main header').waitFor();await page.evaluate(()=>localStorage.removeItem('amg-demo-v2'));await page.reload();
  await page.getByRole('button',{name:'Усі файли',exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'uk');
  assert.equal(await page.locator('.page-heading button').count(),0);assert.equal(await page.locator('.summary-grid').count(),0);
  assert.equal(await page.getByRole('img',{name:'Animagrad Studio'}).count(),1);
  await page.getByRole('button',{name:'Розгорнути Projects',exact:true}).click();await page.getByRole('button',{name:'Brief.pdf',exact:true}).waitFor();
  await page.getByRole('button',{name:'Розгорнути Media',exact:true}).click();await page.getByRole('button',{name:'Cover.jpg',exact:true}).click();
  await page.getByRole('button',{name:'На комп’ютері Доступ без інтернету'}).click();
  assert.equal(await page.getByRole('checkbox',{name:'Обрати Media/Cover.jpg',exact:true}).isChecked(),true);
  await page.screenshot({path:path.join(root,'test-results/interface-uk.png'),fullPage:true});
  await page.getByRole('button',{name:'Закрити властивості'}).click();await page.getByRole('button',{name:'Перевірити план'}).click();
  await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('button',{name:'Показати демо-результат'}).isDisabled(),true);
  await page.getByRole('checkbox',{name:'Я перевірив план і погоджуюся на зміни файлів у Dropbox і локально.'}).check();
  await page.getByRole('button',{name:'Показати демо-результат'}).click();await page.locator('.history-row').first().waitFor();
  await page.getByRole('button',{name:'Правила синхронізації',exact:true}).click();
  await page.getByLabel('Розклад',{exact:true}).selectOption('15');await page.getByRole('button',{name:'Призупинити розклад'}).click();
  await page.getByText('Розклад призупинено',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Усі файли',exact:true}).click();
  await page.getByRole('button',{name:'Мова інтерфейсу'}).click();await page.getByRole('button',{name:'All files',exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'All files',exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'en');
  await page.getByRole('button',{name:/Studio Dropbox Dropbox/}).click();
  assert.equal(await page.getByRole('checkbox',{name:'Select Projects',exact:true}).isChecked(),false);
  assert.equal(await page.locator('.scope-select').count(),0);
  await page.getByPlaceholder('Search loaded folders').fill('missing-file');await page.getByText('No matches in loaded folders').waitFor();
  await page.getByRole('button',{name:'Add account',exact:true}).click();await page.getByLabel('Account name',{exact:true}).fill('Test account');
  await page.getByRole('button',{name:'Add demo account',exact:true}).click();await page.getByRole('button',{name:/Test account Dropbox/}).waitFor();
  await page.getByRole('button',{name:/Personal Dropbox Dropbox/}).click();await page.getByRole('button',{name:'Expand Projects',exact:true}).click();
  await page.getByRole('button',{name:'Expand Media',exact:true}).click();await page.getByRole('button',{name:'Cover.jpg',exact:true}).click();
  await page.setViewportSize({width:1240,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(root,'test-results/interface-en.png'),fullPage:true});
  await page.setViewportSize({width:1000,height:720});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(root,'test-results/compact.png'),fullPage:true});assert.deepEqual(errors,[]);
  console.log('PASS: Ukrainian default, English persistence, requested removals and logo, tree and file policy, confirmation, history, schedule, account isolation, compact layout');
}finally{await demoApp.close();}

const fixture=path.join(root,'.runtime/ui',crypto.randomUUID().slice(0,6)),userData=path.join(fixture,'data'),remote=path.join(fixture,'r'),local=path.join(fixture,'l');
await mkdir(path.join(remote,'Projects'),{recursive:true});await mkdir(local,{recursive:true});await writeFile(path.join(remote,'Projects','sample.txt'),'test fixture content');
let desktop=await electron.launch({args:[root],env:{...env,CLOUDLANE_TEST_DATA:userData}});
try{
  const page=await desktop.firstWindow();await page.getByRole('heading',{name:'Підключення Dropbox'}).waitFor();
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');assert.equal(await page.evaluate(()=>typeof window.cloudlane.execute),'function');
  const before=await page.evaluate(()=>window.cloudlane.state());assert.equal(before.language,'uk');assert.equal(before.accounts.length,0);
  await page.getByRole('button',{name:'Мова інтерфейсу'}).click();await page.getByRole('heading',{name:'Dropbox connection'}).waitFor();
  await page.getByRole('button',{name:'Connect Dropbox',exact:true}).last().click();await page.getByRole('button',{name:'Continue to Dropbox'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Continue to Dropbox'}).isDisabled(),true);
  const testVault={language:'en',binary:path.join(root,'.runtime/tools/rclone.exe'),accounts:[{id:'test-alias',name:'Isolated fixture',config:`[cloud]\ntype = alias\nremote = ${remote}\n`,settings:{localRoot:local,rules:{Projects:{selected:true,mode:'local',kind:'folder'}}},scheduleMinutes:0}]};
  // Seed only this randomly named test profile. No user profile or credentials are read.
  const encrypted=await desktop.evaluate(async({safeStorage},vault)=>{
    const bytes=await safeStorage.encryptStringAsync(JSON.stringify(vault));
    const roundtrip=(await safeStorage.decryptStringAsync(bytes)).result;if(roundtrip!==JSON.stringify(vault))throw new Error('OS encryption mismatch');
    return bytes.toString('base64');
  },testVault);
  await writeFile(path.join(userData,'vault.bin'),Buffer.from(encrypted,'base64'));
}finally{await desktop.close();}
desktop=await electron.launch({args:[root],env:{...env,CLOUDLANE_TEST_DATA:userData}});
try{
  const page=await desktop.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'All files',exact:true}).waitFor();await page.getByRole('button',{name:'Expand Projects',exact:true}).waitFor();
  const earlySchedule=await page.evaluate(async()=>{try{await window.cloudlane.setSchedule('test-alias',15,false);return false;}catch{return true;}});assert.equal(earlySchedule,true);
  await page.getByRole('button',{name:'Review sync plan',exact:true}).click();await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('button',{name:'Start syncing'}).isDisabled(),true);
  await page.getByRole('checkbox',{name:'I reviewed the plan and approve file changes in Dropbox and locally.'}).check();await page.getByRole('button',{name:'Start syncing'}).click();
  await page.locator('.history-row.succeeded, .history-row .succeeded').first().waitFor();
  assert.equal(await readFile(path.join(local,'Projects','sample.txt'),'utf8'),'test fixture content');
  await page.locator('.history-row').first().click();await page.getByRole('dialog').waitFor();assert.match(await page.getByRole('dialog').innerText(),/\.amg-backups/);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  const state=await page.evaluate(()=>window.cloudlane.state());assert.equal(state.language,'en');assert.equal(state.accounts[0].jobs[0].status,'idle');assert.equal('config' in state.accounts[0],false);
  const guard=await page.evaluate(async()=>{try{await window.cloudlane.setScope('test-alias','team');return false;}catch{return true;}});assert.equal(guard,true);
  assert.deepEqual(errors,[]);console.log('PASS: actual Electron, localized vault migration, restricted bridge, OS encryption and real rclone sync through UI using a local-only fixture');
}finally{await desktop.close();}
