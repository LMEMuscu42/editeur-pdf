import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

const PDFJS_BASE = new URL('../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.mjs';
const {
  PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode,
  PDFName, PDFDict, PDFRef, PDFHexString, PDFString, PDFObjectCopier,
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
} = window.PDFLib;

const api = window.api;
const $ = (s) => document.querySelector(s);
const dpr = () => window.devicePixelRatio || 1;
const clone = (o) => JSON.parse(JSON.stringify(o));
const norm = (r) => ((r % 360) + 360) % 360;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
let uid = Date.now() % 100000;
const nid = () => 'n' + (uid++).toString(36);

// ================================================================ constantes
const FONTS = {
  'Helvetica':      { label: 'Helvetica',      css: 'Helvetica, Arial, sans-serif',      weight: 'normal', std: 'Helvetica' },
  'Helvetica-Bold': { label: 'Helvetica gras', css: 'Helvetica, Arial, sans-serif',      weight: 'bold',   std: 'HelveticaBold' },
  'Times':          { label: 'Times',          css: '"Times New Roman", Times, serif',   weight: 'normal', std: 'TimesRoman' },
  'Times-Bold':     { label: 'Times gras',     css: '"Times New Roman", Times, serif',   weight: 'bold',   std: 'TimesRomanBold' },
  'Courier':        { label: 'Courier',        css: '"Courier New", Courier, monospace', weight: 'normal', std: 'Courier' },
};
const cssFont = (a, s) => `${FONTS[a.font].weight} ${a.size * s}px ${FONTS[a.font].css}`;
const BASELINE = 0.94;   // haut de ligne -> ligne de base, en em
const LINE_H = 1.2;
const NOTE_SIZE = 20;    // taille de l'icône de note, en points

const TOOL_HINTS = {
  select: 'Cliquez sur un élément pour le sélectionner, glissez pour le déplacer. Les champs de formulaire se remplissent directement.',
  text: 'Cliquez sur la page pour écrire. Entrée = nouvelle ligne, Ctrl+Entrée ou clic ailleurs = valider, Échap = annuler.',
  edittext: 'Survolez un texte du PDF et cliquez dessus pour le remplacer.',
  highlight: 'Glissez pour surligner une zone.',
  note: 'Cliquez sur la page pour ajouter une note (commentaire).',
  rect: 'Glissez pour dessiner un rectangle.',
  line: 'Glissez pour tracer une ligne.',
  arrow: 'Glissez pour tracer une flèche.',
  ink: 'Dessinez librement à la souris ou au stylet.',
  whiteout: 'Glissez pour recouvrir une zone de blanc (pour masquer du contenu).',
};

const defaultStyles = {
  text: { color: '#000000', size: 14, font: 'Helvetica' },
  highlight: { color: '#fde047' },
  note: { color: '#fbbf24' },
  rect: { color: '#e11d48', stroke: 2, fill: false },
  line: { color: '#e11d48', stroke: 2 },
  arrow: { color: '#e11d48', stroke: 2 },
  ink: { color: '#1d4ed8', stroke: 2 },
};
const toolStyles = clone(defaultStyles);
try {
  const saved = JSON.parse(localStorage.getItem('toolStyles') || 'null');
  if (saved) for (const k in toolStyles) Object.assign(toolStyles[k], saved[k] || {});
} catch { /* ignore */ }
const saveStyles = () => { try { localStorage.setItem('toolStyles', JSON.stringify(toolStyles)); } catch { /* ignore */ } };
const styleKeyFor = (type) => (type === 'edittext' ? 'text' : type);

// ================================================================ état
const state = {
  sources: [],      // { bytes, pdf, name, encrypted }
  pages: [],        // { id, src, index, view:[x0,y0,x1,y1], baseRot, rot, annots:[] }
  images: {},       // id -> { bytes, kind, el, w, h }
  stamps: { pageNumbers: null, watermark: null },
  formValues: new Map(),  // "src|nomDuChamp" -> valeur saisie
  formMeta: new Map(),
  current: 0,
  scale: 1,
  tool: 'select',
  sel: null,        // { page, id }
  filePath: null,
  fileName: null,
  dirty: false,
};
const hist = { undo: [], redo: [] };
const pdfPageCache = new Map();
const textCache = new Map();
const annotCache = new Map();
const thumbBaseCache = new Map();
const renderCache = new Map();

const totalRot = (p) => norm(p.baseRot + p.rot);
const curPage = () => state.pages[state.current] || null;
const srcKey = (p) => (p.src == null ? 'blank:' + p.view.join(',') : p.src + ':' + p.index);

// ================================================================ géométrie
// Même transformation que PageViewport de pdf.js (rotation horaire, y vers le bas à l'écran).
function makeVp(view, rot, s) {
  const [xMin, yMin, xMax, yMax] = view;
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
  let A, B, C, D;
  switch (norm(rot)) {
    case 90: A = 0; B = 1; C = 1; D = 0; break;
    case 180: A = -1; B = 0; C = 0; D = 1; break;
    case 270: A = 0; B = -1; C = -1; D = 0; break;
    default: A = 1; B = 0; C = 0; D = -1;
  }
  let ox, oy, w, h;
  if (A === 0) {
    ox = Math.abs(cy - yMin) * s; oy = Math.abs(cx - xMin) * s;
    w = Math.abs(yMax - yMin) * s; h = Math.abs(xMax - xMin) * s;
  } else {
    ox = Math.abs(cx - xMin) * s; oy = Math.abs(cy - yMin) * s;
    w = Math.abs(xMax - xMin) * s; h = Math.abs(yMax - yMin) * s;
  }
  const t = [A * s, B * s, C * s, D * s, ox - A * s * cx - C * s * cy, oy - B * s * cx - D * s * cy];
  const det = t[0] * t[3] - t[1] * t[2];
  return {
    width: w, height: h, scale: s, rot: norm(rot),
    toScreen: (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]],
    toPdf: (X, Y) => [
      (t[3] * (X - t[4]) - t[2] * (Y - t[5])) / det,
      (-t[1] * (X - t[4]) + t[0] * (Y - t[5])) / det,
    ],
  };
}
function bboxOf(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}
function screenRectToPdf(vp, r) {
  const [ax, ay] = vp.toPdf(r.x, r.y);
  const [bx, by] = vp.toPdf(r.x + r.w, r.y + r.h);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}
const rectFrom = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) });

// ================================================================ interface : petits outils
let toastTimer = null;
function toast(msg, isError = false, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text) {
  $('#busy').hidden = !text;
  $('#busyText').textContent = text || '';
}
function setDirty(d) {
  state.dirty = d;
  api.setDirty(d);
  updateTitle();
}
function updateTitle() {
  const name = state.fileName || (state.pages.length ? 'Sans titre.pdf' : '');
  document.title = (state.dirty ? '• ' : '') + (name ? name + ' – ' : '') + 'Éditeur PDF';
  $('#docTitle').textContent = name ? name + (state.dirty ? '  •  modifié' : '') : '';
  updateStatus();
}
function updateStatus() {
  const n = state.pages.length;
  $('#statusLeft').textContent = n
    ? `${state.fileName || 'Sans titre.pdf'}  —  Page ${state.current + 1} / ${n}${state.dirty ? '  —  modifié' : ''}`
    : 'Aucun document ouvert';
  $('#statusRight').textContent = n ? (TOOL_HINTS[state.tool] || '') : '';
  $('#pageCounter').textContent = n ? `Page ${state.current + 1} / ${n}` : 'Pages';
  $('#zoomLabel').textContent = Math.round(state.scale * 100) + ' %';
}
function updateButtons() {
  const has = state.pages.length > 0;
  for (const id of ['btnSave', 'btnSaveAs', 'btnRotL', 'btnRotR', 'btnDelPage', 'btnMerge', 'btnExtract',
    'btnZoomIn', 'btnZoomOut', 'btnFit', 'btnImage', 'btnSign', 'btnPageUp', 'btnPageDown',
    'btnNumbers', 'btnWatermark', 'btnSearch']) {
    $('#' + id).disabled = !has;
  }
  document.querySelectorAll('button[data-tool]').forEach((b) => { b.disabled = !has; });
  $('#btnUndo').disabled = !hist.undo.length;
  $('#btnRedo').disabled = !hist.redo.length;
  $('#btnDelete').disabled = !selectedAnnot();
  $('#btnPageUp').disabled = !has || state.current === 0;
  $('#btnPageDown').disabled = !has || state.current >= state.pages.length - 1;
}

function askText(title, label, type = 'password') {
  return new Promise((resolve) => {
    const m = $('#modalPrompt'), inp = $('#promptInput');
    $('#promptTitle').textContent = title;
    $('#promptLabel').textContent = label;
    inp.type = type; inp.value = '';
    m.hidden = false;
    setTimeout(() => inp.focus(), 0);
    const done = (v) => {
      m.hidden = true;
      $('#promptOk').onclick = $('#promptCancel').onclick = inp.onkeydown = null;
      resolve(v);
    };
    $('#promptOk').onclick = () => done(inp.value);
    $('#promptCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); };
  });
}
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// ================================================================ historique
const snapshot = () => JSON.stringify({ pages: state.pages, stamps: state.stamps });
function restoreSnapshot(s) {
  const o = JSON.parse(s);
  state.pages = o.pages;
  state.stamps = o.stamps || { pageNumbers: null, watermark: null };
}
function pushHistory(snap = snapshot()) {
  hist.undo.push(snap);
  if (hist.undo.length > 200) hist.undo.shift();
  hist.redo.length = 0;
  setDirty(true);
  updateButtons();
}
function undo() {
  finishEditing(); closeNote();
  if (!hist.undo.length) return;
  hist.redo.push(snapshot());
  restoreSnapshot(hist.undo.pop());
  setDirty(true);
  afterStructureChange();
}
function redo() {
  finishEditing(); closeNote();
  if (!hist.redo.length) return;
  hist.undo.push(snapshot());
  restoreSnapshot(hist.redo.pop());
  setDirty(true);
  afterStructureChange();
}

// ================================================================ chargement
async function addSource(bytes, name) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: PDFJS_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
    isEvalSupported: false,
  });
  let encrypted = false;
  task.onPassword = (update, reason) => {
    encrypted = true;
    const msg = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? 'Mot de passe incorrect, réessayez :' : `« ${name} » est protégé par un mot de passe :`;
    askText('Document protégé', msg).then((pw) => {
      if (pw == null) task.destroy(); else update(pw);
    });
  };
  const pdf = await task.promise;
  const srcIndex = state.sources.push({ bytes, pdf, name, encrypted }) - 1;
  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const p = await pdf.getPage(i + 1);
    pdfPageCache.set(srcIndex + ':' + i, Promise.resolve(p));
    pages.push({ id: nid(), src: srcIndex, index: i, view: [...p.view], baseRot: p.rotate || 0, rot: 0, annots: [] });
  }
  return pages;
}
function getPdfPage(page) {
  if (page.src == null) return Promise.resolve(null);
  const key = page.src + ':' + page.index;
  if (!pdfPageCache.has(key)) pdfPageCache.set(key, state.sources[page.src].pdf.getPage(page.index + 1));
  return pdfPageCache.get(key);
}
function getTextContent(page) {
  if (page.src == null) return Promise.resolve({ items: [], styles: {} });
  const key = srcKey(page);
  if (!textCache.has(key)) {
    textCache.set(key, getPdfPage(page).then((pp) => pp.getTextContent())
      .then((tc) => ({ items: tc.items.filter((it) => typeof it.str === 'string'), styles: tc.styles }))
      .catch(() => ({ items: [], styles: {} })));
  }
  return textCache.get(key);
}
function getPageAnnots(page) {
  if (page.src == null) return Promise.resolve([]);
  const key = srcKey(page);
  if (!annotCache.has(key)) {
    annotCache.set(key, getPdfPage(page).then((pp) => pp.getAnnotations({ intent: 'display' })).catch(() => []));
  }
  return annotCache.get(key);
}

