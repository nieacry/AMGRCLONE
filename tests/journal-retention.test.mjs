import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import path from 'node:path';
import {SyncStore} from '../core/store.mjs';import {JOURNAL_MAX_EVENTS,pruneJournalBatch} from '../core/journal-retention.mjs';import {JournalMaintenance} from '../core/journal-maintenance.mjs';
const now=new Date('2026-11-03T12:00:00Z'),old='2026-09-01T00:00:00Z',recent='2026-11-03T10:00:00Z';
function insertEvents(db,account,count,time,prefix){const insert=db.prepare("INSERT INTO file_events(id,account_id,time,path,kind,action,direction,status) VALUES (?,?,?,?,'file','download','download','succeeded')");db.exec('BEGIN');try{for(let n=0;n<count;n++)insert.run(prefix+n,account,time,`Project/${n}.txt`);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}

test('journal retention keeps the newest 100,000 events per account, removes older than 30 days and preserves sync state',()=>{
  const store=new SyncStore(':memory:');try{
    insertEvents(store.db,'A',6,old,'old-');insertEvents(store.db,'A',JOURNAL_MAX_EVENTS+7,recent,'new-');insertEvents(store.db,'B',3,recent,'other-');store.addFileEvent('A',{id:'boundary',time:'2026-10-04T12:00:00Z',path:'boundary.txt',action:'sync'});
    store.saveNativeItem('A',{key:'keep',path:'Project/data',status:'dirty'});store.saveNativeDeletion('A',{id:'pending',items:[{key:'keep'}]});store.addJob({id:'job',accountId:'A',path:'Project',localPath:'local',marker:'keep'});store.db.prepare("UPDATE jobs SET status='running' WHERE id='job'").run();
    let count=0,passes=0;do{count=pruneJournalBatch(store.db,'A',{now,limit:5});assert.ok(count<=5);passes++;}while(count);
    assert.ok(passes>1);assert.equal(store.db.prepare("SELECT count(*) n FROM file_events WHERE account_id='A'").get().n,JOURNAL_MAX_EVENTS);assert.equal(store.db.prepare("SELECT count(*) n FROM file_events WHERE time=?").get(old).n,0);assert.equal(store.db.prepare("SELECT count(*) n FROM file_events WHERE account_id='B'").get().n,3);assert.ok(store.db.prepare("SELECT id FROM file_events WHERE id='boundary'").get());assert.equal(store.nativeItems('A')[0].status,'dirty');assert.equal(store.nativeDeletions('A')[0].id,'pending');assert.equal(store.job('job').status,'running');
  }finally{store.close();}
});

test('only completed classic logs expire; running and interrupted operations survive regardless of age',()=>{
  const store=new SyncStore(':memory:');try{
    const insert=store.db.prepare("INSERT INTO runs(id,account_id,job_id,remote_path,kind,status,started,ended,log) VALUES (?,'A','job','Project','normal',?,?,?,'keep')");
    for(let n=0;n<105;n++)insert.run('done-'+n,'succeeded',recent,recent);insert.run('expired','failed',old,old);insert.run('active','running',old,null);insert.run('unfinished','interrupted',old,old);
    while(pruneJournalBatch(store.db,'A',{now})){}
    assert.equal(store.db.prepare("SELECT count(*) n FROM runs WHERE status='succeeded'").get().n,100);assert.equal(store.db.prepare("SELECT count(*) n FROM runs WHERE id='expired'").get().n,0);assert.equal(store.db.prepare("SELECT count(*) n FROM runs WHERE id IN ('active','unfinished')").get().n,2);
  }finally{store.close();}
});

test('background worker removes old history without running startup recovery or blocking foreground writes',async()=>{
  const base=path.resolve('.runtime/journal-retention',randomUUID());await mkdir(base,{recursive:true});const filename=path.join(base,'sync.sqlite'),store=new SyncStore(filename),maintenance=new JournalMaintenance(filename);
  try{
    insertEvents(store.db,'A',2100,'2000-01-01T00:00:00Z','worker-');store.addJob({id:'running',accountId:'A',path:'Project',localPath:'local',marker:'keep'});store.db.prepare("UPDATE jobs SET status='running' WHERE id='running'").run();store.saveNativeDeletion('A',{id:'keep-intent'});
    const running=maintenance.runNow();let ticks=0;const timer=setInterval(()=>{ticks++;store.addFileEvent('B',{action:'download',path:'foreground.txt'});},10);try{const result=await running;assert.equal(result.removed,2100);}finally{clearInterval(timer);}
    assert.ok(ticks>1);assert.equal(store.job('running').status,'running');assert.equal(store.nativeDeletions('A')[0].id,'keep-intent');assert.ok(store.fileEvents('B').entries.length);assert.equal(store.fileEvents('A').entries.length,0);
  }finally{await maintenance.close();store.close();}
});
