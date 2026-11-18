const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'); const fs = require('fs');
const [input] = process.argv.slice(-1);
ipcMain.handle('initial-file', () => null); ipcMain.on('set-dirty', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 950, show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js') } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  const b64 = fs.readFileSync(input).toString('base64');
  await win.webContents.executeJavaScript(`window.__editor.openEntry({path:null,name:'in.pdf',data:Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0))})`);
  await new Promise(r => setTimeout(r, 1000));
  console.log(await win.webContents.executeJavaScript(`(async()=>{const E=window.__editor;const t=await E.getTextItems(E.state.pages[0]);return t.items.map(it=>{const bx=E.itemScreenBox(it,E.state.vp);return it.str+' '+JSON.stringify(bx)+' '+(()=>{try{return E.sampleColor(bx)}catch(e){return e.message}})()}).join(' | ')})()`));
  console.log(await win.webContents.executeJavaScript(`(()=>{const b=document.querySelector('#base');const vp=window.__editor.state.vp;const [x,y]=vp.toScreen(100,724);const d=b.getContext('2d').getImageData(0,0,b.width,b.height).data;let n=0,min=999;for(let i=0;i<d.length;i+=4){const l=d[i]+d[i+1]+d[i+2];if(l<min)min=l;if(l<700)n++}return JSON.stringify({w:b.width,h:b.height,dark:n,min,dpr:devicePixelRatio,x,y})})()`));
  app.quit();
});
