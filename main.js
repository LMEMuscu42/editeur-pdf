const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

let win = null;
let dirty = false;

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => a.toLowerCase().endsWith('.pdf') && !a.startsWith('--'));
}

async function readEntry(p) {
  return { path: p, name: path.basename(p), data: await fs.readFile(p) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Éditeur PDF',
    backgroundColor: '#eef0f4',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('close', (e) => {
    if (!dirty) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quitter sans enregistrer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: 'Des modifications ne sont pas enregistrées.',
      detail: 'Voulez-vous vraiment quitter ?',
    });
    if (r === 1) e.preventDefault();
  });
}

ipcMain.handle('open-pdf', async (e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.multi ? 'Choisir les PDF à ajouter' : 'Ouvrir un PDF',
    filters: [{ name: 'Documents PDF', extensions: ['pdf'] }],
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(readEntry));
});

ipcMain.handle('open-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Insérer une image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    properties: ['openFile'],
  });
  if (r.canceled) return null;
  return readEntry(r.filePaths[0]);
});

ipcMain.handle('read-path', async (e, p) => readEntry(p));

ipcMain.handle('save-pdf', async (e, { data, path: target, suggestedName }) => {
  let out = target;
  if (!out) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Enregistrer le PDF',
      defaultPath: suggestedName || 'document.pdf',
      filters: [{ name: 'Documents PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    out = r.filePath;
  }
  await fs.writeFile(out, Buffer.from(data));
  return { path: out, name: path.basename(out) };
});

ipcMain.handle('confirm', async (e, { message, detail, ok }) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [ok || 'OK', 'Annuler'],
    defaultId: 0,
    cancelId: 1,
    message,
    detail,
  });
  return r.response === 0;
});

ipcMain.handle('initial-file', async () => {
  const p = fileFromArgv(process.argv);
  if (!p) return null;
  try { return await readEntry(p); } catch { return null; }
});

ipcMain.on('set-dirty', (e, d) => { dirty = !!d; });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
