import type {Account,Bridge,Item,Plan,Run,State} from './types';
import {makePlan} from '../core/policy.mjs';
const folder=(path:string):Item=>({path,name:path.split('/').at(-1)!,kind:'folder',size:-1});
const file=(path:string,size:number):Item=>({path,name:path.split('/').at(-1)!,kind:'file',size});
const content:Record<string,Item[]>={
  '':[folder('Projects'),folder('Media'),folder('Documents'),folder('Archive'),file('Welcome.pdf',132000)],
  Projects:[folder('Projects/Website'),folder('Projects/Animation'),file('Projects/Brief.pdf',2480000)],
  'Projects/Website':[file('Projects/Website/Concept.fig',18500000),file('Projects/Website/Presentation.pdf',7200000)],
  'Projects/Animation':[file('Projects/Animation/Notes.md',8500)],
  Media:[folder('Media/Video'),folder('Media/Photos'),file('Media/Cover.jpg',6400000)],
  'Media/Video':[file('Media/Video/Edit_v03.mov',2400000000),file('Media/Video/Interview.mp4',856000000)],
  'Media/Photos':[file('Media/Photos/Kyiv.jpg',14800000),file('Media/Photos/Studio.raw',42000000)],
  Documents:[file('Documents/Contract.pdf',340000),file('Documents/Budget.xlsx',128000)],Archive:[folder('Archive/2025')],'Archive/2025':[]
};
const account=(id:string,name:string):Account=>({id,name,scope:'personal',settings:{localRoot:'',rules:{}},jobs:[],scheduleMinutes:0,paused:false,nextRun:null});
const initial:State={accounts:[{...account('demo-personal','Personal Dropbox'),settings:{localRoot:'D:\\AMG Dropbox\\Personal',rules:{Projects:{selected:true,mode:'local',kind:'folder'},Media:{selected:true,mode:'online',kind:'folder'},Documents:{selected:true,mode:'local',kind:'folder'}}}},account('demo-work','Studio Dropbox')],rcloneVersion:'rclone · demo',platform:'preview',nativeProvider:false,language:'uk',activity:null,version:__APP_VERSION__,preferences:{autoStart:false,startMinimized:false,pauseSync:false},drives:[],trayStatus:'idle'};
let state=structuredClone(initial);const runs:Run[]=[];let current:Plan|undefined;
try{const saved=localStorage.getItem('amg-demo-v2');if(saved)state=JSON.parse(saved);}catch{/* Fresh demo. */}
state={...initial,...state,preferences:{...initial.preferences,...state.preferences},drives:state.drives||[],version:__APP_VERSION__};
const save=()=>{localStorage.setItem('amg-demo-v2',JSON.stringify(state));return structuredClone(state);};
export const demo:Bridge={
  resetApp:async()=>{state=structuredClone(initial);return save();},cleanupLegacy:async()=>save(),state:async()=>structuredClone(state),setPreferences:async input=>{state.preferences={...state.preferences,...input};return save();},quit:async()=>true,enableNativeRoot:async()=>{throw new Error('err.nativeRequired');},chooseNativeRoot:async()=>{throw new Error('err.nativeRequired');},refreshNative:async()=>save(),nativeItem:async()=>null,nativeItems:async()=>({}),nativeAvailability:async()=>save(),chooseDriveFolder:async()=>null,driveLetters:async()=>({drives:[]}),createDrive:async()=>{throw new Error('err.nativeRequired');},removeDrive:async()=>{throw new Error('err.driveOwnership');},setLanguage:async language=>{state.language=language;return save();},chooseRclone:async()=>structuredClone(state),
  setScope:async(id,scope)=>{const acc=state.accounts.find(a=>a.id===id)!;acc.scope=scope;acc.settings.rules={};return save();},
  login:async name=>{state.accounts.push(account(crypto.randomUUID(),name));return save();},removeAccount:async id=>{state.accounts=state.accounts.filter(a=>a.id!==id);return save();},
  list:async(_id,path)=>structuredClone(content[path]||[]),chooseRoot:async id=>{state.accounts.find(a=>a.id===id)!.settings.localRoot='D:\\AMG Dropbox\\Demo';return save();},
  saveSettings:async(id,settings)=>{state.accounts.find(a=>a.id===id)!.settings=structuredClone(settings);current=undefined;return save();},
  preview:async(id,options)=>{
    const acc=state.accounts.find(a=>a.id===id)!,policy=makePlan(acc.settings);
    current={token:crypto.randomUUID(),expires:Date.now()+600000,strategy:options?.strategy||'remote',deferred:policy.deferred,log:'DEMO\n\nProjects → local folder\nDocuments → local folder\n\nNo real files are transferred.',jobs:policy.jobs.map(j=>({id:j.path,path:j.path,localPath:acc.settings.localRoot+'\\'+j.path,initialization:!acc.jobs.some(existing=>existing.path===j.path),recovery:false,backupRemote:'cloud:.amg-backups/demo',backupLocal:acc.settings.localRoot+'\\.amg-backups'}))};return structuredClone(current);
  },
  execute:async(id,token,confirmed)=>{
    if(!current||token!==current.token||!confirmed)throw new Error('err.plan');
    const acc=state.accounts.find(a=>a.id===id)!;
    for(const job of current.jobs){acc.jobs=acc.jobs.filter(j=>j.path!==job.path);acc.jobs.push({path:job.path,status:'idle',lastSuccess:new Date().toISOString()});runs.unshift({account_id:id,id:crypto.randomUUID(),job_id:job.id,remote_path:job.path,kind:job.initialization?'initial':'incremental',status:'succeeded',started:new Date().toISOString(),ended:new Date().toISOString(),backup_remote:job.backupRemote,backup_local:job.backupLocal,log:'DEMO · No files transferred.'});}
    const completed=current.jobs.length;current=undefined;return {completed,state:save()};
  },
  fileEvents:async()=>({entries:[],next:null}),history:async id=>structuredClone(runs.filter(r=>r.account_id===id)),runLog:async(_id,runId)=>structuredClone(runs.find(r=>r.id===runId)!),openLocal:async()=>{},
  setSchedule:async(id,minutes,paused)=>{const acc=state.accounts.find(a=>a.id===id)!;if(minutes&&!acc.jobs.length)throw new Error('err.schedule');acc.scheduleMinutes=minutes;acc.paused=paused;acc.nextRun=minutes?Date.now()+minutes*60000:null;return save();},cancel:async()=>true
};
