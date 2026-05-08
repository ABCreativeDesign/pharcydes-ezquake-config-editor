const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:      ()                    => ipcRenderer.invoke('dialog:open'),
  saveFile:      (filePath, content)   => ipcRenderer.invoke('file:save', filePath, content),
  exportFile:    (defaultName, content)=> ipcRenderer.invoke('dialog:save', defaultName, content),
  loadDefault:   (type)                => ipcRenderer.invoke('default:load', type),
  onBeforeClose: (cb)                  => ipcRenderer.on('app:before-close', () => cb()),
  confirmClose:  ()                    => ipcRenderer.invoke('app:confirm-close'),
  getVersion:    ()                    => ipcRenderer.invoke('app:get-version')
});
