const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

app.setName("PharCyde's ezQuake Config Editor");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('config-editor.html');
  win.setTitle("PharCyde's ezQuake Config Editor");
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('dialog:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'Config Files', extensions: ['cfg'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  const filePath = filePaths[0];
  const content = fs.readFileSync(filePath, 'utf8');
  return { filePath, content };
});

ipcMain.handle('file:save', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dialog:save', async (event, defaultName, content) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'Config Files', extensions: ['cfg'] }]
  });
  if (canceled || !filePath) return { success: false };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
