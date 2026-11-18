import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

const PDFJS_BASE = new URL('../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.mjs';
const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode } = window.PDFLib;

const api = window.api;
const $ = (s) => document.querySelector(s);
const dpr = () => window.devicePixelRatio || 1;
const clone = (o) => JSON.parse(JSON.stringify(o));
const norm = (r) => ((r % 360) + 360) % 360;
let uid = Date.now() % 100000;
const nid = () => 'n' + (uid++).toString(36);

// ---------------------------------------------------------------- constants
const FONTS = {
  'Helvetica':      { label: 'Helvetica',      css: 'Helvetica, Arial, sans-serif',          weight: 'normal', std: 'Helvetica' },
  'Helvetica-Bold': { label: 'Helvetica gras', css: 'Helvetica, Arial, sans-serif',          weight: 'bold',   std: 'HelveticaBold' },
  'Times':          { label: 'Times',          css: '"Times New Roman", Times, serif',       weight: 'normal', std: 'TimesRoman' },
  'Times-Bold':     { label: 'Times gras',     css: '"Times New Roman", Times, serif',       weight: 'bold',   std: 'TimesRomanBold' },
  'Courier':        { label: 'Courier',        css: '"Courier New", Courier, monospace',     weight: 'normal', std: 'Courier' },
};
const cssFont = (a, s) => `${FONTS[a.font].weight} ${a.size * s}px ${FONTS[a.font].css}`;
const BASELINE = 0.94;   // distance top-of-line -> baseline, in em
const LINE_H = 1.2;

const TOOL_HINTS = {
  select: 'Cliquez sur un élément pour le sélectionner, glissez pour le déplacer, la poignée pour redimensionner. Double-clic sur un texte pour le modifier.',
  text: 'Cliquez sur la page pour écrire. Entrée = nouvelle ligne, Ctrl+Entrée ou clic ailleurs = valider, Échap = annuler.',
  edittext: 'Survolez un texte du PDF et cliquez dessus pour le remplacer.',
  highlight: 'Glissez pour surligner une zone.',
  rect: 'Glissez pour dessiner un rectangle.',
  line: 'Glissez pour tracer une ligne.',
  arrow: 'Glissez pour tracer une flèche.',
  ink: 'Dessinez librement à la souris ou au stylet.',
  whiteout: 'Glissez pour recouvrir une zone de blanc (pour masquer du contenu).',
};

const defaultStyles = {
  text: { color: '#000000', size: 14, font: 'Helvetica' },
  highlight: { color: '#fde047' },
  rect: { color: '#e11d48', stroke: 2, fill: false },
  line: { color: '#e11d48', stroke: 2 },
  arrow: { color: '#e11d48', stroke: 2 },
  ink: { color: '#1d4ed8', stroke: 2 },
};
let toolStyles = clone(defaultStyles);
try {
  const saved = JSON.parse(localStorage.getItem('toolStyles') || 'null');
  if (saved) for (const k in toolStyles) Object.assign(toolStyles[k], saved[k] || {});
} catch { /* ignore */ }
const saveStyles = () => { try { localStorage.setItem('toolStyles', JSON.stringify(toolStyles)); } catch { /* ignore */ } };
const styleKeyFor = (type) => (type === 'edittext' ? 'text' : type);

// ---------------------------------------------------------------- state
const state = {
  sources: [],      // { bytes, pdf, name, encrypted }
  pages: [],        // { id, src, index, view:[x0,y0,x1,y1], baseRot, rot, annots:[] }
  images: {},       // id -> { bytes, kind, el, w, h }
  current: 0,
  scale: 1,
  tool: 'select',
  selected: null,
  filePath: null,
  fileName: null,
  dirty: false,
  vp: null,
};
const hist = { undo: [], redo: [] };
const pdfPageCache = new Map();
const textCache = new Map();
const thumbBaseCache = new Map();

const totalRot = (p) => norm(p.baseRot + p.rot);
const curPage = () => state.pages[state.current] || null;

// ---------------------------------------------------------------- viewport math
// Same transform as pdf.js PageViewport (rotation clockwise, y down on screen).
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