function resetDocument() {
  finishEditing(); closeNote();
  for (const s of state.sources) { try { s.pdf.destroy(); } catch { /* ignore */ } }
  state.sources = []; state.pages = []; state.images = {};
  state.stamps = { pageNumbers: null, watermark: null };
  state.formValues.clear(); state.formMeta.clear();
  state.current = 0; state.sel = null; state.filePath = null; state.fileName = null;
  pdfPageCache.clear(); textCache.clear(); annotCache.clear(); thumbBaseCache.clear(); renderCache.clear();
  search.cache.clear(); clearSearchResults();
  hist.undo.length = 0; hist.redo.length = 0;
}
async function confirmDiscard() {
  if (!state.dirty) return true;
  return api.confirm({ message: 'Des modifications ne sont pas enregistrées.', detail: 'Continuer et les abandonner ?', ok: 'Continuer' });
}
function fitScaleFor(page) {
  if (!page) return 1;
  const w1 = makeVp(page.view, totalRot(page), 1).width;
  return clamp((viewer.clientWidth - 72) / w1, 0.2, 3);
}
async function openEntry(entry) {
  busy('Ouverture…');
  try {
    const bytes = new Uint8Array(entry.data);
    resetDocument();
    state.pages = await addSource(bytes, entry.name);
    state.filePath = entry.path || null;
    state.fileName = entry.name;
    setDirty(false);
    if (entry.path) addRecent(entry.path, entry.name);
    showDocument();
    state.scale = fitScaleFor(state.pages[0]);
    afterStructureChange();
    viewer.scrollTop = 0; viewer.scrollLeft = 0;
    if (!$('#findbar').hidden && $('#findInput').value.trim()) runSearch();
  } catch (e) {
    console.error(e);
    resetDocument();
    afterStructureChange();
    toast('Impossible d\'ouvrir ce fichier : ' + (e.message || e), true, 6000);
  } finally { busy(null); }
}
async function openDialog() {
  if (!(await confirmDiscard())) return;
  const files = await api.openPdf(false);
  if (files.length) await openEntry(files[0]);
}
const blankPage = (w, h) => ({ id: nid(), src: null, index: 0, view: [0, 0, w, h], baseRot: 0, rot: 0, annots: [] });
async function newDocument() {
  if (!(await confirmDiscard())) return;
  resetDocument();
  state.pages = [blankPage(595.28, 841.89)];
  setDirty(true);
  showDocument();
  state.scale = fitScaleFor(state.pages[0]);
  afterStructureChange();
}
function showDocument() {
  $('#empty').hidden = state.pages.length > 0;
}

// ================================================================ vues des pages (défilement continu)
const viewer = $('#viewer');
const pagesEl = $('#pages');
const views = [];
let viewsGen = 0;
const io = new IntersectionObserver(onIntersect, { root: viewer, rootMargin: '700px 0px' });

function buildViews() {
  viewsGen++;
  io.disconnect();
  pagesEl.textContent = '';
  views.length = 0;
  const frag = document.createDocumentFragment();
  state.pages.forEach((page, i) => {
    const vp = makeVp(page.view, totalRot(page), state.scale);
    const el = document.createElement('div');
    el.className = 'page' + (i === state.current ? ' active-page' : '');
    el.dataset.index = i;
    el.style.width = vp.width + 'px';
    el.style.height = vp.height + 'px';
    const base = document.createElement('canvas');
    base.className = 'base';
    const ov = document.createElement('canvas');
    ov.className = 'overlay';
    el.append(base, ov);
    frag.append(el);
    views.push({ el, base, ov, vp, key: null, visible: false, formsBuilt: false });
  });
  pagesEl.append(frag);
  views.forEach((v) => io.observe(v.el));
}
function onIntersect(entries) {
  for (const en of entries) {
    const i = +en.target.dataset.index;
    const v = views[i];
    if (!v || v.el !== en.target) continue;
    v.visible = en.isIntersecting;
    if (v.visible) {
      drawOverlay(i);
      scheduleRender(i);
      buildFormLayer(i);
    } else {
      v.base.width = v.base.height = 0;
      v.ov.width = v.ov.height = 0;
      v.key = null;
    }
  }
}

function cacheGet(map, k) {
  const v = map.get(k);
  if (v) { map.delete(k); map.set(k, v); }
  return v;
}
function cachePut(map, k, v, max) {
  map.set(k, v);
  while (map.size > max) map.delete(map.keys().next().value);
}

const renderWanted = new Set();
let pumping = false;
function scheduleRender(i) { renderWanted.add(i); pump(); }
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (renderWanted.size) {
      let best = -1;
      for (const i of renderWanted) {
        const v = views[i];
        if (!v || !v.visible) { renderWanted.delete(i); continue; }
        if (best < 0 || Math.abs(i - state.current) < Math.abs(best - state.current)) best = i;
      }
      if (best < 0) break;
      renderWanted.delete(best);
      try { await renderView(best); } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.error(e); }
    }
  } finally { pumping = false; }
}
async function renderView(i) {
  const v = views[i], page = state.pages[i];
  if (!v || !page || !v.visible) return;
  const gen = viewsGen, k = dpr(), R = totalRot(page);
  const key = `${srcKey(page)}|${R}|${state.scale.toFixed(4)}|${k}`;
  if (v.key === key) return;
  let bmp = cacheGet(renderCache, key);
  if (!bmp) {
    const W = Math.round(v.vp.width * k), H = Math.round(v.vp.height * k);
    bmp = document.createElement('canvas');
    bmp.width = W; bmp.height = H;
    const ctx = bmp.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    if (page.src != null) {
      const pp = await getPdfPage(page);
      await pp.render({
        canvasContext: ctx,
        viewport: pp.getViewport({ scale: state.scale * k, rotation: R }),
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      }).promise;
    }
    cachePut(renderCache, key, bmp, 10);
  }
  if (gen !== viewsGen || views[i] !== v || !v.visible) return;
  v.base.width = bmp.width; v.base.height = bmp.height;
  v.base.getContext('2d').drawImage(bmp, 0, 0);
  v.key = key;
  getTextContent(page).catch(() => {});
}

function drawOverlay(i) {
  const v = views[i], page = state.pages[i];
  if (!v || !page || !v.visible) return;
  const k = dpr(), W = Math.round(v.vp.width * k), H = Math.round(v.vp.height * k);
  const ov = v.ov;
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  const ctx = ov.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const vp = v.vp;
  drawSearchHits(ctx, i, vp);
  drawPageLayer(ctx, i, vp, { skipId: editing && editing.page === i ? editing.id : null });
  if (drag && drag.page === i && drag.preview) drawPreview(ctx, vp, drag.preview);
  if (hover && hover.page === i) {
    const b = hover.box;
    ctx.save();
    ctx.fillStyle = 'rgba(37,99,235,.12)'; ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeRect(b.x + .5, b.y + .5, b.w, b.h);
    ctx.restore();
  }
  const sel = state.sel && state.sel.page === i ? selectedAnnot() : null;
  if (sel && !(editing && editing.id === sel.id)) {
    const b = screenBox(sel, vp);
    ctx.save();
    ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x - 2.5, b.y - 2.5, b.w + 5, b.h + 5);
    ctx.setLineDash([]);
    if (isBoxType(sel)) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(b.x + b.w - 3, b.y + b.h - 3, 9, 9);
      ctx.strokeRect(b.x + b.w - 3, b.y + b.h - 3, 9, 9);
    }
    ctx.restore();
  }
}
function redrawAll() { views.forEach((v, i) => { if (v.visible) drawOverlay(i); }); }

