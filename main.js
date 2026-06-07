/* ============================================================
   main.js — Electron entry. Boots the local panel server and
   opens it in a desktop window. The same http://localhost:PORT
   is what you reach over Remote Desktop (keep that port free).
   ============================================================ */
require('dotenv').config();
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');

const store = require('./src/store');
const { startServer } = require('./src/server');
const pm = require('./src/processManager');

let win = null;
let httpServer = null;
let PORT = 8800;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0a0c10',
    title: 'Node Server Manager',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL('http://localhost:' + PORT);

  // open external links in the system browser, keep app links in-window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:' + PORT)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // persist data under the OS user-data dir so it survives updates
  store.init(path.join(app.getPath('userData'), 'data'));
  PORT = store.getConfig().port || 8800;

  try {
    httpServer = startServer(PORT);
    httpServer.on('error', err => {
      dialog.showErrorBox(
        'Port in use',
        'Could not start the panel on port ' + PORT + '.\n\n' +
        err.message + '\n\nFree the port (or change it in Settings) and reopen the app.'
      );
    });
  } catch (e) {
    dialog.showErrorBox('Startup error', e.message);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // tear down any servers we started so nothing is left orphaned
  try { pm.stopAll(); } catch (e) {}
});
