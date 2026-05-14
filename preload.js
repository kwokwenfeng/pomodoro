const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', title, body),
  setTrayTooltip: (tooltip) => ipcRenderer.invoke('set-tray-tooltip', tooltip),
  setTrayTitle: (title) => ipcRenderer.invoke('set-tray-title', title),
  setTrayIcon: (type) => ipcRenderer.invoke('set-tray-icon', type)
});
