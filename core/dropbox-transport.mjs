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
function apiError(status){const error=new Error(status===409?'err.nativeConflict':'err.nativeNetwork');error.httpStatus=status;return error;}
export const headerJson=value=>JSON.stringify(value).replace(/[\u007f-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
export class DropboxTransport {
  constructor({auth,scope='personal'}){this.auth=auth;this.scope=scope;this.profile=null;this.abort=new AbortController();}
  cancel(){this.abort.abort();}
  async accountProfile(token,signal=this.abort.signal){signal.throwIfAborted();if(!this.profile){const response=await fetch('https://api.dropboxapi.com/2/users/get_current_account',{method:'POST',headers:{Authorization:'Bearer '+(token||await this.auth())},signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});if(!response.ok)throw apiError(response.status);this.profile=await response.json();}signal.throwIfAborted();accountRootScope(this.profile);return this.profile;}
  async accountScope(){return accountRootScope(await this.accountProfile());}
  async headers(signal=this.abort.signal){signal.throwIfAborted();const token=await this.auth(),profile=await this.accountProfile(token,signal);signal.throwIfAborted();const namespace=this.scope==='team'?profile.root_info.root_namespace_id:profile.root_info.home_namespace_id;return {Authorization:'Bearer '+token,'Dropbox-API-Path-Root':JSON.stringify({'.tag':'namespace_id',namespace_id:namespace})};}
  async request(endpoint,body,{signal}={}){const requestSignal=AbortSignal.any([this.abort.signal,...(signal?[signal]:[]),AbortSignal.timeout(30000)]);const response=await fetch('https://api.dropboxapi.com/2/'+endpoint,{method:'POST',headers:{...await this.headers(requestSignal),'Content-Type':'application/json'},body:JSON.stringify(body),signal:requestSignal});if(!response.ok){const error=apiError(response.status);if(response.status===409){const detail=await response.json().catch(()=>({}));error.notFound=/^path(?:_lookup)?\/not_found/.test(String(detail.error_summary||''));}throw error;}return response.json();}
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
  async download(item,{offset,length,signal}){const headers=await this.headers();headers['Dropbox-API-Arg']=headerJson({path:'rev:'+item.rev});headers.Range=`bytes=${offset}-${offset+length-1}`;const response=await fetch('https://content.dropboxapi.com/2/files/download',{method:'GET',headers,signal:AbortSignal.any([signal,this.abort.signal])});if(!response.ok)throw apiError(response.status);if(response.status!==206&&(offset!==0||length!==item.size))throw new Error('err.nativeNetwork');const result=JSON.parse(response.headers.get('dropbox-api-result')||'{}');if(result.rev!==item.rev)throw new Error('err.nativeConflict');return response.body;}
  async upload(relative,filename,previous,options={}){const operationSignal=options.signal||new AbortController().signal;const size=(await stat(filename)).size,expected=previous?.rev;const headers=await this.headers();
    const commit={path:remotePath(relative),mode:expected?{'.tag':'update',update:expected}:{'.tag':'add'},autorename:false,mute:true,strict_conflict:true,client_modified:new Date((await stat(filename)).mtimeMs).toISOString().replace(/\.\d{3}Z$/,'Z')};
    if(size<=140*1024*1024){const response=await fetch('https://content.dropboxapi.com/2/files/upload',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Dropbox-API-Arg':headerJson(commit)},body:createReadStream(filename),duplex:'half',signal:AbortSignal.any([operationSignal,this.abort.signal,AbortSignal.timeout(3600000)])});if(!response.ok)throw apiError(response.status);return entry(await response.json());}
    const file=await open(filename,'r');try{let offset=0,session;
      while(offset<size){const amount=Math.min(8*1024*1024,size-offset),buffer=Buffer.alloc(amount);const {bytesRead}=await file.read(buffer,0,amount,offset);if(bytesRead!==amount)throw new Error('err.nativeConflict');let endpoint,arg;
        if(!session){endpoint='upload_session/start';arg={close:false};}else{endpoint='upload_session/append_v2';arg={cursor:{session_id:session,offset},close:false};}
        const response=await fetch('https://content.dropboxapi.com/2/files/'+endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Dropbox-API-Arg':headerJson(arg)},body:buffer,signal:AbortSignal.any([operationSignal,this.abort.signal,AbortSignal.timeout(300000)])});if(!response.ok)throw apiError(response.status);if(!session)session=(await response.json()).session_id;offset+=amount;
      }
      const response=await fetch('https://content.dropboxapi.com/2/files/upload_session/finish',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Dropbox-API-Arg':headerJson({cursor:{session_id:session,offset},commit})},body:Buffer.alloc(0),signal:AbortSignal.any([operationSignal,this.abort.signal,AbortSignal.timeout(300000)])});if(!response.ok)throw apiError(response.status);return entry(await response.json());
    }finally{await file.close();}
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
