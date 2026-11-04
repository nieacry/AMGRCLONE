// UI test harness only. Not included in application packages.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData',path.join(__dirname,'../.runtime/demo'));
app.whenReady().then(()=>{
  const win = new BrowserWindow({width:1320,height:930,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
  win.loadFile(path.join(__dirname,'../dist/index.html'));
});
app.on('window-all-closed',()=>app.quit());
