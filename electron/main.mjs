import { app, BrowserWindow, dialog, ipcMain, safeStorage, Menu, session, shell, Notification } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, unlink, readdir, realpath, stat, lstat, rm } from 'node:fs/promises';
import {watch} from 'node:fs';
import {prepareProfile,commitProfile,bundledBinaryMode,migrateLegacyProfile,relocateProfileWorkdirs} from '../core/profile.mjs';
import {validateAvailabilityPaths} from '../core/native-availability.mjs';
import {currentConfigAccessToken} from '../core/account-root.mjs';
import {archiveMissingRoot,archiveResetRoot} from '../core/account-recovery.mjs';
import {cleanLegacyMarkers,markerSummary} from '../core/legacy-markers.mjs';
import {NativeProviders} from '../core/native-provider.mjs';
import {diagnosticReport} from '../core/diagnostics.mjs';
import {readVault,writeVault} from '../core/vault-file.mjs';
import {TaskQueues} from '../core/task-queue.mjs';
import {release as osRelease} from 'node:os';
import {DropboxTransport,LocalTransport} from '../core/dropbox-transport.mjs';
import {SubstDrives} from '../core/subst-drives.mjs';
import {OwnedDrives} from '../core/drives.mjs';
import {createDesktop,statusFor} from './desktop.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateRemotePath, validateSettings, makePlan, parseAuthorization, contains } from '../core/policy.mjs';
import { translate, messages } from '../core/i18n.mjs';
import { SyncStore } from '../core/store.mjs';
import {JournalMaintenance} from '../core/journal-maintenance.mjs';
import { SyncEngine, settingsHash } from '../core/sync-engine.mjs';