// ---------------------------------------------------------------- UI helpers
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
  $('#zoomLabel').textContent = Math.round(state.scale * 100) + ' %';
}
function updateButtons() {
  const has = state.pages.length > 0;
  for (const id of ['btnSave', 'btnSaveAs', 'btnRotL', 'btnRotR', 'btnDelPage', 'btnMerge', 'btnExtract',
    'btnZoomIn', 'btnZoomOut', 'btnFit', 'btnImage', 'btnSign', 'btnPageUp', 'btnPageDown']) {
    $('#' + id).disabled = !has;
  }
  document.querySelectorAll('[data-tool]').forEach((b) => { b.disabled = !has; });
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

// ---------------------------------------------------------------- history
const snapshot = () => JSON.stringify(state.pages);
function pushHistory(snap = snapshot()) {
  hist.undo.push(snap);
  if (hist.undo.length > 200) hist.undo.shift();
  hist.redo.length = 0;
  setDirty(true);
  updateButtons();
}
function undo() {
  finishEditing();
  if (!hist.undo.length) return;
  hist.redo.push(snapshot());
  state.pages = JSON.parse(hist.undo.pop());
  setDirty(true);
  afterStructureChange();
}
function redo() {
  finishEditing();
  if (!hist.redo.length) return;
  hist.undo.push(snapshot());
  state.pages = JSON.parse(hist.redo.pop());
  setDirty(true);
  afterStructureChange();
}

// ---------------------------------------------------------------- loading
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

async function getTextItems(page) {
  if (page.src == null) return { items: [], styles: {} };
  const key = page.src + ':' + page.index;
  if (!textCache.has(key)) {
    textCache.set(key, getPdfPage(page).then((pp) => pp.getTextContent()).then((tc) => {
      const r = { items: tc.items.filter((it) => it.str && it.str.trim() && it.width > 0), styles: tc.styles };
      textCache.set(key, r);
      return r;
    }));
  }
  return textCache.get(key);
}

function resetDocument() {
  finishEditing();
  for (const s of state.sources) { try { s.pdf.destroy(); } catch { /* ignore */ } }
  state.sources = []; state.pages = []; state.images = {};
  state.current = 0; state.selected = null; state.filePath = null; state.fileName = null;
  pdfPageCache.clear(); textCache.clear(); thumbBaseCache.clear();
  hist.undo.length = 0; hist.redo.length = 0;
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  return api.confirm({ message: 'Des modifications ne sont pas enregistrées.', detail: 'Continuer et les abandonner ?', ok: 'Continuer' });
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
    showDocument();
    fitWidth();
    afterStructureChange();
  } catch (e) {
    console.error(e);
    resetDocument();
    showDocument();
    afterStructureChange();
    toast('Impossible d\'ouvrir ce fichier : ' + (e.message || e), true, 6000);
  } finally { busy(null); }
}

async function openDialog() {
  if (!(await confirmDiscard())) return;
  const files = await api.openPdf(false);
  if (files.length) await openEntry(files[0]);
}

async function newDocument() {
  if (!(await confirmDiscard())) return;
  resetDocument();
  state.pages = [blankPage(595.28, 841.89)];
  state.fileName = null;
  setDirty(true);
  showDocument();
  fitWidth();
  afterStructureChange();
}

const blankPage = (w, h) => ({ id: nid(), src: null, index: 0, view: [0, 0, w, h], baseRot: 0, rot: 0, annots: [] });

function showDocument() {
  const has = state.pages.length > 0;
  $('#empty').hidden = has;
  $('#pageWrap').hidden = !has;
}

// ---------------------------------------------------------------- rendering
let renderToken = 0;
let renderTask = null;

async function renderCurrent() {
  const page = curPage();
  updateStatus();
  if (!page) return;
  const token = ++renderToken;
  const R = totalRot(page);
  const vp = makeVp(page.view, R, state.scale);
  state.vp = vp;
  const wrap = $('#pageWrap');
  wrap.style.width = vp.width + 'px';
  wrap.style.height = vp.height + 'px';
  const ov = $('#overlay');
  ov.width = Math.round(vp.width * dpr());
  ov.height = Math.round(vp.height * dpr());
  redrawOverlay();
  repositionEditor();

  const base = $('#base');
  const W = Math.round(vp.width * dpr()), H = Math.round(vp.height * dpr());
  if (page.src == null) {
    base.width = W; base.height = H;
    const c = base.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    return;
  }
  const pp = await getPdfPage(page);
  if (token !== renderToken) return;
  if (renderTask) { try { renderTask.cancel(); } catch { /* ignore */ } }
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d');
  octx.fillStyle = '#fff'; octx.fillRect(0, 0, W, H);
  const v = pp.getViewport({ scale: state.scale * dpr(), rotation: R });
  const task = pp.render({ canvasContext: octx, viewport: v });
  renderTask = task;
  try { await task.promise; } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    console.error(e);
  }
  if (token !== renderToken) return;
  base.width = W; base.height = H;
  base.getContext('2d').drawImage(off, 0, 0);
  getTextItems(page).catch(() => {});
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
      for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
      ctx.stroke();
      break;
    }
    case 'text': {
      const [ax, ay] = vp.toScreen(a.x, a.y);
      ctx.translate(ax, ay);
      ctx.rotate(norm(vp.rot - a.rot) * Math.PI / 180);
      ctx.font = cssFont(a, s);
      ctx.fillStyle = a.color;
      ctx.textBaseline = 'alphabetic';
      a.text.split('\n').forEach((ln, i) => ctx.fillText(ln, 0, i * a.size * LINE_H * s));
      break;
    }
  }
  ctx.restore();
}

const measureCtx = document.createElement('canvas').getContext('2d');
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

let preview = null;   // in-progress drawing, in screen coords
let hoverBox = null;  // edittext hover rectangle (screen)