let lockUntil = 0;
const lockCurrent = () => { lockUntil = performance.now() + 300; };
function setCurrent(i) {
  if (i === state.current || i < 0 || i >= state.pages.length) return;
  const prev = views[state.current];
  if (prev) prev.el.classList.remove('active-page');
  state.current = i;
  if (views[i]) views[i].el.classList.add('active-page');
  highlightThumb();
  updateStatus();
  updateButtons();
}
function pageAtScroll() {
  const y = viewer.scrollTop + viewer.clientHeight * 0.35;
  let lo = 0, hi = views.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (views[mid].el.offsetTop <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
viewer.addEventListener('scroll', () => {
  if (drag || !views.length || performance.now() < lockUntil) return;
  setCurrent(pageAtScroll());
});
function goTo(i) {
  if (i < 0 || i >= views.length) return;
  finishEditing(); closeNote();
  viewer.scrollTop = views[i].el.offsetTop - 14;
  lockCurrent();
  setCurrent(i);
}
function setScale(s) {
  s = clamp(s, 0.2, 5);
  if (!state.pages.length || Math.abs(s - state.scale) < 1e-4) return;
  finishEditing(); closeNote();
  const i = state.current, v = views[i];
  const frac = v ? (viewer.scrollTop - v.el.offsetTop) / v.el.offsetHeight : 0;
  const fx = viewer.scrollWidth > viewer.clientWidth ? (viewer.scrollLeft + viewer.clientWidth / 2) / viewer.scrollWidth : 0.5;
  state.scale = s;
  buildViews();
  const nv = views[i];
  if (nv) viewer.scrollTop = nv.el.offsetTop + frac * nv.el.offsetHeight;
  viewer.scrollLeft = fx * viewer.scrollWidth - viewer.clientWidth / 2;
  lockCurrent();
  updateStatus();
}
function fitWidth() { const p = curPage(); if (p) setScale(fitScaleFor(p)); }

function afterStructureChange() {
  state.current = clamp(state.current, 0, Math.max(0, state.pages.length - 1));
  if (state.sel && !selectedAnnot()) state.sel = null;
  showDocument();
  const keepTop = viewer.scrollTop;
  buildViews();
  viewer.scrollTop = keepTop;
  lockCurrent();
  buildThumbs();
  syncControls();
  updateButtons();
  updateTitle();
  scheduleComments();
  if (search.query) scheduleSearch(0);
}

// ================================================================ dessin des annotations
const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(a) {
  measureCtx.font = cssFont(a, 1);
  return Math.max(0, ...a.text.split('\n').map((l) => measureCtx.measureText(l).width));
}
function drawNoteIcon(ctx, x, y, s, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.lineWidth = Math.max(1, s / 20);
  ctx.beginPath();
  ctx.rect(x + .5, y + .5, s - 1, s * 0.78);
  ctx.moveTo(x + s * 0.25, y + s * 0.78);
  ctx.lineTo(x + s * 0.25, y + s * 0.98);
  ctx.lineTo(x + s * 0.48, y + s * 0.78);
  ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.lineWidth = Math.max(1, s / 16);
  for (const [f, w] of [[0.26, 0.6], [0.44, 0.6], [0.62, 0.4]]) {
    ctx.beginPath(); ctx.moveTo(x + s * 0.2, y + s * f); ctx.lineTo(x + s * (0.2 + w), y + s * f); ctx.stroke();
  }
  ctx.restore();
}
function drawAnnot(ctx, a, vp) {
  const s = vp.scale;
  ctx.save();
  switch (a.type) {
    case 'rect': case 'highlight': case 'whiteout': {
      const b = screenBox(a, vp);
      if (a.type === 'whiteout') { ctx.fillStyle = '#ffffff'; ctx.fillRect(b.x, b.y, b.w, b.h); }
      else if (a.type === 'highlight') { ctx.globalAlpha = 0.4; ctx.fillStyle = a.color; ctx.fillRect(b.x, b.y, b.w, b.h); }
      else if (a.fill) { ctx.fillStyle = a.color; ctx.fillRect(b.x, b.y, b.w, b.h); }
      else { ctx.strokeStyle = a.color; ctx.lineWidth = a.stroke * s; ctx.strokeRect(b.x, b.y, b.w, b.h); }
      break;
    }
    case 'image': {
      const img = state.images[a.imgId];
      if (!img) break;
      const b = screenBox(a, vp);
      const phi = norm(vp.rot - a.rot);
      ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
      ctx.rotate(phi * Math.PI / 180);
      const sw = (phi === 90 || phi === 270) ? b.h : b.w;
      const sh = (phi === 90 || phi === 270) ? b.w : b.h;
      ctx.drawImage(img.el, -sw / 2, -sh / 2, sw, sh);
      break;
    }
    case 'line': case 'arrow': {
      const [x1, y1] = vp.toScreen(a.x1, a.y1), [x2, y2] = vp.toScreen(a.x2, a.y2);
      ctx.strokeStyle = a.color; ctx.lineWidth = a.stroke * s; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      if (a.type === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1), L = (6 + a.stroke * 3) * s;
        for (const d of [-0.45, 0.45]) {
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - L * Math.cos(ang + d), y2 - L * Math.sin(ang + d));
        }
      }
      ctx.stroke();
      break;
    }
    case 'ink': {
      ctx.strokeStyle = a.color; ctx.fillStyle = a.color;
      ctx.lineWidth = a.stroke * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const pts = a.points.map(([x, y]) => vp.toScreen(x, y));
      if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], a.stroke * s / 2, 0, Math.PI * 2); ctx.fill(); break; }
      ctx.beginPath(); ctx.moveTo(...pts[0]);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(...pts[k]);
      ctx.stroke();
      break;
    }
    case 'text': {
      const [ax, ay] = vp.toScreen(a.x, a.y);
      ctx.translate(ax, ay);
      ctx.rotate(norm(vp.rot - a.rot) * Math.PI / 180);
      ctx.globalAlpha = a.opacity ?? 1;
      ctx.font = cssFont(a, s);
      ctx.fillStyle = a.color;
      ctx.textBaseline = 'alphabetic';
      a.text.split('\n').forEach((ln, k) => ctx.fillText(ln, 0, k * a.size * LINE_H * s));
      break;
    }
    case 'note': {
      const b = screenBox(a, vp);
      drawNoteIcon(ctx, b.x, b.y, b.w, a.color);
      break;
    }
  }
  ctx.restore();
}
function screenBox(a, vp) {
  const s = vp.scale;
  switch (a.type) {
    case 'rect': case 'highlight': case 'whiteout': case 'image': {
      const [x0, y0] = vp.toScreen(a.x, a.y), [x1, y1] = vp.toScreen(a.x + a.w, a.y + a.h);
      return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
    case 'line': case 'arrow':
      return bboxOf([vp.toScreen(a.x1, a.y1), vp.toScreen(a.x2, a.y2)], a.stroke * s / 2 + 4);
    case 'ink':
      return bboxOf(a.points.map(([x, y]) => vp.toScreen(x, y)), a.stroke * s / 2 + 2);
    case 'note': {
      const [x, y] = vp.toScreen(a.x, a.y);
      return { x, y, w: NOTE_SIZE * s, h: NOTE_SIZE * s };
    }
    case 'text': {
      measureCtx.font = cssFont(a, s);
      const lines = a.text.split('\n');
      const W = Math.max(4, ...lines.map((l) => measureCtx.measureText(l).width));
      const lh = a.size * LINE_H * s;
      const top = -a.size * BASELINE * s, bottom = (lines.length - 1) * lh + a.size * 0.28 * s;
      const phi = norm(vp.rot - a.rot) * Math.PI / 180, c = Math.cos(phi), sn = Math.sin(phi);
      const [ax, ay] = vp.toScreen(a.x, a.y);
      return bboxOf([[0, top], [W, top], [W, bottom], [0, bottom]].map(([u, v]) => [ax + u * c - v * sn, ay + u * sn + v * c]), 2);
    }
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}
const isBoxType = (a) => ['rect', 'highlight', 'whiteout', 'image'].includes(a.type);

// Numéros de page et filigrane : éléments calculés, recalculés à chaque affichage.
function stampAnnots(page, i, n) {
  const out = [];
  const { pageNumbers: pn, watermark: wm } = state.stamps;
  if (!pn && !wm) return out;
  const R = totalRot(page), vp1 = makeVp(page.view, R, 1);
  if (wm && wm.text && wm.text.trim()) {
    const a = { type: 'text', text: wm.text, size: wm.size, font: wm.font, color: wm.color, opacity: wm.opacity };
    const W = textWidth(a);
    const phi = wm.angle === 'diag' ? -Math.atan2(vp1.height, vp1.width) : 0;
    const ux = W / 2, uy = -0.35 * a.size;
    const cx = vp1.width / 2 - (ux * Math.cos(phi) - uy * Math.sin(phi));
    const cy = vp1.height / 2 - (ux * Math.sin(phi) + uy * Math.cos(phi));
    const [x, y] = vp1.toPdf(cx, cy);
    out.push({ ...a, id: '_wm', x, y, rot: R - phi * 180 / Math.PI });
  }
  if (pn) {
    const first = pn.skipFirst ? 1 : 0;
    if (i >= first) {
      const num = i - first + pn.start, last = n - 1 - first + pn.start;
      const text = pn.format.replace('{n}', num).replace('{N}', last);
      const a = { type: 'text', text, size: pn.size, font: 'Helvetica', color: pn.color };
      const W = textWidth(a), m = pn.margin, vpos = pn.pos[0], hpos = pn.pos[1];
      const x = hpos === 'l' ? m : hpos === 'r' ? vp1.width - m - W : (vp1.width - W) / 2;
      const y = vpos === 't' ? m + a.size * 0.75 : vp1.height - m;
      const [px, py] = vp1.toPdf(x, y);
      out.push({ ...a, id: '_pn', x: px, y: py, rot: R });
    }
  }
  return out;
}
function drawPageLayer(ctx, i, vp, opts = {}) {
  const page = state.pages[i];
  for (const a of stampAnnots(page, i, state.pages.length)) drawAnnot(ctx, a, vp);
  for (const a of page.annots) { if (a.id !== opts.skipId) drawAnnot(ctx, a, vp); }
}
function drawPreview(ctx, vp, p) {
  const s = vp.scale;
  const st = toolStyles[p.tool] || {};
  ctx.save();
  if (p.tool === 'ink') {
    ctx.strokeStyle = st.color; ctx.lineWidth = st.stroke * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(...p.pts[0]);
    for (const q of p.pts) ctx.lineTo(...q);
    ctx.stroke();
  } else if (p.tool === 'line' || p.tool === 'arrow') {
    const [x1, y1] = vp.toPdf(...p.start), [x2, y2] = vp.toPdf(...p.cur);
    drawAnnot(ctx, { type: p.tool, color: st.color, stroke: st.stroke, x1, y1, x2, y2 }, vp);
  } else {
    const r = rectFrom(p.start, p.cur);
    if (p.tool === 'whiteout') { ctx.fillStyle = '#fff'; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeStyle = '#94a3b8'; ctx.setLineDash([4, 3]); ctx.strokeRect(r.x, r.y, r.w, r.h); }
    else if (p.tool === 'highlight') { ctx.globalAlpha = 0.4; ctx.fillStyle = st.color; ctx.fillRect(r.x, r.y, r.w, r.h); }
    else if (st.fill) { ctx.fillStyle = st.color; ctx.fillRect(r.x, r.y, r.w, r.h); }
    else { ctx.strokeStyle = st.color; ctx.lineWidth = st.stroke * s; ctx.strokeRect(r.x, r.y, r.w, r.h); }
  }
  ctx.restore();
}

// ================================================================ vignettes
let thumbQueue = Promise.resolve();
const THUMB_W = 136;
async function thumbBase(page, R, s) {
  const key = srcKey(page) + ':' + R;
  const hit = cacheGet(thumbBaseCache, key);
  if (hit) return hit;
  const vp = makeVp(page.view, R, s);
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width * dpr()); c.height = Math.round(vp.height * dpr());
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (page.src != null) {
    const pp = await getPdfPage(page);
    await pp.render({ canvasContext: ctx, viewport: pp.getViewport({ scale: s * dpr(), rotation: R }), annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  }
  cachePut(thumbBaseCache, key, c, 400);
  return c;
}
async function drawThumb(i, canvas) {
  const page = state.pages[i];
  if (!canvas.isConnected || !page) return;
  const R = totalRot(page);
  const s = THUMB_W / makeVp(page.view, R, 1).width;
  const vp = makeVp(page.view, R, s);
  const base = await thumbBase(page, R, s);
  if (!canvas.isConnected || state.pages[i] !== page) return;
  canvas.width = base.width; canvas.height = base.height;
  canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  drawPageLayer(ctx, i, vp);
}
function queueThumb(i, canvas) {
  thumbQueue = thumbQueue.then(() => drawThumb(i, canvas)).catch((e) => console.warn(e));
}
const thumbIO = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const c = en.target.querySelector('canvas');
    if (c.dataset.drawn) continue;
    c.dataset.drawn = '1';
    queueThumb(+en.target.dataset.index, c);
  }
}, { root: $('#thumbs'), rootMargin: '400px 0px' });

let dragFrom = null;
function buildThumbs() {
  const box = $('#thumbs');
  thumbIO.disconnect();
  box.textContent = '';
  state.pages.forEach((page, i) => {
    const item = document.createElement('div');
    item.className = 'thumb' + (i === state.current ? ' active' : '');
    item.draggable = true;
    item.dataset.index = i;
    const c = document.createElement('canvas');
    const r1 = makeVp(page.view, totalRot(page), 1);
    c.style.width = THUMB_W + 'px'; c.style.height = (THUMB_W * r1.height / r1.width) + 'px';
    const n = document.createElement('span');
    n.textContent = i + 1;
    item.append(c, n);
    item.onclick = () => goTo(i);
    item.ondragstart = (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); };
    item.ondragover = (e) => { if (dragFrom != null) { e.preventDefault(); item.classList.add('dragover'); } };
    item.ondragleave = () => item.classList.remove('dragover');
    item.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation();
      item.classList.remove('dragover');
      if (dragFrom != null && dragFrom !== i) movePage(dragFrom, i);
      dragFrom = null;
    };
    item.ondragend = () => { dragFrom = null; };
    box.append(item);
    thumbIO.observe(item);
  });
}
const thumbTimers = new Map();
function refreshThumb(i) {
  clearTimeout(thumbTimers.get(i));
  thumbTimers.set(i, setTimeout(() => {
    thumbTimers.delete(i);
    const el = $('#thumbs').children[i];
    const c = el && el.querySelector('canvas');
    if (c && c.dataset.drawn) queueThumb(i, c);
  }, 250));
}
function refreshAllThumbs() {
  [...$('#thumbs').children].forEach((el, i) => {
    const c = el.querySelector('canvas');
    if (c.dataset.drawn) queueThumb(i, c);
  });
}
function highlightThumb() {
  const kids = $('#thumbs').children;
  for (let k = 0; k < kids.length; k++) kids[k].classList.toggle('active', k === state.current);
  const el = kids[state.current];
  if (el && !$('#tabPages').hidden) el.scrollIntoView({ block: 'nearest' });
}

// ================================================================ opérations sur les pages
function rotatePage(delta) {
  const page = curPage(); if (!page) return;
  finishEditing(); closeNote();
  pushHistory();
  page.rot = norm(page.rot + delta);
  afterStructureChange();
}
function deletePage() {
  if (!curPage()) return;
  if (state.pages.length === 1) { toast('Un document doit contenir au moins une page.'); return; }
  finishEditing(); closeNote();
  pushHistory();
  state.pages.splice(state.current, 1);
  afterStructureChange();
}
function movePage(from, to) {
  finishEditing(); closeNote();
  pushHistory();
  const [p] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, p);
  state.current = to;
  afterStructureChange();
  goTo(to);
}
function insertBlank() {
  finishEditing(); closeNote();
  const ref = curPage();
  const w = ref ? ref.view[2] - ref.view[0] : 595.28, h = ref ? ref.view[3] - ref.view[1] : 841.89;
  const p = blankPage(w, h);
  if (ref) p.rot = totalRot(ref);
  pushHistory();
  const at = state.pages.length ? state.current + 1 : 0;
  state.pages.splice(at, 0, p);
  state.current = at;
  afterStructureChange();
  goTo(at);
}
async function mergePdfs() {
  finishEditing(); closeNote();
  const files = await api.openPdf(true);
  if (!files.length) return;
  busy('Ajout des pages…');
  try {
    const snap = snapshot();
    const all = [];
    for (const f of files) all.push(...(await addSource(new Uint8Array(f.data), f.name)));
    pushHistory(snap);
    const at = state.current + 1;
    state.pages.splice(at, 0, ...all);
    afterStructureChange();
    goTo(at);
    toast(`${all.length} page(s) ajoutée(s).`);
  } catch (e) {
    console.error(e);
    toast('Échec de la fusion : ' + (e.message || e), true);
  } finally { busy(null); }
}
async function extractPage() {
  const page = curPage(); if (!page) return;
  finishEditing(); closeNote();
  busy('Création du PDF…');
  try {
    const bytes = await buildPdf([page], [state.current]);
    busy(null);
    const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    const r = await api.savePdf({ data: bytes, path: null, suggestedName: `${base} - page ${state.current + 1}.pdf` });
    if (r) toast('Page extraite : ' + r.name);
  } catch (e) {
    console.error(e);
    toast('Erreur : ' + (e.message || e), true);
  } finally { busy(null); }
}

// ================================================================ annotations
function selectedAnnot() {
  const s = state.sel;
  if (!s) return null;
  const p = state.pages[s.page];
  return p ? p.annots.find((a) => a.id === s.id) || null : null;
}
function select(i, id) {
  const prev = state.sel;
  state.sel = id != null && i != null ? { page: i, id } : null;
  if (prev && (!state.sel || prev.page !== state.sel.page)) drawOverlay(prev.page);
  if (state.sel) drawOverlay(state.sel.page);
  syncControls();
  updateButtons();
  markActiveComment();
}
function deleteSelected() {
  const a = selectedAnnot();
  if (!a) return;
  const i = state.sel.page;
  closeNote();
  const page = state.pages[i];
  pushHistory();
  page.annots = page.annots.filter((x) => x.id !== a.id && !(a.coverId && x.id === a.coverId));
  state.sel = null;
  annotsChanged(i);
}
function annotsChanged(i) {
  drawOverlay(i);
  refreshThumb(i);
  syncControls();
  updateButtons();
  scheduleComments();
}
function hitTest(i, pt) {
  const page = state.pages[i], vp = views[i].vp;
  for (let k = page.annots.length - 1; k >= 0; k--) {
    const a = page.annots[k];
    const b = screenBox(a, vp);
    if (pt[0] >= b.x - 3 && pt[0] <= b.x + b.w + 3 && pt[1] >= b.y - 3 && pt[1] <= b.y + b.h + 3) return a;
  }
  return null;
}
function nearHandle(a, vp, pt) {
  const b = screenBox(a, vp);
  return Math.abs(pt[0] - (b.x + b.w)) <= 8 && Math.abs(pt[1] - (b.y + b.h)) <= 8;
}
function translateAnnot(a, dx, dy) {
  if ('x' in a) { a.x += dx; a.y += dy; }
  if ('x1' in a) { a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy; }
  if (a.points) a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
}

