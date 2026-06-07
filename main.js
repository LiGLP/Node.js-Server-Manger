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

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:' + PORT)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

function applyAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: [],
    });
  } catch (e) {}
}

function autoStartServers() {
  try {
    store.getServers().forEach(s => {
      if (s.startOnBoot) {
        setTimeout(() => { try { pm.start(s); } catch (e) {} }, 600);
      }
    });
  } catch (e) {}
}

app.whenReady().then(() => {
  store.init(path.join(app.getPath('userData'), 'data'));
  const cfg = store.getConfig();
  PORT = cfg.port || 8800;

  global.__applyAutoLaunch = applyAutoLaunch;
  applyAutoLaunch(cfg.autoLaunch);

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

  autoStartServers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { pm.stopAll(); } catch (e) {}
});