function redrawOverlay() {
  const page = curPage(), vp = state.vp;
  if (!page || !vp) return;
  const ov = $('#overlay'), ctx = ov.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ov.width, ov.height);
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  for (const a of page.annots) {
    if (editing && a.id === editing.id) continue;
    drawAnnot(ctx, a, vp);
  }
  if (preview) drawPreview(ctx);
  if (hoverBox) {
    ctx.save();
    ctx.fillStyle = 'rgba(37,99,235,.12)'; ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1;
    ctx.fillRect(hoverBox.x, hoverBox.y, hoverBox.w, hoverBox.h);
    ctx.strokeRect(hoverBox.x + .5, hoverBox.y + .5, hoverBox.w, hoverBox.h);
    ctx.restore();
  }
  const sel = selectedAnnot();
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

function drawPreview(ctx) {
  const p = preview, vp = state.vp, s = vp.scale;
  const st = toolStyles[p.tool] || {};
  ctx.save();
  if (p.tool === 'ink') {
    ctx.strokeStyle = st.color; ctx.lineWidth = st.stroke * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(...p.pts[0]);
    for (const q of p.pts) ctx.lineTo(...q);
    ctx.stroke();
  } else if (p.tool === 'line' || p.tool === 'arrow') {
    drawAnnot(ctx, { type: p.tool, color: st.color, stroke: st.stroke,
      x1: vp.toPdf(...p.start)[0], y1: vp.toPdf(...p.start)[1], x2: vp.toPdf(...p.cur)[0], y2: vp.toPdf(...p.cur)[1] }, vp);
  } else {
    const r = rectFrom(p.start, p.cur);
    if (p.tool === 'whiteout') { ctx.fillStyle = '#fff'; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeStyle = '#94a3b8'; ctx.setLineDash([4, 3]); ctx.strokeRect(r.x, r.y, r.w, r.h); }
    else if (p.tool === 'highlight') { ctx.globalAlpha = 0.4; ctx.fillStyle = st.color; ctx.fillRect(r.x, r.y, r.w, r.h); }
    else if (st.fill) { ctx.fillStyle = st.color; ctx.fillRect(r.x, r.y, r.w, r.h); }
    else { ctx.strokeStyle = st.color; ctx.lineWidth = st.stroke * s; ctx.strokeRect(r.x, r.y, r.w, r.h); }
  }
  ctx.restore();
}

const rectFrom = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) });

// ---------------------------------------------------------------- thumbnails
let thumbQueue = Promise.resolve();
const THUMB_W = 132;

async function thumbBase(page, R, s) {
  const key = (page.src == null ? 'blank' + page.view.join('x') : page.src + ':' + page.index) + ':' + R;
  if (thumbBaseCache.has(key)) return thumbBaseCache.get(key);
  const vp = makeVp(page.view, R, s);
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width * dpr()); c.height = Math.round(vp.height * dpr());
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (page.src != null) {
    const pp = await getPdfPage(page);
    await pp.render({ canvasContext: ctx, viewport: pp.getViewport({ scale: s * dpr(), rotation: R }) }).promise;
  }
  thumbBaseCache.set(key, c);
  return c;
}

async function drawThumb(page, canvas) {
  const R = totalRot(page);
  const s = THUMB_W / makeVp(page.view, R, 1).width;
  const vp = makeVp(page.view, R, s);
  const base = await thumbBase(page, R, s);
  canvas.width = base.width; canvas.height = base.height;
  canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  for (const a of page.annots) drawAnnot(ctx, a, vp);
}

function queueThumb(page, canvas) {
  thumbQueue = thumbQueue.then(() => drawThumb(page, canvas)).catch((e) => console.warn(e));
}

let dragFrom = null;
function buildThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.pages.forEach((page, i) => {
    const item = document.createElement('div');
    item.className = 'thumb' + (i === state.current ? ' active' : '');
    item.draggable = true;
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
    queueThumb(page, c);
  });
}

let thumbTimer = null;
function refreshCurrentThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const el = $('#thumbs').children[state.current];
    const page = curPage();
    if (el && page) queueThumb(page, el.querySelector('canvas'));
  }, 250);
}