// images
async function makeImage(bytes) {
  let kind = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : (bytes[0] === 0xFF && bytes[1] === 0xD8 ? 'jpg' : null);
  const url = URL.createObjectURL(new Blob([bytes]));
  const el = new Image();
  await new Promise((res, rej) => { el.onload = res; el.onerror = () => rej(new Error('image illisible')); el.src = url; });
  if (kind !== 'png') {
    // réencodage (orientation EXIF, CMJN, formats non pris en charge par pdf-lib)
    const c = document.createElement('canvas');
    c.width = el.naturalWidth; c.height = el.naturalHeight;
    const cx = c.getContext('2d');
    if (kind === 'jpg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); }
    cx.drawImage(el, 0, 0);
    const type = kind === 'jpg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((r) => c.toBlob(r, type, 0.92));
    bytes = new Uint8Array(await blob.arrayBuffer());
    kind = kind === 'jpg' ? 'jpg' : 'png';
  }
  const id = nid();
  state.images[id] = { bytes, kind, el, w: el.naturalWidth, h: el.naturalHeight };
  return id;
}
function placeImage(imgId, widthFrac = 0.4) {
  const i = state.current, v = views[i], page = state.pages[i];
  if (!page || !v) return;
  const vp = v.vp, img = state.images[imgId];
  let sw = Math.min(img.w * 0.75 * vp.scale, vp.width * widthFrac);
  let sh = sw * img.h / img.w;
  if (sh > vp.height * 0.6) { sh = vp.height * 0.6; sw = sh * img.w / img.h; }
  const pr = v.el.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
  const y0 = clamp(vr.top - pr.top, 0, vp.height), y1 = clamp(vr.bottom - pr.top, 0, vp.height);
  const x0 = clamp(vr.left - pr.left, 0, vp.width), x1 = clamp(vr.right - pr.left, 0, vp.width);
  const cx = clamp((x0 + x1) / 2, sw / 2, vp.width - sw / 2);
  const cy = clamp((y0 + y1) / 2, sh / 2, vp.height - sh / 2);
  const r = screenRectToPdf(vp, { x: cx - sw / 2, y: cy - sh / 2, w: sw, h: sh });
  pushHistory();
  const a = { id: nid(), type: 'image', ...r, imgId, rot: vp.rot };
  page.annots.push(a);
  setTool('select');
  select(i, a.id);
  annotsChanged(i);
}
async function insertImageDialog() {
  if (!curPage()) return;
  const f = await api.openImage();
  if (!f) return;
  try { placeImage(await makeImage(new Uint8Array(f.data))); }
  catch (e) { toast('Image non prise en charge : ' + e.message, true); }
}

// ================================================================ saisie de texte sur la page
let editing = null;   // { page, id, isNew, prevSnap, origText, ta }

function startEditing(i, a, isNew, prevSnap, origText = null) {
  closeNote();
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.wrap = 'off';
  ta.spellcheck = true;
  ta.value = a.text;
  views[i].el.append(ta);
  editing = { page: i, id: a.id, isNew, prevSnap, origText, ta };
  state.sel = { page: i, id: a.id };
  styleEditor();
  ta.addEventListener('input', autosizeEditor);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finishEditing(true); }
    else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); finishEditing(); }
  });
  setTimeout(() => {
    if (!editing || editing.ta !== ta) return;
    ta.focus();
    if (!isNew || origText != null) ta.select();
    ta.addEventListener('blur', () => finishEditing());
  }, 0);
  drawOverlay(i);
  syncControls();
}
function editingAnnot() {
  if (!editing) return null;
  const p = state.pages[editing.page];
  return p ? p.annots.find((x) => x.id === editing.id) || null : null;
}
function styleEditor() {
  const a = editingAnnot();
  if (!a) return;
  const ta = editing.ta, vp = views[editing.page].vp, s = vp.scale;
  ta.style.font = cssFont(a, s);
  ta.style.lineHeight = (a.size * LINE_H * s) + 'px';
  ta.style.color = a.color;
  const [sx, sy] = vp.toScreen(a.x, a.y);
  ta.style.left = sx + 'px';
  ta.style.top = (sy - a.size * BASELINE * s) + 'px';
  autosizeEditor();
}
function autosizeEditor() {
  if (!editing) return;
  const ta = editing.ta;
  ta.style.width = '0px'; ta.style.height = '0px';
  ta.style.width = (ta.scrollWidth + 6) + 'px';
  ta.style.height = ta.scrollHeight + 'px';
}
function finishEditing(cancel = false) {
  if (!editing) return;
  const e = editing;
  editing = null;
  e.ta.remove();
  const page = state.pages[e.page];
  const a = page && page.annots.find((x) => x.id === e.id);
  if (!a) { drawOverlay(e.page); return; }
  const val = e.ta.value.replace(/\s+$/, '');
  const unchanged = e.origText != null && val === e.origText;
  if (cancel || !val.trim() || unchanged) {
    if (e.isNew) {
      state.pages[e.page] = JSON.parse(e.prevSnap).pages[e.page];
      state.sel = null;
    } else if (!cancel) {
      page.annots = page.annots.filter((x) => x.id !== a.id && !(a.coverId && x.id === a.coverId));
      state.sel = null;
      pushHistory(e.prevSnap);
    }
  } else if (e.isNew || val !== a.text) {
    a.text = val;
    pushHistory(e.prevSnap);
  }
  annotsChanged(e.page);
}

// Remplacer un texte existant du PDF
async function editExistingText(i, pt) {
  const page = state.pages[i], vp = views[i].vp;
  const found = await findTextItem(i, pt);
  if (!found) { toast('Aucun texte à cet endroit. Survolez un texte : il s\'encadre en bleu.'); return; }
  const { item, styles } = found;
  const tx = item.transform;
  if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 || tx[0] <= 0) {
    toast('Ce texte est incliné : utilisez « Effaceur » puis « Texte ».'); return;
  }
  const size = Math.abs(tx[3]) || item.height;
  const pp = await getPdfPage(page);
  const font = guessFont(item, styles, pp);
  const color = sampleColor(i, itemScreenBox(item, vp));
  const snap = snapshot();
  const cover = { id: nid(), type: 'whiteout', x: tx[4] - 1, y: tx[5] - size * 0.28, w: item.width + 2, h: size * 1.25 };
  const a = { id: nid(), type: 'text', x: tx[4], y: tx[5], text: item.str, size: Math.round(size * 10) / 10, font, color, rot: 0, coverId: cover.id };
  page.annots.push(cover, a);
  hover = null;
  startEditing(i, a, true, snap, item.str);
}
function itemPdfBox(item) {
  const tx = item.transform, size = Math.abs(tx[3]) || item.height;
  return { x: tx[4], y: tx[5] - size * 0.25, w: item.width, h: size * 1.15 };
}
function itemScreenBox(item, vp) {
  const r = itemPdfBox(item);
  return bboxOf([vp.toScreen(r.x, r.y), vp.toScreen(r.x + r.w, r.y + r.h)]);
}
async function findTextItem(i, pt) {
  const page = state.pages[i], vp = views[i] && views[i].vp;
  if (!page || !vp) return null;
  const { items, styles } = await getTextContent(page);
  const [px, py] = vp.toPdf(pt[0], pt[1]);
  let best = null, bestArea = Infinity;
  for (const it of items) {
    if (!it.str.trim() || !(it.width > 0)) continue;
    const tx = it.transform;
    if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01) {
      const b = itemScreenBox(it, vp);
      if (pt[0] < b.x || pt[0] > b.x + b.w || pt[1] < b.y || pt[1] > b.y + b.h) continue;
    } else {
      const r = itemPdfBox(it);
      if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
    }
    const area = it.width * (it.height || 1);
    if (area < bestArea) { best = it; bestArea = area; }
  }
  return best ? { item: best, styles } : null;
}
function guessFont(item, styles, pp) {
  let name = '';
  try { const f = pp.commonObjs.has(item.fontName) ? pp.commonObjs.get(item.fontName) : null; name = (f && f.name) || ''; } catch { /* ignore */ }
  const fam = ((styles[item.fontName] && styles[item.fontName].fontFamily) || '') + ' ' + name;
  const bold = /bold|black|heavy|semibold|demi/i.test(name);
  if (/courier|mono/i.test(fam)) return 'Courier';
  if (/times|serif|roman|georgia|garamond|cambria|book/i.test(fam) && !/sans/i.test(fam)) return bold ? 'Times-Bold' : 'Times';
  return bold ? 'Helvetica-Bold' : 'Helvetica';
}
function sampleColor(i, b) {
  try {
    const base = views[i].base, k = dpr();
    if (!base.width) return '#000000';
    const x = Math.max(0, Math.floor(b.x * k)), y = Math.max(0, Math.floor(b.y * k));
    const w = Math.max(1, Math.min(base.width - x, Math.ceil(b.w * k))), h = Math.max(1, Math.min(base.height - y, Math.ceil(b.h * k)));
    const d = base.getContext('2d').getImageData(x, y, w, h).data;
    let best = 765, col = [0, 0, 0];
    for (let p = 0; p < d.length; p += 4) {
      const l = d[p] + d[p + 1] + d[p + 2];
      if (l < best) { best = l; col = [d[p], d[p + 1], d[p + 2]]; }
    }
    if (best > 600) return '#000000';
    return '#' + col.map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch { return '#000000'; }
}

// ================================================================ notes (commentaires)
let noteEdit = null;  // { page, id, isNew, prevSnap, el, ta, orig }

function openNote(i, id, isNew, prevSnap) {
  closeNote();
  const page = state.pages[i], v = views[i];
  const a = page && page.annots.find((x) => x.id === id);
  if (!a || !v) return;
  const el = document.createElement('div');
  el.className = 'note-pop';
  el.innerHTML = '<div class="note-head"><span class="note-title">Note</span><span class="note-date"></span><span class="spacer"></span>'
    + '<button class="note-del" title="Supprimer la note"><svg class="ic"><use href="#i-trash"/></svg></button>'
    + '<button class="note-close" title="Fermer (Échap)"><svg class="ic"><use href="#i-close"/></svg></button></div>'
    + '<textarea placeholder="Écrivez votre commentaire…"></textarea>';
  el.querySelector('.note-date').textContent = fmtDate(a.date);
  const ta = el.querySelector('textarea');
  ta.value = a.text;
  v.el.append(el);
  const b = screenBox(a, v.vp);
  let left = b.x + b.w + 8;
  if (left + 244 > v.vp.width) left = Math.max(0, b.x - 248);
  el.style.left = left + 'px';
  el.style.top = clamp(b.y, 0, Math.max(0, v.vp.height - 150)) + 'px';
  noteEdit = { page: i, id, isNew, prevSnap, el, ta, orig: a.text };
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); closeNote(); }
  });
  el.querySelector('.note-close').onclick = () => closeNote();
  el.querySelector('.note-del').onclick = () => deleteNote();
  setTimeout(() => { if (noteEdit && noteEdit.ta === ta) ta.focus(); }, 0);
}
function closeNote(cancel = false) {
  if (!noteEdit) return;
  const ne = noteEdit;
  noteEdit = null;
  ne.el.remove();
  const page = state.pages[ne.page];
  const a = page && page.annots.find((x) => x.id === ne.id);
  if (!a) return;
  const val = ne.ta.value.replace(/\s+$/, '');
  if ((cancel || !val.trim()) && ne.isNew) {
    state.pages[ne.page] = JSON.parse(ne.prevSnap).pages[ne.page];
    state.sel = null;
  } else if (!cancel && (ne.isNew || val !== ne.orig)) {
    a.text = val;
    pushHistory(ne.prevSnap);
  }
  annotsChanged(ne.page);
}
function deleteNote() {
  if (!noteEdit) return;
  const ne = noteEdit;
  noteEdit = null;
  ne.el.remove();
  if (ne.isNew) state.pages[ne.page] = JSON.parse(ne.prevSnap).pages[ne.page];
  else {
    pushHistory(ne.prevSnap);
    const page = state.pages[ne.page];
    page.annots = page.annots.filter((x) => x.id !== ne.id);
  }
  state.sel = null;
  annotsChanged(ne.page);
}

