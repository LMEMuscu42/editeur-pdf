// electron test/render.js <input.pdf> <outprefix> : screenshots each page as opened by the app (no edits)
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'); const fs = require('fs');
const [input, prefix] = process.argv.slice(-2);
ipcMain.handle('initial-file', () => null); ipcMain.on('set-dirty', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 1000, show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js') } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  const b64 = fs.readFileSync(input).toString('base64');
  const n = await win.webContents.executeJavaScript(`(async()=>{const ed=window.__editor;await ed.openEntry({path:null,name:'out.pdf',data:Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0))});return ed.state.pages.length})()`);
  for (let i = 0; i < n; i++) {
    await win.webContents.executeJavaScript(`(async()=>{document.querySelectorAll('.thumb')[${i}].click();await new Promise(r=>setTimeout(r,200));const s=window.__editor.state;s.scale=0.9;document.querySelector('#btnZoomOut').click();document.querySelector('#btnZoomIn').click();await new Promise(r=>setTimeout(r,900));})()`);
    fs.writeFileSync(`${prefix}-p${i + 1}.png`, (await win.webContents.capturePage()).toPNG());
  }
  console.log('pages', n); app.quit();
});
