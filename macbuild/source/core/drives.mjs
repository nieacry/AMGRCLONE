import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {validateRemotePath} from './policy.mjs';
const normalized=value=>value.replaceAll('/','\\').toLowerCase();
export class OwnedDrives {
  constructor({records,account,backend,persist,resolveFolder}){this.records=records;this.account=account;this.backend=backend;this.persist=persist;this.resolveFolder=resolveFolder|| (async(acc,relative)=>{const root=acc.native?.enabled?acc.native.root:acc.settings.localRoot;if(!root)throw new Error('err.root');return {root,target:path.win32.join(root,...relative.split('/'))};});}
  expected(record){const acc=this.account(record.accountId);if(!record.owner||record.owner!==acc.driveOwner||!path.win32.isAbsolute(record.root))throw new Error('err.driveOwnership');validateRemotePath(record.path);return '\\??\\'+path.win32.join(record.root,...record.path.split('/'));}
  async available(){return this.backend.list();}
  async create(accountId,relative,letter){validateRemotePath(relative);if(typeof letter!=='string'||! /^[A-Z]$/.test(letter))throw new Error('err.driveLetter');const acc=this.account(accountId),{root,target}=await this.resolveFolder(acc,relative);if(!acc.driveOwner)throw new Error('err.driveOwnership');if(this.records.some(r=>r.letter===letter))throw new Error('err.driveOccupied');if(!(await this.available()).some(d=>d.letter===letter&&d.available))throw new Error('err.driveOccupied');
    const record={id:randomUUID(),accountId,path:relative,letter,root,owner:acc.driveOwner,status:'creating'};record.target=this.expected(record);if(normalized(record.target)!==normalized('\\??\\'+target))throw new Error('err.link');this.records.push(record);await this.persist();
    try{const result=await this.backend.create(letter,target);if(normalized(result.target)!==normalized(record.target))throw new Error('err.driveOwnership');record.status='mounted';await this.persist();return record;}
    catch(error){record.status='error';await this.persist();throw error;}
  }
  async remove(id){const index=this.records.findIndex(r=>r.id===id);if(index<0)throw new Error('err.driveOwnership');const record=this.records[index],expected=this.expected(record),current=(await this.available()).find(d=>d.letter===record.letter);if(!current)throw new Error('err.driveOwnership');if(!current.available){if(normalized(current.target)!==normalized(expected))throw new Error('err.driveOwnership');await this.backend.remove(record);}this.records.splice(index,1);await this.persist();}
  async restore(){for(const record of this.records){try{const expected=this.expected(record),current=(await this.available()).find(d=>d.letter===record.letter);if(!current)throw new Error('err.driveOwnership');if(current.available)await this.backend.create(record.letter,expected.slice(4));else if(normalized(current.target)!==normalized(expected))throw new Error('err.driveOwnership');record.status='mounted';}catch{record.status='blocked';}}await this.persist();}
  async disconnect(){for(const record of this.records){try{const expected=this.expected(record),current=(await this.available()).find(d=>d.letter===record.letter);if(current&&!current.available&&normalized(current.target)===normalized(expected))await this.backend.remove(record);}catch{/* Never remove a foreign disk, including during shutdown. */}}}
}