function highlightThumb() {
  [...$('#thumbs').children].forEach((el, i) => el.classList.toggle('active', i === state.current));
  const el = $('#thumbs').children[state.current];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- navigation / zoom
function goTo(i) {
  if (i < 0 || i >= state.pages.length) return;
  finishEditing();
  state.current = i;
  state.selected = null;
  hoverBox = null;
  highlightThumb();
  $('#viewer').scrollTop = 0;
  renderCurrent();
  syncControls();
  updateButtons();
}

function setScale(s) {
  state.scale = Math.min(5, Math.max(0.2, s));
  finishEditing();
  renderCurrent();
}
function fitWidth() {
  const page = curPage();
  if (!page) return;
  const w1 = makeVp(page.view, totalRot(page), 1).width;
  const avail = $('#viewer').clientWidth - 80;
  state.scale = Math.min(3, Math.max(0.2, avail / w1));
  renderCurrent();
}

function afterStructureChange() {
  state.current = Math.min(Math.max(0, state.current), Math.max(0, state.pages.length - 1));
  if (state.selected && !selectedAnnot()) state.selected = null;
  showDocument();
  buildThumbs();
  renderCurrent();
  syncControls();
  updateButtons();
  updateTitle();
}

// ---------------------------------------------------------------- page operations
function rotatePage(delta) {
  const page = curPage(); if (!page) return;
  finishEditing();
  pushHistory();
  page.rot = norm(page.rot + delta);
  afterStructureChange();
}
async function deletePage() {
  if (!curPage()) return;
  if (state.pages.length === 1) { toast('Un document doit contenir au moins une page.'); return; }
  finishEditing();
  pushHistory();
  state.pages.splice(state.current, 1);
  afterStructureChange();
}
function movePage(from, to) {
  finishEditing();
  pushHistory();
  const [p] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, p);
  state.current = to;
  afterStructureChange();
}
function insertBlank() {
  finishEditing();
  const ref = curPage();
  const w = ref ? ref.view[2] - ref.view[0] : 595.28, h = ref ? ref.view[3] - ref.view[1] : 841.89;
  const p = blankPage(w, h);
  if (ref) p.rot = totalRot(ref);
  pushHistory();
  state.pages.splice(state.pages.length ? state.current + 1 : 0, 0, p);
  if (state.pages.length > 1) state.current++;
  afterStructureChange();
}
async function mergePdfs() {
  finishEditing();
  const files = await api.openPdf(true);
  if (!files.length) return;
  busy('Ajout des pages…');
  try {
    const snap = snapshot();
    const all = [];
    for (const f of files) all.push(...(await addSource(new Uint8Array(f.data), f.name)));
    pushHistory(snap);
    state.pages.splice(state.current + 1, 0, ...all);
    afterStructureChange();
    toast(`${all.length} page(s) ajoutée(s).`);
  } catch (e) {
    console.error(e);
    toast('Échec de la fusion : ' + (e.message || e), true);
  } finally { busy(null); }
}
async function extractPage() {
  const page = curPage(); if (!page) return;
  finishEditing();
  busy('Création du PDF…');
  try {
    const bytes = await buildPdf([page]);
    busy(null);
    const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    const r = await api.savePdf({ data: bytes, path: null, suggestedName: `${base} - page ${state.current + 1}.pdf` });
    if (r) toast('Page extraite : ' + r.name);
  } catch (e) {
    console.error(e);
    toast('Erreur : ' + (e.message || e), true);
  } finally { busy(null); }
}

// ---------------------------------------------------------------- annotations
function selectedAnnot() {
  const page = curPage();
  return page && state.selected ? page.annots.find((a) => a.id === state.selected) || null : null;
}
function select(id) {
  state.selected = id;
  syncControls();
  redrawOverlay();
  updateButtons();
}
function deleteSelected() {
  const page = curPage(), a = selectedAnnot();
  if (!a) return;
  pushHistory();
  page.annots = page.annots.filter((x) => x.id !== a.id && !(a.coverId && x.id === a.coverId));
  state.selected = null;
  annotsChanged();
}
function annotsChanged() {
  redrawOverlay();
  refreshCurrentThumb();
  syncControls();
  updateButtons();
}
function hitTest(page, pt) {
  for (let i = page.annots.length - 1; i >= 0; i--) {
    const a = page.annots[i];
    const b = screenBox(a, state.vp);
    const pad = 3;
    if (pt[0] >= b.x - pad && pt[0] <= b.x + b.w + pad && pt[1] >= b.y - pad && pt[1] <= b.y + b.h + pad) return a;
  }
  return null;
}
function nearHandle(a, pt) {
  const b = screenBox(a, state.vp);
  return Math.abs(pt[0] - (b.x + b.w)) <= 8 && Math.abs(pt[1] - (b.y + b.h)) <= 8;
}
function translateAnnot(a, dx, dy) {
  if ('x' in a) { a.x += dx; a.y += dy; }
  if ('x1' in a) { a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy; }
  if (a.points) a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
}

