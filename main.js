// main.js
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

/** --- GPU stability: most important lines --- **/
app.disableHardwareAcceleration();
// If needed, uncomment one of the following:
// app.commandLine.appendSwitch('use-angle', 'swiftshader');
// app.commandLine.appendSwitch('disable-direct-composition');
// app.commandLine.appendSwitch('disable-gpu');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'PaperTrail',
    backgroundColor: '#0f172a',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'), // ✅ correct place
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false
    }

  });

  mainWindow.on('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile('index.html');

  // Optional: catch renderer crashes to surface errors quickly
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer crashed:', details);
  });
  mainWindow.webContents.on('gpu-process-crashed', (_e, killed) => {
    console.error('GPU process crashed. Killed:', killed);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* IPC: App Info */
ipcMain.handle('get-app-info', async () => {
  return { name: app.getName(), version: app.getVersion(), platform: process.platform };
});

/* IPC: Export data to JSON */
ipcMain.handle('export-data', async (_evt, data) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export FocusFlow Backup',
    defaultPath: `focusflow-backup-${new Date().toISOString().slice(0,10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { canceled: false, filePath };
  } catch (err) {
    return { canceled: true, error: err?.message || String(err) };
  }
});

/* IPC: Import data from JSON */
ipcMain.handle('import-data', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import FocusFlow Backup',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths?.[0]) return { canceled: true };
  try {
    const text = fs.readFileSync(filePaths[0], 'utf-8');
    const data = JSON.parse(text);
    return { canceled: false, data };
  } catch (err) {
    return { canceled: true, error: err?.message || String(err) };
  }
});

/* Optional: open external links safely */
ipcMain.handle('open-external', async (_evt, url) => {
  await shell.openExternal(url);
  return true;
});

/* Notifications */
ipcMain.handle('notify', async (_evt, payload) => {
  try {
    const n = new Notification({
      title: payload?.title || 'FocusFlow',
      body: payload?.body || '',
      silent: !!payload?.silent
    });
    n.show();
    return true;
  } catch {
    return false;
  }
});
