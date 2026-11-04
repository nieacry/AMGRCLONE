import {app,Menu,Tray,nativeImage} from 'electron';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {trayPng,trayStatus} from './tray-icons.mjs';

export function createDesktop({state,t,show,quit,savePreferences,isolated}){
  const images=new Map(),image=(status,frame=0)=>{const key=status+frame;if(!images.has(key))images.set(key,nativeImage.createFromBuffer(trayPng(status,frame)));return images.get(key);};
  const tray=new Tray(image('idle'));let tick=0,previous='';
  const update=()=>{const current=state(),status=current.trayStatus;tray.setImage(image(status,status==='syncing'?tick++%8:0));const last=Math.max(0,...current.accounts.flatMap(a=>a.native?.enabled?[a.native.lastSync||0]:a.jobs.map(j=>j.lastSuccess?Date.parse(j.lastSuccess):0)));const tip='AMG rclone UI · '+t('tray_'+status)+(last?'\n'+t('lastSync')+': '+new Date(last).toLocaleString(current.language==='en'?'en-GB':'uk-UA'):'');tray.setToolTip(tip.slice(0,250));const key=status+current.language+JSON.stringify(current.preferences)+last;
    if(key!==previous){previous=key;tray.setContextMenu(Menu.buildFromTemplate([{label:t('showWindow'),click:show},{label:t('tray_'+status),enabled:false},{type:'separator'},{label:t('pauseBackground'),type:'checkbox',checked:current.preferences.pauseSync,click:item=>savePreferences({pauseSync:item.checked}).catch(()=>{})},{label:t('autoStart'),type:'checkbox',checked:current.preferences.autoStart,click:item=>savePreferences({autoStart:item.checked}).catch(()=>{})},{label:t('startMinimized'),type:'checkbox',checked:current.preferences.startMinimized,click:item=>savePreferences({startMinimized:item.checked}).catch(()=>{})},{type:'separator'},{label:t('quitApp'),click:quit}]));}
  };
  tray.on('double-click',show);tray.on('click',()=>{if(process.platform!=='darwin')show();});
  const timer=setInterval(update,250);update();
  return {icon:image('idle'),update,stop(){clearInterval(timer);tray.destroy();},applyLoginSettings(preferences){if(isolated)return;if(process.platform==='win32')app.setLoginItemSettings({openAtLogin:preferences.autoStart,path:app.isPackaged&&path.basename(path.dirname(process.execPath))==='app'&&existsSync(path.resolve(path.dirname(process.execPath),'../AMG rclone UI.exe'))?path.resolve(path.dirname(process.execPath),'../AMG rclone UI.exe'):process.execPath,args:app.isPackaged?['--autostart']:[app.getAppPath(),'--autostart']});else if(process.platform==='darwin')app.setLoginItemSettings({openAtLogin:preferences.autoStart});}};
}
export function statusFor(publicAccounts,activity,preferences,dirty){return trayStatus({accounts:publicAccounts,activity,paused:preferences.pauseSync,native:a=>a.native||{status:'idle'},dirty});}