let commentsTimer = null, commentsGen = 0;
function scheduleComments() {
  clearTimeout(commentsTimer);
  commentsTimer = setTimeout(renderComments, 150);
}
function commentItem({ page, color, author, date, text, onClick, id }) {
  const b = document.createElement('button');
  b.className = 'c-item';
  if (id) b.dataset.id = id;
  const meta = document.createElement('div');
  meta.className = 'c-meta';
  const dot = document.createElement('span');
  dot.className = 'c-dot';
  dot.style.background = color || '#fbbf24';
  meta.append(dot, document.createTextNode([`Page ${page}`, author, date].filter(Boolean).join(' · ')));
  const t = document.createElement('div');
  t.className = 'c-text' + (text ? '' : ' empty');
  t.textContent = text || '(note vide)';
  b.append(meta, t);
  b.onclick = onClick;
  return b;
}
async function renderComments() {
  const ours = [];
  state.pages.forEach((p, i) => p.annots.forEach((a) => { if (a.type === 'note') ours.push({ i, a }); }));
  $('#commentCount').textContent = ours.length ? `(${ours.length})` : '';
  if ($('#tabComments').hidden) return;
  const gen = ++commentsGen;
  const list = $('#commentList');
  list.textContent = '';
  if (!state.pages.length) {
    list.innerHTML = '<div class="c-empty">Aucun document ouvert.</div>';
    return;
  }
  if (ours.length) {
    const g = document.createElement('div'); g.className = 'c-group'; g.textContent = 'Mes notes';
    list.append(g);
    for (const { i, a } of ours) {
      list.append(commentItem({
        page: i + 1, color: a.color, date: fmtDate(a.date), text: a.text, id: a.id,
        onClick: () => revealNote(i, a.id),
      }));
    }
  }
  const existing = [];
  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    if (page.src == null) continue;
    const anns = await getPageAnnots(page);
    if (gen !== commentsGen) return;
    for (const an of anns) {
      if ([2, 16, 20].includes(an.annotationType)) continue;   // liens, popups, champs
      const txt = (an.contentsObj && an.contentsObj.str) || '';
      if (!txt.trim()) continue;
      const col = an.color ? '#' + [...an.color].map((v) => v.toString(16).padStart(2, '0')).join('') : '#fbbf24';
      existing.push({ i, txt, author: (an.titleObj && an.titleObj.str) || '', color: col });
    }
  }
  if (existing.length) {
    const g = document.createElement('div'); g.className = 'c-group'; g.textContent = 'Déjà dans le document';
    list.append(g);
    for (const c of existing) list.append(commentItem({ page: c.i + 1, color: c.color, author: c.author, text: c.txt, onClick: () => goTo(c.i) }));
  }
  if (!ours.length && !existing.length) {
    list.innerHTML = '<div class="c-empty">Aucun commentaire.<br>Utilisez l\'outil « Note » pour en ajouter.</div>';
  }
  markActiveComment();
}
function markActiveComment() {
  const id = state.sel && state.sel.id;
  $('#commentList').querySelectorAll('.c-item[data-id]').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
}
function revealNote(i, id) {
  const page = state.pages[i], v = views[i];
  const a = page && page.annots.find((x) => x.id === id);
  if (!a || !v) return;
  finishEditing(); closeNote();
  const b = screenBox(a, v.vp);
  viewer.scrollTop = v.el.offsetTop + b.y - viewer.clientHeight / 3;
  lockCurrent();
  setCurrent(i);
  if (state.tool !== 'select') setTool('select');
  select(i, id);
  openNote(i, id, false, snapshot());
}

// ================================================================ formulaires
const formKey = (src, name) => src + '|' + name;

async function buildFormLayer(i) {
  const v = views[i], page = state.pages[i];
  if (!v || v.formsBuilt || !page || page.src == null) return;
  v.formsBuilt = true;
  const anns = await getPageAnnots(page);
  if (views[i] !== v) return;
  const widgets = anns.filter((a) => a.annotationType === 20 && !a.hidden && a.fieldName
    && (a.fieldType === 'Tx' || a.fieldType === 'Ch' || (a.fieldType === 'Btn' && (a.checkBox || a.radioButton))));
  if (!widgets.length) return;
  const layer = document.createElement('div');
  layer.className = 'forms';
  for (const w of widgets) {
    try { const el = makeField(w, page.src, v.vp); if (el) layer.append(el); } catch (e) { console.warn(e); }
  }
  v.el.append(layer);
}
function makeField(w, src, vp) {
  const key = formKey(src, w.fieldName);
  const stored = state.formValues.has(key) ? state.formValues.get(key) : undefined;
  let el;
  if (w.fieldType === 'Tx') {
    el = document.createElement(w.multiLine ? 'textarea' : 'input');
    if (!w.multiLine) el.type = 'text';
    el.value = stored !== undefined ? stored : (w.fieldValue ?? '');
    if (w.maxLen) el.maxLength = w.maxLen;
    el.style.textAlign = ['left', 'center', 'right'][w.textAlignment] || 'left';
    el.spellcheck = false;
    el.addEventListener('input', () => setFormValue(key, el.value, el));
  } else if (w.fieldType === 'Ch') {
    el = document.createElement('select');
    const opts = w.options || [];
    state.formMeta.set(key, { options: opts });
    if (!w.combo) el.size = 2;
    if (w.combo) el.append(new Option('', ''));
    for (const o of opts) el.append(new Option(o.displayValue ?? o.exportValue, o.exportValue));
    const cur = stored !== undefined ? stored : (Array.isArray(w.fieldValue) ? w.fieldValue[0] : w.fieldValue);
    el.value = cur ?? '';
    el.addEventListener('change', () => setFormValue(key, el.value, el));
  } else if (w.checkBox) {
    el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = stored !== undefined ? !!stored
      : (w.fieldValue != null && w.fieldValue !== 'Off' && (w.exportValue == null || w.fieldValue === w.exportValue));
    el.addEventListener('change', () => setFormValue(key, el.checked, el));
  } else if (w.radioButton) {
    el = document.createElement('input');
    el.type = 'radio';
    el.name = 'r:' + key;
    el.value = w.buttonValue;
    el.checked = (stored !== undefined ? stored : w.fieldValue) === w.buttonValue;
    el.addEventListener('change', () => { if (el.checked) setFormValue(key, w.buttonValue, el); });
  } else return null;
  el.dataset.key = key;
  if (w.readOnly) el.disabled = true;
  const [x1, y1, x2, y2] = w.rect;
  const s = vp.scale;
  const [ax, ay] = vp.toScreen(x1, y1), [bx, by] = vp.toScreen(x2, y2);
  const cx = (ax + bx) / 2, cy = (ay + by) / 2;
  const ww = Math.abs(x2 - x1) * s, hh = Math.abs(y2 - y1) * s;
  el.style.left = (cx - ww / 2) + 'px';
  el.style.top = (cy - hh / 2) + 'px';
  el.style.width = ww + 'px';
  el.style.height = hh + 'px';
  if (vp.rot) el.style.transform = `rotate(${vp.rot}deg)`;
  let fs = w.defaultAppearanceData && w.defaultAppearanceData.fontSize;
  if (!fs) fs = w.multiLine ? 10 : clamp(Math.abs(y2 - y1) * 0.62, 6, 12);
  el.style.fontSize = (fs * s) + 'px';
  el.title = w.alternativeText || w.fieldName;
  el.addEventListener('keydown', (ev) => ev.stopPropagation());
  return el;
}
function setFormValue(key, value, srcEl) {
  state.formValues.set(key, value);
  setDirty(true);
  for (const el of pagesEl.querySelectorAll('.forms > [data-key]')) {
    if (el === srcEl || el.dataset.key !== key) continue;
    if (el.type === 'checkbox') el.checked = !!value;
    else if (el.type === 'radio') el.checked = el.value === value;
    else el.value = value;
  }
}
async function fillForms(lib, src) {
  const prefix = src + '|';
  const entries = [...state.formValues].filter(([k]) => k.startsWith(prefix));
  if (!entries.length) return;
  let form;
  try { form = lib.getForm(); } catch (e) { console.warn(e); return; }
  const helv = await lib.embedFont(StandardFonts.Helvetica);
  for (const [k, v] of entries) {
    const name = k.slice(prefix.length);
    let f;
    try { f = form.getField(name); } catch { continue; }
    try {
      if (f instanceof PDFTextField) {
        let t = sanitizeText(helv, String(v ?? ''));
        const ml = f.getMaxLength();
        if (ml !== undefined && t.length > ml) t = t.slice(0, ml);
        f.setText(t || undefined);
      } else if (f instanceof PDFCheckBox) {
        if (v) f.check(); else f.uncheck();
      } else if (f instanceof PDFRadioGroup) {
        if (v && v !== 'Off') setRadio(f, v);
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        if (!v) f.clear();
        else {
          try { f.select(v); }
          catch {
            const meta = state.formMeta.get(k);
            const o = meta && meta.options.find((x) => x.exportValue === v);
            if (o && o.displayValue) f.select(o.displayValue);
          }
        }
      }
    } catch (e) { console.warn('Champ non rempli :', name, e); }
  }
  try { form.updateFieldAppearances(helv); } catch (e) { console.warn(e); }
}
function setRadio(f, v) {
  try { f.select(v); return; } catch { /* valeur d'apparence différente des options */ }
  const on = PDFName.of(v);
  f.acroField.dict.set(PDFName.of('V'), on);
  for (const w of f.acroField.getWidgets()) {
    w.setAppearanceState(w.getOnValue() === on ? on : PDFName.of('Off'));
  }
}
// Après copie des pages, déclare les champs dans le formulaire du nouveau document.
function registerFields(out, outPages, srcLib) {
  try {
    const Subtype = PDFName.of('Subtype'), Widget = PDFName.of('Widget'), Parent = PDFName.of('Parent');
    const seen = new Set(), roots = [];
    for (const p of outPages) {
      const annots = p.node.Annots();
      if (!annots) continue;
      for (let k = 0; k < annots.size(); k++) {
        const ref = annots.get(k);
        if (!(ref instanceof PDFRef)) continue;
        const d = out.context.lookup(ref);
        if (!(d instanceof PDFDict) || d.get(Subtype) !== Widget) continue;
        let root = ref, cur = d, guard = 0;
        while (cur.get(Parent) instanceof PDFRef && guard++ < 20) {
          root = cur.get(Parent);
          cur = out.context.lookup(root);
          if (!(cur instanceof PDFDict)) break;
        }
        const id = root.toString();
        if (!seen.has(id)) { seen.add(id); roots.push(root); }
      }
    }
    if (!roots.length) return;
    const acro = out.getForm().acroForm;
    for (const r of roots) acro.addField(r);
    const srcAcro = srcLib && srcLib.catalog.getAcroForm && srcLib.catalog.getAcroForm();
    if (srcAcro) {
      const copier = PDFObjectCopier.for(srcLib.context, out.context);
      for (const key of ['DA', 'DR', 'Q']) {
        const val = srcAcro.dict.get(PDFName.of(key));
        if (val && !acro.dict.get(PDFName.of(key))) acro.dict.set(PDFName.of(key), copier.copy(val));
      }
    }
  } catch (e) { console.warn('Formulaire non conservé :', e); }
}

// ================================================================ recherche
const search = { query: '', results: [], index: -1, gen: 0, running: false, cache: new Map() };
const fold = (ch) => {
  const f = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return f.length === 1 ? f : (ch.toLowerCase().charAt(0) || ' ');
};
const foldQuery = (q) => [...q].map((c) => (/\s/.test(c) ? ' ' : fold(c))).join('').replace(/ +/g, ' ').trim();

