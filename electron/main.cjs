// PersonaLive Desktop Studio - Electron Main Process
//
// - Serves the built web app over a privileged `app://` scheme (instead of file://) so that the
//   MediaPipe WASM runtime, the model cache and the service worker all work exactly like in a
//   browser, fully offline after the first launch.
// - Grants camera access to the app window.
// - Enables GPU rasterisation / WebGL for the real-time mesh warp.
// - Ships with electron-updater for delta updates from GitHub Releases.

const { app, BrowserWindow, ipcMain, shell, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const { resolveDistFile } = require('./resolveDistFile.cjs');

const APP_SCHEME = 'app';
const APP_HOST = 'personalive';
const DIST_DIR = path.join(__dirname, '..', 'dist');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// GPU flags must be set before the app is ready.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

let mainWindow = null;

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, (request) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    let file = resolveDistFile(DIST_DIR, pathname);
    if (!file) return new Response('Forbidden', { status: 403 });
    // SPA fallback for unknown routes.
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'PersonaLive Desktop Studio',
    backgroundColor: '#020617',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
    icon: path.join(__dirname, '../public/pwa-512x512.png'),
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  } else {
    mainWindow.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<body style="font-family:sans-serif;background:#020617;color:#e2e8f0;padding:40px">' +
            '<h2>PersonaLive: no build found</h2><p>Run <code>npm run build</code> first, or <code>npm run desktop:dev</code> to use the Vite dev server.</p></body>'
        )
    );
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (app.isPackaged) {
      // Rejects when offline or when no release exists yet; that is routine, not fatal.
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        console.warn('[updater] Update check failed:', err instanceof Error ? err.message : err);
      });
    }
  });
}

/** Sends an updater event to the renderer if the window is still alive. */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Auto-updater events → renderer
autoUpdater.on('checking-for-update', () => sendToRenderer('updater-status', { status: 'checking' }));
autoUpdater.on('update-available', (info) => sendToRenderer('updater-status', { status: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => sendToRenderer('updater-status', { status: 'up-to-date' }));
autoUpdater.on('download-progress', (p) =>
  sendToRenderer('updater-progress', { percent: p.percent, transferred: p.transferred, total: p.total })
);
autoUpdater.on('update-downloaded', (info) => sendToRenderer('updater-status', { status: 'ready-to-install', version: info.version }));
autoUpdater.on('error', (err) => {
  console.warn('[updater]', err instanceof Error ? err.message : err);
  sendToRenderer('updater-status', { status: 'error', message: err instanceof Error ? err.message : String(err) });
});

// IPC results must be structured-cloneable, so only plain data crosses the bridge.
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { status: 'dev-mode' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { status: 'checked', version: result?.updateInfo?.version ?? null };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle('quit-and-install-update', () => autoUpdater.quitAndInstall());

app.whenReady().then(() => {
  registerAppProtocol();

  // Allow the studio window to use the webcam (and nothing else).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
