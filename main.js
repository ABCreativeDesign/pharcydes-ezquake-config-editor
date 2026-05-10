const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execFile } = require('child_process');

app.setName("PharCyde's ezQuake Config Editor");

// Portable mode: when running as the electron-builder portable .exe, redirect
// userData (localStorage, GPU cache, etc.) to a sibling folder next to the
// .exe instead of the default %APPDATA% location. This makes the app behave
// as a true portable — drop the .exe anywhere, run it, and to uninstall just
// delete the .exe + the sibling data folder. No registry, no AppData traces.
//
// Activation: only when PORTABLE_EXECUTABLE_DIR is set (electron-builder
// injects this for portable builds). In dev (`npm start`) the env var is
// unset, so userData stays at the default AppData location and dev
// localStorage isn't affected.
//
// Fallback: if the sibling location isn't writable (e.g. user dropped the
// .exe into Program Files), silently fall back to the default AppData path
// so the app still works rather than crashing on every persisted-pref write.
//
// IMPORTANT: must be called before app.whenReady() — Electron resolves
// userData on first access (e.g. when the BrowserWindow loads), and once
// resolved it can't be changed.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    const portableData = path.join(
      process.env.PORTABLE_EXECUTABLE_DIR,
      'PCs_ezQuake_data'
    );
    fs.mkdirSync(portableData, { recursive: true });
    // Probe write permission with a throwaway file. If this throws (read-only
    // mount, restricted directory, etc.) we keep the default userData path.
    const writeProbe = path.join(portableData, '.write-test');
    fs.writeFileSync(writeProbe, '');
    fs.unlinkSync(writeProbe);
    app.setPath('userData', portableData);
  } catch (err) {
    // Sibling dir isn't writable — fall back to default AppData location.
  }
}

// Suppress Chromium web-platform features this localStorage-only app has no
// use for. Each one would otherwise drop its own state file/dir into userData
// by default, cluttering the folder users inspect after running the portable
// .exe. None of these affect rendering or any feature we ship.
app.commandLine.appendSwitch(
  'disable-features',
  'DIPS,SharedStorageAPI,InterestGroupStorage,BrowsingTopics,FledgeApi'
);

// Best-effort cleanup of cruft directories/files that Chromium creates as
// side-effects but our app never uses. Removed at boot before Chromium opens
// its session, so any "lazy" artifacts (Dawn caches, blob_storage) stay gone
// across runs. Eager artifacts (Cache, Network, Shared Dictionary) will be
// recreated mid-run but at least don't accumulate stale state from prior
// versions of the app or Chromium.
try {
  const userDataDir = app.getPath('userData');
  const cruftDirs = [
    'Cache',
    'Network',
    'Shared Dictionary',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'blob_storage',
  ];
  for (const dir of cruftDirs) {
    try {
      fs.rmSync(path.join(userDataDir, dir), { recursive: true, force: true });
    } catch (e) {}
  }
  // DIPS + SharedStorage files: these are suppressed by the disable-features
  // flag above, but pre-existing copies from earlier runs/versions may linger.
  const cruftFiles = [
    'DIPS', 'DIPS-shm', 'DIPS-wal',
    'SharedStorage', 'SharedStorage-shm', 'SharedStorage-wal',
  ];
  for (const f of cruftFiles) {
    try {
      fs.unlinkSync(path.join(userDataDir, f));
    } catch (e) {}
  }
} catch (e) {}

// Known ezQuake/nQuake launcher exe names. Order matters — we prefer the
// real client (ezquake-gl.exe) over wrapper launchers (nquake.exe) so the
// `+exec` arg lands directly on the game and not on a chooser.
const EZQUAKE_EXE_NAMES = [
  'ezquake-gl.exe',
  'ezquake.exe',
  'ezquake-x86_64.exe',
  'ezquake-gl-x86_64.exe',
  'nquake.exe',
];

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
let closeFallbackTimer = null;

