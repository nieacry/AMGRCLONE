export type Language='uk'|'en';
export type Mode='online'|'local';
export type Item={path:string;name:string;kind:'file'|'folder';size:number;modified?:string;id?:string};
export type Rule={selected:boolean;mode:Mode;kind:Item['kind'];itemId?:string};
export type Settings={localRoot:string;rules:Record<string,Rule>};
export type Job={path:string;status:string;lastSuccess:string|null};
export type NativeState={enabled:boolean;shellRegistered?:boolean;canChangeRoot?:boolean;canDisconnectUninitialized?:boolean;registered?:boolean;initializationFailed?:boolean;catalogItems?:number;pendingDeletions?:number;skippedFiles?:number;root?:string;status?:string;progress?:{phase:'listing'|'placeholders';completed:number;total?:number}|null;canceled?:boolean;error?:string;detail?:string;lastChecked?:number;lastSync?:number|null;waiting?:string;pending?:number;transfers?:number;counts?:{online:number;local:number;conflicts:number};review?:Review|null;confirmations?:Confirmation[]};
export type Review={id:string;created:number;count:number;files:number;downloaded:number;bytes:number;sample:string[]};
export type Confirmation={id:string;path:string;action:'delete'|'recycle';count:number;preparedAt:number};
export type Preferences={autoStart:boolean;startMinimized:boolean;pauseSync:boolean};
export type Drive={absolutePath?:string;id:string;accountId:string;path:string;letter:string;status:string};
export type Account={id:string;name:string;scope:'personal'|'team';accountType?:'business'|'personal';settings:Settings;jobs:Job[];scheduleMinutes:number;paused:boolean;nextRun:number|null;native?:NativeState;maintenance?:{total:number;removed:number;pending:number}};
export type Activity={accountId:string;status:string;path:string;stats:{bytes:number;totalBytes:number;speed:number;transfers:number;totalTransfers:number}|null};
export type State={profilePath?:string;accounts:Account[];rcloneVersion:string|null;platform:string;nativeProvider:boolean;language:Language;activity:Activity|null;version:string;preferences:Preferences;drives:Drive[];trayStatus:string};
export type Plan={token:string;expires:number;strategy:'remote'|'local';jobs:{id:string;path:string;localPath:string;initialization:boolean;recovery:boolean;backupRemote:string;backupLocal:string}[];deferred:{path:string;reason:string}[];log:string};
export type FileEvent={seq:number;id:string;time:string;path:string;kind:'file'|'folder';action:string;direction:string;status:string;size:number|null;detail:string;target:string};
export type EventPage={entries:FileEvent[];next:number|null};
export type Run={account_id?:string;id:string;job_id:string;remote_path:string;kind:string;status:string;started:string;ended:string|null;backup_remote:string;backup_local:string;log?:string};
export interface Bridge{
  exportDiagnostics():Promise<boolean>;
  state():Promise<State>;setLanguage(language:Language):Promise<State>;chooseRclone():Promise<State>;login(name:string):Promise<State>;removeAccount(id:string,confirmed?:boolean):Promise<State>;
  setScope(id:string,scope:'personal'|'team'):Promise<State>;
  list(id:string,path:string):Promise<Item[]>;chooseRoot(id:string):Promise<State>;saveSettings(id:string,settings:Settings):Promise<State>;
  preview(id:string,options?:{strategy:'remote'|'local';recovery:boolean}):Promise<Plan>;
  execute(id:string,token:string,confirmed:boolean):Promise<{completed:number;state:State}>;
  fileEvents(id:string,options?:{before?:number;search?:string;status?:string;limit?:number}):Promise<EventPage>;
  history(id:string):Promise<Run[]>;runLog(id:string,runId:string):Promise<Run>;openLocal(id:string):Promise<void>;
  setSchedule(id:string,minutes:number,paused:boolean):Promise<State>;cancel(id?:string):Promise<boolean>;
  setPreferences(input:Partial<Preferences>):Promise<State>;quit():Promise<boolean>;
  resetApp(confirmed:boolean):Promise<State>;cleanupLegacy(id:string):Promise<State>;
  enableNativeRoot(id:string):Promise<State>;chooseNativeRoot(id:string):Promise<State>;refreshNative(id:string):Promise<State>;nativeItem(id:string,path:string):Promise<string|null>;
  nativeAvailability(id:string,path:string,mode:Mode):Promise<State>;
  nativeReview(id:string,action:'apply'|'restore'|'confirm'|'cancel',operationId?:string):Promise<State>;openQuarantine(id:string):Promise<void>;
  nativeItems(id:string,paths:string[]):Promise<Record<string,string>>;
  chooseDriveFolder(id:string):Promise<string|null>;driveLetters():Promise<{drives:{letter:string;available:boolean;target?:string}[]}>;createDrive(id:string,path:string,letter:string):Promise<State>;removeDrive(id:string):Promise<State>;
}
declare global{interface Window{cloudlane?:Bridge}}
