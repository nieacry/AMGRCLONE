import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TaskQueues} from '../core/task-queue.mjs';

const gate=()=>{let open;const promise=new Promise(resolve=>open=resolve);return {promise,open};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('two accounts work at the same time; one account keeps its order',async()=>{
  const q=new TaskQueues(),log=[],slow=gate();
  const a1=q.run(async()=>{log.push('a1 start');await slow.promise;log.push('a1 end');},'A');
  const a2=q.run(async()=>{log.push('a2');},'A');
  const b1=q.run(async()=>{log.push('b1');},'B');
  await b1;assert.deepEqual(log,['a1 start','b1'],'B did not wait for A');
  slow.open();await a1;await a2;assert.deepEqual(log,['a1 start','b1','a1 end','a2']);
  assert.equal(q.pending,0);
});

test('a global task waits for everything queued before it, and blocks what comes after',async()=>{
  const q=new TaskQueues(),log=[],slowA=gate(),slowGlobal=gate();
  q.run(async()=>{await slowA.promise;log.push('A');},'A');
  const global=q.run(async()=>{log.push('global start');await slowGlobal.promise;log.push('global end');});
  const b=q.run(async()=>{log.push('B');},'B');
  await tick();assert.deepEqual(log,[],'global waits for A; B waits for global');
  slowA.open();await tick();await tick();assert.deepEqual(log,['A','global start']);
  slowGlobal.open();await global;await b;assert.deepEqual(log,['A','global start','global end','B']);
});

test('a failed task does not block the queue and reports its own error',async()=>{
  const q=new TaskQueues();
  await assert.rejects(q.run(async()=>{throw new Error('boom');},'A'),/boom/);
  assert.equal(await q.run(async()=>'next','A'),'next');
  await assert.rejects(q.run(async()=>{throw new Error('global boom');}),/global boom/);
  assert.equal(await q.run(async()=>'after','B'),'after');assert.equal(q.pending,0);
});