// Detect a `qw/` folder of a Quake install (nQuake, standalone ezQuake, or
// plain Quake — they all follow the same QW convention with id1/ + qw/
// siblings). Saves the user the navigation step on first launch. Returns
// null if nothing's found; the dialog then opens at the OS default.
// Once the renderer has its own remembered path (in localStorage), it wins.
//
// Cached per session: this runs synchronous fs.readdirSync on every entry
// in C:\, D:\, E:\ etc. — which can stall the main process for seconds on a
// slow/sleeping/disconnected drive. Result is stable for the lifetime of the
// app, so cache after the first call. `null` is also a valid cached result
// (means we already looked and found nothing — no point re-walking).
let _qwFolderCache; // undefined = not yet probed; null = probed, no match; string = found path
function detectQwFolder() {
  if (_qwFolderCache !== undefined) return _qwFolderCache;
  // Layer 1: well-known nQuake/ezQuake/Quake paths — fastest path
  const explicit = [
    'D:\\nQuake\\qw', 'C:\\nQuake\\qw', 'E:\\nQuake\\qw',
    'D:\\ezQuake\\qw', 'C:\\ezQuake\\qw',
    'C:\\Quake\\qw', 'D:\\Quake\\qw',
    'C:\\Program Files\\nQuake\\qw', 'C:\\Program Files (x86)\\nQuake\\qw',
    'C:\\Games\\nQuake\\qw', 'D:\\Games\\nQuake\\qw',
    'C:\\Games\\Quake\\qw', 'D:\\Games\\Quake\\qw',
  ];
  for (const p of explicit) {
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return (_qwFolderCache = p); } catch (e) {}
  }

  // Layer 2: scan common parent folders one level deep for any subdir that
  // contains both `id1/` and `qw/` — that's the universal Quake pattern.
  // Catches installs with non-standard names (e.g. "MyQuake/", "ZQ/", etc.).
  const roots = [
    'C:\\', 'D:\\', 'E:\\',
    'C:\\Program Files', 'C:\\Program Files (x86)',
    'C:\\Games', 'D:\\Games', 'E:\\Games',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Games') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : null,
  ].filter(Boolean);

  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const qw = path.join(dir, 'qw');
        const id1 = path.join(dir, 'id1');
        try {
          if (fs.existsSync(qw) && fs.existsSync(id1)) return (_qwFolderCache = qw);
        } catch (e) {}
      }
    } catch (e) {} // permission errors etc — keep scanning
  }
  return (_qwFolderCache = null);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 820,
    minWidth: 800,
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

  // Intercept window close — give the renderer a chance to confirm if there are unsaved changes.
  // Fallback timer: if the renderer doesn't reply within 2s (e.g. throws in its handler, or
  // the IPC bridge isn't ready), force the close anyway so the user is never stuck.
  // Dedupe: a second close attempt while the first is in flight (user hammers
  // the X, hits Alt+F4, etc.) used to stack additional 2s timers and could
  // force-close the window while the renderer's "Unsaved changes" modal was
  // still open. Now we no-op while a timer is already pending.
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    if (closeFallbackTimer) return; // already asking the renderer
    try {
      win.webContents.send('app:before-close');
    } catch (sendErr) {
      // Renderer process gone — force close immediately
      forceClose = true;
      win.close();
      return;
    }
    closeFallbackTimer = setTimeout(() => {
      closeFallbackTimer = null;
      if (!forceClose && !win.isDestroyed()) {
        forceClose = true;
        win.close();
      }
    }, 2000);
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

