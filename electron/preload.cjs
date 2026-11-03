// PersonaLive Desktop Studio - Safe Preload Script
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isElectron: true,
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  quitAndInstallUpdate: () => ipcRenderer.invoke('quit-and-install-update'),
  onUpdaterStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('updater-status', listener);
    return () => ipcRenderer.removeListener('updater-status', listener);
  },
  onUpdaterProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('updater-progress', listener);
    return () => ipcRenderer.removeListener('updater-progress', listener);
  },
});
