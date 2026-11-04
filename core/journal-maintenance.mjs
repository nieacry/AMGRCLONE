import {Worker} from 'node:worker_threads';
export class JournalMaintenance {
  constructor(filename){this.filename=filename;this.worker=null;this.pending=null;}
  start(){if(this.timer)return;this.initial=setTimeout(()=>this.runNow().catch(()=>{}),10000);this.timer=setInterval(()=>this.runNow().catch(()=>{}),60000);this.initial.unref();this.timer.unref();}
  runNow(){
    if(this.pending)return this.pending.promise;
    if(!this.worker){
      const worker=new Worker(new URL('./journal-maintenance-worker.mjs',import.meta.url),{workerData:{filename:this.filename}});this.worker=worker;
      const finish=(error,result)=>{const pending=this.pending;this.pending=null;if(pending)error?pending.reject(error):pending.resolve(result);};
      worker.on('message',message=>{if(this.worker!==worker)return;worker.unref();if(message.type==='done')finish(null,message);else finish(Error('Journal maintenance failed'));});
      worker.on('error',error=>{if(this.worker===worker)finish(error);});worker.on('exit',()=>{if(this.worker===worker){this.worker=null;finish(Error('Journal maintenance stopped'));}});
    }
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});this.pending={promise,resolve,reject};this.worker.ref();this.worker.postMessage('run');return promise;
  }
  async close(){clearTimeout(this.initial);clearInterval(this.timer);this.initial=null;this.timer=null;const pending=this.pending;this.pending=null;pending?.reject(Error('Journal maintenance stopped'));const worker=this.worker;this.worker=null;if(worker)await worker.terminate();}
}
