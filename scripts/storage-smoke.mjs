import {_electron as electron} from 'playwright';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const project=path.resolve(import.meta.dirname,'..'),stage=process.argv.includes('--packaged')?JSON.parse(await readFile(path.join(project,'.runtime/release-stage.json'),'utf8')):null;
const base=path.join(project,'.runtime/storage-test',randomUUID()),data=path.join(base,'data'),remote=path.join(base,'remote'),root=path.join(base,'root'),folder='Test/Nested',pdf=folder+'/pdf.pdf',keep=folder+'/Keep.pdf',online=folder+'/Online.png';
await mkdir(path.join(remote,folder),{recursive:true});await mkdir(path.join(remote,'Test/Empty'),{recursive:true});await mkdir(root,{recursive:true});const content='%PDF-1.7\nFixture bytes for Windows hydration\n';for(const relative of [pdf,keep,online])await writeFile(path.join(remote,relative),content);
const env={...process.env,CLOUDLANE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch(stage?{executablePath:path.join(stage.app,'AMG rclone UI.exe'),env}:{args:[project],env});
let app=await launch();
try{
  let page=await app.firstWindow();await page.locator('main header').waitFor();const vault={language:'en',accounts:['storage','other'].map(id=>({id,name:id,config:`[cloud]\ntype = alias\nremote = ${remote}\n`,settings:{localRoot:'',rules:{}}}))};const bytes=await app.evaluate(async({safeStorage},value)=>(await safeStorage.encryptStringAsync(JSON.stringify(value))).toString('base64'),vault);await writeFile(path.join(data,'vault.bin'),Buffer.from(bytes,'base64'));await app.close();
  app=await launch();page=await app.firstWindow();await page.getByRole('button',{name:'All files',exact:true}).waitFor();await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});},root);await page.getByRole('button',{name:'Choose folder',exact:true}).click();
  for(let i=0;i<200;i++){if((await page.evaluate(()=>window.cloudlane.state())).accounts[0].native.status==='current')break;await new Promise(r=>setTimeout(r,100));}
  const expand=async()=>{await page.getByRole('button',{name:'Expand Test',exact:true}).click();await page.getByRole('button',{name:'Expand Nested',exact:true}).click();};await expand();
  const state=(p,s)=>page.locator(`.file-row[data-path="${p}"] .storage-state[data-storage-state="${s}"]`);
  await state(pdf,'online').waitFor();await state(online,'online').waitFor();await state('Test/Empty','empty').waitFor();
  const compactRows=async()=>{const heights=await page.locator('.native-storage .file-row').evaluateAll(rows=>rows.map(row=>({path:row.dataset.path,height:row.getBoundingClientRect().height})));assert.ok(heights.every(row=>row.height<=38),'Every row, including empty folders, must stay compact: '+JSON.stringify(heights));};
  await compactRows();await page.getByRole('button',{name:'Empty',exact:true}).click();await compactRows();await page.locator('.close-details').click();await compactRows();
  await page.evaluate(()=>window.cloudlane.setPreferences({pauseSync:true}));
  const read=()=>promisify(execFile)(process.execPath,['-e',"process.stdout.write(require('node:fs').readFileSync(process.argv[1]))",path.join(root,pdf)],{windowsHide:true});assert.equal((await read()).stdout,content);
  await state(pdf,'cached').waitFor({timeout:10000});await state('Test','mixed').waitFor();assert.equal(await page.locator(`.file-row[data-path="${pdf}"] .storage-rule`).innerText(),'Online only');
  assert.equal((await page.evaluate(()=>window.cloudlane.state())).accounts[0].settings.rules[''].mode,'online');console.log('PASS: Explorer-style external open changes actual state to cached, even while sync is paused; inherited online rule remains unchanged and folder shows mixed availability');
  await app.close();app=await launch();page=await app.firstWindow();await page.getByRole('button',{name:'All files',exact:true}).waitFor();await expand();await state(pdf,'cached').waitFor({timeout:10000});assert.equal((await read()).stdout,content);console.log('PASS: downloaded cache survives app/provider restart without becoming pinned');
  await page.getByRole('button',{name:'Keep.pdf',exact:true}).click();await page.locator('.mode-option').nth(1).click();await state(keep,'pinned').waitFor({timeout:10000});await state(pdf,'cached').waitFor();await state(online,'online').waitFor();assert.equal(await state(keep,'pinned').innerText(),'Pinned locally');
  await page.locator('.mode-option').nth(0).click();await state(keep,'online').waitFor({timeout:10000});await page.locator('.mode-option').nth(1).click();await state(keep,'pinned').waitFor({timeout:10000});
  await page.getByRole('button',{name:'Interface language',exact:true}).click();await page.getByRole('button',{name:'Усі файли',exact:true}).waitFor();assert.equal(await state(pdf,'cached').innerText(),'Завантажено в кеш');assert.equal(await state(keep,'pinned').innerText(),'Закріплено локально');assert.equal(await state(online,'online').innerText(),'Лише онлайн');
  await page.setViewportSize({width:1000,height:760});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(await page.locator('.native-storage .table-head>span').allTextContents(),['Назва','Стан','Правило','Розмір']);
  const geometry=await page.locator('.native-storage .file-row').evaluateAll(rows=>rows.map(row=>{const cells=[...row.children].map(cell=>cell.getBoundingClientRect());return {height:row.getBoundingClientRect().height,state:cells[1].x,rule:cells[2].x,separate:cells[1].right<=cells[2].x+1};}));
  assert.ok(geometry.every(row=>row.height<=38&&row.separate));assert.ok(geometry.every(row=>row.state===geometry[0].state&&row.rule===geometry[0].rule));await page.screenshot({path:path.join(project,`test-results/storage-states-${stage?.version||'source'}.png`),fullPage:true});
  assert.deepEqual(await page.evaluate(p=>window.cloudlane.nativeItems('other',[p]),pdf),{});assert.equal(await page.evaluate(async()=>{try{await window.cloudlane.nativeItems('storage',['../outside']);return false;}catch{return true;}}),true);
  await page.evaluate(()=>window.cloudlane.resetApp(true));assert.equal(await readFile(path.join(root,pdf),'utf8'),content);assert.equal(await readFile(path.join(root,keep),'utf8'),content);assert.equal(await stat(path.join(root,online)).catch(()=>null),null);console.log('PASS: pin/free-space transitions, all three Ukrainian/English labels, narrow layout, account isolation and safe cleanup verified');
}finally{if(app)try{const page=await app.firstWindow(),state=await page.evaluate(()=>window.cloudlane.state());if(state.accounts.length&&state.accounts.every(a=>['storage','other'].includes(a.id)&&(!a.native?.root||a.native.root===root)))await page.evaluate(()=>window.cloudlane.resetApp(true));}catch{/* Preserve failed fixture for diagnosis if safe cleanup is unavailable. */}await app?.close().catch(()=>{});}
