import {open,readFile,writeFile,mkdir,stat,lstat,readdir,rename,unlink,rmdir,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {validateRemotePath} from './policy.mjs';
import {accountRootScope} from './account-root.mjs';
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';

export async function dropboxHash(filename){const file=await open(filename,'r'),aggregate=createHash('sha256');try{const buffer=Buffer.alloc(4*1024*1024);let position=0;while(true){let used=0;while(used<buffer.length){const {bytesRead}=await file.read(buffer,used,buffer.length-used,position+used);if(!bytesRead)break;used+=bytesRead;}if(!used)break;aggregate.update(createHash('sha256').update(buffer.subarray(0,used)).digest());position+=used;if(used<buffer.length)break;}return aggregate.digest('hex');}finally{await file.close();}}
const remotePath=relative=>{validateRemotePath(relative);return relative?'/'+relative:'';};
function entry(metadata){return {remoteId:metadata.id,kind:metadata['.tag']==='folder'?'folder':'file',rev:metadata.rev||'',size:metadata.size||0,modified:metadata.client_modified?Date.parse(metadata.client_modified):0,hash:metadata.content_hash||''};}
// Dropbox reports most endpoint failures as HTTP 409 with an `error_summary`
// such as "path/conflict/file/..", "too_many_write_operations/.." or
// "path/insufficient_space/..". Only an explicit `conflict` is a version
// conflict; an unknown 409 keeps the old, conservative meaning
// (err.nativeConflict: stop and preserve) but is not marked versionConflict.
export function dropboxError(status,summary='',{retryAfter=null,detail=null}={}){
  const text=String(summary||'').slice(0,300);let message,retryable=false;
  if(status===429||/(^|\/)too_many_(write_operations|requests)(\/|$)/.test(text)){message='err.dropboxBusy';retryable=true;}
  else if(status>=500){message='err.nativeNetwork';retryable=true;}
  else if(status===409&&/(^|\/)insufficient_(space|quota)(\/|$)/.test(text))message='err.dropboxFull';
  else if(status===409&&/(^|\/)(disallowed_name|malformed_path)(\/|$)/.test(text))message='err.dropboxName';
  else message=status===409?'err.nativeConflict':'err.nativeNetwork';
  const error=new Error(message);error.httpStatus=status;error.dropboxSummary=text;error.retryable=retryable;
  error.versionConflict=status===409&&/(^|\/)conflict(\/|$)/.test(text);
  error.notFound=status===409&&/^(?:path|path_lookup|from_lookup|lookup)\/not_found/.test(text);
  if(retryable&&Number.isFinite(retryAfter)&&retryAfter>=0)error.retryAfter=Math.min(retryAfter,300);
  if(detail)error.dropboxDetail=detail;
  return error;
}
async function responseError(response){
  let body={};try{body=await response.json();}catch{/* Non-JSON error body. */}
  const header=Number(response.headers.get('retry-after')),retryAfter=Number.isFinite(header)&&header>=0?header:Number(body?.error?.retry_after);
  return dropboxError(response.status,body?.error_summary||'',{retryAfter:Number.isFinite(retryAfter)?retryAfter:null,detail:body?.error||null});
}
export const RETRY_ATTEMPTS=5;
// Delay before attempt n+1: the server's Retry-After, otherwise 1, 2, 4, 8 s (max 60 s)
// with +-50% jitter so several computers on one account do not retry in lockstep.
export function retryDelay(error,attempt,random=Math.random){
  if(Number.isFinite(error.retryAfter))return error.retryAfter*1000;
  return Math.round(Math.min(60000,1000*2**(attempt-1))*(0.5+random()));
}
function sleepFor(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(new Error('err.canceled'));const onAbort=()=>{clearTimeout(timer);reject(new Error('err.canceled'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);signal?.addEventListener('abort',onAbort,{once:true});});}
const transientNetwork=(error,signal)=>!signal?.aborted&&(error?.name==='TypeError'||error?.name==='TimeoutError');
export const headerJson=value=>JSON.stringify(value).replace(/[\u007f-￿]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
export class DropboxTransport {
  constructor({auth,scope='personal',sleep=sleepFor,random=Math.random}){this.auth=auth;this.scope=scope;this.profile=null;this.abort=new AbortController();this.sleep=sleep;this.random=random;}
  cancel(){this.abort.abort();}
  // Runs `attempt` until it succeeds, a non-retryable error occurs, the operation is
  // cancelled or RETRY_ATTEMPTS is reached. `attempt` must rebuild its request body.
  async retrying(signal,attempt,onRetry){
    for(let n=1;;n++){
      try{return await attempt(n);}
      catch(caught){
        let error=caught;if(transientNetwork(caught,signal))error=Object.assign(new Error('err.nativeNetwork'),{retryable:true,cause:caught});
        if(signal?.aborted||!error.retryable||n>=RETRY_ATTEMPTS)throw error;
        onRetry?.(error,n);await this.sleep(retryDelay(error,n,this.random),signal);
      }
    }
  }
  async send(url,options,signal){const response=await fetch(url,{...options,signal});if(!response.ok)throw await responseError(response);return response;}
  async accountProfile(token,signal=this.abort.signal){signal.throwIfAborted();if(!this.profile){const response=await this.retrying(signal,async()=>this.send('https://api.dropboxapi.com/2/users/get_current_account',{method:'POST',headers:{Authorization:'Bearer '+(token||await this.auth())}},AbortSignal.any([signal,AbortSignal.timeout(30000)])));this.profile=await response.json();}signal.throwIfAborted();accountRootScope(this.profile);return this.profile;}
  async accountScope(){return accountRootScope(await this.accountProfile());}
  async headers(signal=this.abort.signal){signal.throwIfAborted();const token=await this.auth(),profile=await this.accountProfile(token,signal);signal.throwIfAborted();const namespace=this.scope==='team'?profile.root_info.root_namespace_id:profile.root_info.home_namespace_id;return {Authorization:'Bearer '+token,'Dropbox-API-Path-Root':JSON.stringify({'.tag':'namespace_id',namespace_id:namespace})};}
  async request(endpoint,body,{signal}={}){const outer=AbortSignal.any([this.abort.signal,...(signal?[signal]:[])]);const response=await this.retrying(outer,async()=>{const requestSignal=AbortSignal.any([outer,AbortSignal.timeout(30000)]);return this.send('https://api.dropboxapi.com/2/'+endpoint,{method:'POST',headers:{...await this.headers(requestSignal),'Content-Type':'application/json'},body:JSON.stringify(body)},requestSignal);});return response.json();}
  async metadata(relative,options){return entry(await this.request('files/get_metadata',{path:remotePath(relative)},options));}
  async *listPages(relative,recursive=true,{signal,onProgress}={}){
    const listingSignal=AbortSignal.any([this.abort.signal,...(signal?[signal]:[])]);let count=0;
    let response=await this.request('files/list_folder',{path:remotePath(relative),recursive,include_deleted:false,include_mounted_folders:true},{signal:listingSignal});
    while(true){
      listingSignal.throwIfAborted();const page=[];
      for(const item of response.entries){
        if(!['folder','file'].includes(item['.tag']))continue;
        page.push({path:item.path_display.replace(/^\//,''),...entry(item)});
        if(page.length%1024===0){await yieldToEventLoop();listingSignal.throwIfAborted();}
      }
      count+=page.length;onProgress?.(count);yield page;
      // Release each API response before fetching the next page, and let UI/cancel IPC run.
      const more=response.has_more,cursor=response.cursor;response=null;
      await yieldToEventLoop();listingSignal.throwIfAborted();if(!more)break;
      response=await this.request('files/list_folder/continue',{cursor},{signal:listingSignal});
    }
  }
  async list(relative,recursive=true,options={}){const items=[];for await(const page of this.listPages(relative,recursive,options))for(const item of page)items.push(item);return items;}
  async download(item,{offset,length,signal}){const outer=AbortSignal.any([signal,this.abort.signal]);const response=await this.retrying(outer,async()=>{const headers=await this.headers(outer);headers['Dropbox-API-Arg']=headerJson({path:'rev:'+item.rev});headers.Range=`bytes=${offset}-${offset+length-1}`;return this.send('https://content.dropboxapi.com/2/files/download',{method:'GET',headers},outer);});if(response.status!==206&&(offset!==0||length!==item.size))throw new Error('err.nativeNetwork');const result=JSON.parse(response.headers.get('dropbox-api-result')||'{}');if(result.rev!==item.rev)throw new Error('err.nativeConflict');return response.body;}
  async upload(relative,filename,previous,options={}){
    const operationSignal=AbortSignal.any([options.signal||new AbortController().signal,this.abort.signal]);const info=await stat(filename),size=info.size,expected=previous?.rev;let retried=false;const onRetry=()=>{retried=true;};
    const commit={path:remotePath(relative),mode:expected?{'.tag':'update',update:expected}:{'.tag':'add'},autorename:false,mute:true,strict_conflict:true,client_modified:new Date(info.mtimeMs).toISOString().replace(/\.\d{3}Z$/,'Z')};
    const content=(endpoint,arg,body,timeout)=>this.retrying(operationSignal,async()=>{const signal=AbortSignal.any([operationSignal,AbortSignal.timeout(timeout)]);return this.send('https://content.dropboxapi.com/2/files/'+endpoint,{method:'POST',headers:{...await this.headers(signal),'Content-Type':'application/octet-stream','Dropbox-API-Arg':headerJson(arg)},body:body(),...(body.stream?{duplex:'half'}:{})},signal);},onRetry);
    try{
      if(size<=140*1024*1024){const body=()=>createReadStream(filename);body.stream=true;return entry(await (await content('upload',commit,body,3600000)).json());}
      const file=await open(filename,'r');try{let offset=0,session;
        while(offset<size){const amount=Math.min(8*1024*1024,size-offset),buffer=Buffer.alloc(amount);const {bytesRead}=await file.read(buffer,0,amount,offset);if(bytesRead!==amount)throw new Error('err.nativeConflict');
          if(!session){session=(await (await content('upload_session/start',{close:false},()=>buffer,300000)).json()).session_id;}
          else{try{await content('upload_session/append_v2',{cursor:{session_id:session,offset},close:false},()=>buffer,300000);}
            // A retried append whose first attempt reached Dropbox reports the offset it already has.
            catch(error){if(error.dropboxDetail?.['.tag']!=='incorrect_offset'||error.dropboxDetail.correct_offset!==offset+amount)throw error;}}
          offset+=amount;
        }
        return entry(await (await content('upload_session/finish',{cursor:{session_id:session,offset},commit},()=>Buffer.alloc(0),300000)).json());
      }finally{await file.close();}
    }catch(error){
      // A retried commit can fail as a conflict only because its first attempt already
      // succeeded and the response was lost. Accept it when Dropbox holds exactly our bytes.
      if(retried&&error.versionConflict){const current=await this.metadata(relative,{signal:operationSignal}).catch(()=>null);if(current?.kind==='file'&&current.hash&&current.hash===await dropboxHash(filename))return current;}
      throw error;
    }
  }
  async createFolder(relative){return entry((await this.request('files/create_folder_v2',{path:remotePath(relative),autorename:false})).metadata);}
  async remove(item){await this.request('files/delete_v2',{path:'id:'+item.remoteId.replace(/^id:/,''),...(item.rev?{parent_rev:item.rev}:{})});}
  async move(item,target){return entry((await this.request('files/move_v2',{from_path:'id:'+item.remoteId.replace(/^id:/,''),to_path:remotePath(target),autorename:false,allow_shared_folder:false})).metadata);}
}

// Local-only adapter used by automated tests; production accounts use DropboxTransport.
export class LocalTransport {
  constructor(root){this.root=root;}
  local(relative){validateRemotePath(relative);return path.join(this.root,...relative.split('/'));}
  async metadata(relative){const filename=this.local(relative),info=await lstat(filename);if(info.isSymbolicLink())throw new Error('err.link');return {remoteId:String(info.dev)+':'+String(info.ino),kind:info.isDirectory()?'folder':'file',rev:info.isDirectory()?'':await dropboxHash(filename),size:info.isDirectory()?0:info.size,modified:info.isDirectory()?0:info.mtimeMs,hash:info.isDirectory()?'':await dropboxHash(filename)};}
  async list(relative,_recursive=true,{signal,onProgress}={}){const items=[];const scan=async current=>{signal?.throwIfAborted();for(const dirent of await readdir(this.local(current),{withFileTypes:true})){signal?.throwIfAborted();if(dirent.isSymbolicLink())throw new Error('err.link');const child=current?current+'/'+dirent.name:dirent.name;items.push({path:child,...await this.metadata(child)});onProgress?.(items.length);if(dirent.isDirectory())await scan(child);}};await scan(relative);signal?.throwIfAborted();return items;}
  async find(item){const all=await this.list('');const found=all.find(i=>i.remoteId===item.remoteId);if(!found)throw Object.assign(new Error('err.nativeConflict'),{notFound:true});return found;}
  async download(item,{offset,length,signal}){const current=await this.metadata(item.path);if(current.rev!==item.rev)throw new Error('err.nativeConflict');return createReadStream(this.local(item.path),{start:offset,end:offset+length-1,signal});}
  async upload(relative,filename,previous){const current=await this.metadata(relative).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if((previous&&current?.rev!==previous.rev)||(!previous&&current))throw new Error('err.nativeConflict');await mkdir(path.dirname(this.local(relative)),{recursive:true});await writeFile(this.local(relative),await readFile(filename));return this.metadata(relative);}
  async createFolder(relative){await mkdir(this.local(relative));return this.metadata(relative);}
  async remove(item){const current=await this.find(item);if(item.rev&&current.rev!==item.rev)throw new Error('err.nativeConflict');if(current.kind==='folder')await rm(this.local(current.path),{recursive:true});else await unlink(this.local(current.path));}
  async move(item,target){const current=await this.find(item);if(item.rev&&current.rev!==item.rev)throw new Error('err.nativeConflict');await rename(this.local(current.path),this.local(target));return this.metadata(target);}
}
