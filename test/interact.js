// electron test/interact.js <input.pdf> <outdir> : drives the UI with real mouse/keyboard events
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'); const fs = require('fs');
const [input, outDir] = process.argv.slice(-2);
ipcMain.handle('initial-file', () => null); ipcMain.on('set-dirty', () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 950, show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js') } });
  const logs = []; win.webContents.on('console-message', (e, l, m) => logs.push(`[${l}] ${m}`));
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  const wc = win.webContents; const js = (c) => wc.executeJavaScript(c);
  const b64 = fs.readFileSync(input).toString('base64');
  await js(`window.__editor.openEntry({path:null,name:'in.pdf',data:Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0))})`);
  await wait(2500);
  const pt = (x, y) => js(`(()=>{const r=document.querySelector('#overlay').getBoundingClientRect();const [a,b]=window.__editor.state.vp.toScreen(${x},${y});return [Math.round(r.left+a),Math.round(r.top+b)]})()`);
  const click = async ([x, y]) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); await wait(60); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await wait(30); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await wait(250); };
  const dragm = async ([x0, y0], [x1, y1]) => { wc.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 }); await wait(30); wc.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers: ['leftButtonDown'] }); await wait(30); for (let i = 1; i <= 8; i++) { wc.sendInputEvent({ type: 'mouseMove', x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8, button: 'left', modifiers: ['leftButtonDown'] }); await wait(20); } wc.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 }); await wait(200); };
  const type = async (t) => { for (const ch of t) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await wait(10); } };

  // 1. edit existing text
  await js(`window.__editor.setTool('edittext')`);
  await click(await pt(150, 724));
  console.log('after click:', await js(`JSON.stringify(window.__editor.state.pages[0].annots.map(a=>a.type+':'+(a.color||'')))`));
  await js(`document.activeElement.select()`);
  await type('Texte remplacé !');
  // 2. add new text with text tool (clicking elsewhere commits the edit first)
  await js(`window.__editor.setTool('text')`);
  await click(await pt(72, 600));
  await type('Nouveau texte');
  await click(await pt(300, 300)); // commits
  await js(`window.__ev=[];['pointerdown','pointermove','pointerup'].forEach(t=>document.querySelector('#overlay').addEventListener(t,e=>window.__ev.push(t+':'+e.buttons)))`);
  // 3. draw a rectangle
  await js(`window.__editor.setTool('rect')`);
  await dragm(await pt(80, 500), await pt(250, 420));
  console.log('events', await js('window.__ev.join(" ")'));
  // 4. select + move the rectangle
  await js(`window.__editor.setTool('select')`);
  await dragm(await pt(80, 460), await pt(380, 460));
  await wait(400);
  const annots = await js(`JSON.stringify(window.__editor.state.pages[0].annots.map(a=>({t:a.type,text:a.text,x:Math.round(a.x||a.x1),y:Math.round(a.y||a.y1)})))`);
  console.log(annots);
  await js(`document.querySelector('#btnUndo').click()`); await wait(200);
  console.log('after undo:', await js(`JSON.stringify(window.__editor.state.pages[0].annots.map(a=>a.type+':'+Math.round(a.x)))`));
  console.log('redo disabled?', await js(`document.querySelector('#btnRedo').disabled`)); await js(`document.querySelector('#btnRedo').click()`); await wait(600); console.log('after redo:', await js(`JSON.stringify(window.__editor.state.pages[0].annots.map(a=>a.type+':'+Math.round(a.x)+':'+(a.color||'')))`));
  fs.writeFileSync(path.join(outDir, 'interact.png'), (await wc.capturePage()).toPNG());
  console.log(logs.filter((l) => !l.includes('Electron Security')).join('\n'));
  app.quit();
});
