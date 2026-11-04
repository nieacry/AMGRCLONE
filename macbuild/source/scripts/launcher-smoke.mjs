import {chromium} from 'playwright';
import {readFile,mkdir,copyFile,symlink,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const project=path.resolve(import.meta.dirname,'..'),stage=JSON.parse(await readFile(path.join(project,'.runtime/release-stage.json'),'utf8'));
const entries=await readdir(stage.binary,{withFileTypes:true});assert.deepEqual(entries.filter(e=>e.isFile()).map(e=>e.name),['AMG rclone UI.exe']);assert.ok(entries.every(e=>e.isDirectory()||e.name==='AMG rclone UI.exe'));
const base=path.join(project,'.runtime/launcher-test',randomUUID().slice(0,8),'Запуск з пробілами');await mkdir(base,{recursive:true});await copyFile(path.join(stage.binary,'AMG rclone UI.exe'),path.join(base,'AMG rclone UI.exe'));await symlink(stage.app,path.join(base,'app'),'junction');
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
const env={...process.env,CLOUDLANE_TEST_DATA:path.join(base,'профіль'),ELECTRON_RUN_AS_NODE:'1'};
await promisify(execFile)(path.join(base,'AMG rclone UI.exe'),[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,cwd:base,windowsHide:true,timeout:10000});
let browser;
try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(ready,true,'Launcher must start its bundled Electron app');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page',{timeout:30000});await page.locator('main header').waitFor();const state=await page.evaluate(()=>window.cloudlane.state());assert.equal(state.version,stage.version);assert.equal(state.accounts.length,0);assert.equal(state.language,'uk');assert.ok(state.rcloneVersion.startsWith('rclone v'));
  await page.evaluate(()=>window.cloudlane.setLanguage('en'));await page.evaluate(()=>window.cloudlane.quit()).catch(()=>{});
  console.log('PASS: top-level folder contains only EXE and subfolders; actual launcher starts app through Unicode/spaced paths, forwards arguments, clears Electron Node mode and finds bundled rclone');
}finally{if(browser){for(const context of browser.contexts())for(const page of context.pages())await page.evaluate(()=>window.cloudlane?.quit()).catch(()=>{});await browser.close().catch(()=>{});}}
