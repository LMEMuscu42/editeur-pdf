// Automated smoke test: electron test/e2e.js <input.pdf> <outdir>
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const [input, outDir] = process.argv.slice(-2);
ipcMain.handle('initial-file', () => null);
ipcMain.on('set-dirty', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1300, height: 850, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true },
  });
  const logs = [];
  win.webContents.on('console-message', (e, level, msg) => logs.push(`[${level}] ${msg}`));
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  const data = fs.readFileSync(input);
  const b64 = data.toString('base64');
  try {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const ed = window.__editor;
      const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
      await ed.openEntry({ path: null, name: 'test.pdf', data: bytes });
      await new Promise(r => setTimeout(r, 800));
      const st = ed.state;
      const p0 = st.pages[0];
      const [, , w, h] = p0.view;
      p0.annots.push(
        { id: 't1', type: 'text', x: 72, y: h - 300, text: 'Bonjour é à ç €\\nDeuxième ligne', size: 18, font: 'Helvetica-Bold', color: '#c00000', rot: 0 },
        { id: 'h1', type: 'highlight', x: 60, y: h - 320, w: 250, h: 40, color: '#fde047' },
        { id: 'r1', type: 'rect', x: 60, y: h - 420, w: 200, h: 60, color: '#1d4ed8', stroke: 3, fill: false },
        { id: 'a1', type: 'arrow', x1: 300, y1: h - 450, x2: 450, y2: h - 380, color: '#e11d48', stroke: 2 },
        { id: 'i1', type: 'ink', points: [[100, 200], [150, 240], [200, 210], [260, 260]], color: '#16a34a', stroke: 3 },
        { id: 'w1', type: 'whiteout', x: 300, y: 100, w: 120, h: 40 },
      );
      if (st.pages[1]) { st.pages[1].rot = 90; st.pages[1].annots.push({ id: 't2', type: 'text', x: 100, y: 100, text: 'Page pivotée', size: 20, font: 'Times', color: '#000000', rot: 90 }); }
      ed.setTool('select');
      window.dispatchEvent(new Event('resize'));
      document.querySelector('#btnFit').click();
      await new Promise(r => setTimeout(r, 1200));
      const out = await ed.buildPdf(st.pages);
      let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      return { pages: st.pages.length, b64: btoa(s) };
    })()`);
    fs.writeFileSync(path.join(outDir, 'out.pdf'), Buffer.from(result.b64, 'base64'));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'screen.png'), img.toPNG());
    console.log('OK pages=' + result.pages);
  } catch (e) {
    console.log('FAIL ' + e.message);
  }
  console.log(logs.join('\n'));
  app.quit();
});
