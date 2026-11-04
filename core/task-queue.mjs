// Roadmap 3.6: one queue per account plus one global queue.
//  - Tasks of the same account run one at a time, in order.
//  - Tasks of different accounts run at the same time.
//  - A global task (adding or removing accounts, reset, drives, language...) waits for every
//    task queued before it, and every task queued after it waits for it.
// Failures never block the queue: each task gets its own result.
export class TaskQueues{
  constructor(){this.global=Promise.resolve();this.accounts=new Map();this.pending=0;}
  run(task,accountId){
    this.pending++;
    const before=accountId?[this.global,this.accounts.get(accountId)||Promise.resolve()]:[this.global,...this.accounts.values()];
    const result=Promise.all(before).then(()=>task()).finally(()=>{this.pending--;});
    const settled=result.then(()=>{},()=>{});
    if(accountId)this.accounts.set(accountId,settled);else{this.global=settled;this.accounts.clear();}
    return result;
  }
  forget(accountId){this.accounts.delete(accountId);}
}
