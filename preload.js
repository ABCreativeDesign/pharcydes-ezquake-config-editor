const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:   ()                    => ipcRenderer.invoke('dialog:open'),
  saveFile:   (filePath, content)   => ipcRenderer.invoke('file:save', filePath, content),
  exportFile: (defaultName, content)=> ipcRenderer.invoke('dialog:save', defaultName, content)
});
