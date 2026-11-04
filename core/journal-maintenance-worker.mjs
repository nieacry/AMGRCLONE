import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {journalAccounts,pruneJournalBatch} from './journal-retention.mjs';
// A bare connection: SyncStore startup recovery must never run in this worker.
const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA busy_timeout=50; PRAGMA journal_size_limit=8388608');let running=false;
const busy=error=>[5,6].includes(error.errcode)||/busy|locked/i.test(error.message);
parentPort.on('message',async message=>{
  if(message!=='run'||running)return;running=true;let removed=0;
  try{
    let again=true;while(again){again=false;for(const account of journalAccounts(db)){
      try{const count=pruneJournalBatch(db,account);removed+=count;if(count)again=true;}catch(error){if(!busy(error))throw error;again=true;}
      await delay(20);
    }}
    if(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum===2)try{db.exec('PRAGMA incremental_vacuum(64)');}catch(error){if(!busy(error))throw error;}
    try{db.exec('PRAGMA wal_checkpoint(PASSIVE)');}catch(error){if(!busy(error))throw error;}
    parentPort.postMessage({type:'done',removed});
  }catch{parentPort.postMessage({type:'failed'});}finally{running=false;}
});
