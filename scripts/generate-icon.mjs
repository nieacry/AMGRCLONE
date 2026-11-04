import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {trayPng} from '../electron/tray-icons.mjs';
const output=path.resolve(import.meta.dirname,'../native/bin');await mkdir(output,{recursive:true});const png=trayPng('current',0,256),header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[8]=0;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);await writeFile(path.join(output,'app.ico'),Buffer.concat([header,png]));