async function pageSearchIndex(page) {
  const key = srcKey(page);
  if (search.cache.has(key)) return search.cache.get(key);
  const { items } = await getTextContent(page);
  let str = '';
  const mapItem = [], mapOff = [];
  const pushSpace = () => { if (str && !str.endsWith(' ')) { str += ' '; mapItem.push(-1); mapOff.push(0); } };
  items.forEach((it, k) => {
    for (let j = 0; j < it.str.length; j++) {
      const c = it.str[j];
      if (/\s/.test(c)) { pushSpace(); continue; }
      str += fold(c); mapItem.push(k); mapOff.push(j);
    }
    const next = items[k + 1];
    if (it.hasEOL) pushSpace();
    else if (next && it.transform && next.transform) {
      const t = it.transform, u = next.transform;
      const lineChange = Math.abs(u[5] - t[5]) > Math.abs(t[3] || 10) * 0.5;
      const gap = u[4] - (t[4] + (it.width || 0));
      if (lineChange || gap > Math.abs(t[3] || 10) * 0.15) pushSpace();
    }
  });
  const r = { str, mapItem, mapOff, items };
  search.cache.set(key, r);
  return r;
}
function itemPoly(it, j0, j1) {
  const t = it.transform, len = it.str.length || 1;
  measureCtx.font = '100px Arial, sans-serif';
  const full = measureCtx.measureText(it.str).width || 1;
  const fr = (j) => (j <= 0 ? 0 : j >= len ? 1 : measureCtx.measureText(it.str.slice(0, j)).width / full);
  const a = fr(j0), b = fr(j1);
  const dl = Math.hypot(t[0], t[1]) || 1, ux = t[0] / dl, uy = t[1] / dl;
  const h = Math.hypot(t[2], t[3]) || it.height || 10, vx = t[2] / h, vy = t[3] / h;
  const W = it.width || 0;
  const P = (s, v) => [t[4] + ux * s * W + vx * v * h, t[5] + uy * s * W + vy * v * h];
  return [P(a, -0.22), P(b, -0.22), P(b, 0.9), P(a, 0.9)];
}
function matchPolys(idx, start, end) {
  const polys = [];
  let k = start;
  while (k < end) {
    const item = idx.mapItem[k];
    if (item < 0) { k++; continue; }
    const j0 = idx.mapOff[k];
    let j1 = j0 + 1;
    while (k < end && idx.mapItem[k] === item) { j1 = idx.mapOff[k] + 1; k++; }
    polys.push(itemPoly(idx.items[item], j0, j1));
  }
  return polys;
}
function clearSearchResults() {
  search.gen++;
  search.results = [];
  search.index = -1;
  search.running = false;
}
async function runSearch() {
  const q = foldQuery($('#findInput').value);
  clearSearchResults();
  const gen = search.gen;
  search.query = q;
  redrawAll();
  updateFindCount();
  if (!q || !state.pages.length) return;
  search.running = true;
  updateFindCount();
  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    if (page.src == null) continue;
    let idx;
    try { idx = await pageSearchIndex(page); } catch { continue; }
    if (gen !== search.gen) return;
    let from = 0, pos, found = false;
    while ((pos = idx.str.indexOf(q, from)) !== -1) {
      search.results.push({ page: i, polys: matchPolys(idx, pos, pos + q.length) });
      from = pos + Math.max(1, q.length);
      found = true;
    }
    if (found) {
      if (search.index < 0 && i >= state.current) gotoMatch(search.results.findIndex((r) => r.page === i));
      else if (views[i] && views[i].visible) drawOverlay(i);
    }
    if (i % 25 === 0) updateFindCount();
  }
  search.running = false;
  if (search.index < 0 && search.results.length) gotoMatch(0);
  updateFindCount();
}
let searchTimer = null;
function scheduleSearch(ms = 250) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, ms);
}
function updateFindCount() {
  const el = $('#findCount');
  if (!search.query) { el.textContent = ''; return; }
  const n = search.results.length;
  if (search.running && !n) el.textContent = 'Recherche…';
  else if (!n) el.textContent = 'Aucun résultat';
  else el.textContent = `${search.index + 1} / ${n}${search.running ? '…' : ''}`;
  $('#findPrev').disabled = $('#findNext').disabled = !n;
}
function gotoMatch(k) {
  const n = search.results.length;
  if (!n) return;
  const prevPage = search.index >= 0 && search.results[search.index] ? search.results[search.index].page : null;
  search.index = ((k % n) + n) % n;
  const r = search.results[search.index], v = views[r.page];
  if (!v) return;
  const b = bboxOf(r.polys.flat().map(([x, y]) => v.vp.toScreen(x, y)));
  const top = v.el.offsetTop + b.y, left = v.el.offsetLeft + b.x;
  if (top < viewer.scrollTop + 60 || top + b.h > viewer.scrollTop + viewer.clientHeight - 40) viewer.scrollTop = top - viewer.clientHeight / 3;
  if (left < viewer.scrollLeft || left + b.w > viewer.scrollLeft + viewer.clientWidth) viewer.scrollLeft = left - viewer.clientWidth / 3;
  lockCurrent();
  setCurrent(r.page);
  if (prevPage != null && prevPage !== r.page) drawOverlay(prevPage);
  drawOverlay(r.page);
  updateFindCount();
}
function drawSearchHits(ctx, i, vp) {
  if (!search.results.length) return;
  ctx.save();
  search.results.forEach((r, k) => {
    if (r.page !== i) return;
    const cur = k === search.index;
    ctx.fillStyle = cur ? 'rgba(255,140,0,.5)' : 'rgba(255,205,0,.4)';
    for (const poly of r.polys) {
      ctx.beginPath();
      poly.forEach(([x, y], n) => { const [sx, sy] = vp.toScreen(x, y); if (n) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
      ctx.closePath();
      ctx.fill();
      if (cur) { ctx.strokeStyle = 'rgba(220,90,0,.95)'; ctx.lineWidth = 1.2; ctx.stroke(); }
    }
  });
  ctx.restore();
}
function openFind() {
  const bar = $('#findbar'), inp = $('#findInput');
  bar.hidden = false;
  inp.focus();
  inp.select();
  if (inp.value.trim() && !search.results.length) runSearch();
}
function closeFind() {
  $('#findbar').hidden = true;
  clearSearchResults();
  search.query = '';
  redrawAll();
  updateFindCount();
}

// ================================================================ numéros de page et filigrane
function bindLivePreview(modal, read, apply) {
  const inputs = modal.querySelectorAll('input, select');
  const preview = () => { apply(read()); redrawAll(); };
  inputs.forEach((el) => { el.oninput = preview; el.onchange = preview; });
  preview();
  return () => inputs.forEach((el) => { el.oninput = null; el.onchange = null; });
}
function openStampDialog(modal, kind, defaults, fill, read) {
  if (!state.pages.length) return;
  finishEditing(); closeNote();
  const before = snapshot();
  const prev = state.stamps[kind];
  fill(prev || defaults);
  const unbind = bindLivePreview(modal, read, (v) => { state.stamps[kind] = v; });
  const close = (mode) => {
    modal.hidden = true;
    unbind();
    if (mode === 'cancel') state.stamps[kind] = prev;
    if (mode === 'remove') state.stamps[kind] = null;
    if (snapshot() !== before) pushHistory(before);
    redrawAll();
    refreshAllThumbs();
  };
  modal.querySelector('.primary').onclick = () => close('ok');
  modal.querySelector('.modal-foot .left').onclick = () => close('remove');
  modal.querySelector('.modal-foot .secondary:not(.left)').onclick = () => close('cancel');
  modal.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close('cancel'); }
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.stopPropagation(); close('ok'); }
  };
  modal.hidden = false;
  setTimeout(() => modal.querySelector('input, select').focus(), 0);
}
const numIn = (sel, def, min, max) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? clamp(v, min, max) : def; };
function openNumbersDialog() {
  openStampDialog($('#modalNumbers'), 'pageNumbers',
    { pos: 'bc', format: '{n}', start: 1, size: 10, margin: 28, color: '#333333', skipFirst: false },
    (v) => {
      $('#pnPos').value = v.pos; $('#pnFmt').value = v.format; $('#pnStart').value = v.start;
      $('#pnSize').value = v.size; $('#pnMargin').value = v.margin; $('#pnColor').value = v.color; $('#pnSkip').checked = v.skipFirst;
    },
    () => ({
      pos: $('#pnPos').value, format: $('#pnFmt').value,
      start: Math.round(numIn('#pnStart', 1, 0, 99999)), size: numIn('#pnSize', 10, 4, 72),
      margin: numIn('#pnMargin', 28, 0, 200), color: $('#pnColor').value, skipFirst: $('#pnSkip').checked,
    }));
}
function openWatermarkDialog() {
  openStampDialog($('#modalWatermark'), 'watermark',
    { text: 'CONFIDENTIEL', font: 'Helvetica-Bold', size: 72, color: '#c0392b', angle: 'diag', opacity: 0.22 },
    (v) => {
      $('#wmText').value = v.text; $('#wmFont').value = v.font; $('#wmSize').value = v.size;
      $('#wmColor').value = v.color; $('#wmAngle').value = v.angle; $('#wmOpacity').value = Math.round(v.opacity * 100);
    },
    () => ({
      text: $('#wmText').value, font: $('#wmFont').value, size: numIn('#wmSize', 72, 6, 400),
      color: $('#wmColor').value, angle: $('#wmAngle').value, opacity: numIn('#wmOpacity', 22, 1, 100) / 100,
    }));
}

// ================================================================ outils et propriétés
function setTool(t) {
  finishEditing(); closeNote();
  state.tool = t;
  hover = null;
  if (t !== 'select' && state.sel) { const p = state.sel.page; state.sel = null; drawOverlay(p); }
  document.body.dataset.tool = t;
  document.querySelectorAll('button[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  views.forEach((v) => { v.ov.style.cursor = ''; });
  syncControls();
  redrawAll();
  updateStatus();
  updateButtons();
}
const FIELDS = {
  text: ['color', 'font', 'size'],
  highlight: ['color'],
  note: ['color'],
  rect: ['color', 'stroke', 'fill'],
  line: ['color', 'stroke'],
  arrow: ['color', 'stroke'],
  ink: ['color', 'stroke'],
};
function syncControls() {
  const a = selectedAnnot();
  const type = a ? a.type : styleKeyFor(state.tool);
  const fields = FIELDS[type] || [];
  const src = a || toolStyles[type] || {};
  document.querySelectorAll('#styleBar .ctl').forEach((el) => { el.hidden = !fields.includes(el.dataset.for); });
  if (src.color) $('#ctlColor').value = src.color;
  if (src.font) $('#ctlFont').value = src.font;
  if (src.size) $('#ctlSize').value = src.size;
  if (src.stroke) $('#ctlStroke').value = src.stroke;
  $('#ctlFill').checked = !!src.fill;
}
let ctlSnap = null;
function onControl(field, value, final) {
  const a = selectedAnnot() || editingAnnot();
  if (a) {
    const i = state.sel ? state.sel.page : editing.page;
    if (!ctlSnap) ctlSnap = snapshot();
    a[field] = value;
    if (editing && a.id === editing.id) styleEditor();
    drawOverlay(i);
    if (final) { pushHistory(ctlSnap); ctlSnap = null; refreshThumb(i); scheduleComments(); }
    const ts = toolStyles[a.type];
    if (ts && field in ts) { ts[field] = value; saveStyles(); }
  } else {
    const ts = toolStyles[styleKeyFor(state.tool)];
    if (ts) { ts[field] = value; saveStyles(); }
  }
}
function bindControl(sel, field, parse) {
  const el = $(sel);
  el.addEventListener('input', () => { const v = parse(el); if (v != null) onControl(field, v, false); });
  el.addEventListener('change', () => { const v = parse(el); if (v != null) onControl(field, v, true); });
}
const num = (min) => (el) => { const v = parseFloat(el.value); return Number.isFinite(v) && v >= min ? v : null; };
bindControl('#ctlColor', 'color', (el) => el.value);
bindControl('#ctlFont', 'font', (el) => el.value);
bindControl('#ctlSize', 'size', num(2));
bindControl('#ctlStroke', 'stroke', num(0.25));
bindControl('#ctlFill', 'fill', (el) => el.checked);
for (const [k, f] of Object.entries(FONTS)) {
  $('#ctlFont').append(new Option(f.label, k));
  $('#wmFont').append(new Option(f.label, k));
}

// ================================================================ souris / stylet sur les pages
let drag = null;    // { page, mode, ... }
let hover = null;   // { page, box }
const isOverlay = (t) => !!(t && t.classList && t.classList.contains('overlay'));
const pageIndexOf = (el) => { const p = el.closest('.page'); return p ? +p.dataset.index : -1; };
function ptIn(i, e) { const r = views[i].ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

pagesEl.addEventListener('mousedown', (e) => { if (isOverlay(e.target)) e.preventDefault(); });
pagesEl.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0 || !isOverlay(e.target)) return;
  const i = pageIndexOf(e.target);
  if (i < 0 || !views[i]) return;
  const page = state.pages[i], vp = views[i].vp, pt = ptIn(i, e);
  lockCurrent();
  setCurrent(i);
  const hadEditor = !!editing || !!noteEdit;
  finishEditing();
  closeNote();
  if (hadEditor && ['text', 'edittext', 'note'].includes(state.tool)) return;
  const tool = state.tool;
  if (tool === 'select') {
    const sel = selectedAnnot();
    if (sel && state.sel.page === i && isBoxType(sel) && nearHandle(sel, vp, pt)) {
      e.target.setPointerCapture(e.pointerId);
      drag = { page: i, mode: 'resize', id: sel.id, box: screenBox(sel, vp), snap: snapshot(), moved: false };
      return;
    }
    const hit = hitTest(i, pt);
    if (hit) {
      select(i, hit.id);
      e.target.setPointerCapture(e.pointerId);
      drag = { page: i, mode: 'move', id: hit.id, start: pt, orig: clone(hit), snap: snapshot(), moved: false };
    } else select(null);
  } else if (tool === 'text') {
    const st = toolStyles.text;
    const snap = snapshot();
    const [x, y] = vp.toPdf(pt[0], pt[1] + st.size * BASELINE * vp.scale);
    const a = { id: nid(), type: 'text', x, y, text: '', size: st.size, font: st.font, color: st.color, rot: vp.rot };
    page.annots.push(a);
    startEditing(i, a, true, snap);
  } else if (tool === 'note') {
    const snap = snapshot();
    const half = NOTE_SIZE * vp.scale / 2;
    const [x, y] = vp.toPdf(pt[0] - half, pt[1] - half);
    const a = { id: nid(), type: 'note', x, y, text: '', color: toolStyles.note.color, date: Date.now() };
    page.annots.push(a);
    state.sel = { page: i, id: a.id };
    drawOverlay(i);
    openNote(i, a.id, true, snap);
  } else if (tool === 'edittext') {
    await editExistingText(i, pt);
  } else {
    e.target.setPointerCapture(e.pointerId);
    drag = { page: i, mode: 'draw', preview: tool === 'ink' ? { tool, pts: [pt] } : { tool, start: pt, cur: pt } };
  }
});

