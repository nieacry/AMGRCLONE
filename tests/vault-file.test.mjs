import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readVault,writeVault,settingsMirror} from '../core/vault-file.mjs';
import {SyncStore} from '../core/store.mjs';
import {DropboxTransport} from '../core/dropbox-transport.mjs';

// Stand-in for safeStorage: reversible, and fails on bytes "encrypted" for another user.
const encrypt=async text=>Buffer.concat([Buffer.from('ME:'),Buffer.from(text)]);
const decrypt=async bytes=>{if(!bytes.subarray(0,3).equals(Buffer.from('ME:')))throw new Error('Error while decrypting the ciphertext');return bytes.subarray(3).toString();};
const secret='[cloud]\ntype = dropbox\ntoken = {"access_token":"a","refresh_token":"SECRET-REFRESH"}\n';
const sample=(name='Studio')=>({language:'uk',preferences:{pauseSync:false},drives:[],binary:'rclone',accounts:[{id:'acc-1',name,config:secret,settings:{localRoot:'',rules:{'':{selected:true,mode:'online',kind:'folder'}}},native:{enabled:true,root:'D:\\Dropbox',owner:'o1'}}]});
async function dir(){const d=path.resolve(import.meta.dirname,'../.runtime/vault-file',randomUUID());await mkdir(d,{recursive:true});return d;}

test('a save keeps the previous vault and a token-free settings mirror',async()=>{
  const d=await dir();await writeVault({dataDir:d,vault:sample('First'),encrypt});await writeVault({dataDir:d,vault:sample('Second'),encrypt});
  assert.equal(JSON.parse(await decrypt(await readFile(path.join(d,'vault.bin')))).accounts[0].name,'Second');
  assert.equal(JSON.parse(await decrypt(await readFile(path.join(d,'vault.bak')))).accounts[0].name,'First');
  const mirror=await readFile(path.join(d,'settings-backup.json'),'utf8');
  assert.equal(mirror.includes('SECRET-REFRESH'),false);assert.equal(mirror.includes('access_token'),false);
  assert.equal(JSON.parse(mirror).accounts[0].native.root,'D:\\Dropbox');
  assert.deepEqual((await readdir(d)).sort(),['settings-backup.json','vault.bak','vault.bin']);
});

test('a failed encryption leaves the current vault untouched',async()=>{
  const d=await dir();await writeVault({dataDir:d,vault:sample('Good'),encrypt});
  await assert.rejects(writeVault({dataDir:d,vault:sample('Bad'),encrypt:async()=>{throw new Error('err.keys');}}));
  assert.equal((await readVault({dataDir:d,decrypt})).vault.accounts[0].name,'Good');
});

test('normal start reads vault.bin',async()=>{
  const d=await dir();await writeVault({dataDir:d,vault:sample(),encrypt});
  const result=await readVault({dataDir:d,decrypt});assert.equal(result.source,'vault');assert.equal(result.problem,undefined);assert.equal(result.vault.accounts[0].config,secret);
});

test('first start with no profile is a new vault, not a problem',async()=>{
  const d=await dir();assert.deepEqual(await readVault({dataDir:d,decrypt}),{vault:null,source:'new'});
});

for(const [label,damage,problem] of [['an empty vault.bin (power loss)',Buffer.alloc(0),'empty'],['a vault.bin from another Windows user',Buffer.from('XX:{}'),'decrypt'],['a truncated vault.bin',Buffer.from('ME:{"accounts":['),'parse']]){
  test(`${label} falls back to vault.bak and keeps the damaged file`,async()=>{
    const d=await dir();await writeVault({dataDir:d,vault:sample('Previous'),encrypt});await writeVault({dataDir:d,vault:sample('Latest'),encrypt});
    await writeFile(path.join(d,'vault.bin'),damage);
    const result=await readVault({dataDir:d,decrypt,now:1234});
    assert.equal(result.source,'backup');assert.equal(result.problem,problem);assert.equal(result.vault.accounts[0].name,'Previous');assert.equal(result.vault.accounts[0].config,secret);
    assert.equal(JSON.parse(await decrypt(await readFile(path.join(d,'vault.bin')))).accounts[0].name,'Previous','vault.bin is repaired');
    const files=await readdir(d);assert.equal(files.includes('vault.damaged-1234.bin'),damage.length>0);
  });
}