const exec=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
const entry=pathToFileURL(path.join(here,'../dist/index.html')).href;
let window,vault,dataDir,runtimeDir,activeChild,store,engine,scheduler,providers,drives,desktop,driveBackend,maintenanceRemote;
let journalMaintenance,vaultRecovery=null;let persistQueue=Promise.resolve();const dirtyAccounts=new Set(),watchers=new Map(),accountRootErrors=new Map();
let rcloneVersion=null,quitting=false;const tasks=new TaskQueues();
const isolated=process.env.CLOUDLANE_TEST_DATA;
const profileDir=isolated?path.resolve(isolated):path.join(app.getPath('documents'),'AMGRCLONE');
const legacyDir=isolated?(process.env.CLOUDLANE_LEGACY_TEST_DATA?path.resolve(process.env.CLOUDLANE_LEGACY_TEST_DATA):profileDir):path.join(app.getPath('appData'),'cloudlane');
// Keep a stable singleton key so old AppData and new Documents builds cannot sync concurrently.
app.setPath('userData',legacyDir);
if(process.platform==='win32')app.setAppUserModelId('app.cloudlane.desktop');
const primary=app.requestSingleInstanceLock();
let profileMigrationError;if(primary)try{migrateLegacyProfile({legacyDir,dataDir:profileDir});}catch(error){profileMigrationError=error;}
app.setPath('userData',profileDir);app.setPath('sessionData',profileDir);
if(!primary)app.quit();
app.on('second-instance',(_event,argv)=>{if(!argv.includes('--autostart'))showWindow();});
function showWindow(){if(window){window.show();if(window.isMinimized())window.restore();window.focus();}}
const t=(key,values={})=>translate(vault?.language||'uk',key,values);
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('RCLONE_')));
const safeLog=value=>value.replace(/(access_token|refresh_token|Authorization)["\s:=]+[^\s,}\n]+/gi,'$1=[redacted]').slice(-1000000);

function run(args,{binary=vault?.binary||'rclone',timeout=120000,onLog,secret=false,track=true}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{shell:false,windowsHide:true,env:cleanEnv(),stdio:['ignore','pipe','pipe']});
    if(track)activeChild=child;let stdout='',stderr='',lineBuffer='',failure;
    const timer=setTimeout(()=>{failure=new Error('err.timeout');child.kill();},timeout);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>32*1024*1024){failure=new Error('err.large');child.kill();}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1000000);lineBuffer+=chunk;let end;while((end=lineBuffer.indexOf('\n'))>=0){onLog?.(lineBuffer.slice(0,end));lineBuffer=lineBuffer.slice(end+1);}});
    child.on('error',()=>{clearTimeout(timer);if(activeChild===child)activeChild=null;reject(new Error('err.binary'));});
    child.on('close',code=>{
      clearTimeout(timer);if(activeChild===child)activeChild=null;if(lineBuffer)onLog?.(lineBuffer);
      if(failure||code!==0){const error=failure||new Error(code===null||child.killed?'err.canceled':/too many deletes/i.test(stderr)?'err.deletes':/syntax error detected in your path|filename.*too long|path.*too long/i.test(stderr)?'err.longPath':'err.operation');if(!secret)error.safeLog=safeLog(stderr);error.exitCode=code;reject(error);}
      else resolve({stdout,stderr:secret?stderr:safeLog(stderr)});
    });
  });
}
async function encrypt(text){if(safeStorage.isAsyncEncryptionAvailable){if(!await safeStorage.isAsyncEncryptionAvailable())throw new Error('err.keys');return safeStorage.encryptStringAsync(text);}if(!safeStorage.isEncryptionAvailable())throw new Error('err.keys');return safeStorage.encryptString(text);}
async function decrypt(bytes){return safeStorage.decryptStringAsync?(await safeStorage.decryptStringAsync(bytes)).result:safeStorage.decryptString(bytes);}
async function persist(){const result=persistQueue.then(()=>writeVault({dataDir,vault,encrypt}));persistQueue=result.catch(()=>{});return result;}
function account(id){const acc=vault.accounts.find(a=>a.id===id);if(!acc)throw new Error('err.account');return acc;}
function nativeState(acc){if(acc.needsLogin)return acc.native?.enabled?{enabled:true,root:acc.native.root,status:'pending'}:{enabled:false};const value=providers?.status(acc)||{enabled:false};return accountRootErrors.has(acc.id)?{...value,status:'error',error:accountRootErrors.get(acc.id)}:value;}
async function usableAccessToken(acc){return currentConfigAccessToken(acc.config)||await nativeAuth(acc);}
function publicState(){const accounts=vault.accounts.map(({id,name,settings,scope='personal',accountType,scheduleMinutes=0,paused=false,nextRun=null,needsLogin=false})=>({id,name,scope,accountType,settings,scheduleMinutes,paused,nextRun,needsLogin,native:nativeState(account(id)),maintenance:markerSummary(store.markerReceipts(id)),jobs:store.jobs(id).filter(j=>j.status!=='retired').map(j=>({path:j.remote_path,status:j.status,lastSuccess:j.last_success}))}));const preferences=vault.preferences;return {accounts,vaultRecovery,profilePath:dataDir,rcloneVersion,version:app.getVersion(),platform:process.platform,nativeProvider:process.platform==='win32',language:vault.language,activity:engine.activity,preferences,drives:(vault.drives||[]).map(({id,accountId,path:relative,root,letter,status})=>({id,accountId,path:relative,absolutePath:path.join(root,...relative.split('/')),letter,status})),trayStatus:statusFor(accounts,engine.activity,preferences,dirtyAccounts)};}
async function savePreferences(input){for(const [key,value]of Object.entries(input)){if(!['autoStart','startMinimized','pauseSync'].includes(key)||typeof value!=='boolean')throw new Error('err.settings');}const next={...vault.preferences,...input};if(input.autoStart!==undefined)desktop?.applyLoginSettings(next);vault.preferences=next;if(providers&&input.pauseSync!==undefined)providers.setPaused(next.pauseSync);await persist();desktop?.update();return publicState();}
function watchClassic(acc){watchers.get(acc.id)?.close();watchers.delete(acc.id);if(!acc.settings.localRoot||acc.native?.enabled)return;try{const watcher=watch(acc.settings.localRoot,{recursive:true},()=>{if(!engine.activity)dirtyAccounts.add(acc.id);});watcher.on('error',()=>dirtyAccounts.add(acc.id));watchers.set(acc.id,watcher);}catch{dirtyAccounts.add(acc.id);}}
// Roadmap 2.5: one Dropbox account may be connected once. Two app accounts on the same Dropbox
// would sync it twice and pass deletions between their folders.
async function dropboxIdentity(accessToken){const remote=new DropboxTransport({auth:async()=>accessToken});try{const profile=await remote.accountProfile(accessToken);if(typeof profile.account_id!=='string')throw new Error('err.accountRoot');return profile.account_id;}finally{remote.cancel();}}
async function assertNewDropboxAccount(identity,exceptId){
  for(const other of vault.accounts){
    if(other.id===exceptId||!other.config||!/^type\s*=\s*dropbox$/m.test(other.config))continue;
    if(!other.dropboxAccountId){try{other.dropboxAccountId=await dropboxIdentity(await usableAccessToken(other));}catch{continue;}}
    if(other.dropboxAccountId===identity)throw Object.assign(new Error('err.accountDuplicate'),{detail:other.name});
  }
}
function notify(body){if(!Notification.isSupported())return;const notice=new Notification({title:'AMG rclone UI',body});notice.on('click',showWindow);notice.show();}
// A mass deletion waiting for this user's decision: a Windows notification that opens the window.
const notifiedReviews=new Set();
function notifyReview(acc,{inbound,outbound}){const id=(inbound||outbound)?.id;if(!id||notifiedReviews.has(id))return;notifiedReviews.add(id);desktop?.update();if(!Notification.isSupported())return;const count=inbound?inbound.items.length:(outbound.remoteBaseline||outbound.items).length;const notice=new Notification({title:'AMG rclone UI · '+acc.name,body:t(inbound?'reviewInboundNotice':'reviewOutboundNotice',{count,path:outbound?.path||''})});notice.on('click',showWindow);notice.show();}
async function nativeAuth(acc){if(quitting)throw new Error('err.canceled');return withConfig(acc,async flags=>{await run(['about','cloud:',...flags],{track:false});const config=await readFile(flags[1],'utf8'),line=config.match(/^token\s*=\s*(.+)$/m)?.[1];if(!line)throw new Error('err.oauth');const token=JSON.parse(line);return token.access_token;});}