ipcMain.handle('dialog:open', async (event, hintDir) => {
  // Prefer the renderer's remembered last-used dir; otherwise fall back to
  // a detected nQuake install. Either is just a starting point — the user
  // can navigate freely from there.
  const startDir = hintDir || detectQwFolder() || undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    defaultPath: startDir,
    filters: [{ name: 'Config Files', extensions: ['cfg'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  const filePath = filePaths[0];
  // Wrapped: a flaky drive (USB unplug, permission flip) between picker close
  // and read would otherwise throw an unhandled rejection at the renderer's
  // .then() and silently no-op the load. Surface the error so the renderer
  // can show a message instead.
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { error: err.message, filePath };
  }
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
  // Renderer agreed to close — clear any pending fallback timer so we don't
  // double-fire close() after the renderer-driven path lands.
  if (closeFallbackTimer) {
    clearTimeout(closeFallbackTimer);
    closeFallbackTimer = null;
  }
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

// Locate the ezQuake launcher exe. Strategy: the launcher always sits at the
// install root, sibling to qw/. So given the saved file's directory (which is
// usually qw/ now that we default the save dialog there), walking up one level
// hits the install root. Fall back to the qw-detection scan if no hint.
function detectEzquakeExe(hintDir) {
  const probe = (dir) => {
    if (!dir) return null;
    for (const name of EZQUAKE_EXE_NAMES) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (e) {}
    }
    return null;
  };
  // 1. hintDir's parent (hintDir is usually qw/, parent is install root)
  if (hintDir) {
    const found = probe(path.dirname(hintDir));
    if (found) return found;
    // Some users may pass the install root directly — try that too
    const found2 = probe(hintDir);
    if (found2) return found2;
  }
  // 2. Fall back to scan-detected qw/, walk up
  const qw = detectQwFolder();
  if (qw) {
    const found = probe(path.dirname(qw));
    if (found) return found;
  }
  return null;
}

// Check whether any ezQuake/nQuake process is running. Single tasklist call,
// regex matched against the CSV image-name column. Faster than forking N
// filtered tasklists.
//
// Regex anchored to start-of-line + leading quote so it only matches the
// CSV's first column (the image name). Without the anchor, any process whose
// arbitrary CSV cell happened to contain "ezquake.exe" as a substring would
// false-positive and flip the launch button to reload mode for the wrong
// reason. Multiline + case-insensitive so we match each row independently.
function isQuakeRunning() {
  return new Promise((resolve) => {
    exec('tasklist /FO CSV /NH', { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/^"(?:ezquake|nquake)[^"]*\.exe"/im.test(stdout));
    });
  });
}

// Send the reload key to the ezQuake window via PowerShell + user32.dll.
// We embed the script as a string so there's no external file to ship.
//
// Why PostMessage (not SendInput / keybd_event):
//   ezQuake on modern builds uses raw input for keyboard, which filters out
//   synthesized events from SendInput/keybd_event — they reach the system
//   queue but the game ignores them. PostMessage delivers WM_KEYDOWN/WM_KEYUP
//   straight to the window's message queue, where the game's main loop reads
//   them via PeekMessage — same path as real keys. Doesn't require focus,
//   doesn't depend on the input device backend, works while window is in the
//   background.
//
// LPARAM layout for WM_KEYDOWN:
//   bits  0-15 = repeat count (1)
//   bits 16-23 = scancode (0x44 for F10)
//   bit  24    = extended key (0)
//   bit  29    = context (0 — Alt not down)
//   bit  30    = previous key state (0 for down, 1 for up)
//   bit  31    = transition (0 for down, 1 for up)
//
// Why F10:
//   Empty in our default configs and not bound for screenshot (F12) or
//   fullscreen (F11) on most ezQuake setups.
const SEND_RELOAD_PS = `
$ErrorActionPreference = 'Stop'
$names = @('ezquake-gl','ezquake','ezquake-x86_64','ezquake-gl-x86_64','nquake')
$proc = $null
foreach ($n in $names) {
  $p = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $proc = $p; break }
}
if (-not $proc) { exit 2 }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace EZ {
  public static class Win {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  }
}
"@
$h = $proc.MainWindowHandle
# Restore from minimized + bring to front so the user gets visual feedback
# that the reload happened. PostMessage works without focus, but the focus
# shift makes it obvious the action took effect.
if ([EZ.Win]::IsIconic($h)) { [EZ.Win]::ShowWindow($h, 9) | Out-Null }  # SW_RESTORE
[EZ.Win]::SetForegroundWindow($h) | Out-Null

$WM_KEYDOWN = 0x0100
$WM_KEYUP   = 0x0101
$VK_F10     = 0x79
# lParam: scancode 0x44 in bits 16-23, repeat count 1 in bits 0-15
$lpDown = [IntPtr]::new(0x00440001)
# lParam for KEYUP: scancode + repeat + bits 30 (prev down) + 31 (transition)
$lpUp   = [IntPtr]::new(0xC0440001)

[EZ.Win]::PostMessage($h, $WM_KEYDOWN, [IntPtr]::new($VK_F10), $lpDown) | Out-Null
Start-Sleep -Milliseconds 50
[EZ.Win]::PostMessage($h, $WM_KEYUP, [IntPtr]::new($VK_F10), $lpUp) | Out-Null
exit 0
`;

function sendReloadKeyToEzquake() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SEND_RELOAD_PS],
      { windowsHide: true, timeout: 4000 },
      (err) => resolve(!err)
    );
  });
}

