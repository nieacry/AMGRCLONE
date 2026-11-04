export const JOURNAL_DAYS=30;
export const JOURNAL_MAX_EVENTS=100000;
export const JOURNAL_MAX_RUNS=100;
export const JOURNAL_BATCH=500;
export function journalAccounts(db){return db.prepare("SELECT DISTINCT account_id FROM file_events UNION SELECT DISTINCT account_id FROM runs WHERE status IN ('succeeded','failed')").all().map(r=>r.account_id);}

// Never touches catalog, jobs, credentials or pending-operation tables.
export function pruneJournalBatch(db,accountId,{now=new Date(),limit=JOURNAL_BATCH}={}){
  if(typeof accountId!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>JOURNAL_BATCH)throw Error('Invalid journal maintenance request');
  const cutoff=new Date(now.getTime()-JOURNAL_DAYS*86400000).toISOString();let removed=0;db.exec('BEGIN IMMEDIATE');
  try{
    removed+=db.prepare('DELETE FROM file_events WHERE seq IN (SELECT seq FROM file_events WHERE account_id=? AND time<? ORDER BY time,seq LIMIT ?)').run(accountId,cutoff,limit).changes;
    if(removed<limit){const boundary=db.prepare('SELECT seq FROM file_events WHERE account_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?').get(accountId,JOURNAL_MAX_EVENTS-1);if(boundary)removed+=db.prepare('DELETE FROM file_events WHERE seq IN (SELECT seq FROM file_events WHERE account_id=? AND seq<? ORDER BY seq LIMIT ?)').run(accountId,boundary.seq,limit-removed).changes;}
    if(removed<limit)removed+=db.prepare("DELETE FROM runs WHERE rowid IN (SELECT rowid FROM runs WHERE account_id=? AND status IN ('succeeded','failed') AND COALESCE(ended,started)<? ORDER BY COALESCE(ended,started) LIMIT ?)").run(accountId,cutoff,limit-removed).changes;
    if(removed<limit)removed+=db.prepare("DELETE FROM runs WHERE rowid IN (SELECT rowid FROM runs WHERE account_id=? AND status IN ('succeeded','failed') ORDER BY COALESCE(ended,started) DESC,rowid DESC LIMIT ? OFFSET ?)").run(accountId,limit-removed,JOURNAL_MAX_RUNS).changes;
    db.exec('COMMIT');return removed;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