pagesEl.addEventListener('pointermove', async (e) => {
  if (drag) { onDragMove(e); return; }
  if (!isOverlay(e.target)) return;
  const i = pageIndexOf(e.target);
  if (i < 0 || !views[i]) return;
  const pt = ptIn(i, e), ov = views[i].ov;
  if (state.tool === 'select') {
    const sel = selectedAnnot();
    const onHandle = sel && state.sel.page === i && isBoxType(sel) && nearHandle(sel, views[i].vp, pt);
    ov.style.cursor = onHandle ? 'nwse-resize' : (hitTest(i, pt) ? 'move' : '');
  } else if (state.tool === 'edittext') {
    const found = await findTextItem(i, pt);
    if (!views[i]) return;
    const nb = found ? itemScreenBox(found.item, views[i].vp) : null;
    const old = hover;
    if (JSON.stringify(nb) !== JSON.stringify(old && old.page === i ? old.box : null)) {
      hover = nb ? { page: i, box: nb } : null;
      if (old && old.page !== i) drawOverlay(old.page);
      drawOverlay(i);
    }
    ov.style.cursor = found ? 'text' : '';
  }
});
pagesEl.addEventListener('pointerleave', () => {
  if (hover) { const p = hover.page; hover = null; drawOverlay(p); }
});

function onDragMove(e) {
  const i = drag.page, v = views[i];
  if (!v) return;
  const vp = v.vp, page = state.pages[i], pt = ptIn(i, e);
  if (drag.mode === 'move') {
    const [x0, y0] = vp.toPdf(...drag.start), [x1, y1] = vp.toPdf(...pt);
    const a = page.annots.find((x) => x.id === drag.id);
    if (!a) return;
    const moved = clone(drag.orig);
    translateAnnot(moved, x1 - x0, y1 - y0);
    Object.assign(a, moved);
    drag.moved = drag.moved || Math.hypot(pt[0] - drag.start[0], pt[1] - drag.start[1]) > 2;
    drawOverlay(i);
  } else if (drag.mode === 'resize') {
    const a = page.annots.find((x) => x.id === drag.id);
    if (!a) return;
    const b = drag.box;
    const w = Math.max(5, pt[0] - b.x);
    let h = Math.max(5, pt[1] - b.y);
    if (a.type === 'image' && !e.shiftKey) h = w * b.h / b.w;
    Object.assign(a, screenRectToPdf(vp, { x: b.x, y: b.y, w, h }));
    drag.moved = true;
    drawOverlay(i);
  } else if (drag.mode === 'draw') {
    const p = drag.preview;
    if (p.tool === 'ink') {
      const last = p.pts[p.pts.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 1.5) p.pts.push(pt);
    } else p.cur = pt;
    drawOverlay(i);
  }
}
function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  const i = d.page, page = state.pages[i], v = views[i];
  if (!page || !v) return;
  const vp = v.vp;
  if (d.mode === 'move' || d.mode === 'resize') {
    if (d.moved) { pushHistory(d.snap); annotsChanged(i); }
    else if (d.mode === 'move') {
      const a = page.annots.find((x) => x.id === d.id);
      if (a && a.type === 'note') openNote(i, a.id, false, snapshot());
    }
    return;
  }
  const p = d.preview;
  const st = toolStyles[p.tool] || {};
  let a = null;
  if (p.tool === 'ink') {
    a = { type: 'ink', points: p.pts.map((q) => vp.toPdf(...q)), color: st.color, stroke: st.stroke };
  } else if (p.tool === 'line' || p.tool === 'arrow') {
    if (Math.hypot(p.cur[0] - p.start[0], p.cur[1] - p.start[1]) < 4) { drawOverlay(i); return; }
    const [x1, y1] = vp.toPdf(...p.start), [x2, y2] = vp.toPdf(...p.cur);
    a = { type: p.tool, x1, y1, x2, y2, color: st.color, stroke: st.stroke };
  } else {
    const r = rectFrom(p.start, p.cur);
    if (r.w < 3 || r.h < 3) { drawOverlay(i); return; }
    a = { type: p.tool, ...screenRectToPdf(vp, r) };
    if (p.tool === 'rect') Object.assign(a, { color: st.color, stroke: st.stroke, fill: !!st.fill });
    if (p.tool === 'highlight') a.color = st.color;
  }
  a.id = nid();
  pushHistory();
  page.annots.push(a);
  annotsChanged(i);
}
pagesEl.addEventListener('pointerup', endDrag);
pagesEl.addEventListener('pointercancel', endDrag);
pagesEl.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select' || !isOverlay(e.target)) return;
  const i = pageIndexOf(e.target);
  if (i < 0) return;
  const hit = hitTest(i, ptIn(i, e));
  if (hit && hit.type === 'text') startEditing(i, hit, false, snapshot());
});

// ================================================================ export PDF
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0, 0, 0);
}
function sanitizeText(font, str) {
  let out = '';
  for (const ch of str) {
    try { font.encodeText(ch); out += ch; } catch { out += ch === '\n' ? '\n' : '?'; }
  }
  return out;
}
async function rasterPage(out, page) {
  const pp = await getPdfPage(page);
  const v = pp.getViewport({ scale: 2.5, rotation: 0 });
  const c = document.createElement('canvas');
  c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pp.render({ canvasContext: ctx, viewport: v, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const [x0, y0, x1, y1] = page.view;
  const p = out.addPage([x1 - x0, y1 - y0]);
  p.setMediaBox(x0, y0, x1 - x0, y1 - y0);
  p.drawImage(img, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  return p;
}
async function loadLib(src) {
  const s = state.sources[src];
  if (!s || s.encrypted) return null;
  try { return await PDFDocument.load(s.bytes, { updateMetadata: false }); }
  catch (e) { console.warn('pdf-lib ne peut pas lire cette source', e); return null; }
}
function isWholeSource(pages) {
  if (pages !== state.pages || !pages.length) return false;
  const s0 = pages[0].src;
  if (s0 == null || state.sources[s0].encrypted) return false;
  return pages.length === state.sources[s0].pdf.numPages && pages.every((p, k) => p.src === s0 && p.index === k);
}
async function buildPdf(pages, indices) {
  indices = indices || pages.map((_, k) => k);
  if (isWholeSource(pages)) {
    // document d'origine complet et dans l'ordre : on le modifie directement,
    // ce qui conserve formulaires, signets, liens et métadonnées
    try {
      const out = await loadLib(pages[0].src);
      if (out && out.getPageCount() === pages.length) {
        await fillForms(out, pages[0].src);
        await decorate(out, pages, out.getPages(), indices);
        out.setModificationDate(new Date());
        return await out.save({ updateFieldAppearances: false });
      }
    } catch (e) { console.warn('Enregistrement direct impossible, copie des pages', e); }
  }
  const out = await PDFDocument.create();
  out.setProducer('Éditeur PDF');
  const needed = new Map();
  pages.forEach((p) => { if (p.src != null) { if (!needed.has(p.src)) needed.set(p.src, []); needed.get(p.src).push(p.index); } });
  const copied = new Map();
  let firstLib = null;
  for (const [src, idxs] of needed) {
    const lib = await loadLib(src);
    if (!lib) continue;
    await fillForms(lib, src);
    copied.set(src, await out.copyPages(lib, idxs));
    if (!firstLib) firstLib = lib;
  }
  const outPages = [];
  let rastered = 0;
  for (const page of pages) {
    let p;
    if (page.src == null) {
      const [x0, y0, x1, y1] = page.view;
      p = out.addPage([x1 - x0, y1 - y0]);
    } else if (copied.has(page.src)) {
      p = out.addPage(copied.get(page.src).shift());
    } else {
      p = await rasterPage(out, page);
      rastered++;
    }
    outPages.push(p);
  }
  if (firstLib) registerFields(out, outPages, firstLib);
  await decorate(out, pages, outPages, indices);
  if (rastered) toast(`${rastered} page(s) protégée(s) ou illisible(s) ont été converties en image.`, false, 6000);
  return out.save({ updateFieldAppearances: false });
}
async function decorate(out, pages, outPages, indices) {
  const fonts = {};
  const getFont = async (key) => (fonts[key] ??= await out.embedFont(StandardFonts[FONTS[key].std]));
  const imgs = {};
  const total = state.pages.length;
  for (let k = 0; k < pages.length; k++) {
    const page = pages[k], p = outPages[k], R = totalRot(page);
    p.setRotation(degrees(R));
    const vp1 = makeVp(page.view, R, 1);
    for (const a of stampAnnots(page, indices[k], total)) await drawAnnotPdf(out, p, a, getFont, imgs, vp1);
    for (const a of page.annots) await drawAnnotPdf(out, p, a, getFont, imgs, vp1);
  }
}
function addNoteAnnot(out, p, a, vp1) {
  const [sx, sy] = vp1.toScreen(a.x, a.y);
  const [ax, ay] = vp1.toPdf(sx, sy), [bx, by] = vp1.toPdf(sx + NOTE_SIZE, sy + NOTE_SIZE);
  const x0 = Math.min(ax, bx), y0 = Math.min(ay, by);
  const c = hexToRgb(a.color);
  const f = (n) => n.toFixed(3);
  const ops = `q ${f(c.red)} ${f(c.green)} ${f(c.blue)} rg 0 0 0 RG 0.6 w 0.5 4.4 19 15.1 re B `
    + '5 4.4 m 5 0.4 l 9.6 4.4 l h B 1.1 w 4 14.8 m 16 14.8 l S 4 11.2 m 16 11.2 l S 4 7.6 m 12 7.6 l S Q';
  const ap = out.context.register(out.context.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20] }));
  const dict = out.context.obj({
    Type: 'Annot', Subtype: 'Text', Name: 'Comment',
    Rect: [x0, y0, x0 + NOTE_SIZE, y0 + NOTE_SIZE],
    Contents: PDFHexString.fromText(a.text || ''),
    M: PDFString.fromDate(new Date(a.date || Date.now())),
    C: [c.red, c.green, c.blue], F: 28, Open: false,
    AP: { N: ap },
  });
  p.node.addAnnot(out.context.register(dict));
}
async function drawAnnotPdf(out, p, a, getFont, imgs, vp1) {
  const col = hexToRgb(a.color);
  switch (a.type) {
    case 'rect':
      if (a.fill) p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: col });
      else p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, borderColor: col, borderWidth: a.stroke });
      break;
    case 'highlight':
      p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: col, opacity: 0.4, blendMode: BlendMode.Multiply });
      break;
    case 'whiteout':
      p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: rgb(1, 1, 1) });
      break;
    case 'line': case 'arrow': {
      const opt = { thickness: a.stroke, color: col, lineCap: LineCapStyle.Round };
      p.drawLine({ start: { x: a.x1, y: a.y1 }, end: { x: a.x2, y: a.y2 }, ...opt });
      if (a.type === 'arrow') {
        const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), L = 6 + a.stroke * 3;
        for (const d of [-0.45, 0.45]) {
          p.drawLine({ start: { x: a.x2, y: a.y2 }, end: { x: a.x2 - L * Math.cos(ang + d), y: a.y2 - L * Math.sin(ang + d) }, ...opt });
        }
      }
      break;
    }
    case 'ink': {
      const pts = a.points;
      if (pts.length === 1) { p.drawCircle({ x: pts[0][0], y: pts[0][1], size: a.stroke / 2, color: col }); break; }
      for (let k = 1; k < pts.length; k++) {
        p.drawLine({ start: { x: pts[k - 1][0], y: pts[k - 1][1] }, end: { x: pts[k][0], y: pts[k][1] }, thickness: a.stroke, color: col, lineCap: LineCapStyle.Round });
      }
      break;
    }
    case 'text': {
      const font = await getFont(a.font);
      const th = a.rot * Math.PI / 180, lh = a.size * LINE_H;
      a.text.split('\n').forEach((ln, k) => {
        const t = sanitizeText(font, ln);
        if (!t) return;
        p.drawText(t, {
          x: a.x + k * lh * Math.sin(th), y: a.y - k * lh * Math.cos(th),
          size: a.size, font, color: col, rotate: degrees(a.rot), opacity: a.opacity ?? 1,
        });
      });
      break;
    }
    case 'image': {
      const rec = state.images[a.imgId];
      if (!rec) break;
      const im = (imgs[a.imgId] ??= rec.kind === 'png' ? await out.embedPng(rec.bytes) : await out.embedJpg(rec.bytes));
      const r = norm(a.rot);
      const o = r === 90 ? { x: a.x + a.w, y: a.y, width: a.h, height: a.w }
        : r === 180 ? { x: a.x + a.w, y: a.y + a.h, width: a.w, height: a.h }
        : r === 270 ? { x: a.x, y: a.y + a.h, width: a.h, height: a.w }
        : { x: a.x, y: a.y, width: a.w, height: a.h };
      p.drawImage(im, { ...o, rotate: degrees(r) });
      break;
    }
    case 'note':
      addNoteAnnot(out, p, a, vp1);
      break;
  }
}
async function save(saveAs = false) {
  if (!state.pages.length) return;
  finishEditing(); closeNote();
  busy('Enregistrement…');
  try {
    const bytes = await buildPdf(state.pages);
    busy(null);
    const r = await api.savePdf({ data: bytes, path: saveAs ? null : state.filePath, suggestedName: state.fileName || 'document.pdf' });
    if (r) {
      state.filePath = r.path;
      state.fileName = r.name;
      setDirty(false);
      addRecent(r.path, r.name);
      toast('Enregistré : ' + r.path);
    }
  } catch (e) {
    console.error(e);
    toast('Erreur lors de l\'enregistrement : ' + (e.message || e), true, 7000);
  } finally { busy(null); }
}

