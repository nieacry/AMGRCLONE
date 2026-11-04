import {readFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';

export async function peImports(filename){
  const bytes=await readFile(filename),pe=bytes.readUInt32LE(0x3c);if(bytes.toString('ascii',0,2)!=='MZ'||bytes.readUInt32LE(pe)!==0x4550)throw new Error('Not a PE image: '+filename);
  if(bytes.readUInt16LE(pe+4)!==0x8664)throw new Error('Portable Windows release requires x64 images: '+filename);
  const optional=pe+24,magic=bytes.readUInt16LE(optional),directories=optional+(magic===0x20b?112:magic===0x10b?96:0);if(directories===optional)throw new Error('Unsupported PE format');
  const sections=pe+24+bytes.readUInt16LE(pe+20),count=bytes.readUInt16LE(pe+6),rva=value=>{if(value<bytes.readUInt32LE(optional+60))return value;for(let n=0;n<count;n++){const at=sections+n*40,start=bytes.readUInt32LE(at+12),length=Math.max(bytes.readUInt32LE(at+8),bytes.readUInt32LE(at+16));if(value>=start&&value<start+length)return bytes.readUInt32LE(at+20)+value-start;}throw new Error('Invalid PE address');};
  const name=value=>{const start=rva(value),end=bytes.indexOf(0,start);if(end<start||end-start>1024)throw new Error('Invalid import name');return bytes.toString('ascii',start,end).toLowerCase();},imports=new Set();
  for(const [index,stride,field]of [[1,20,12],[13,32,4]]){const start=bytes.readUInt32LE(directories+index*8),length=bytes.readUInt32LE(directories+index*8+4);if(!start)continue;const at=rva(start);for(let offset=0;offset+stride<=length;offset+=stride){const address=bytes.readUInt32LE(at+offset+field);if(!address)break;if(index===13&&!(bytes.readUInt32LE(at+offset)&1))throw new Error('Unsupported delay-import address');imports.add(name(address));}}
  return [...imports].sort();
}
const exists=filename=>access(filename).then(()=>true).catch(()=>false);
const optionalRuntime=/^(?:vcruntime|msvcp|msvcr|concrt|vcomp)\d+.*\.dll$|^(?:ucrtbased|python\d+|node)\.dll$/i;
const windowsComponents=new Set('advapi32.dll bcryptprimitives.dll bthprops.cpl cfgmgr32.dll cldapi.dll comctl32.dll comdlg32.dll crypt32.dll cryptui.dll d3d11.dll d3d12.dll dbghelp.dll dcomp.dll dhcpcsvc.dll dwmapi.dll dwrite.dll dxgi.dll gdi32.dll hid.dll iphlpapi.dll kernel32.dll mf.dll mfplat.dll mfreadwrite.dll mmdevapi.dll ncrypt.dll ntdll.dll ole32.dll oleacc.dll oleaut32.dll pdh.dll propsys.dll rpcrt4.dll secur32.dll setupapi.dll shell32.dll shlwapi.dll tbs.dll uiautomationcore.dll urlmon.dll user32.dll userenv.dll uxtheme.dll version.dll wevtapi.dll winhttp.dll winmm.dll winspool.drv wintrust.dll winusb.dll ws2_32.dll wtsapi32.dll'.split(' '));
export async function auditPortable(base){
  const images=[];async function walk(folder){for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('Unexpected link in portable release');const filename=path.join(folder,entry.name);if(entry.isDirectory())await walk(filename);else if(/\.(exe|dll)$/i.test(entry.name))images.push(filename);}}await walk(base);
  const report={platform:'win32-x64',verification:'PE import and delay-import audit',requires:'Supported Windows x64 with Cloud Files; NTFS sync folder',components:{electron:true,rclone:true,cloudFiles:true},externalInstallersRequired:false,images:{}},system=path.join(process.env.SystemRoot||'C:\\Windows','System32');
  for(const filename of images){const dependencies=await peImports(filename),relative=path.relative(base,filename).replaceAll('\\','/'),directory=path.dirname(filename),entryDirectory=/\.exe$/i.test(filename)||relative.includes('/resources/bin/')?directory:path.join(base,'app');
    for(const dependency of dependencies){if(await exists(path.join(directory,dependency))||await exists(path.join(entryDirectory,dependency)))continue;if(optionalRuntime.test(dependency))throw new Error('Unbundled runtime dependency: '+relative+' → '+dependency);if(/^(api-ms-|ext-ms-)/i.test(dependency))continue;if(!windowsComponents.has(dependency)||!await exists(path.join(system,dependency)))throw new Error('Missing or unapproved external dependency: '+relative+' → '+dependency);}
    report.images[relative]=dependencies;
  }
  for(const relative of ['AMG rclone UI.exe','app/AMG rclone UI.exe','app/resources/bin/amg-cloud.exe','app/resources/bin/rclone.exe'])if(!report.images[relative])throw new Error('Missing portable component: '+relative);
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){const stage=JSON.parse(await readFile('.runtime/release-stage.json','utf8'));const report=await auditPortable(stage.binary);console.log(JSON.stringify(report,null,2));}
