// PersonaLive Desktop Studio - Electron Main Process
// Configured with auto-updater via GitHub Releases and hardware acceleration for WebGL & Canvas

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// Configure autoUpdater logging and feed
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'PersonaLive Desktop Studio',
    backgroundColor: '#020617',
    titleBarStyle: 'hiddenInset', // Native clean macOS/Windows titlebar
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
    icon: path.join(__dirname, '../public/icon.svg'),
  });

  // Enable hardware acceleration flags for real-time 60 FPS face transformation
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');

  // In development, load local Vite dev server; in production, load built dist
  const startUrl = process.env.VITE_DEV_SERVER_URL || `file://${path.join(__dirname, '../dist/index.html')}`;
  mainWindow.loadURL(startUrl);

  // Open external links safely in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Check for auto-updates after window is ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (app.isPackaged) {
      autoUpdater.checkForUpdatesAndNotify();
    }
  });
}

// Auto-updater event listeners & IPC forwarding to renderer UI
autoUpdater.on('checking-for-update', () => {
  mainWindow?.webContents.send('updater-status', { status: 'checking' });
});

autoUpdater.on('update-available', (info) => {
  mainWindow?.webContents.send('updater-status', { status: 'available', version: info.version });
});

autoUpdater.on('update-not-available', () => {
  mainWindow?.webContents.send('updater-status', { status: 'up-to-date' });
});

autoUpdater.on('download-progress', (progressObj) => {
  mainWindow?.webContents.send('updater-progress', {
    percent: progressObj.percent,
    transferred: progressObj.transferred,
    total: progressObj.total,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  mainWindow?.webContents.send('updater-status', { status: 'ready-to-install', version: info.version });
});

// Manual update triggers from UI
ipcMain.handle('check-for-updates', async () => {
  if (app.isPackaged) {
    return await autoUpdater.checkForUpdates();
  }
  return { status: 'dev-mode' };
});

ipcMain.handle('quit-and-install-update', () => {
  autoUpdater.quitAndInstall();
});

// App lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
