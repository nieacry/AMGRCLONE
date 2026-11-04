import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const DATABASE_SCHEMA=5;

export class SyncStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    try{
      if(this.db.prepare('PRAGMA user_version').get().user_version>DATABASE_SCHEMA)throw new Error('err.database');
      if(this.db.prepare('PRAGMA page_count').get().page_count===0)this.db.exec('PRAGMA auto_vacuum=INCREMENTAL');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=8388608; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      try{
        this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, remote_path TEXT NOT NULL, local_path TEXT NOT NULL, item_id TEXT, marker TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', generation INTEGER NOT NULL DEFAULT 0, last_success TEXT);
          CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, job_id TEXT NOT NULL, remote_path TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, log TEXT NOT NULL DEFAULT '', backup_remote TEXT, backup_local TEXT);
          CREATE TABLE IF NOT EXISTS items (account_id TEXT NOT NULL, item_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER, modified TEXT, PRIMARY KEY(account_id,item_id));`);
        if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='workdir'))this.db.exec('ALTER TABLE jobs ADD COLUMN workdir TEXT');
        if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='remote_root'))this.db.exec("ALTER TABLE jobs ADD COLUMN remote_root TEXT NOT NULL DEFAULT ''");
        this.db.exec(`CREATE TABLE IF NOT EXISTS native_items(account_id TEXT NOT NULL,item_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account_id,item_key));
          CREATE TABLE IF NOT EXISTS marker_cleanup(account_id TEXT NOT NULL,job_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account_id,job_id));
          CREATE TABLE IF NOT EXISTS native_deletions(account_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account_id,id));
          CREATE TABLE IF NOT EXISTS file_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL,time TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,action TEXT NOT NULL,direction TEXT NOT NULL,status TEXT NOT NULL,size INTEGER,detail TEXT NOT NULL DEFAULT '',target TEXT NOT NULL DEFAULT '');
          CREATE INDEX IF NOT EXISTS file_events_account_seq ON file_events(account_id,seq DESC);
          CREATE INDEX IF NOT EXISTS file_events_account_time ON file_events(account_id,time,seq);
          CREATE INDEX IF NOT EXISTS runs_account_completed ON runs(account_id,COALESCE(ended,started)) WHERE status IN ('succeeded','failed');
          PRAGMA user_version=${DATABASE_SCHEMA};
          UPDATE jobs SET status='needsReview', generation=generation+1 WHERE status='running';
          UPDATE runs SET status='interrupted', ended=datetime('now') WHERE status='running'; COMMIT;`);
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }catch(error){this.db.close();throw error;}
  }
  jobs(accountId) { return this.db.prepare('SELECT * FROM jobs WHERE account_id=?').all(accountId); }
  job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  setWorkdir(id,workdir){this.db.prepare('UPDATE jobs SET workdir=? WHERE id=?').run(workdir,id);}
  addJob(job) {
    this.db.prepare('INSERT OR IGNORE INTO jobs(id,account_id,remote_path,local_path,item_id,marker,remote_root) VALUES (?,?,?,?,?,?,?)').run(job.id,job.accountId,job.path,job.localPath,job.itemId||null,job.marker,job.remoteRoot||'');
    return this.job(job.id);
  }
  mark(id,status,initialized) {
    if (initialized === undefined) this.db.prepare('UPDATE jobs SET status=?,generation=generation+1 WHERE id=?').run(status,id);
    else this.db.prepare('UPDATE jobs SET status=?,initialized=?,generation=generation+1,last_success=? WHERE id=?').run(status,initialized?1:0,new Date().toISOString(),id);
  }
  startRun(accountId,job,kind,backupRemote,backupLocal) {
    const id=randomUUID();
    this.db.prepare('INSERT INTO runs(id,account_id,job_id,remote_path,kind,status,started,backup_remote,backup_local) VALUES (?,?,?,?,?,?,?,?,?)').run(id,accountId,job.id,job.remote_path,kind,'running',new Date().toISOString(),backupRemote,backupLocal);
    this.mark(job.id,'running');return id;
  }
  finishRun(id,status,log) { this.db.prepare('UPDATE runs SET status=?,ended=?,log=? WHERE id=?').run(status,new Date().toISOString(),log.slice(-1000000),id); }
  previewFailure(accountId,job,error){const now=new Date().toISOString();this.db.prepare('INSERT INTO runs(id,account_id,job_id,remote_path,kind,status,started,ended,log) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(),accountId,job.id,job.remote_path,'preview','failed',now,now,(error.safeLog||error.message).slice(-1000000));}
  history(accountId) { return this.db.prepare('SELECT id,job_id,remote_path,kind,status,started,ended,backup_remote,backup_local FROM runs WHERE account_id=? ORDER BY started DESC LIMIT 100').all(accountId); }
  run(accountId,id) { return this.db.prepare('SELECT * FROM runs WHERE account_id=? AND id=?').get(accountId,id); }
  observe(accountId,items) {
    const upsert=this.db.prepare('INSERT INTO items(account_id,item_id,path,kind,size,modified) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,item_id) DO UPDATE SET path=excluded.path,kind=excluded.kind,size=excluded.size,modified=excluded.modified');
    const moves=[];
    this.db.exec('BEGIN');
    try { for(const item of items) if(item.id) {
      const previous=this.db.prepare('SELECT path FROM items WHERE account_id=? AND item_id=?').get(accountId,item.id);
      if(previous&&previous.path!==item.path) moves.push({from:previous.path,to:item.path,id:item.id});
      upsert.run(accountId,item.id,item.path,item.kind,item.size,item.modified||null);
    } this.db.exec('COMMIT'); } catch(error) {this.db.exec('ROLLBACK');throw error;}
    return moves;
  }
  reset(){this.db.exec('BEGIN; DELETE FROM file_events; DELETE FROM native_deletions; DELETE FROM marker_cleanup; DELETE FROM native_items; DELETE FROM runs; DELETE FROM jobs; DELETE FROM items; COMMIT; VACUUM');}
  retireJobs(accountId){this.db.prepare("UPDATE jobs SET status='retired',generation=generation+1 WHERE account_id=? AND status<>'retired'").run(accountId);}
  markerReceipt(accountId,jobId){const row=this.db.prepare('SELECT data FROM marker_cleanup WHERE account_id=? AND job_id=?').get(accountId,jobId);return row?JSON.parse(row.data):null;}
  markerReceipts(accountId){return this.db.prepare('SELECT data FROM marker_cleanup WHERE account_id=?').all(accountId).map(row=>JSON.parse(row.data));}
  saveMarkerReceipt(accountId,jobId,data){this.db.prepare('INSERT INTO marker_cleanup(account_id,job_id,data) VALUES (?,?,?) ON CONFLICT(account_id,job_id) DO UPDATE SET data=excluded.data').run(accountId,jobId,JSON.stringify(data));}
  close() {this.db.close();}
  nativeItems(accountId){return this.db.prepare('SELECT data FROM native_items WHERE account_id=?').all(accountId).map(row=>JSON.parse(row.data));}
  saveNativeItem(accountId,item){this.db.prepare('INSERT INTO native_items(account_id,item_key,data) VALUES (?,?,?) ON CONFLICT(account_id,item_key) DO UPDATE SET data=excluded.data').run(accountId,item.key,JSON.stringify(item));}
  deleteNativeItem(accountId,key){this.db.prepare('DELETE FROM native_items WHERE account_id=? AND item_key=?').run(accountId,key);}
  addFileEvent(accountId,event){const id=event.id||randomUUID();this.db.prepare('INSERT OR IGNORE INTO file_events(id,account_id,time,path,kind,action,direction,status,size,detail,target) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,accountId,event.time||new Date().toISOString(),event.path||'',event.kind||'file',event.action,event.direction||'none',event.status||'succeeded',event.size??null,event.detail||'',event.target||'');return id;}
  fileEvents(accountId,{before=0,search='',status='all',limit=100}={}){const rows=this.db.prepare("SELECT seq,id,time,path,kind,action,direction,status,size,detail,target FROM file_events WHERE account_id=? AND (?=0 OR seq<?) AND (?='' OR instr(lower(path),lower(?))>0 OR instr(lower(target),lower(?))>0) AND (?='all' OR status=?) ORDER BY seq DESC LIMIT ?").all(accountId,before,before,search,search,search,status,status,limit+1);return {entries:rows.slice(0,limit),next:rows.length>limit?rows[limit-1].seq:null};}
  nativeDeletions(accountId){return this.db.prepare('SELECT data FROM native_deletions WHERE account_id=?').all(accountId).map(row=>JSON.parse(row.data));}
  saveNativeDeletion(accountId,operation){this.db.prepare('INSERT INTO native_deletions(account_id,id,data) VALUES (?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET data=excluded.data').run(accountId,operation.id,JSON.stringify(operation));}
  deleteNativeDeletion(accountId,id){this.db.prepare('DELETE FROM native_deletions WHERE account_id=? AND id=?').run(accountId,id);}
  cancelNativeDeletion(accountId,operation,event){this.db.exec('BEGIN');try{this.addFileEvent(accountId,{...event,id:operation.id+':canceled'});this.deleteNativeDeletion(accountId,operation.id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
  finishNativeDeletion(accountId,operation){this.db.exec('BEGIN');try{for(const item of operation.items){this.deleteNativeItem(accountId,item.key);this.addFileEvent(accountId,{id:operation.id+':'+item.key,path:item.path,kind:item.kind,size:item.size,action:operation.action==='recycle'?'recycle':'delete',direction:item.remoteId?'upload':'none'});}this.deleteNativeDeletion(accountId,operation.id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
