import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeAvailabilityStates,nativeFileStatus,validateAvailabilityPaths} from '../core/native-availability.mjs';
import {NativeProviders} from '../core/native-provider.mjs';

test('actual bytes distinguish online, cached and pinned; an unfinished pin never claims offline availability',()=>{
  assert.equal(nativeFileStatus({inSync:true,partial:true,pin:0}),'online');
  assert.equal(nativeFileStatus({inSync:true,partial:false,pin:0}),'cached');
  assert.equal(nativeFileStatus({inSync:true,partial:false,pin:1}),'pinned');
  assert.equal(nativeFileStatus({inSync:true,partial:true,pin:1}),'online');
  assert.equal(nativeFileStatus({inSync:false,partial:false,pin:1}),'dirty');
});
test('folder state describes all known descendants, including collapsed branches, mixed files and errors',()=>{
  const items=[{path:'Project',kind:'folder',status:'cached'},{path:'Project/Nested',kind:'folder',status:'cached'},{path:'Project/a.pdf',kind:'file',status:'online'},{path:'Project/Nested/b.pdf',kind:'file',status:'cached'},{path:'Empty',kind:'folder',status:'cached'}];
  const read=()=>nativeAvailabilityStates(items,['Project','Project/Nested','Project/a.pdf','Empty','Missing']);
  assert.deepEqual(read(),{'Project':'mixed','Project/Nested':'cached','Project/a.pdf':'online','Empty':'empty','Missing':'unknown'});
  items[2].status='pinned';items[3].status='pinned';assert.equal(read().Project,'pinned');
  items[2].status='cached';assert.equal(read().Project,'cached');
  assert.equal(nativeAvailabilityStates(items,['Project'],['Project/Nested/b.pdf']).Project,'syncing');
  items[2].status='conflict';assert.equal(nativeAvailabilityStates(items,['Project'],['Project/Nested/b.pdf']).Project,'conflict');
});
test('visible status inspects only attributes, remains accurate while sync is paused, and never rewrites the rule',async()=>{
  const item={path:'Project/a.pdf',kind:'file',status:'online',identity:'owned'},acc={id:'A',settings:{rules:{Project:{selected:true,mode:'online',kind:'folder'}}}};
  const commands=[],provider=new NativeProviders({}),ctx={items:new Map([['a',item]]),fetches:new Map(),uploads:new Set(),host:{request:async(command)=>{commands.push(command);return {exists:true,placeholder:true,identity:'owned',inSync:true,partial:false,pin:0};}}};provider.contexts.set('A',ctx);provider.paused=true;
  assert.equal((await provider.itemStates(acc,['Project/a.pdf']))['Project/a.pdf'],'cached');assert.deepEqual(commands,['inspect']);assert.equal(item.status,'online');assert.equal(acc.settings.rules.Project.mode,'online');
  assert.equal((await provider.itemStates({id:'B'},['Project/a.pdf']))['Project/a.pdf'],'unknown');
  ctx.fetches.set('live',{nativePath:'Project/a.pdf'});assert.equal((await provider.itemStates(acc,['Project/a.pdf']))['Project/a.pdf'],'syncing');
});
test('availability query is bounded and rejects traversal, absolute paths and non-string input',()=>{
  for(const paths of [null,['../outside'],['/outside'],[5],Array(1001).fill('a')])assert.throws(()=>validateAvailabilityPaths(paths));
  assert.deepEqual(validateAvailabilityPaths(['Project/a.pdf','Project/a.pdf']),['Project/a.pdf']);
  const result=nativeAvailabilityStates([{path:'__proto__',kind:'file',status:'cached'}],['__proto__']);assert.equal(Object.hasOwn(result,'__proto__'),true);assert.equal(result.__proto__,'cached');
});