// image insertion
async function makeImage(bytes) {
  let kind = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : (bytes[0] === 0xFF && bytes[1] === 0xD8 ? 'jpg' : null);
  const url = URL.createObjectURL(new Blob([bytes]));
  const el = new Image();
  await new Promise((res, rej) => { el.onload = res; el.onerror = () => rej(new Error('image illisible')); el.src = url; });
  if (kind !== 'png') {
    // re-encode JPEG (EXIF orientation, CMYK) and other formats through a canvas
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
  const page = curPage(), vp = state.vp;
  if (!page || !vp) return;
  const img = state.images[imgId];
  let sw = Math.min(img.w * 0.75 * vp.scale, vp.width * widthFrac);
  let sh = sw * img.h / img.w;
  if (sh > vp.height * 0.6) { sh = vp.height * 0.6; sw = sh * img.w / img.h; }
  const v = $('#viewer');
  const cx = Math.min(vp.width / 2, v.scrollLeft + v.clientWidth / 2);
  const cy = Math.min(vp.height - sh / 2, Math.max(sh / 2, v.scrollTop + v.clientHeight / 2 - 24));
  const r = screenRectToPdf(vp, { x: cx - sw / 2, y: cy - sh / 2, w: sw, h: sh });
  pushHistory();
  const a = { id: nid(), type: 'image', ...r, imgId, rot: vp.rot };
  page.annots.push(a);
  setTool('select');
  select(a.id);
  annotsChanged();
}

async function insertImageDialog() {
  if (!curPage()) return;
  const f = await api.openImage();
  if (!f) return;
  try { placeImage(await makeImage(new Uint8Array(f.data))); }
  catch (e) { toast('Image non prise en charge : ' + e.message, true); }
}

// ---------------------------------------------------------------- inline text editing
let editing = null;

function startEditing(a, isNew, prevSnap, origText = null) {
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.wrap = 'off';
  ta.spellcheck = true;
  ta.value = a.text;
  $('#pageWrap').append(ta);
  editing = { id: a.id, isNew, prevSnap, origText, ta };
  state.selected = a.id;
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
  redrawOverlay();
  syncControls();
}

function editingAnnot() {
  const page = curPage();
  return editing && page ? page.annots.find((x) => x.id === editing.id) : null;
}

function styleEditor() {
  const a = editingAnnot();
  if (!a) return;
  const ta = editing.ta, s = state.vp.scale;
  ta.style.font = cssFont(a, s);
  ta.style.lineHeight = (a.size * LINE_H * s) + 'px';
  ta.style.color = a.color;
  repositionEditor();
  autosizeEditor();
}
function repositionEditor() {
  const a = editingAnnot();
  if (!a) return;
  const [sx, sy] = state.vp.toScreen(a.x, a.y);
  const s = state.vp.scale;
  editing.ta.style.left = sx + 'px';
  editing.ta.style.top = (sy - a.size * BASELINE * s) + 'px';
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
  const page = curPage();
  const a = page && page.annots.find((x) => x.id === e.id);
  const val = e.ta.value.replace(/\s+$/, '');
  if (!a) { redrawOverlay(); return; }
  const unchanged = e.origText != null && val === e.origText;
  if (cancel || !val.trim() || unchanged) {
    if (e.isNew) {
      state.pages[state.current] = JSON.parse(e.prevSnap)[state.current];
      state.selected = null;
    } else if (!cancel) {
      page.annots = page.annots.filter((x) => x.id !== a.id && !(a.coverId && x.id === a.coverId));
      state.selected = null;
      pushHistory(e.prevSnap);
    }
  } else if (e.isNew || val !== a.text) {
    a.text = val;
    pushHistory(e.prevSnap);
  }
  annotsChanged();
}

// Replace an existing piece of text of the PDF
async function editExistingText(pt) {
  const page = curPage(), vp = state.vp;
  const found = await findTextItem(page, pt);
  if (!found) { toast('Aucun texte à cet endroit. Survolez un texte : il s\'encadre en bleu.'); return; }
  const { item, styles } = found;
  const tx = item.transform;
  if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 || tx[0] <= 0) {
    toast('Ce texte est incliné : utilisez « Effaceur » puis « Texte ».'); return;
  }
  const size = Math.abs(tx[3]) || item.height;
  const pp = await getPdfPage(page);
  const font = guessFont(item, styles, pp);
  const color = sampleColor(itemScreenBox(item, vp));
  const snap = snapshot();
  const cover = { id: nid(), type: 'whiteout', x: tx[4] - 1, y: tx[5] - size * 0.28, w: item.width + 2, h: size * 1.25 };
  const a = { id: nid(), type: 'text', x: tx[4], y: tx[5], text: item.str, size: Math.round(size * 10) / 10, font, color, rot: 0, coverId: cover.id };
  page.annots.push(cover, a);
  hoverBox = null;
  startEditing(a, true, snap, item.str);
}

