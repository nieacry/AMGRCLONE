import {translate} from './i18n.mjs';
import {hostname,userInfo} from 'node:os';
import {computerName} from './conflicts.mjs';

// Deliberate allowlist: never serialize the vault, configs, cookies, file contents or raw process logs.
// Roadmap 3.4: several computers share one Dropbox account, so a report says which computer it came from.
export function currentDevice(){let user='';try{user=userInfo().username;}catch{/* No user database entry. */}return {computer:computerName(hostname()),user};}
export function diagnosticReport({state,store,arch,osVersion,now=new Date(),device=currentDevice()}){
  return {
    format:'amg-rclone-diagnostics-v1',created:now.toISOString(),
    application:{version:state.version,platform:state.platform,arch,osVersion,rclone:state.rcloneVersion},
    device,
    note:'Contains the computer and Windows user name, account names and paths from recent errors. Does not include sign-in credentials, tokens, cookies, file contents or the full Dropbox catalog.',
    accounts:state.accounts.map(account=>{
      const native=account.native||{};
      return {name:account.name,type:account.accountType||account.scope,
        provider:{enabled:!!native.enabled,status:native.status||null,error:native.error||null,detail:native.detail||'',lastSync:native.lastSync||null,progress:native.progress||null,canChangeRoot:!!native.canChangeRoot,registered:!!native.registered,initializationFailed:!!native.initializationFailed,skippedFiles:native.skippedFiles||0,catalogItems:native.catalogItems??null,pendingDeletions:native.pendingDeletions??null,metrics:native.metrics||null},
        recentSkipped:store.fileEvents(account.id,{status:'skipped',limit:100}).entries.map(event=>({time:event.time,path:event.path,detail:event.detail,explanation:translate('en',event.detail)})),
        recentErrors:store.fileEvents(account.id,{status:'failed',limit:100}).entries.map(event=>({
          time:event.time,path:event.path,action:event.action,detail:event.detail,
          explanation:(event.detail||'').split(' · ').map(part=>part.startsWith('err.')?translate('en',part):part).join(' · ')
        }))};
    })
  };
}