ipcMain.handle('quake:running', async () => {
  return await isQuakeRunning();
});

// Sanitize a renderer-supplied cfg name before passing it as a `+exec` arg.
// Allowed: word chars, hyphens, underscores, dots — exactly one .cfg suffix.
// Forbid path separators (anti-traversal) and shell metacharacters. Falls back
// to "config.cfg" on any rejection.
function _safeCfgName(name) {
  if (typeof name !== 'string') return 'config.cfg';
  const base = name.split(/[\\/]/).pop(); // strip any path components
  if (!/^[\w.\-]+\.cfg$/i.test(base)) return 'config.cfg';
  return base;
}

ipcMain.handle('quake:launch', async (event, hintDir, cfgName) => {
  const exe = detectEzquakeExe(hintDir);
  if (!exe) {
    // No exe found — let the renderer prompt the user to pick one. The pick
    // is authoritative: we trust its parent as basedir rather than letting
    // hintDir override it (the user-picked location wins).
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Locate ezQuake executable',
      defaultPath: hintDir ? path.dirname(hintDir) : undefined,
      filters: [{ name: 'ezQuake executable', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { success: false, error: 'No exe selected' };
    return _spawnEzquake(filePaths[0], hintDir, cfgName, /*userPicked*/ true);
  }
  return _spawnEzquake(exe, hintDir, cfgName, /*userPicked*/ false);
});

function _spawnEzquake(exe, hintDir, cfgName, userPicked) {
  // basedir = parent of qw/. ezQuake needs cwd = basedir for it to find id1/, qw/, etc.
  let basedir = path.dirname(exe);
  // For auto-detected exes only: if the renderer passed a hintDir whose parent
  // contains a qw/, prefer that as the basedir — it matches where the user
  // actually saves their config. For user-picked exes, the picked location is
  // authoritative — never let hintDir override (was a real bug when user kept
  // configs in one install dir but pointed at an exe in another).
  if (!userPicked && hintDir) {
    const parent = path.dirname(hintDir);
    if (fs.existsSync(path.join(parent, 'qw'))) basedir = parent;
  }
  const safeName = _safeCfgName(cfgName);
  try {
    const child = spawn(exe, ['+exec', safeName], {
      cwd: basedir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { success: true, exe, basedir, cfgName: safeName };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

ipcMain.handle('quake:reload', async () => {
  const ok = await sendReloadKeyToEzquake();
  return { success: ok };
});

ipcMain.handle('dialog:save', async (event, defaultName, content, hintDir) => {
  // If the renderer has a remembered dir, pre-fill the save dialog with it
  // joined to the suggested filename. Otherwise fall back to detected nQuake.
  const startDir = hintDir || detectQwFolder();
  const defaultPath = startDir ? path.join(startDir, defaultName) : defaultName;
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath,
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