function itemPdfBox(item) {
  const tx = item.transform, size = Math.abs(tx[3]) || item.height;
  return { x: tx[4], y: tx[5] - size * 0.25, w: item.width, h: size * 1.15 };
}
function itemScreenBox(item, vp) {
  const r = itemPdfBox(item);
  return bboxOf([vp.toScreen(r.x, r.y), vp.toScreen(r.x + r.w, r.y + r.h)]);
}
async function findTextItem(page, pt) {
  const { items, styles } = await getTextItems(page);
  const [px, py] = state.vp.toPdf(pt[0], pt[1]);
  let best = null, bestArea = Infinity;
  for (const it of items) {
    const tx = it.transform;
    if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01) {
      // rotated text: rough box test in screen space
      const b = itemScreenBox(it, state.vp);
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
function sampleColor(b) {
  try {
    const base = $('#base'), k = dpr();
    const x = Math.max(0, Math.floor(b.x * k)), y = Math.max(0, Math.floor(b.y * k));
    const w = Math.max(1, Math.min(base.width - x, Math.ceil(b.w * k))), h = Math.max(1, Math.min(base.height - y, Math.ceil(b.h * k)));
    const d = base.getContext('2d').getImageData(x, y, w, h).data;
    let best = 765, col = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] + d[i + 1] + d[i + 2];
      if (l < best) { best = l; col = [d[i], d[i + 1], d[i + 2]]; }
    }
    if (best > 600) return '#000000';
    return '#' + col.map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch { return '#000000'; }
}

// ---------------------------------------------------------------- pointer handling
let drag = null;
const overlay = $('#overlay');
const evPt = (e) => { const r = overlay.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

overlay.addEventListener('mousedown', (e) => e.preventDefault());
overlay.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0) return;
  const page = curPage(), vp = state.vp;
  if (!page || !vp) return;
  const pt = evPt(e);
  if (editing) {
    finishEditing();
    if (state.tool === 'text' || state.tool === 'edittext') return;
  }
  overlay.setPointerCapture(e.pointerId);
  const tool = state.tool;
  if (tool === 'select') {
    const sel = selectedAnnot();
    if (sel && isBoxType(sel) && nearHandle(sel, pt)) {
      drag = { mode: 'resize', id: sel.id, start: pt, box: screenBox(sel, vp), snap: snapshot(), moved: false };
      return;
    }
    const hit = hitTest(page, pt);
    if (hit) {
      select(hit.id);
      drag = { mode: 'move', id: hit.id, start: pt, orig: clone(hit), snap: snapshot(), moved: false };
    } else select(null);
  } else if (tool === 'text') {
    const st = toolStyles.text;
    const snap = snapshot();
    const [x, y] = vp.toPdf(pt[0], pt[1] + st.size * BASELINE * vp.scale);
    const a = { id: nid(), type: 'text', x, y, text: '', size: st.size, font: st.font, color: st.color, rot: vp.rot };
    page.annots.push(a);
    startEditing(a, true, snap);
  } else if (tool === 'edittext') {
    await editExistingText(pt);
  } else if (tool === 'ink') {
    drag = { mode: 'draw' };
    preview = { tool, pts: [pt] };
  } else {
    drag = { mode: 'draw' };
    preview = { tool, start: pt, cur: pt };
  }
});

overlay.addEventListener('pointermove', async (e) => {
  const page = curPage(), vp = state.vp;
  if (!page || !vp) return;
  const pt = evPt(e);
  if (!drag) {
    if (state.tool === 'select') {
      const sel = selectedAnnot();
      overlay.style.cursor = sel && isBoxType(sel) && nearHandle(sel, pt) ? 'nwse-resize' : (hitTest(page, pt) ? 'move' : 'default');
    } else if (state.tool === 'edittext') {
      const found = await findTextItem(page, pt);
      const nb = found ? itemScreenBox(found.item, vp) : null;
      if (JSON.stringify(nb) !== JSON.stringify(hoverBox)) { hoverBox = nb; redrawOverlay(); }
      overlay.style.cursor = found ? 'text' : 'default';
    }
    return;
  }
  if (drag.mode === 'move') {
    const [x0, y0] = vp.toPdf(...drag.start), [x1, y1] = vp.toPdf(...pt);
    const a = page.annots.find((x) => x.id === drag.id);
    if (!a) return;
    const moved = clone(drag.orig);
    translateAnnot(moved, x1 - x0, y1 - y0);
    Object.assign(a, moved);
    drag.moved = drag.moved || Math.hypot(pt[0] - drag.start[0], pt[1] - drag.start[1]) > 1;
    redrawOverlay();
  } else if (drag.mode === 'resize') {
    const a = page.annots.find((x) => x.id === drag.id);
    if (!a) return;
    const b = drag.box;
    let w = Math.max(5, pt[0] - b.x), h = Math.max(5, pt[1] - b.y);
    if (a.type === 'image' && !e.shiftKey) h = w * b.h / b.w;
    Object.assign(a, screenRectToPdf(vp, { x: b.x, y: b.y, w, h }));
    drag.moved = true;
    redrawOverlay();
  } else if (drag.mode === 'draw' && preview) {
    if (preview.tool === 'ink') {
      const last = preview.pts[preview.pts.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 1.5) preview.pts.push(pt);
    } else {
      preview.cur = pt;
    }
    redrawOverlay();
  }
});

