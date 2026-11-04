import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {SubstDrives} from '../core/subst-drives.mjs';
import {OwnedDrives} from '../core/drives.mjs';
const project=path.resolve(import.meta.dirname,'..'),base=path.join(project,'.runtime/subst-test',randomUUID().slice(0,8)),root=path.join(base,'dbproject'),relative='Проєкт 1';
await mkdir(path.join(root,relative),{recursive:true});await mkdir(path.join(base,'other'),{recursive:true});await writeFile(path.join(root,relative,'original.txt'),'original hierarchy');await writeFile(path.join(base,'other','foreign.txt'),'do not remove foreign mapping');
const acc={id:'local-fixture',driveOwner:randomUUID(),settings:{localRoot:root,rules:{}}},original=JSON.stringify(acc.settings),records=[],backend=new SubstDrives(path.join(project,'native/bin/amg-cloud.exe'));
const manager=new OwnedDrives({records,account:()=>acc,backend,persist:async()=>{await writeFile(path.join(base,'records.json'),JSON.stringify(records));}}),letter=(await backend.list()).filter(d=>d.available).at(-1)?.letter;
assert.ok(letter,'An available drive letter is required');
try{
  const created=await manager.create(acc.id,relative,letter);assert.equal(await readFile(letter+':\\original.txt','utf8'),'original hierarchy');assert.equal(JSON.stringify(acc.settings),original);console.log('PASS: actual subst.exe maps a Unicode local folder without changing absolute sync paths or rules');
  await assert.rejects(()=>manager.remove('C'),/err.driveOwnership/);await assert.rejects(()=>manager.remove('not-owned'),/err.driveOwnership/);
  await backend.remove(created);const foreign=await backend.create(letter,path.join(base,'other'));
  await assert.rejects(()=>manager.remove(created.id),/err.driveOwnership/);await manager.restore();assert.equal(records[0].status,'blocked');assert.equal(await readFile(letter+':\\foreign.txt','utf8'),'do not remove foreign mapping');console.log('PASS: app refuses system/arbitrary IDs and leaves a changed target untouched');
  await backend.remove({letter,target:foreign.target});await manager.restore();assert.equal(records[0].status,'mounted');await manager.remove(created.id);assert.equal(records.length,0);assert.equal(await readFile(path.join(root,relative,'original.txt'),'utf8'),'original hierarchy');console.log('PASS: subst /D removes only the owned binding; original files remain unchanged');
}finally{const current=(await backend.list()).find(d=>d.letter===letter);if(current&&!current.available&&current.target.toLowerCase().startsWith(('\\??\\'+base).toLowerCase()+'\\'))await backend.remove({letter,target:current.target});}
