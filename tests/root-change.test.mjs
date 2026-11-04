import {test} from 'node:test';import assert from 'node:assert/strict';import {NativeProviders} from '../core/native-provider.mjs';
test('a pending deletion prevents direct root replacement even if no catalog items remain',async()=>{
  let released=0;const providers=new NativeProviders({store:{}}),acc={id:'mix',native:{enabled:true}},ctx={failed:true,items:new Map(),deletions:new Map([['pending',{}]]),fetches:new Map(),uploads:new Set(),host:{request:async()=>{released++;}}};providers.contexts.set(acc.id,ctx);
  const status=providers.status(acc);assert.equal(status.canChangeRoot,false);assert.equal(status.catalogItems,0);assert.equal(status.pendingDeletions,1);await assert.rejects(()=>providers.forgetEmpty(acc),/err.nativeExclusive/);assert.equal(released,0);
});