async function withConfig(acc,callback){const filename=path.join(runtimeDir,`session-${randomUUID()}.conf`);await writeFile(filename,acc.config,{flag:'wx',mode:0o600});try{return await callback(['--config',filename,'--ask-password=false']);}finally{try{acc.config=await readFile(filename,'utf8');await persist();}finally{await unlink(filename);}}}
async function version(binary){const {stdout}=await run(['version'],{binary,timeout:15000});const match=stdout.match(/^rclone v(\d+)\.(\d+)\.(\d+)/);if(!match||+match[1]<1||(+match[1]===1&&+match[2]<70))throw new Error('err.version');return match[0];}
function enqueue(task,accountId){return tasks.run(task,accountId);}
// Roadmap 3.6: these act on one account and run beside other accounts' work. Everything else
// that is serialized changes shared state (account list, drives, language, bisync engine) and
// waits for all accounts. login/relogin wait for the browser outside any queue.
const ACCOUNT_SCOPED=new Set(['refreshNative','cleanupLegacy','nativeAvailability','nativeReview','list','saveSettings','setScope','setSchedule']),UNQUEUED=new Set(['login','relogin']);
function register(name,handler,serialized=true){ipcMain.handle('cloudlane:'+name,async(event,...args)=>{if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==entry)throw new Error(t('err.sender'));try{return await(serialized&&!UNQUEUED.has(name)?enqueue(()=>handler(...args),ACCOUNT_SCOPED.has(name)&&typeof args[0]==='string'?args[0]:undefined):handler(...args));}catch(error){throw new Error(t(messages.en[error.message]?error.message:'err.operation')+(error.detail?' ('+error.detail+')':''));}});}
function invalidateSchedule(acc){acc.scheduleMinutes=0;acc.nextRun=null;engine.plans.clear();}
async function initialize(){
  dataDir=app.getPath('userData');const profileUpgrade=await prepareProfile({dataDir,version:app.getVersion()});runtimeDir=path.join(dataDir,'runtime');await mkdir(runtimeDir,{recursive:true,mode:0o700});
  if(process.platform==='win32'){const {stdout}=await exec('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true});const sid=stdout.match(/S-1-[\d-]+/)?.[0];if(!sid)throw new Error('err.permissions');await exec('icacls.exe',[runtimeDir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],{windowsHide:true});}
  for(const file of await readdir(runtimeDir))if(/^session-[\da-f-]+\.conf$/.test(file))await unlink(path.join(runtimeDir,file));
  const devBinary=app.isPackaged?path.join(process.resourcesPath,'bin',process.platform==='win32'?'rclone.exe':'rclone'):path.join(app.getAppPath(),'.runtime','tools',process.platform==='win32'?'rclone.exe':'rclone'),devExists=await stat(devBinary).then(s=>s.isFile()).catch(()=>false);
  // Roadmap 2.2: a damaged or undecryptable vault no longer stops the app. vault.bak is tried
  // next, then settings-backup.json (accounts come back and only need a new Dropbox sign-in).
  const loaded=await readVault({dataDir,decrypt});vault=loaded.vault||{accounts:[]};vault.binary=vault.binary||(devExists?devBinary:'rclone');
  if(loaded.problem)vaultRecovery={source:loaded.source,problem:loaded.problem,accounts:vault.accounts.filter(a=>a.needsLogin).map(a=>a.name)};
  vault.binaryMode=bundledBinaryMode(vault,devBinary);if(vault.binaryMode==='bundled'&&devExists)vault.binary=devBinary;
  vault.language=vault.language==='en'?'en':'uk';vault.preferences={autoStart:false,startMinimized:false,pauseSync:false,...vault.preferences};vault.drives=vault.drives||[];
  try{rcloneVersion=await version(vault.binary);}catch{if(devExists)try{rcloneVersion=await version(devBinary);vault.binary=devBinary;}catch{/* Setup in UI. */}}
  store=new SyncStore(path.join(dataDir,'sync.sqlite'));journalMaintenance=new JournalMaintenance(path.join(dataDir,'sync.sqlite'));journalMaintenance.start();await relocateProfileWorkdirs({store,dataDir});engine=new SyncEngine({store,dataDir,connection:withConfig,run,rootGuard:root=>process.platform==='win32'?providers.isManagedRoot(root):false});
  const nativeBinary=app.isPackaged?path.join(process.resourcesPath,'bin','amg-cloud.exe'):path.join(app.getAppPath(),'native','bin','amg-cloud.exe');
  providers=new NativeProviders({binary:nativeBinary,dataDir,store,persist,onReview:notifyReview,transport:acc=>{if(isolated&&/^type\s*=\s*alias$/m.test(acc.config)){const root=acc.config.match(/^remote\s*=\s*(.+)$/m)?.[1];return new LocalTransport(root);}let cached;return new DropboxTransport({scope:acc.scope||'personal',auth:async()=>{if(!cached||cached.until<Date.now())cached={token:await usableAccessToken(acc),until:Date.now()+60000};return cached.token;}});}});providers.paused=vault.preferences.pauseSync;
  driveBackend=new SubstDrives(nativeBinary);
  for(const acc of vault.accounts)acc.driveOwner=acc.driveOwner||randomUUID();
  drives=new OwnedDrives({records:vault.drives,account,backend:driveBackend,persist,resolveFolder:async(acc,relative)=>{const configured=acc.native?.enabled?acc.native.root:acc.settings.localRoot;if(!configured)throw new Error('err.root');const root=await realpath(configured),target=await realpath(path.join(root,...relative.split('/'))).catch(()=>{throw new Error('err.driveLocalFolder');});const inside=path.relative(root,target);if(!(await stat(target)).isDirectory()||inside.startsWith('..')||path.isAbsolute(inside))throw new Error('err.link');return {root,target};}});
  for(const acc of vault.accounts){if(store.jobs(acc.id).some(j=>j.status==='needsReview'))acc.paused=true;watchClassic(acc);}
  desktop=createDesktop({state:publicState,t,show:showWindow,quit:()=>app.quit(),savePreferences,isolated});desktop.applyLoginSettings(vault.preferences);
  for(const acc of vault.accounts)if(acc.native?.enabled&&!acc.needsLogin)enqueue(async()=>{await ensureAccountRoot(acc);await providers.start(acc);if(!acc.native.resetting&&!vault.preferences.pauseSync)backgroundNativeRefresh(acc);},acc.id).catch(()=>{});
  if(vault.drives.length)drives.restore().catch(()=>{});
  register('state',publicState,false);
  register('exportDiagnostics',async()=>{
    const result=await dialog.showSaveDialog(window,{title:t('saveDiagnostics'),defaultPath:`AMG-rclone-diagnostics-${app.getVersion()}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,filters:[{name:'JSON',extensions:['json']}]});
    if(result.canceled||!result.filePath)return false;
    const report=diagnosticReport({state:publicState(),store,arch:process.arch,osVersion:osRelease()});
    try{await writeFile(result.filePath,JSON.stringify(report,null,2)+'\n',{mode:0o600});}catch{throw new Error('err.diagnosticsSave');}
    return true;
  },false);
  register('setPreferences',savePreferences,false);
  register('quit',()=>{app.quit();return true;},false);
  async function cleanupLegacy(acc){if(!acc.native?.enabled)throw new Error('err.nativeRequired');const remote=providers.transport(acc);maintenanceRemote=remote;try{return await cleanLegacyMarkers(acc,store,remote);}finally{remote.cancel?.();if(maintenanceRemote===remote)maintenanceRemote=null;}}
  function backgroundNativeRefresh(acc){providers.refresh(acc).then(async()=>{if(!quitting&&vault.accounts.includes(acc)&&acc.native?.enabled&&!acc.native.resetting)await cleanupLegacy(acc);}).catch(()=>{});}
  async function detachNative(acc,keepDownloaded=false){if(!acc.native?.enabled)return;const result=await providers.detach(acc,{keepDownloaded});if(result?.missing)await archiveMissingRoot({dataDir,account:acc,items:store.nativeItems(acc.id),jobs:store.jobs(acc.id)});else if(keepDownloaded||result?.uninitialized)await archiveResetRoot({dataDir,account:acc,items:store.nativeItems(acc.id),jobs:store.jobs(acc.id),deletions:store.nativeDeletions(acc.id)});const detachedRoot=acc.native.root;acc.settings.localRoot=detachedRoot;delete acc.native;await persist();if(result?.uninitialized)providers.contexts.delete(acc.id);}
  async function disconnectOwnedDrives(acc){for(const record of [...vault.drives].filter(d=>d.accountId===acc.id)){const expected=drives.expected(record),current=(await driveBackend.list()).find(d=>d.letter===record.letter);if(current&&!current.available&&current.target.toLowerCase()!==expected.toLowerCase()){const index=vault.drives.findIndex(d=>d.id===record.id);vault.drives.splice(index,1);await persist();}else await drives.remove(record.id);}}
  async function ensureAccountRoot(acc){
    if(!/^type\s*=\s*dropbox$/m.test(acc.config)||acc.accountRoot){accountRootErrors.delete(acc.id);return;}
    const remote=new DropboxTransport({auth:()=>usableAccessToken(acc)});
    try{
      const scope=await remote.accountScope();acc.accountType=scope==='team'||remote.profile?.team||remote.profile?.root_info?.['.tag']==='team'?'business':'personal';
      if(scope!==(acc.scope||'personal')){
        if(store.jobs(acc.id).some(job=>job.initialized||job.status!=='new')||store.nativeItems(acc.id).length||store.nativeDeletions(acc.id).length||vault.drives.some(d=>d.accountId===acc.id))throw new Error('err.accountRootBusy');
        const root=acc.native?.root||acc.settings.localRoot;if(root&&(await readdir(root)).length)throw new Error('err.accountRootBusy');
        if(acc.native?.enabled)await providers.releaseEmptyRoot(acc);
        if(root&&(await readdir(root)).length)throw new Error('err.accountRootBusy');
        acc.scope=scope;acc.settings.rules=acc.native?.enabled?{'':{selected:true,mode:'online',kind:'folder'}}:{};
        if(acc.native)acc.native.lastSync=null;
        store.db.prepare('DELETE FROM jobs WHERE account_id=?').run(acc.id);invalidateSchedule(acc);
      }
      acc.accountRoot=true;accountRootErrors.delete(acc.id);await persist();
    }catch(error){accountRootErrors.set(acc.id,error.message?.startsWith('err.')?error.message:'err.accountRoot');throw error;}finally{remote.cancel();}
  }
  async function activateNativeRoot(acc,chosen){
    if(process.platform!=='win32')throw new Error('err.nativeRequired');await ensureAccountRoot(acc);
    const root=await realpath(chosen);if((await readdir(root)).length)throw new Error('err.nativeFolder');
    // Resolve saved roots too: a different spelling or junction must not bypass overlap checks.
    for(const other of vault.accounts){
      for(const configured of [other.settings.localRoot,other.native?.root].filter(Boolean)){
        const existing=await realpath(configured).catch(()=>configured),a=root.toLowerCase(),b=existing.toLowerCase();
        const reusableClassic=other.id===acc.id&&configured===other.settings.localRoot&&a===b&&!store.jobs(acc.id).some(j=>j.initialized);
        const retryOwn=other.id===acc.id&&configured===other.native?.root&&a===b&&providers.status(acc).canChangeRoot;
        const relative=path.relative(existing,root),reverse=path.relative(root,existing);
        const within=value=>!value.startsWith('..')&&!path.isAbsolute(value);
        if(!reusableClassic&&!retryOwn&&(within(relative)||within(reverse)))throw new Error('err.nativeFolder');
      }
    }
    if(acc.native?.enabled){await providers.forgetEmpty(acc);delete acc.native;await persist();}
    acc.native={enabled:true,root,owner:randomUUID()};acc.settings.rules={'':{selected:true,mode:'online',kind:'folder'}};dirtyAccounts.delete(acc.id);invalidateSchedule(acc);watchers.get(acc.id)?.close();watchers.delete(acc.id);await persist();await providers.start(acc);acc.native.registered=true;await persist();if(!vault.preferences.pauseSync)backgroundNativeRefresh(acc);return publicState();
  }
  register('chooseNativeRoot',async id=>{
    if(process.platform!=='win32')throw new Error('err.nativeRequired');const acc=account(id);
    const result=await dialog.showOpenDialog(window,{title:t('chooseNativeFolder'),defaultPath:acc.settings.localRoot||undefined,properties:['openDirectory','createDirectory']});if(result.canceled)return publicState();
    return activateNativeRoot(acc,result.filePaths[0]);
  });
  register('enableNativeRoot',async id=>{const acc=account(id);if(!acc.settings.localRoot)throw new Error('err.root');return activateNativeRoot(acc,acc.settings.localRoot);});
  register('refreshNative',async id=>{const acc=account(id);await ensureAccountRoot(acc);if(!acc.native?.enabled)throw new Error('err.nativeRequired');backgroundNativeRefresh(acc);return publicState();});
  register('resetApp',async confirmed=>{
    if(confirmed!==true)throw new Error('err.confirm');if(engine.activity)throw new Error('err.resetBusy');let resetStage='prepare';
    for(const acc of vault.accounts)if(acc.native?.enabled){acc.native.resetting=true;acc.native.resetMode='keepDownloaded';providers.cancelAccount(acc.id);}await persist();
    try{
      resetStage='detach';for(const acc of vault.accounts)if(acc.native?.enabled){await detachNative(acc,true);}
      resetStage='drives';await drives.disconnect();
      for(const record of vault.drives){const current=(await driveBackend.list()).find(d=>d.letter===record.letter);if(current&&!current.available&&current.target.toLowerCase()===drives.expected(record).toLowerCase())throw new Error('err.driveOwnership');}
      resetStage='autostart';desktop.applyLoginSettings({...vault.preferences,autoStart:false});for(const watcher of watchers.values())watcher.close();watchers.clear();dirtyAccounts.clear();
      resetStage='browser-storage';await session.defaultSession.clearStorageData();await session.defaultSession.clearCache();
      resetStage='files';for(const name of ['native-cache','previews','sync']){const target=path.resolve(dataDir,name),relative=path.relative(path.resolve(dataDir),target);if(relative!==name)throw new Error('err.reset');await rm(target,{recursive:true,force:true});}
      resetStage='database';await journalMaintenance.close();try{store.reset();}finally{journalMaintenance.start();}engine.plans.clear();vault={accounts:[],language:'uk',preferences:{autoStart:false,startMinimized:false,pauseSync:false},drives:[],binary:devExists?devBinary:'rclone'};providers.paused=false;drives.records=vault.drives;await persist();desktop.update();return publicState();
    }catch(error){throw Object.assign(new Error('err.reset'),{detail:[resetStage,error.message?.startsWith('err.')?t(error.message):error.code||error.message].filter(Boolean).join(': ').slice(0,200)});}
  });
  register('cleanupLegacy',async id=>{await cleanupLegacy(account(id));return publicState();});
  register('nativeAvailability',async(id,relative,mode)=>{const acc=account(id);await ensureAccountRoot(acc);validateRemotePath(relative);if(!acc.native?.enabled||!['local','online'].includes(mode))throw new Error('err.nativeRequired');providers.availability(acc,relative,mode).catch(()=>{});return publicState();});
  register('nativeReview',async(id,action,operationId)=>{const acc=account(id);if(!acc.native?.enabled||!['apply','restore','confirm','cancel'].includes(action)||(operationId!==undefined&&typeof operationId!=='string'))throw new Error('err.settings');await providers.decide(acc,action,operationId);desktop?.update();return publicState();});
  register('openQuarantine',async id=>{const acc=account(id),target=providers.quarantinePath(acc);await mkdir(target,{recursive:true});const error=await shell.openPath(target);if(error)throw new Error('err.operation');},false);
  register('showInFolder',async(id,relative)=>{const acc=account(id);validateRemotePath(relative);if(!relative||!acc.native?.enabled)throw new Error('err.nativeRequired');const root=await realpath(acc.native.root),target=path.join(root,...relative.split('/'));if(path.relative(root,target).startsWith('..'))throw new Error('err.link');shell.showItemInFolder(target);},false);
  register('nativeItem',(id,relative)=>{account(id);validateRemotePath(relative);return store.nativeItems(id).find(i=>i.path===relative)?.status||null;},false);
  register('nativeItems',(id,paths)=>{const acc=account(id),checked=validateAvailabilityPaths(paths);return acc.native?.enabled?providers.itemStates(acc,checked):{};},false);
  register('driveLetters',async()=>({drives:(await driveBackend.list()).map(({letter,available})=>({letter,available}))}));
  register('chooseDriveFolder',async id=>{const acc=account(id),configured=acc.native?.enabled?acc.native.root:acc.settings.localRoot;if(!configured)throw new Error('err.root');const root=await realpath(configured),choice=await dialog.showOpenDialog(window,{title:t('chooseDriveFolder'),defaultPath:root,properties:['openDirectory']});if(choice.canceled)return null;const target=await realpath(choice.filePaths[0]),relative=path.relative(root,target);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('err.link');return relative.split(path.sep).join('/');});
  register('createDrive',async(id,relative,letter)=>{if(process.platform!=='win32')throw new Error('err.driveOperation');const acc=account(id);validateRemotePath(relative);if(!acc.driveOwner)acc.driveOwner=randomUUID();await persist();await drives.create(id,relative,letter);return publicState();});
  register('removeDrive',async id=>{await drives.remove(id);return publicState();});
  register('setLanguage',async language=>{if(!['uk','en'].includes(language))throw new Error('err.language');vault.language=language;await persist();return publicState();});
  register('setScope',async(id,scope)=>{const acc=account(id);if(/^type\s*=\s*dropbox$/m.test(acc.config))throw new Error('err.accountRootManaged');if(acc.native?.enabled)throw new Error('err.nativeExclusive');if(!['personal','team'].includes(scope))throw new Error('err.settings');if(store.jobs(id).some(j=>j.initialized||j.status!=='new'))throw new Error('err.scope');acc.scope=scope;acc.settings.rules={};store.db.prepare('DELETE FROM jobs WHERE account_id=?').run(id);invalidateSchedule(acc);await persist();return publicState();});
  register('chooseRclone',async()=>{const result=await dialog.showOpenDialog(window,{title:t('chooseRclone'),properties:['openFile'],filters:process.platform==='win32'?[{name:'rclone',extensions:['exe']}]:[]});if(!result.canceled){const binary=result.filePaths[0],checked=await version(binary);vault.binary=binary;vault.binaryMode='custom';rcloneVersion=checked;await persist();}return publicState();});
  // Signs an existing account in again (after a vault restored from settings-backup.json). The
  // Dropbox account must be the same one: its folders, rules and catalog belong to it.
  register('relogin',async id=>{const acc=account(id);if(!rcloneVersion)throw new Error('err.setup');await encrypt('availability-check');const result=await run(['authorize','dropbox','--config',path.join(runtimeDir,'unused.conf'),'--ask-password=false'],{timeout:300000,secret:true,track:false});const token=parseAuthorization(result.stdout+'\n'+result.stderr);const identity=await dropboxIdentity(JSON.parse(token).access_token);return enqueue(async()=>{if(!vault.accounts.includes(acc))throw new Error('err.account');if(acc.dropboxAccountId&&identity!==acc.dropboxAccountId)throw new Error('err.accountMismatch');await assertNewDropboxAccount(identity,acc.id);acc.dropboxAccountId=identity;acc.config=`[cloud]\ntype = dropbox\ntoken = ${token}\n`;delete acc.needsLogin;await persist();if(vaultRecovery){vaultRecovery.accounts=vault.accounts.filter(a=>a.needsLogin).map(a=>a.name);if(!vaultRecovery.accounts.length)vaultRecovery=null;}if(acc.native?.enabled){await ensureAccountRoot(acc);await providers.start(acc);if(!vault.preferences.pauseSync)backgroundNativeRefresh(acc);}return publicState();});});
  register('dismissRecovery',()=>{vaultRecovery=null;return publicState();},false);
  register('login',async name=>{if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('err.name');if(!rcloneVersion)throw new Error('err.setup');await encrypt('availability-check');const result=await run(['authorize','dropbox','--config',path.join(runtimeDir,'unused.conf'),'--ask-password=false'],{timeout:300000,secret:true,track:false});const token=parseAuthorization(result.stdout+'\n'+result.stderr);const dropboxAccountId=await dropboxIdentity(JSON.parse(token).access_token);return enqueue(async()=>{await assertNewDropboxAccount(dropboxAccountId);const acc={id:randomUUID(),name:name.trim(),dropboxAccountId,config:`[cloud]\ntype = dropbox\ntoken = ${token}\n`,settings:{localRoot:'',rules:{}},scheduleMinutes:0};vault.accounts.push(acc);await persist();await ensureAccountRoot(acc);return publicState();});});
  register('removeAccount',async(id,confirmed=false)=>{
    const acc=account(id);if(confirmed!==true)throw new Error('err.confirm');
    if(acc.native?.enabled){acc.native.resetting=true;acc.native.resetMode='keepDownloaded';providers.cancelAccount(acc.id);invalidateSchedule(acc);await persist();await detachNative(acc,true);}
    await disconnectOwnedDrives(acc);watchers.get(id)?.close();watchers.delete(id);dirtyAccounts.delete(id);const revoke=acc.config&&/^type\s*=\s*dropbox$/m.test(acc.config)?new DropboxTransport({auth:()=>usableAccessToken(acc)}):null;await revoke?.revoke().catch(()=>{});revoke?.cancel();vault.accounts=vault.accounts.filter(a=>a.id!==id);engine.plans.clear();await persist();store.forgetAccount(id);return publicState();
  });
  register('list',async(id,remotePath)=>{
    validateRemotePath(remotePath);const acc=account(id);await ensureAccountRoot(acc);
    const listing=async flags=>{
      let items;
      if(/^type\s*=\s*dropbox$/m.test(acc.config)){
        const remote=new DropboxTransport({scope:acc.scope||'personal',auth:()=>usableAccessToken(acc)});
        try{items=(await remote.list(remotePath,false)).map(item=>({path:item.path,name:item.path.split('/').at(-1),kind:item.kind,size:item.kind==='folder'?-1:item.size,modified:item.modified?new Date(item.modified).toISOString():undefined,id:item.remoteId}));}finally{remote.cancel();}
      }else{const {stdout}=await run(['lsjson',`cloud:${acc.scope==='team'?'/':''}${remotePath}`,'--no-mimetype',...flags]);items=JSON.parse(stdout).map(item=>({path:remotePath?remotePath+'/'+item.Name:item.Name,name:item.Name,kind:item.IsDir?'folder':'file',size:item.Size,modified:item.ModTime,id:item.ID}));}
      items=items.filter(item=>item.name!=='.amg-backups'&&!item.name.startsWith('.amg-access-'));for(const item of items)validateRemotePath(item.path);
      const moves=store.observe(id+':'+(acc.scope||'personal'),items);for(const move of moves){invalidateSchedule(acc);for(const job of store.jobs(id))if(contains(move.from,job.remote_path)||contains(job.remote_path,move.from))store.mark(job.id,'needsReview');}
      for(const item of items)if(item.id&&acc.settings.rules[item.path])acc.settings.rules[item.path].itemId=item.id;
      return items;
    };return /^type\s*=\s*dropbox$/m.test(acc.config)?listing([]):withConfig(acc,listing);
  });
  register('chooseRoot',async id=>{
    const acc=account(id);if(acc.native?.enabled)throw new Error('err.nativeExclusive');await ensureAccountRoot(acc);const result=await dialog.showOpenDialog(window,{title:t('chooseFolder'),message:t('localOnlyWarning'),properties:['openDirectory','createDirectory']});
    if(!result.canceled){const root=await realpath(result.filePaths[0]);if(process.platform==='win32'){const previousRoot=acc.settings.localRoot;acc.settings.localRoot=root;try{return await activateNativeRoot(acc,root);}catch(error){if(!acc.native?.enabled)acc.settings.localRoot=previousRoot;throw error;}}if(process.platform==='win32'&&await providers.isManagedRoot(root))throw new Error('err.link');for(const other of vault.accounts)for(const candidate of [other.id!==id?other.settings.localRoot:null,other.native?.root].filter(Boolean)){const a=root.toLocaleLowerCase(),b=candidate.toLocaleLowerCase();if(a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep))throw new Error('err.overlap');}if(store.jobs(id).length&&root!==acc.settings.localRoot)throw new Error('err.overlap');acc.settings.localRoot=root;invalidateSchedule(acc);watchClassic(acc);await persist();}return publicState();
  });
  register('saveSettings',async(id,input)=>{const acc=account(id);await ensureAccountRoot(acc);const checked=validateSettings(input);if(checked.localRoot!==acc.settings.localRoot)throw new Error('err.pickRoot');for(const [remote,rule]of Object.entries(checked.rules)){const known=store.db.prepare('SELECT item_id FROM items WHERE account_id=? AND path=?').get(id+':'+(acc.scope||'personal'),remote);if(known)rule.itemId=known.item_id;else delete rule.itemId;}if(settingsHash(checked)!==settingsHash(acc.settings))invalidateSchedule(acc);acc.settings=checked;await persist();if(acc.native?.enabled)providers.refresh(acc).catch(()=>{});return publicState();});
  register('preview',async(id,options)=>{const acc=account(id);if(acc.native?.enabled)throw new Error('err.nativeExclusive');return engine.preview(acc,options);});
  register('execute',async(id,token,confirmed)=>{const acc=account(id);if(acc.native?.enabled)throw new Error('err.nativeExclusive');try{const result=await engine.execute(acc,token,confirmed);acc.nextRun=acc.scheduleMinutes?Date.now()+acc.scheduleMinutes*60000:null;dirtyAccounts.delete(id);await persist();return {...result,state:publicState()};}catch(error){acc.paused=true;await persist();throw error;}});
  register('fileEvents',(id,options={})=>{account(id);const {before=0,search='',status='all',limit=100}=options;if(!Number.isSafeInteger(before)||before<0||typeof search!=='string'||search.length>300||!['all','succeeded','failed','skipped'].includes(status)||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('err.settings');return store.fileEvents(id,{before,search,status,limit});},false);
  register('history',id=>{account(id);return store.history(id);},false);
  register('runLog',(id,runId)=>{account(id);const record=store.run(id,runId);if(!record)throw new Error('err.history');return {...record,log:record.log.split('\n').map(line=>messages.en[line]?t(line):line).join('\n')};},false);
  register('openLocal',async id=>{const acc=account(id),root=acc.native?.enabled?acc.native.root:acc.settings.localRoot;if(!root)throw new Error('err.root');if((await lstat(root)).isSymbolicLink())throw new Error('err.link');const error=await shell.openPath(root);if(error)throw new Error('err.operation');});
  register('setSchedule',async(id,minutes,paused=false)=>{const acc=account(id);if(acc.native?.enabled)throw new Error('err.nativeExclusive');if(![0,5,15,30,60].includes(minutes)||typeof paused!=='boolean')throw new Error('err.settings');if(minutes){const planned=makePlan(acc.settings),jobs=store.jobs(id);if(!planned.jobs.length||planned.jobs.some(p=>!jobs.some(j=>j.remote_path===p.path&&j.initialized&&j.status==='idle')))throw new Error('err.schedule');}acc.scheduleMinutes=minutes;acc.paused=paused;acc.nextRun=minutes?Date.now()+minutes*60000:null;await persist();return publicState();});
  register('cancel',id=>{if(id!==undefined){account(id);providers.cancelAccount(id);if(engine.activity?.accountId===id){engine.cancel();activeChild?.kill();}return true;}maintenanceRemote?.cancel();providers.cancel();engine.cancel();activeChild?.kill();return true;},false);
  await persist();await commitProfile({dataDir,version:app.getVersion(),upgrade:profileUpgrade});
  scheduler=setInterval(()=>{if(quitting||tasks.pending||engine.activity||vault.preferences.pauseSync)return;const acc=vault.accounts.find(a=>!a.native?.enabled&&a.scheduleMinutes&&!a.paused&&a.nextRun&&a.nextRun<=Date.now());if(!acc)return;enqueue(async()=>{try{const plan=await engine.preview(acc);if(plan.jobs.some(j=>j.initialization))throw new Error('err.schedule');await engine.execute(acc,plan.token,true);dirtyAccounts.delete(acc.id);acc.nextRun=Date.now()+acc.scheduleMinutes*60000;}catch{acc.paused=true;notify(t('schedulePausedNotice',{name:acc.name}));desktop?.update();}finally{await persist();}}).catch(()=>{});},15000);
}
async function createWindow(){
  Menu.setApplicationMenu(process.platform==='darwin'?Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'},{role:'windowMenu'}]):null);session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  window=new BrowserWindow({title:'AMG rclone UI',width:1240,height:800,minWidth:980,minHeight:650,backgroundColor:'#101217',icon:desktop?.icon,show:false,webPreferences:{preload:path.join(here,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});window.once('ready-to-show',()=>{if(!vault.preferences.startMinimized)window.show();});await window.loadURL(entry);
}
if(primary)app.whenReady().then(async()=>{if(profileMigrationError)throw profileMigrationError;await initialize();await createWindow();}).catch(error=>{dialog.showErrorBox('AMG rclone UI',t(messages.en[error.message]?error.message:'err.operation'));app.quit();});
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;clearInterval(scheduler);engine?.cancel();activeChild?.kill();maintenanceRemote?.cancel();providers?.cancel();for(const watcher of watchers.values())watcher.close();Promise.all([tasks.global,...tasks.accounts.values()]).then(async()=>{await providers?.close();await journalMaintenance?.close();await persistQueue;}).finally(()=>{desktop?.stop();store?.close();app.quit();});});
app.on('window-all-closed',()=>{});
app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0&&vault)createWindow();else showWindow();});
