// Test des fonctions v1.1 : electron test/v11.js <form.pdf> <dossier-sortie>
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const [input, outDir] = process.argv.slice(-2);
ipcMain.handle('initial-file', () => null);
ipcMain.handle('read-path', async (e, p) => ({ path: p, name: path.basename(p), data: fs.readFileSync(p) }));
ipcMain.on('set-dirty', () => {});
ipcMain.on('add-recent', () => {});
ipcMain.on('set-theme', () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 920, show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), offscreen: true } });
  win.webContents.setFrameRate(30);
  const logs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) logs.push(msg); });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c);
  const click = async ([x, y]) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y }); await wait(40);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await wait(30);
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await wait(200);
  };
  const type = async (t) => { for (const ch of t) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await wait(8); } await wait(100); };
  const key = async (k, mods = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods }); wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods }); await wait(150); };
  const center = (sel) => js(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()`);

  try {
    await js(`window.__editor.openEntry({path:${JSON.stringify(input)},name:'form.pdf',data:Uint8Array.from(atob('${fs.readFileSync(input).toString('base64')}'),c=>c.charCodeAt(0))})`);
    await wait(1800);

    // --- défilement continu
    const pages = await js(`document.querySelectorAll('#pages .page').length`);
    check('défilement continu : 3 pages affichées', pages === 3, `${pages} pages`);
    await js(`document.querySelector('#viewer').scrollTop = document.querySelectorAll('#pages .page')[2].offsetTop`);
    await wait(500);
    const cur = await js(`window.__editor.state.current`);
    check('la page courante suit le défilement', cur === 2, `courante = ${cur + 1}`);
    await js(`window.__editor.goTo(0)`); await wait(600);

    // --- formulaires
    const nFields = await js(`document.querySelectorAll('#pages .forms > [data-key]').length`);
    check('champs de formulaire détectés', nFields === 5, `${nFields} champs`);
    await click(await center('.forms > input[type=text]'));
    await type('Rémi Durand');
    await click(await center('.forms > input[type=checkbox]'));
    const radios = await js(`[...document.querySelectorAll('.forms > input[type=radio]')].map(r=>r.value)`);
    await click(await center(`.forms > input[type=radio][value="${radios[1]}"]`));
    await js(`(()=>{const s=document.querySelector('.forms > select');s.value='Saint-Étienne';s.dispatchEvent(new Event('change'))})()`);
    const fv = await js(`JSON.stringify([...window.__editor.state.formValues])`);
    check('saisie dans les champs', fv.includes('Rémi Durand') && fv.includes('true') && fv.includes('Saint-'), fv);

    // --- note
    await js(`window.__editor.setTool('note')`);
    await click(await js(`window.__editor.pagePoint(0, 420, 700)`));
    await type('Vérifier la clause 1');
    await key('Escape');
    const notes = await js(`JSON.stringify(window.__editor.state.pages[0].annots.filter(a=>a.type==='note').map(a=>a.text))`);
    check('note ajoutée', notes === '["Vérifier la clause 1"]', notes);
    await js(`document.querySelector('.side-tabs button[data-tab=comments]').click()`); await wait(600);
    const cl = await js(`document.querySelector('#commentList').innerText`);
    check('note listée dans l\'onglet Commentaires', cl.includes('Vérifier la clause 1') && cl.includes('Page 1'), cl.replace(/\s+/g, ' ').slice(0, 80));
    await js(`document.querySelector('.side-tabs button[data-tab=pages]').click()`);
    await js(`window.__editor.setTool('select')`);

    // --- numéros de page + filigrane
    await js(`document.querySelector('#btnNumbers').click()`); await wait(200);
    await js(`(()=>{const s=document.querySelector('#pnFmt');s.value='Page {n} sur {N}';s.dispatchEvent(new Event('change'))})()`);
    await js(`document.querySelector('#pnOk').click()`); await wait(200);
    await js(`document.querySelector('#btnWatermark').click()`); await wait(200);
    await js(`document.querySelector('#wmOk').click()`); await wait(300);
    const stamps = await js(`JSON.stringify(window.__editor.state.stamps)`);
    check('numérotation et filigrane appliqués', stamps.includes('Page {n} sur {N}') && stamps.includes('CONFIDENTIEL'));
    await js(`document.querySelector('#btnUndo').click()`); await wait(200);
    const afterUndo = await js(`!!window.__editor.state.stamps.watermark`);
    await js(`document.querySelector('#btnRedo').click()`); await wait(300);
    const afterRedo = await js(`!!window.__editor.state.stamps.watermark`);
    check('annuler / rétablir le filigrane', afterUndo === false && afterRedo === true);

    // --- recherche
    await key('F', ['control']);
    await type('loyer');
    await wait(900);
    const sr = await js(`({n: window.__editor.search.results.length, i: window.__editor.search.index, label: document.querySelector('#findCount').textContent})`);
    check('recherche « loyer »', sr.n === 3 && sr.i === 0, `${sr.n} résultats, compteur « ${sr.label} »`);
    await key('Return'); await wait(400);
    const sr2 = await js(`({i: window.__editor.search.index, cur: window.__editor.state.current})`);
    check('résultat suivant (Entrée)', sr2.i === 1 && sr2.cur === 1, `résultat ${sr2.i + 1}, page ${sr2.cur + 1}`);
    const accent = await js(`(async()=>{document.querySelector('#findInput').value='SIGNE';await window.__editor.runSearch();return window.__editor.search.results.length})()`);
    check('recherche sans accents ni majuscules (« SIGNE » trouve « signé »)', accent === 3, `${accent} résultats`);
    await js(`(async()=>{document.querySelector('#findInput').value='loyer';await window.__editor.runSearch();})()`); await wait(300);
    await js(`window.__editor.goTo(0)`); await wait(800);
    fs.writeFileSync(path.join(outDir, 'v11-light.png'), (await wc.capturePage()).toPNG());

    // --- mode sombre
    const themeBefore = await js(`document.documentElement.dataset.theme`);
    await js(`document.querySelector('#btnTheme').click()`); await wait(500);
    const theme = await js(`document.documentElement.dataset.theme`);
    check('bascule du thème', theme !== themeBefore, `${themeBefore} -> ${theme}`);
    fs.writeFileSync(path.join(outDir, 'v11-dark.png'), (await wc.capturePage()).toPNG());
    await key('Escape');

    // --- fonctions de base avec le nouvel affichage
    const drag = async ([x0, y0], [x1, y1]) => {
      wc.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 }); await wait(30);
      wc.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers: ['leftButtonDown'] }); await wait(30);
      for (let k = 1; k <= 8; k++) { wc.sendInputEvent({ type: 'mouseMove', x: x0 + (x1 - x0) * k / 8, y: y0 + (y1 - y0) * k / 8, modifiers: ['leftButtonDown'] }); await wait(20); }
      wc.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 }); await wait(250);
    };
    await js(`window.__editor.goTo(0)`); await wait(700);
    await js(`window.__editor.setTool('edittext')`);
    await click(await js(`window.__editor.pagePoint(0, 150, 744)`));
    await js(`document.activeElement.select()`);
    await type('Texte remplacé');
    await click(await js(`window.__editor.pagePoint(0, 300, 300)`));
    await js(`window.__editor.setTool('rect')`);
    await drag(await js(`window.__editor.pagePoint(0, 400, 610)`), await js(`window.__editor.pagePoint(0, 500, 560)`));
    await js(`window.__editor.setTool('select')`);
    const rectY0 = await js(`Math.round(window.__editor.state.pages[0].annots.find(a=>a.type==='rect').y)`);
    await drag(await js(`window.__editor.pagePoint(0, 450, 585)`), await js(`window.__editor.pagePoint(0, 450, 535)`));
    const rectY1 = await js(`Math.round(window.__editor.state.pages[0].annots.find(a=>a.type==='rect').y)`);
    const types = await js(`window.__editor.state.pages[0].annots.map(a=>a.type+(a.text?':'+a.text:'')).join(', ')`);
    check('modifier un texte + rectangle', types.includes('text:Texte remplacé') && types.includes('whiteout') && types.includes('rect'), types);
    check('déplacer le rectangle', rectY1 - rectY0 <= -40, `y ${rectY0} -> ${rectY1}`);
    await key('Z', ['control']);
    const rectY2 = await js(`Math.round(window.__editor.state.pages[0].annots.find(a=>a.type==='rect').y)`);
    check('annuler le déplacement (Ctrl+Z)', rectY2 === rectY0, `y = ${rectY2}`);
    await js(`window.__editor.select(null)`);
    await wait(600);
    fs.writeFileSync(path.join(outDir, 'v11-dark2.png'), (await wc.capturePage()).toPNG());

    // --- récents
    const recent = await js(`JSON.parse(localStorage.getItem('recentFiles')||'[]').map(r=>r.name)`);
    check('fichier ajouté aux récents', recent[0] === 'form.pdf', JSON.stringify(recent));

    // --- export (document complet : modification directe)
    const b64a = await js(`(async()=>{const o=await window.__editor.buildPdf(window.__editor.state.pages);let s='';for(let i=0;i<o.length;i+=0x8000)s+=String.fromCharCode.apply(null,o.subarray(i,i+0x8000));return btoa(s)})()`);
    fs.writeFileSync(path.join(outDir, 'v11-full.pdf'), Buffer.from(b64a, 'base64'));
    // --- export après suppression d'une page (copie des pages)
    await js(`(()=>{window.__editor.goTo(1);document.querySelector('#btnDelPage').click()})()`); await wait(500);
    const b64b = await js(`(async()=>{const o=await window.__editor.buildPdf(window.__editor.state.pages);let s='';for(let i=0;i<o.length;i+=0x8000)s+=String.fromCharCode.apply(null,o.subarray(i,i+0x8000));return btoa(s)})()`);
    fs.writeFileSync(path.join(outDir, 'v11-copy.pdf'), Buffer.from(b64b, 'base64'));
    check('export PDF (2 variantes)', b64a.length > 1000 && b64b.length > 1000);
  } catch (e) {
    check('exécution du test', false, e.message);
  }
  console.log(results.join('\n'));
  if (logs.length) console.log('Erreurs console :\n' + logs.join('\n'));
  app.quit();
});