test('a missing vault.bin with a vault.bak is recovered',async()=>{
  const d=await dir();await writeVault({dataDir:d,vault:sample('A'),encrypt});await writeVault({dataDir:d,vault:sample('B'),encrypt});
  const {rm}=await import('node:fs/promises');await rm(path.join(d,'vault.bin'));
  const result=await readVault({dataDir:d,decrypt});assert.equal(result.source,'backup');assert.equal(result.problem,'missing');assert.equal(result.vault.accounts[0].name,'A');
});

test('when no encrypted copy can be read, accounts come back from the mirror and need a new sign-in',async()=>{
  const d=await dir();await writeVault({dataDir:d,vault:sample('A'),encrypt});await writeVault({dataDir:d,vault:sample('B'),encrypt});
  const otherUser=async()=>{throw new Error('Error while decrypting the ciphertext');};
  const result=await readVault({dataDir:d,decrypt:otherUser,now:99});
  assert.equal(result.source,'mirror');assert.equal(result.problem,'decrypt');
  const account=result.vault.accounts[0];assert.equal(account.name,'B');assert.equal(account.config,'');assert.equal(account.needsLogin,true);assert.equal(account.native.root,'D:\\Dropbox');assert.deepEqual(account.settings.rules,sample().accounts[0].settings.rules);
  const files=await readdir(d);assert.ok(files.includes('vault.damaged-99.bin'));assert.ok(files.includes('vault.damaged-99.bak'),'both encrypted copies are kept for later');
});

test('when nothing can be read and there is no mirror, the app starts clean but reports it',async()=>{
  const d=await dir();await writeFile(path.join(d,'vault.bin'),Buffer.from('XX:garbage'));
  const result=await readVault({dataDir:d,decrypt,now:5});assert.equal(result.vault,null);assert.equal(result.source,'new');assert.equal(result.problem,'decrypt');
  assert.ok((await readdir(d)).includes('vault.damaged-5.bin'));
});

test('the mirror never contains a token, even inside nested data',()=>{
  const text=JSON.stringify(settingsMirror(sample()));assert.equal(text.includes('SECRET'),false);assert.equal(JSON.parse(text).accounts[0].dropbox,true);
});

test('forgetting an account removes its catalog, journal and history only',()=>{
  const store=new SyncStore(':memory:');
  for(const id of ['gone','kept']){store.addFileEvent(id,{action:'upload'});store.saveNativeItem(id,{key:'k',path:'a'});store.saveNativeReview(id,{id:'r'});store.saveNativeDeletion(id,{id:'d'});store.db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?)').run(id+':personal','i','p','file',1,null);}
  store.forgetAccount('gone');
  for(const table of ['file_events','native_items','native_reviews','native_deletions'])assert.deepEqual(store.db.prepare(`SELECT DISTINCT account_id FROM ${table}`).all().map(r=>r.account_id),['kept'],table);
  assert.deepEqual(store.db.prepare('SELECT account_id FROM items').all().map(r=>r.account_id),['kept:personal']);
});

test('removing an account revokes its Dropbox token; an already invalid token is fine',async()=>{
  const original=globalThis.fetch,calls=[];
  try{
    globalThis.fetch=async(url,options)=>{calls.push({url,auth:options.headers.Authorization});return new Response(null,{status:200});};
    await new DropboxTransport({auth:async()=>'token-1'}).revoke();
    globalThis.fetch=async()=>Response.json({error_summary:'invalid_access_token/..'},{status:401});
    await new DropboxTransport({auth:async()=>'token-2'}).revoke();
  }finally{globalThis.fetch=original;}
  assert.deepEqual(calls,[{url:'https://api.dropboxapi.com/2/auth/token/revoke',auth:'Bearer token-1'}]);
});
