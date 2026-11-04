import {validateLocalMapping} from './policy.mjs';

// Only actual, successful file operations are history; previews and stats are not transfers.
export function rcloneFileEvent(event,branch){
  if(typeof event.object!=='string'||!event.object||typeof event.msg!=='string')return null;
  const relative=event.object.replaceAll('\\','/');try{validateLocalMapping(relative,process.platform);}catch{return null;}
  if(relative.split('/').some(p=>p==='.amg-backups'||p.startsWith('.amg-access-')))return null;
  const failed=event.level==='error',action=failed?'sync':/^Copied\b/.test(event.msg)?'copy':/^Moved\b/.test(event.msg)?'move':/^Deleted\b/.test(event.msg)?'delete':null;
  if(!action||/skipped|dry.run/i.test(event.msg))return null;
  const time=typeof event.time==='string'&&Number.isFinite(Date.parse(event.time))?event.time:undefined;
  return {path:branch?branch+'/'+relative:relative,kind:'file',action,direction:'both',status:failed?'failed':'succeeded',size:Number.isSafeInteger(event.size)&&event.size>=0?event.size:null,time,detail:failed?'err.operation':''};
}
