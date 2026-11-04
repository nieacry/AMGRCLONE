import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePolicy, validateSettings, validateRemotePath, validateLocalMapping, makePlan, bisyncArgs, parseAuthorization } from '../core/policy.mjs';
const rule = (mode = 'local', kind = 'folder', selected = true) => ({ mode, kind, selected });
const plan = rules => makePlan({ localRoot: '/tmp/local', rules });
test('nearest ancestor determines availability and selection', () => {
  const rules = { 'Media': rule('online'), 'Media/edit': rule('local') };
  assert.equal(effectivePolicy('Media/raw.mov', rules).mode, 'online');
  assert.equal(effectivePolicy('Media/edit/main.mov', rules).mode, 'local');
  assert.equal(effectivePolicy('Media2/raw.mov', rules).selected, false);
});
test('excluded subtree can reselect a child', () => {
  const rules = { 'Projects': rule(), 'Projects/private': rule('local','folder',false), 'Projects/private/share': rule() };
  assert.equal(effectivePolicy('Projects/private/file',rules).selected,false);
  assert.equal(effectivePolicy('Projects/private/share/file',rules).selected,true);
});
test('missing ancestor never selects unrelated files', () => {
  assert.deepEqual(effectivePolicy('anything',{}),{selected:false,mode:'online'});
});
test('nested local roots generate only one bisync job', () => {
  assert.deepEqual(plan({'A':rule(),'A/B':rule()}).jobs.map(j=>j.path),['A']);
});
test('online-only descendant blocks parent bisync', () => {
  const value=plan({'A':rule(),'A/raw.mov':rule('online','file')});
  assert.equal(value.jobs.length,0);
  assert.equal(value.deferred[0].reason,'deferred_exception');
});
test('excluded descendant blocks parent bisync', () => {
  assert.equal(plan({'A':rule(),'A/private':rule('local','folder',false)}).jobs.length,0);
});
test('local child of an online-only folder can be a separate job', () => {
  assert.deepEqual(plan({'Media':rule('online'),'Media/Working':rule()}).jobs.map(j=>j.path),['Media/Working']);
});
test('individual local file is deferred rather than treated as a directory', () => {
  assert.equal(plan({'clip.mov':rule('local','file')}).jobs.length,0);
});
test('unselected paths produce no jobs', () => assert.equal(plan({'A':rule('local','folder',false)}).jobs.length,0));
test('reject traversal, absolute paths, config injection and null bytes', () => {
  for(const p of ['../A','A/../B','/A','A\\B','A\nB','A\0B','A//B','A/./B']) assert.throws(()=>validateRemotePath(p));
  assert.equal(validateRemotePath('Проекты/Київ 🗂'),'Проекты/Київ 🗂');
});
test('reject malformed settings from renderer', () => {
  for(const settings of [null,{}, {localRoot:'x',rules:[]},{localRoot:'x',rules:{A:{selected:true,mode:'secret',kind:'folder'}}}]) assert.throws(()=>validateSettings(settings));
});
test('preview always uses dry-run and never force or automatic conflict winner', () => {
  const args=bisyncArgs('cloud:Проекты','C:\\Local Folder','/state');
  assert.ok(args.includes('--dry-run'));assert.ok(args.includes('--resync'));
  assert.equal(args[args.indexOf('--conflict-resolve')+1],'none');
  assert.ok(!args.includes('--force'));assert.equal(args[1],'cloud:Проекты');
});
test('OAuth output parser accepts token amid instructions', () => {
  const token={access_token:'test-only',refresh_token:'refresh-only',expiry:'2026-12-01T00:00:00Z'};
  assert.deepEqual(JSON.parse(parseAuthorization('Paste the following\n'+JSON.stringify(token)+'\nEnd')),token);
});
test('OAuth output requires refresh token and rejects arbitrary output', () => {
  assert.throws(()=>parseAuthorization('{"access_token":"temporary"}'));
  assert.throws(()=>parseAuthorization('Authorization failed'));
});
test('Windows mapping rejects reserved names, drive syntax and ambiguous endings', () => {
  for (const p of ['CON', 'Media/AUX.mov', 'C:folder', 'A/file.', 'A/file ', 'A/foo?']) assert.throws(()=>validateLocalMapping(p,'win32'));
  assert.equal(validateLocalMapping('Проекты/Київ','win32'),'Проекты/Київ');
});
