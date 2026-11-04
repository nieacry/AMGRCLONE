import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

export const retryableNativeError=error=>['0x80070322','0x80070020','0x80070021'].includes(error.nativeCode?.toLowerCase());

export class NativeHost extends EventEmitter {
  constructor(binary){super();this.pending=new Map();this.child=spawn(binary,[],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});this.closed=false;this.closing=false;this.child.stdin.on('error',()=>{});this.child.stderr.on('data',()=>{});
    createInterface({input:this.child.stdout}).on('line',line=>{try{const message=JSON.parse(line);if(message.event){this.emit('event',message);return;}const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);if(message.ok)pending.resolve(message.data);else{const error=new Error(message.error?.toLowerCase()==='0x80070186'?'err.nativeRootRegistration':message.error?.toLowerCase()==='0x8007017a'?'err.nativeAlreadyConnected':'err.native');error.nativeCode=message.error;error.nativeStage=message.stage;error.nativeCommand=pending.command;error.nativePath=pending.path;pending.reject(error);}}catch{/* Invalid IPC cannot issue OS commands. */}});
    const failed=()=>{this.closed=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('err.nativeStopped'));}this.pending.clear();this.emit('stopped');};this.child.once('error',failed);this.child.once('exit',failed);
  }
  request(command,values={},timeout=30000){if(this.closed||this.closing)return Promise.reject(new Error('err.nativeStopped'));const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('err.timeout'));},timeout);this.pending.set(id,{resolve,reject,timer,command,path:values.path});this.child.stdin.write(JSON.stringify({...values,command,id})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('err.nativeStopped'));}});});}
  async close(){if(this.closed)return;this.closing=true;const exit=new Promise(resolve=>this.child.once('exit',resolve));this.child.stdin.end(JSON.stringify({command:'shutdown'})+'\n');const timer=setTimeout(()=>this.child.kill(),10000);await exit;clearTimeout(timer);}
}