function endDrag() {
  const page = curPage(), vp = state.vp;
  if (!drag || !page) { drag = null; return; }
  const d = drag;
  drag = null;
  if (d.mode === 'move' || d.mode === 'resize') {
    if (d.moved) { pushHistory(d.snap); annotsChanged(); }
    return;
  }
  const p = preview;
  preview = null;
  if (!p) return;
  const st = toolStyles[p.tool] || {};
  let a = null;
  if (p.tool === 'ink') {
    a = { type: 'ink', points: p.pts.map((q) => vp.toPdf(...q)), color: st.color, stroke: st.stroke };
  } else if (p.tool === 'line' || p.tool === 'arrow') {
    if (Math.hypot(p.cur[0] - p.start[0], p.cur[1] - p.start[1]) < 4) { redrawOverlay(); return; }
    const [x1, y1] = vp.toPdf(...p.start), [x2, y2] = vp.toPdf(...p.cur);
    a = { type: p.tool, x1, y1, x2, y2, color: st.color, stroke: st.stroke };
  } else {
    const r = rectFrom(p.start, p.cur);
    if (r.w < 3 || r.h < 3) { redrawOverlay(); return; }
    a = { type: p.tool, ...screenRectToPdf(vp, r) };
    if (p.tool === 'rect') Object.assign(a, { color: st.color, stroke: st.stroke, fill: !!st.fill });
    if (p.tool === 'highlight') a.color = st.color;
  }
  a.id = nid();
  pushHistory();
  page.annots.push(a);
  annotsChanged();
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);
overlay.addEventListener('pointerleave', () => { if (hoverBox) { hoverBox = null; redrawOverlay(); } });

overlay.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select') return;
  const page = curPage(); if (!page) return;
  const hit = hitTest(page, evPt(e));
  if (hit && hit.type === 'text') startEditing(hit, false, snapshot());
});

// ---------------------------------------------------------------- tools & style controls
function setTool(t) {
  finishEditing();
  state.tool = t;
  preview = null; hoverBox = null;
  if (t !== 'select') state.selected = null;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  overlay.style.cursor = t === 'select' ? 'default' : (t === 'text' ? 'text' : 'crosshair');
  syncControls();
  redrawOverlay();
  updateStatus();
  updateButtons();
}

const FIELDS = {
  text: ['color', 'font', 'size'],
  highlight: ['color'],
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
    if (!ctlSnap) ctlSnap = snapshot();
    a[field] = value;
    if (editing && a.id === editing.id) styleEditor();
    redrawOverlay();
    if (final) { pushHistory(ctlSnap); ctlSnap = null; refreshCurrentThumb(); }
    const ts = toolStyles[a.type];
    if (ts && field in ts) { ts[field] = value; saveStyles(); }
  } else {
    const ts = toolStyles[styleKeyFor(state.tool)];
    if (ts) { ts[field] = value; saveStyles(); }
  }
}
function bindControl(sel, field, parse) {
  const el = $(sel);
  const val = () => parse(el);
  el.addEventListener('input', () => { const v = val(); if (v != null) onControl(field, v, false); });
  el.addEventListener('change', () => { const v = val(); if (v != null) onControl(field, v, true); });
}
const num = (min) => (el) => { const v = parseFloat(el.value); return Number.isFinite(v) && v >= min ? v : null; };
bindControl('#ctlColor', 'color', (el) => el.value);
bindControl('#ctlFont', 'font', (el) => el.value);
bindControl('#ctlSize', 'size', num(2));
bindControl('#ctlStroke', 'stroke', num(0.25));
bindControl('#ctlFill', 'fill', (el) => el.checked);
for (const [k, f] of Object.entries(FONTS)) {
  const o = document.createElement('option'); o.value = k; o.textContent = f.label; $('#ctlFont').append(o);
}

// ---------------------------------------------------------------- PDF export
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0, 0, 0);
}
function sanitizeText(font, str) {
  let out = '';
  for (const ch of str) {
    try { font.encodeText(ch); out += ch; }
    catch { out += '?'; }
  }
  return out;
}

async function rasterPage(out, page) {
  const pp = await getPdfPage(page);
  const scale = 2.5;
  const v = pp.getViewport({ scale, rotation: 0 });
  const c = document.createElement('canvas');
  c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pp.render({ canvasContext: ctx, viewport: v }).promise;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const [x0, y0, x1, y1] = page.view;
  const p = out.addPage([x1 - x0, y1 - y0]);
  p.setMediaBox(x0, y0, x1 - x0, y1 - y0);
  p.drawImage(img, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  return p;
}

async function buildPdf(pages) {
  const out = await PDFDocument.create();
  out.setProducer('Éditeur PDF');
  const fonts = {};
  const getFont = async (key) => (fonts[key] ??= await out.embedFont(StandardFonts[FONTS[key].std]));
  const imgs = {};

  // copy pages source by source (keeps shared resources shared)
  const needed = new Map();
  pages.forEach((pg) => { if (pg.src != null) { if (!needed.has(pg.src)) needed.set(pg.src, []); needed.get(pg.src).push(pg.index); } });
  const copied = new Map();
  let rastered = 0;
  for (const [src, idxs] of needed) {
    const s = state.sources[src];
    let lib = null;
    if (!s.encrypted) {
      try { lib = await PDFDocument.load(s.bytes, { updateMetadata: false }); }
      catch (e) { console.warn('pdf-lib load failed, falling back to raster', e); }
    }
    if (lib) copied.set(src, await out.copyPages(lib, idxs));
  }

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
    p.setRotation(degrees(totalRot(page)));
    for (const a of page.annots) await drawAnnotPdf(out, p, a, getFont, imgs);
  }
  if (rastered) toast(`${rastered} page(s) protégée(s) ou illisible(s) ont été converties en image.`, false, 6000);
  return out.save();
}

