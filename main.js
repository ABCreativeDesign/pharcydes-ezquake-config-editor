const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

app.setName("PharCyde's ezQuake Config Editor");

// Custom application menu — same as Electron's default but with Toggle Developer Tools removed from View
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // DevTools available in dev only — kept out of the packaged .exe
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

let mainWin = null;
let forceClose = false;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 700,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    }
  });
  win.loadFile('config-editor.html');
  win.setTitle("PharCyde's ezQuake Config Editor");

  // Intercept window close — give the renderer a chance to confirm if there are unsaved changes
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    win.webContents.send('app:before-close');
  });

  mainWin = win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildAppMenu());
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    Menu.setApplicationMenu(buildAppMenu());
    createWindow();
  }
});

ipcMain.handle('dialog:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'Config Files', extensions: ['cfg'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  const filePath = filePaths[0];
  const content = fs.readFileSync(filePath, 'utf8');
  // Try to read sibling ctf.cfg in same directory (returns null if missing)
  const ctfPath = path.join(path.dirname(filePath), 'ctf.cfg');
  let ctfContent = null;
  try {
    if (filePath.toLowerCase() !== ctfPath.toLowerCase() && fs.existsSync(ctfPath)) {
      ctfContent = fs.readFileSync(ctfPath, 'utf8');
    }
  } catch (err) {}
  return { filePath, content, ctfPath, ctfContent };
});

ipcMain.handle('file:save', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('app:confirm-close', () => {
  forceClose = true;
  if (mainWin) mainWin.close();
});

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('default:load', async (event, type) => {
  const file = type === 'ctf' ? 'default-ctf.cfg' : 'default-dm.cfg';
  const filePath = path.join(__dirname, 'defaults', file);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, type, filename: file };
  } catch (err) {
    return { error: err.message };
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
