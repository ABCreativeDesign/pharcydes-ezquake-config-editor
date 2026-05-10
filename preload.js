const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:      (hintDir)                       => ipcRenderer.invoke('dialog:open', hintDir),
  saveFile:      (filePath, content)             => ipcRenderer.invoke('file:save', filePath, content),
  exportFile:    (defaultName, content, hintDir) => ipcRenderer.invoke('dialog:save', defaultName, content, hintDir),
  loadDefault:   (type)                          => ipcRenderer.invoke('default:load', type),
  onBeforeClose: (cb)                            => ipcRenderer.on('app:before-close', () => cb()),
  confirmClose:  ()                              => ipcRenderer.invoke('app:confirm-close'),
  getVersion:    ()                              => ipcRenderer.invoke('app:get-version'),
  // Quake launch / hot-reload
  quakeRunning:  ()                              => ipcRenderer.invoke('quake:running'),
  quakeLaunch:   (hintDir, cfgName)              => ipcRenderer.invoke('quake:launch', hintDir, cfgName),
  quakeReload:   ()                              => ipcRenderer.invoke('quake:reload')
});
