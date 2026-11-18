const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('data:text/html,<canvas id=c width=512 height=512></canvas>');
  const b64 = await w.webContents.executeJavaScript(`(()=>{const c=document.getElementById('c'),x=c.getContext('2d');
  const r=(X,Y,W,H,R)=>{x.beginPath();x.roundRect(X,Y,W,H,R)};
  r(96,40,320,432,36);x.fillStyle='#ffffff';x.fill();x.lineWidth=14;x.strokeStyle='#1e3a8a';x.stroke();
  x.fillStyle='#dc2626';r(60,300,250,120,24);x.fill();
  x.fillStyle='#fff';x.font='bold 92px Segoe UI';x.textAlign='center';x.textBaseline='middle';x.fillText('PDF',185,362);
  x.strokeStyle='#94a3b8';x.lineWidth=16;x.lineCap='round';for(const y of [120,170,220]){x.beginPath();x.moveTo(150,y);x.lineTo(360,y);x.stroke();}
  x.save();x.translate(400,330);x.rotate(Math.PI/4);x.fillStyle='#2563eb';r(-26,-150,52,220,10);x.fill();x.fillStyle='#fbbf24';x.beginPath();x.moveTo(-26,70);x.lineTo(26,70);x.lineTo(0,120);x.closePath();x.fill();x.restore();
  return c.toDataURL('image/png').split(',')[1]})()`);
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), Buffer.from(b64, 'base64')); app.quit();
});
