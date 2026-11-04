import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {NativeHost} from './native-host.mjs';
const exec=promisify(execFile),normalize=value=>value.replaceAll('/','\\').toLowerCase();
export class SubstDrives {
  constructor(helper){this.helper=helper;this.binary=path.join(process.env.SystemRoot||'C:\\Windows','System32','subst.exe');}
  async list(){const host=new NativeHost(this.helper);try{return (await host.request('drives')).drives;}finally{await host.close();}}
  async command(args){try{await exec(this.binary,args,{windowsHide:true,shell:false,timeout:10000,encoding:'buffer'});}catch{throw new Error('err.driveOperation');}}
  async create(letter,absolutePath){if(!/^[A-Z]$/.test(letter)||!path.win32.isAbsolute(absolutePath))throw new Error('err.driveLetter');const current=(await this.list()).find(d=>d.letter===letter);if(!current?.available)throw new Error('err.driveOccupied');await this.command([letter+':',absolutePath]);const mapped=(await this.list()).find(d=>d.letter===letter);const expected='\\??\\'+absolutePath;if(!mapped||normalize(mapped.target)!==normalize(expected))throw new Error('err.driveOwnership');return {target:mapped.target};}
  async remove(record){const current=(await this.list()).find(d=>d.letter===record.letter);if(!current||current.available||normalize(current.target)!==normalize(record.target))throw new Error('err.driveOwnership');await this.command([record.letter+':','/D']);}
}
