import {_electron as electron} from 'playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const project=path.resolve(import.meta.dirname,'..'),stage=process.argv.includes('--packaged')?JSON.parse(await readFile('.runtime/release-stage.json','utf8')):null,version=stage?.version||JSON.parse(await readFile('package.json','utf8')).version;
const base=path.join(project,'.runtime/background-test',randomUUID()),data=path.join(base,'data'),root=path.join(base,'Large_Project-test');await mkdir(root,{recursive:true});
const env={...process.env,CLOUDLANE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;let app;
const fixture=()=>{
  const text='On-demand fixture bytes',folder={'.tag':'folder',id:'id:project',path_display:'/Project'},files=Array.from({length:240},(_v,n)=>({'.tag':'file',id:'id:file-'+n,rev:'r1',path_display:`/Project/file-${String(n).padStart(3,'0')}.bin`,size:Buffer.byteLength(text),client_modified:'2026-11-01T00:00:00Z',content_hash:'fixture'}));
  globalThis.backgroundFixture={blockList:true,listing:false,aborted:0,downloads:0,creates:0,creationBlocked:false,releaseCreation:null,host:null};const state=globalThis.backgroundFixture;
  globalThis.fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):{};
    if(url.endsWith('get_current_account'))return Response.json({root_info:{home_namespace_id:'fixture-home',root_namespace_id:'fixture-home'}});
    if(url.endsWith('files/list_folder'))return Response.json({entries:body.path==='/Project'?files:[folder],has_more:!!body.recursive,cursor:'fixture-next'});
    if(url.endsWith('files/list_folder/continue')){
      state.listing=true;if(state.blockList)await new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>{state.aborted++;reject(options.signal.reason);},{once:true});options.signal.throwIfAborted();});return Response.json({entries:files,has_more:false});
    }
    if(url.endsWith('files/get_metadata'))return Response.json(body.path==='/Project'?folder:files.find(file=>file.path_display===body.path));
    if(url.endsWith('files/download')){state.downloads++;const range=options.headers.Range.match(/bytes=(\d+)-(\d+)/);return new Response(Buffer.from(text).subarray(+range[1],+range[2]+1),{status:206,headers:{'dropbox-api-result':JSON.stringify({rev:'r1'})}});}
    throw new Error('Unexpected cloud mutation: '+url);
  };
};
try{
  // Only the test's isolated profile is seeded. No real account or Windows autostart entry is changed.
  app=await electron.launch({args:[project],env});await (await app.firstWindow()).locator('main header').waitFor();
  const vault={language:'en',binary:path.join(project,'.runtime/tools/rclone.exe'),accounts:[{id:'background',name:'Background fixture',config:'[cloud]\ntype = dropbox\ntoken = '+JSON.stringify({access_token:'fixture',refresh_token:'fixture',expiry:new Date(Date.now()+3600000).toISOString()})+'\n',settings:{localRoot:'',rules:{}}}]};
  const encrypted=await app.evaluate(async({safeStorage},value)=>(await safeStorage.encryptStringAsync(JSON.stringify(value))).toString('base64'),vault);await writeFile(path.join(data,'vault.bin'),Buffer.from(encrypted,'base64'));await app.close();app=null;
  const appPath=stage?path.join(stage.app,'resources/app.asar'):project,bootstrap=path.join(base,'bootstrap.cjs');
  await writeFile(bootstrap,`const {app,dialog}=require('electron');app.getAppPath=()=>${JSON.stringify(appPath)};app.getVersion=()=>${JSON.stringify(version)};${stage?`Object.defineProperty(app,'isPackaged',{value:true});Object.defineProperty(process,'resourcesPath',{value:${JSON.stringify(path.join(stage.app,'resources'))}});`:''}dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(root)}]});(${fixture.toString()})();(async()=>{const {pathToFileURL}=require('node:url');const {NativeHost}=await import(pathToFileURL(${JSON.stringify(path.join(appPath,'core/native-host.mjs'))}).href);const request=NativeHost.prototype.request;NativeHost.prototype.request=async function(command,value,...args){const result=await request.call(this,command,value,...args),state=globalThis.backgroundFixture;if(command==='init')state.host=this;if(command==='create'&&++state.creates===12){state.creationBlocked=true;await new Promise(resolve=>state.releaseCreation=resolve);}return result;};await import(pathToFileURL(${JSON.stringify(path.join(appPath,'electron/main.mjs'))}).href);})();`);
  const launch=()=>electron.launch({args:[bootstrap],env});app=await launch();let page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.getByRole('button',{name:'Expand Project',exact:true}).waitFor();
  await page.locator('.local-root').getByRole('button',{name:'Choose folder',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('footer')?.textContent.includes('Choosing folder'),{},{timeout:10000});
  const waitFixture=async predicate=>{for(let count=0;count<200;count++){if(await app.evaluate(predicate))return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Fixture did not reach expected phase');};
  await waitFixture(()=>globalThis.backgroundFixture.listing);assert.equal((await page.evaluate(()=>window.cloudlane.state())).accounts[0].native.enabled,true);
  await page.getByRole('button',{name:'Settings',exact:true}).click();let dialog=page.getByRole('dialog');
  for(const name of ['Launch when I sign in','Start directly in the tray']){await dialog.getByRole('checkbox',{name,exact:true}).check({timeout:3000});await page.waitForFunction(()=>!document.querySelector('.preference-options input:disabled'));}
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('footer').getByRole('button',{name:'Cancel',exact:true}).click();
  const waitState=async predicate=>{for(let count=0;count<600;count++){const state=await page.evaluate(()=>window.cloudlane.state());if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Native state did not converge');};
  await waitState(s=>s.accounts[0].native.canceled&&s.accounts[0].native.status==='pending');
  assert.equal(await app.evaluate(()=>globalThis.backgroundFixture.aborted),1);assert.equal(await app.evaluate(()=>globalThis.backgroundFixture.creates),0);assert.equal(await app.evaluate(()=>globalThis.backgroundFixture.downloads),0);
  console.log('PASS: folder choice returns during delayed recursive listing; Settings toggles save and dialog closes with X/Escape; Cancel aborts the listing without creating or downloading files');
  // An explicit refresh resumes the canceled listing with the same provider.
  await app.evaluate(()=>{globalThis.backgroundFixture.blockList=false;});await page.getByRole('button',{name:'Refresh files on demand',exact:true}).click();await waitFixture(()=>globalThis.backgroundFixture.creationBlocked);
  await page.getByRole('button',{name:'Expand Project',exact:true}).click();await page.getByRole('button',{name:'file-000.bin',exact:true}).waitFor();
  const inspect=relative=>app.evaluate(async(_electron,relative)=>globalThis.backgroundFixture.host.request('inspect',{path:relative}),relative);
  const before=await inspect('Project/file-000.bin');assert.equal(before.partial,true);assert.equal(before.onDisk,0);assert.equal(before.pin,0);assert.equal(await app.evaluate(()=>globalThis.backgroundFixture.downloads),0);
  assert.equal(await readFile(path.join(root,'Project/file-000.bin'),'utf8'),'On-demand fixture bytes');assert.ok(await app.evaluate(()=>globalThis.backgroundFixture.downloads)>0);assert.equal((await inspect('Project/file-001.bin')).onDisk,0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('checkbox',{name:'Start directly in the tray',exact:true}).uncheck({timeout:3000});await page.waitForFunction(()=>!document.querySelector('.preference-options input:disabled'));await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await page.screenshot({path:path.join(project,`test-results/background-${version}.png`),fullPage:true});
  await app.evaluate(()=>globalThis.backgroundFixture.releaseCreation());
  await waitState(s=>s.accounts[0].native.status==='current'&&s.accounts[0].native.counts.online===239);
  const opened=await inspect('Project/file-000.bin'),untouched=await inspect('Project/file-239.bin');assert.equal(opened.partial,false,JSON.stringify(opened));assert.equal(untouched.onDisk,0,JSON.stringify(untouched));
  console.log('PASS: during real NTFS placeholder creation, file tree and Settings remain usable; opening one file hydrates only that file; all others remain online only');
  const prefs=(await page.evaluate(()=>window.cloudlane.state())).preferences;assert.equal(prefs.autoStart,true);assert.equal(prefs.startMinimized,false);
  // Restart while a fresh remote enumeration is stalled. Quit must abort it rather than wait for the whole tree.
  await app.evaluate(()=>{globalThis.backgroundFixture.blockList=true;globalThis.backgroundFixture.listing=false;});await page.evaluate(()=>window.cloudlane.refreshNative('background'));await waitFixture(()=>globalThis.backgroundFixture.listing);
  await page.evaluate(()=>window.cloudlane.quit());await app.close();app=null;
  app=await launch();page=await app.firstWindow();await page.locator('main header').waitFor();const restored=await page.evaluate(()=>window.cloudlane.state());assert.deepEqual(restored.preferences,prefs);await page.evaluate(()=>window.cloudlane.cancel());
  assert.deepEqual(errors,[]);console.log('PASS: Quit interrupts cloud enumeration; same isolated profile, preferences and native root reopen successfully');
}finally{
  if(app){try{await app.evaluate(()=>{const s=globalThis.backgroundFixture;s.blockList=false;s.releaseCreation?.();});const page=await app.firstWindow();await page.evaluate(()=>window.cloudlane.cancel());await page.evaluate(()=>window.cloudlane.setPreferences({pauseSync:true}));await page.evaluate(()=>window.cloudlane.resetApp(true));}catch(error){console.error('Fixture cleanup:',error.message);}await app.close().catch(()=>{});}
}