// ================================================================ signature
function openSignature() {
  if (!curPage()) return;
  const m = $('#modalSign'), c = $('#signCanvas'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  let drawing = false, any = false, last = null;
  const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.onpointerdown = (e) => { drawing = true; last = pos(e); c.setPointerCapture(e.pointerId); };
  c.onpointermove = (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.strokeStyle = $('#signColor').value;
    ctx.lineWidth = +$('#signWidth').value * (e.pressure && e.pointerType === 'pen' ? 0.5 + e.pressure : 1);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke();
    last = p; any = true;
  };
  c.onpointerup = c.onpointercancel = () => { drawing = false; };
  const close = () => { m.hidden = true; };
  $('#signClear').onclick = () => { ctx.clearRect(0, 0, c.width, c.height); any = false; };
  $('#signCancel').onclick = close;
  $('#signOk').onclick = async () => {
    if (!any) { close(); return; }
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
    const t = document.createElement('canvas');
    t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
    t.getContext('2d').drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
    const blob = await new Promise((r) => t.toBlob(r, 'image/png'));
    close();
    placeImage(await makeImage(new Uint8Array(await blob.arrayBuffer())), 0.3);
  };
  m.hidden = false;
}

// ================================================================ fichiers récents
const RECENT_KEY = 'recentFiles';
function getRecent() {
  try { return (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') || []).filter((r) => r && r.path); } catch { return []; }
}
function setRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* ignore */ }
  renderRecent();
}
function addRecent(path, name) {
  if (!path) return;
  const list = getRecent().filter((r) => r.path.toLowerCase() !== path.toLowerCase());
  list.unshift({ path, name: name || path.split(/[\\/]/).pop(), t: Date.now() });
  setRecent(list);
  api.addRecent(path);
}
function recentButton(r) {
  const b = document.createElement('button');
  b.className = 'recent-row';
  b.title = r.path;
  b.innerHTML = '<svg class="ic"><use href="#i-file"/></svg><span class="r-col"><span class="r-name"></span><span class="r-path"></span></span>';
  b.querySelector('.r-name').textContent = r.name;
  b.querySelector('.r-path').textContent = r.path.replace(/[\\/][^\\/]*$/, '');
  b.onclick = () => { closeRecentMenu(); openRecent(r); };
  return b;
}
function renderRecent() {
  const list = getRecent();
  const menu = $('#recentMenu');
  menu.textContent = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty-item';
    d.textContent = 'Aucun fichier récent';
    menu.append(d);
  } else {
    for (const r of list) menu.append(recentButton(r));
    const sep = document.createElement('div');
    sep.className = 'sep';
    const clr = document.createElement('button');
    clr.textContent = 'Effacer la liste';
    clr.onclick = () => { setRecent([]); closeRecentMenu(); };
    menu.append(sep, clr);
  }
  const box = $('#emptyRecentList');
  box.textContent = '';
  $('#emptyRecent').hidden = !list.length;
  for (const r of list.slice(0, 6)) box.append(recentButton(r));
}
async function openRecent(r) {
  if (!(await confirmDiscard())) return;
  let entry;
  try { entry = await api.readPath(r.path); }
  catch {
    toast('Fichier introuvable : ' + r.path, true, 5000);
    setRecent(getRecent().filter((x) => x.path !== r.path));
    return;
  }
  await openEntry(entry);
}
function closeRecentMenu() {
  $('#recentMenu').hidden = true;
  $('#btnRecent').classList.remove('open');
}

// ================================================================ thème
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#btnTheme use').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  $('#btnTheme').title = t === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre';
}
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', t); } catch { /* ignore */ }
  api.setTheme(t);
  applyTheme(t);
}

// ================================================================ branchements
$('#btnNew').onclick = newDocument;
$('#emptyNew').onclick = newDocument;
$('#btnOpen').onclick = openDialog;
$('#emptyOpen').onclick = openDialog;
$('#btnSave').onclick = () => save(false);
$('#btnSaveAs').onclick = () => save(true);
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnDelete').onclick = deleteSelected;
$('#btnImage').onclick = insertImageDialog;
$('#btnSign').onclick = openSignature;
$('#btnNumbers').onclick = openNumbersDialog;
$('#btnWatermark').onclick = openWatermarkDialog;
$('#btnSearch').onclick = openFind;
$('#btnZoomIn').onclick = () => setScale(state.scale * 1.2);
$('#btnZoomOut').onclick = () => setScale(state.scale / 1.2);
$('#btnFit').onclick = fitWidth;
$('#btnRotL').onclick = () => rotatePage(-90);
$('#btnRotR').onclick = () => rotatePage(90);
$('#btnDelPage').onclick = deletePage;
$('#btnBlank').onclick = () => { if (!state.pages.length) newDocument(); else insertBlank(); };
$('#btnMerge').onclick = mergePdfs;
$('#btnExtract').onclick = extractPage;
$('#btnPageUp').onclick = () => { if (state.current > 0) movePage(state.current, state.current - 1); };
$('#btnPageDown').onclick = () => { if (state.current < state.pages.length - 1) movePage(state.current, state.current + 1); };
$('#btnTheme').onclick = toggleTheme;
$('#btnRecent').onclick = (e) => {
  e.stopPropagation();
  const m = $('#recentMenu');
  m.hidden = !m.hidden;
  $('#btnRecent').classList.toggle('open', !m.hidden);
};
document.addEventListener('pointerdown', (e) => {
  if (!$('#recentMenu').hidden && !e.target.closest('.dropdown')) closeRecentMenu();
});
document.querySelectorAll('button[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
document.querySelectorAll('.side-tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.side-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('#tabPages').hidden = b.dataset.tab !== 'pages';
    $('#tabComments').hidden = b.dataset.tab !== 'comments';
    if (b.dataset.tab === 'comments') renderComments(); else highlightThumb();
  };
});

// recherche
$('#findInput').addEventListener('input', () => scheduleSearch(250));
$('#findInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (foldQuery($('#findInput').value) !== search.query) { clearTimeout(searchTimer); runSearch(); }
    else gotoMatch(search.index + (e.shiftKey ? -1 : 1));
  }
  if (e.key === 'F3') { e.preventDefault(); gotoMatch(search.index + (e.shiftKey ? -1 : 1)); }
});
$('#findNext').onclick = () => gotoMatch(search.index + 1);
$('#findPrev').onclick = () => gotoMatch(search.index - 1);
$('#findClose').onclick = closeFind;

viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pages.length) return;
  e.preventDefault();
  setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

const TOOL_KEYS = { v: 'select', t: 'text', e: 'edittext', h: 'highlight', n: 'note', r: 'rect', l: 'line', a: 'arrow', d: 'ink', w: 'whiteout' };
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (e.ctrlKey && k === 'o') { e.preventDefault(); openDialog(); return; }
  if (e.ctrlKey && k === 'f') { e.preventDefault(); if (state.pages.length) openFind(); return; }
  if (e.key === 'F3') { e.preventDefault(); gotoMatch(search.index + (e.shiftKey ? -1 : 1)); return; }
  if (document.querySelector('.modal:not([hidden])')) return;
  if (inField) return;
  if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); redo(); return; }
  if (!state.pages.length) return;
  if (e.ctrlKey && (k === '+' || k === '=')) { e.preventDefault(); setScale(state.scale * 1.2); return; }
  if (e.ctrlKey && k === '-') { e.preventDefault(); setScale(state.scale / 1.2); return; }
  if (e.ctrlKey && k === '0') { e.preventDefault(); fitWidth(); return; }
  if (e.ctrlKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedAnnot()) { e.preventDefault(); deleteSelected(); } return; }
  if (e.key === 'Escape') {
    if (!$('#findbar').hidden) closeFind();
    else if (state.sel) select(null);
    else setTool('select');
    return;
  }
  if (e.key === 'PageDown') { e.preventDefault(); goTo(state.current + 1); return; }
  if (e.key === 'PageUp') { e.preventDefault(); goTo(state.current - 1); return; }
  if (e.key === 'Home') { e.preventDefault(); goTo(0); return; }
  if (e.key === 'End') { e.preventDefault(); goTo(state.pages.length - 1); return; }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const a = selectedAnnot();
    if (a) {
      const vp = views[state.sel.page].vp, step = e.shiftKey ? 10 : 1;
      const [dx0, dy0] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      const [ax, ay] = vp.toPdf(0, 0), [bx, by] = vp.toPdf(dx0, dy0);
      pushHistory();
      translateAnnot(a, bx - ax, by - ay);
      annotsChanged(state.sel.page);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      viewer.scrollTop += e.key === 'ArrowDown' ? 60 : -60;
    } else {
      goTo(state.current + (e.key === 'ArrowRight' ? 1 : -1));
    }
    return;
  }
  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});

// glisser-déposer de fichiers
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); viewer.classList.add('dropping'); }
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) viewer.classList.remove('dropping'); });
document.addEventListener('drop', async (e) => {
  viewer.classList.remove('dropping');
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!files.length) return;
  e.preventDefault();
  const pdf = files.find((f) => /\.pdf$/i.test(f.name));
  const img = files.find((f) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
  if (pdf) {
    if (!(await confirmDiscard())) return;
    await openEntry({ path: api.pathForFile(pdf), name: pdf.name, data: new Uint8Array(await pdf.arrayBuffer()) });
  } else if (img && curPage()) {
    try { placeImage(await makeImage(new Uint8Array(await img.arrayBuffer()))); }
    catch (err) { toast('Image non prise en charge : ' + err.message, true); }
  }
});

api.onOpenFile(async (entry) => {
  if (!(await confirmDiscard())) return;
  await openEntry(entry);
});

// ================================================================ démarrage
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
try { api.setTheme(localStorage.getItem('theme') || 'system'); } catch { api.setTheme('system'); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (ev) => {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* ignore */ }
  if (!saved) applyTheme(ev.matches ? 'dark' : 'light');
});
renderRecent();
setTool('select');
updateButtons();
updateTitle();
renderComments();
api.initialFile().then((f) => { if (f) openEntry(f); });

// accès pour les tests automatisés
window.__editor = {
  state, views, search, buildPdf, openEntry, setTool, makeVp, goTo, setScale, runSearch, gotoMatch, select,
  pagePoint(i, x, y) {
    const v = views[i], r = v.ov.getBoundingClientRect();
    const [sx, sy] = v.vp.toScreen(x, y);
    return [Math.round(r.left + sx), Math.round(r.top + sy)];
  },
};
