import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountRootScope,currentConfigAccessToken} from '../core/account-root.mjs';
import {DropboxTransport} from '../core/dropbox-transport.mjs';

test('Business uses its own root namespace; personal uses its own home; missing identity never silently falls back',()=>{
  assert.equal(accountRootScope({root_info:{root_namespace_id:'business',home_namespace_id:'member'}}),'team');
  assert.equal(accountRootScope({root_info:{root_namespace_id:'personal',home_namespace_id:'personal'}}),'personal');
  for(const profile of [{},null,{root_info:{home_namespace_id:'home'}}])assert.throws(()=>accountRootScope(profile),/err.accountRoot/);
});
test('only a valid unexpired token avoids an unnecessary rclone refresh',()=>{
  const config=value=>'[cloud]\ntype = dropbox\ntoken = '+JSON.stringify(value)+'\n',now=Date.now();
  assert.equal(currentConfigAccessToken(config({access_token:'fixture',expiry:new Date(now+120000).toISOString()}),now),'fixture');
  for(const value of [{access_token:'fixture'},{access_token:'fixture',expiry:new Date(now-1).toISOString()},null])assert.equal(currentConfigAccessToken(config(value),now),null);
});
test('shallow business and personal listings paginate inside the authenticated account without mixing spaces',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{const business=options.headers.Authorization==='Bearer business',body=options.body?JSON.parse(options.body):{};if(url.endsWith('get_current_account'))return Response.json({root_info:{root_namespace_id:business?'business-root':'personal-root',home_namespace_id:business?'business-home':'personal-root'}});
    const ns=JSON.parse(options.headers['Dropbox-API-Path-Root']).namespace_id;calls.push({ns,body});
    if(url.endsWith('/continue'))return Response.json({entries:[{'.tag':'folder',id:'b2',path_display:'/Business-two'}],has_more:false});
    assert.equal(body.recursive,false);return Response.json({entries:[{'.tag':'folder',id:'b1',path_display:business?'/Business-one':'/Personal-only'}],has_more:business,cursor:'business-cursor'});
  };
  try{const business=new DropboxTransport({auth:async()=>'business'});business.scope=await business.accountScope();assert.deepEqual((await business.list('',false)).map(i=>i.path),['Business-one','Business-two']);const personal=new DropboxTransport({auth:async()=>'personal'});personal.scope=await personal.accountScope();assert.deepEqual((await personal.list('',false)).map(i=>i.path),['Personal-only']);assert.deepEqual(calls.map(c=>c.ns),['business-root','business-root','personal-root']);}finally{globalThis.fetch=original;}
});
