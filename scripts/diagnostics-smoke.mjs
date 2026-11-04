import {_electron as electron} from 'playwright';
import {mkdir,readFile,writeFile,readdir,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const project=path.resolve(import.meta.dirname,'..'),stage=process.argv.includes('--packaged')?JSON.parse(await readFile('.runtime/release-stage.json','utf8')):null;
const version=stage?.version||JSON.parse(await readFile('package.json','utf8')).version,base=path.join(project,'.runtime/diagnostics-test',randomUUID()),data=path.join(base,'data'),root=path.join(base,'root'),output=path.join(base,'support-report.json');await mkdir(root,{recursive:true});
const env={...process.env,CLOUDLANE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
let app=await electron.launch({args:[project],env});
try{
  await (await app.firstWindow()).locator('main header').waitFor();
  const vault={language:'en',accounts:[{id:'diagnostics',name:'Studio diagnostics',config:'[cloud]\ntype = dropbox\ntoken = '+JSON.stringify({access_token:'PRIVATE-ACCESS-FIXTURE',refresh_token:'PRIVATE-REFRESH-FIXTURE',expiry:new Date(Date.now()+3600000).toISOString()})+'\n',settings:{localRoot:root,rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,root,owner:randomUUID()}}]};
  const bytes=await app.evaluate(async({safeStorage},value)=>(await safeStorage.encryptStringAsync(JSON.stringify(value))).toString('base64'),vault);await writeFile(path.join(data,'vault.bin'),Buffer.from(bytes,'base64'));
}finally{await app.close();}
const fixture=()=>{
  globalThis.diagnosticsFixture={paths:['Project/Bad?.ma'],downloads:0,cancelSave:true,block:false,waiting:false};const state=globalThis.diagnosticsFixture,folder={'.tag':'folder',id:'id:project',path_display:'/Project'};
  globalThis.fetch=async(url,options={})=>{
    if(url.endsWith('get_current_account'))return Response.json({root_info:{home_namespace_id:'test',root_namespace_id:'test'}});
    const body=options.body?JSON.parse(options.body):{};
    if(url.endsWith('files/list_folder')){
      if(body.recursive&&state.block){state.waiting=true;await new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});options.signal.throwIfAborted();});}
      const files=state.paths.map((p,n)=>({'.tag':'file',id:'id:'+n,rev:'r1',size:1,path_display:'/'+p}));
      return Response.json({entries:body.recursive?[folder,{'.tag':'file',id:'id:good',rev:'r1',size:1,path_display:'/Project/good.ma'},...files]:body.path==='/Project'?[{'.tag':'file',id:'id:good',rev:'r1',size:1,path_display:'/Project/good.ma'},...files]:[folder],has_more:false});
    }
    if(url.endsWith('files/download')){state.downloads++;return new Response('x',{status:206,headers:{'dropbox-api-result':JSON.stringify({rev:'r1'})}});}
    throw new Error('Unexpected network operation: '+url);
  };
};
const appPath=stage?path.join(stage.app,'resources/app.asar'):project,bootstrap=path.join(base,'bootstrap.cjs');
await writeFile(bootstrap,`const {app,dialog}=require('electron');app.getAppPath=()=>${JSON.stringify(appPath)};app.getVersion=()=>${JSON.stringify(version)};${stage?`Object.defineProperty(app,'isPackaged',{value:true});Object.defineProperty(process,'resourcesPath',{value:${JSON.stringify(path.join(stage.app,'resources'))}});`:''}(${fixture.toString()})();dialog.showSaveDialog=async()=>globalThis.diagnosticsFixture.cancelSave?({canceled:true}):({canceled:false,filePath:${JSON.stringify(output)}});(async()=>{await import(require('node:url').pathToFileURL(${JSON.stringify(path.join(appPath,'electron/main.mjs'))}).href);})();`);
const launch=()=>electron.launch({args:[bootstrap],env});app=await launch();
async function waitError(page,path,reason){
  for(let i=0;i<200;i++){const state=await page.evaluate(()=>window.cloudlane.state());const n=state.accounts[0]?.native;if(n?.error==='err.mapping'&&n.detail.includes(path)&&n.detail.includes(reason))return;await new Promise(r=>setTimeout(r,50));}throw Error('Expected mapping diagnosis not recorded: '+path);
}
async function waitSkipped(page,path,reason){for(let i=0;i<200;i++){const s=await page.evaluate(()=>window.cloudlane.state()),events=await page.evaluate(()=>window.cloudlane.fileEvents('diagnostics',{status:'skipped'}));if(s.accounts[0]?.native.status==='current'&&s.accounts[0]?.native.skippedFiles&&events.entries.some(e=>e.path===path&&e.detail===reason))return;await new Promise(r=>setTimeout(r,50));}throw Error('Expected skipped path: '+path);}
try{
  let page=await app.firstWindow();await waitSkipped(page,'Project/Bad?.ma','err.mappingCharacters');
  await page.getByRole('button',{name:'Show in history',exact:true}).click();await page.getByRole('combobox',{name:'Result',exact:true}).waitFor();assert.equal(await page.getByRole('combobox',{name:'Result',exact:true}).inputValue(),'skipped');
  await page.locator('.journal-file').filter({hasText:'Project/Bad?.ma'}).waitFor();await page.screenshot({path:path.join(project,`test-results/skipped-${version}.png`)});
  for(const [paths,reason] of [[['Project/trailing /file.ma'],'err.mappingEnding'],[['Project/AUX.pdf'],'err.mappingReserved'],[['Project/Scene.ma','Project/scene.ma'],'err.mappingCollision']]){
    await app.evaluate((_e,paths)=>{globalThis.diagnosticsFixture.paths=paths;},paths);await page.evaluate(()=>window.cloudlane.refreshNative('diagnostics'));await (reason==='err.mappingCollision'?waitError:waitSkipped)(page,paths.at(-1),reason);
  }
  assert.deepEqual(await readdir(root),['Project']);assert.equal(await app.evaluate(()=>globalThis.diagnosticsFixture.downloads),0);assert.equal(await readFile(path.join(root,'Project/good.ma'),'utf8'),'x');assert.equal(await app.evaluate(()=>globalThis.diagnosticsFixture.downloads),1);
  await app.close();app=await launch();page=await app.firstWindow();await waitSkipped(page,'Project/Bad?.ma','err.mappingCharacters');
  // Export remains accessible while a new background listing is deliberately stalled.
  await app.evaluate(()=>{globalThis.diagnosticsFixture.block=true;});await page.evaluate(()=>window.cloudlane.refreshNative('diagnostics'));
  for(let i=0;i<200&&!await app.evaluate(()=>globalThis.diagnosticsFixture.waiting);i++)await new Promise(r=>setTimeout(r,50));
  assert.equal(await app.evaluate(()=>globalThis.diagnosticsFixture.waiting),true);
  await page.getByRole('button',{name:'Settings',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Save diagnostics',exact:true}).click();assert.equal(await access(output).then(()=>true,()=>false),false);
  await app.evaluate(()=>{globalThis.diagnosticsFixture.cancelSave=false;});await dialog.getByRole('button',{name:'Save diagnostics',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Report saved'}).waitFor();
  const text=await readFile(output,'utf8'),report=JSON.parse(text),entries=report.accounts[0].recentErrors;
  assert.equal(report.application.version,version);assert.equal(report.format,'amg-rclone-diagnostics-v1');
  for(const p of ['Project/Bad?.ma','Project/trailing /file.ma','Project/AUX.pdf','Project/Scene.ma','Project/scene.ma'])assert.ok(text.includes(p),p);
  assert.ok(report.accounts[0].recentSkipped.some(e=>e.explanation.includes('reserved Windows device name')));assert.ok(entries.some(e=>e.explanation.includes('these two paths')));
  for(const secret of ['PRIVATE-ACCESS-FIXTURE','PRIVATE-REFRESH-FIXTURE','vault.bin','refresh_token','access_token'])assert.equal(text.includes(secret),false,secret);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await page.evaluate(()=>window.cloudlane.setLanguage('uk'));await page.getByRole('button',{name:'Налаштування',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Зберегти діагностику',exact:true}).waitFor();
  await page.screenshot({path:path.join(project,`test-results/diagnostics-${version}.png`)});
  console.log('PASS: packaged native provider skips invalid names, continues real placeholder creation and on-open hydration, exposes skipped history and bounded diagnostics; collisions remain protected, UK/EN export works during background sync, no credentials exported');
}finally{
  if(app){try{const page=await app.firstWindow();await page.evaluate(()=>window.cloudlane.cancel());await page.evaluate(()=>window.cloudlane.setPreferences({pauseSync:true}));await page.evaluate(()=>window.cloudlane.resetApp(true));}finally{await app.close();}}
}