async function drawAnnotPdf(out, p, a, getFont, imgs) {
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
      for (let i = 1; i < pts.length; i++) {
        p.drawLine({ start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] }, thickness: a.stroke, color: col, lineCap: LineCapStyle.Round });
      }
      break;
    }
    case 'text': {
      const font = await getFont(a.font);
      const th = a.rot * Math.PI / 180, lh = a.size * LINE_H;
      a.text.split('\n').forEach((ln, i) => {
        const t = sanitizeText(font, ln);
        if (!t) return;
        p.drawText(t, { x: a.x + i * lh * Math.sin(th), y: a.y - i * lh * Math.cos(th), size: a.size, font, color: col, rotate: degrees(a.rot) });
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
  }
}

async function save(saveAs = false) {
  if (!state.pages.length) return;
  finishEditing();
  busy('Enregistrement…');
  try {
    const bytes = await buildPdf(state.pages);
    busy(null);
    const r = await api.savePdf({ data: bytes, path: saveAs ? null : state.filePath, suggestedName: state.fileName || 'document.pdf' });
    if (r) {
      state.filePath = r.path;
      state.fileName = r.name;
      setDirty(false);
      toast('Enregistré : ' + r.path);
    }
  } catch (e) {
    console.error(e);
    toast('Erreur lors de l\'enregistrement : ' + (e.message || e), true, 7000);
  } finally { busy(null); }
}

// ---------------------------------------------------------------- signature pad
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
    // trim transparent borders
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

// ---------------------------------------------------------------- wiring
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
document.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });

$('#viewer').addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pages.length) return;
  e.preventDefault();
  setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

const TOOL_KEYS = { v: 'select', t: 'text', e: 'edittext', h: 'highlight', r: 'rect', l: 'line', a: 'arrow', d: 'ink', w: 'whiteout' };
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (e.ctrlKey && k === 'o') { e.preventDefault(); openDialog(); return; }
  if (inField || !$('#modalSign').hidden || !$('#modalPrompt').hidden) return;
  if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); redo(); return; }
  if (!state.pages.length) return;
  if (e.ctrlKey && (k === '+' || k === '=')) { e.preventDefault(); setScale(state.scale * 1.2); return; }
  if (e.ctrlKey && k === '-') { e.preventDefault(); setScale(state.scale / 1.2); return; }
  if (e.ctrlKey && k === '0') { e.preventDefault(); fitWidth(); return; }
  if (e.ctrlKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedAnnot()) { e.preventDefault(); deleteSelected(); } return; }
  if (e.key === 'Escape') { if (state.selected) select(null); else setTool('select'); return; }
  if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !state.selected)) { e.preventDefault(); goTo(state.current + 1); return; }
  if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !state.selected)) { e.preventDefault(); goTo(state.current - 1); return; }
  if (e.key.startsWith('Arrow') && state.selected) {
    e.preventDefault();
    const a = selectedAnnot(), step = (e.shiftKey ? 10 : 1) / state.scale;
    const [dx0, dy0] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    const [ax, ay] = state.vp.toPdf(0, 0), [bx, by] = state.vp.toPdf(dx0, dy0);
    pushHistory();
    translateAnnot(a, bx - ax, by - ay);
    annotsChanged();
    return;
  }
  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});

// drag & drop of files onto the window
const viewer = $('#viewer');
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); viewer.classList.add('dropping'); }
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) viewer.classList.remove('dropping'); });
document.addEventListener('drop', async (e) => {
  viewer.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const pdf = files.find((f) => /\.pdf$/i.test(f.name));
  const img = files.find((f) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
  if (pdf) {
    if (!(await confirmDiscard())) return;
    const p = api.pathForFile(pdf);
    await openEntry({ path: p, name: pdf.name, data: new Uint8Array(await pdf.arrayBuffer()) });
  } else if (img && curPage()) {
    try { placeImage(await makeImage(new Uint8Array(await img.arrayBuffer()))); }
    catch (err) { toast('Image non prise en charge : ' + err.message, true); }
  }
});

window.addEventListener('resize', () => { if (editing) repositionEditor(); });

// ---------------------------------------------------------------- start
setTool('select');
updateButtons();
updateTitle();
api.initialFile().then((f) => { if (f) openEntry(f); });

// exposed for debugging / automated tests
window.__editor = { state, buildPdf, openEntry, setTool, makeVp, sampleColor, itemScreenBox, getTextItems };
