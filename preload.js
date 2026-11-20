const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openPdf: (multi = false) => ipcRenderer.invoke('open-pdf', { multi }),
  openImage: () => ipcRenderer.invoke('open-image'),
  readPath: (p) => ipcRenderer.invoke('read-path', p),
  savePdf: (args) => ipcRenderer.invoke('save-pdf', args),
  confirm: (args) => ipcRenderer.invoke('confirm', args),
  initialFile: () => ipcRenderer.invoke('initial-file'),
  setDirty: (d) => ipcRenderer.send('set-dirty', d),
  addRecent: (p) => ipcRenderer.send('add-recent', p),
  setTheme: (t) => ipcRenderer.send('set-theme', t),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (e, entry) => cb(entry)),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return null; } },
});
