import { zipSync, strToU8 } from 'fflate';
import { Viewer } from './viewer.js';
import { History, clamp, localToWorld, hitLayer, resizeLayer, compose, applyCrop } from './layers.js';

const $ = id => document.getElementById(id);
const canvas = $('uv-canvas'); const context = canvas.getContext('2d');
const assets = new Map(); const workspaces = new Map();
let catalog, model, part, workspace, viewer, maskGuides = new Map(), textures = new Map();
let loadToken = 0, zoom = 1, pointer = null, cropState = null, renderQueued = false, toastTimer, busy = false;
const uuid = () => crypto.randomUUID();
const activeDocument = () => workspace?.parts[part?.id];
const activeLayer = () => activeDocument()?.layers.find(layer => layer.id === activeDocument().selectedId);
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function status(message) { $('app-status').textContent = message; }
function snapshot() { return structuredClone(workspace.parts); }
function commit() { workspace.history.push(snapshot()); workspace.dirty = true; updateButtons(); }
function updateButtons() {
  const loaded = !!part && $('model-loader').hidden; const layer = activeLayer(); const doc = activeDocument();
  for (const id of ['add-images', 'download-uv', 'export-part', 'export-all', 'project-save', 'project-save-mobile', 'reset-part', 'base-color', 'transparent-base']) $(id).disabled = !loaded || busy;
  for (const id of ['crop-layer', 'duplicate-layer', 'delete-layer', 'center-x', 'center-y', 'reset-transform']) $(id).disabled = !loaded || !layer || busy;
  $('undo').disabled = !loaded || !workspace?.history.canUndo || busy; $('redo').disabled = !loaded || !workspace?.history.canRedo || busy;
  const index = doc?.layers.findIndex(l => l.id === layer?.id) ?? -1;
  $('layer-up').disabled = index < 0 || index >= doc.layers.length - 1 || busy;
  $('layer-down').disabled = index <= 0 || busy;
  $('part-focus').disabled = !part?.hasMesh; $('isolate-part').disabled = !part?.hasMesh;
  $('layer-properties').hidden = !layer;
}
function updateProperties() {
  const layer = activeLayer(); const doc = activeDocument(); if (!doc) return;
  const set = (id, value) => { if (document.activeElement !== $(id)) $(id).value = value; };
  $('base-color').value = doc.color; $('color-value').textContent = doc.color.toUpperCase(); $('transparent-base').checked = doc.transparent;
  if (layer) {
    set('layer-name', layer.name); set('layer-opacity', Math.round(layer.opacity * 100)); $('opacity-value').textContent = `${Math.round(layer.opacity * 100)}%`;
    set('layer-width', Math.round(layer.w * 1000) / 10); set('layer-height', Math.round(layer.h * 1000) / 10); set('layer-angle', Math.round(layer.angle * 10) / 10);
    set('layer-x', Math.round(layer.x * 1000) / 10); set('layer-y', Math.round(layer.y * 1000) / 10);
  }
  updateButtons();
}
function renderLayers() {
  const doc = activeDocument(); if (!doc) return;
  $('layers-list').replaceChildren(); $('layer-count').textContent = doc.layers.length;
  if (!doc.layers.length) $('layers-list').append(element('div', 'no-layers', 'Добавьте первую картинку'));
  for (const layer of [...doc.layers].reverse()) {
    const row = element('div', `layer-row${layer.id === doc.selectedId ? ' selected' : ''}${layer.visible ? '' : ' invisible'}`); row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `Слой ${layer.name}`); row.dataset.layerId = layer.id;
    const image = element('img', 'layer-thumb'); image.src = assets.get(layer.assetId).thumbnail; image.alt = '';
    const titleBox = element('div'); titleBox.title = layer.name; titleBox.append(element('div', 'layer-title', layer.name), element('div', 'layer-subtitle', `${Math.round(layer.opacity * 100)}% · ${layer.crop.w < .999 || layer.crop.h < .999 ? 'обрезано' : 'картинка'}`));
    const visibility = element('button', 'visibility'); visibility.append(icon(layer.visible ? 'eye' : 'eye-off')); visibility.title = layer.visible ? 'Скрыть слой' : 'Показать слой'; visibility.setAttribute('aria-label', visibility.title);
    visibility.addEventListener('click', event => { event.stopPropagation(); layer.visible = !layer.visible; doc.selectedId = layer.id; commit(); refresh(); });
    row.addEventListener('click', () => { doc.selectedId = layer.id; refresh(); }); row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); doc.selectedId = layer.id; refresh(); } });
    row.append(image, titleBox, visibility); $('layers-list').append(row);
  }
}
const checkerTile = document.createElement('canvas'); checkerTile.width = checkerTile.height = 32;
const tileContext = checkerTile.getContext('2d'); tileContext.fillStyle = '#080a0d'; tileContext.fillRect(0, 0, 32, 32); tileContext.fillStyle = '#0c0f13'; tileContext.fillRect(0, 0, 16, 16); tileContext.fillRect(16, 16, 16, 16);
const checkerPattern = context.createPattern(checkerTile, 'repeat');
function checker(ctx) {
  ctx.save(); ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = checkerPattern; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore();
}
function selectionHandles(layer) {
  const corners = [-1, 1].flatMap(sx => [-1, 1].map(sy => ({ ...localToWorld(layer, sx * layer.w / 2, sy * layer.h / 2), sx, sy })));
  const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([sx, sy]) => ({ ...localToWorld(layer, sx * layer.w / 2, sy * layer.h / 2), sx, sy }));
  return { corners, sides, rotation: localToWorld(layer, 0, -layer.h / 2 - 30 / canvas.getBoundingClientRect().width) };
}
function guideOverlay(doc) {
  const guide = maskGuides.get(part.id);
  const rgb = doc.color.slice(1).match(/../g).map(v => parseInt(v, 16));
  const light = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 140;
  const color = $('show-base').checked && !doc.transparent && light ? '#193824' : '#a2dfed';
  if (guide.dataset.tint !== color) {
    // Reuse the mask canvas and preserve its alpha; no second 4 MB canvas needed.
    const c = guide.getContext('2d'); c.save(); c.globalCompositeOperation = 'source-in'; c.fillStyle = color; c.fillRect(0, 0, 1024, 1024); c.restore(); guide.dataset.tint = color;
  }
  return guide;
}
function paintEditor() {
  const doc = activeDocument(); if (!doc) return;
  // The dark working background is a display preference, independent of exports.
  compose(canvas, doc, assets, { transparent: !$('show-base').checked || doc.transparent }); checker(context);
  if ($('show-guide').checked && maskGuides.get(part.id)) { context.save(); context.globalAlpha = Number($('guide-opacity').value) / 100; context.drawImage(guideOverlay(doc), 0, 0, 1024, 1024); context.restore(); }
  const layer = activeLayer();
  if (layer) {
    const pixels = 1024 / Math.max(100, canvas.getBoundingClientRect().width); const handles = selectionHandles(layer);
    context.save(); context.strokeStyle = '#8cf4f2'; context.fillStyle = '#142b30'; context.lineWidth = 1.5 * pixels;
    const ordered = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => localToWorld(layer, x * layer.w / 2, y * layer.h / 2));
    context.beginPath(); ordered.forEach((p, i) => i ? context.lineTo(p.x * 1024, p.y * 1024) : context.moveTo(p.x * 1024, p.y * 1024)); context.closePath(); context.stroke();
    const top = localToWorld(layer, 0, -layer.h / 2); context.beginPath(); context.moveTo(top.x * 1024, top.y * 1024); context.lineTo(handles.rotation.x * 1024, handles.rotation.y * 1024); context.stroke();
    for (const p of [...handles.corners, ...handles.sides]) { const side = (p.sx && p.sy ? 8 : 6) * pixels; context.fillRect(p.x * 1024 - side / 2, p.y * 1024 - side / 2, side, side); context.strokeRect(p.x * 1024 - side / 2, p.y * 1024 - side / 2, side, side); }
    context.beginPath(); context.arc(handles.rotation.x * 1024, handles.rotation.y * 1024, 5 * pixels, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
  }
  $('empty-hint').hidden = !!doc.layers.length;
}
function renderTexture(id = part?.id) {
  if (!id || !workspace?.parts[id] || !textures.get(id)) return;
  compose(textures.get(id), workspace.parts[id], assets, { transparent: false }); viewer?.update(id);
}
function schedulePaint() {
  if (renderQueued) return; renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderTexture(); paintEditor(); updateProperties(); });
}
function refresh() { renderTexture(); paintEditor(); renderLayers(); updateProperties(); }
function selectPart(id) {
  part = model.parts.find(p => p.id === id); if (!part) return;
  $('part-select').value = id; $('part-heading').textContent = part.name;
  $('part-size').textContent = `${part.width} × ${part.height}${part.hasMesh ? '' : ' · только 2D'}`;
  if (!part.hasMesh) $('isolate-part').checked = false;
  viewer?.select(part.id, $('isolate-part').checked); refresh();
  status(`${model.name} · ${part.name}${part.hasMesh ? ' · перетаскивайте слои на развёртке' : ' · в исходной папке есть маска, mesh отсутствует'}`);
}
function fitCanvas(nextZoom = zoom) {
  zoom = clamp(nextZoom, .5, 4); const stage = $('uv-stage'); const base = Math.max(200, Math.min(stage.clientWidth - 46, stage.clientHeight - 46));
  const pixels = Math.round(base * zoom); canvas.style.width = canvas.style.height = `${pixels}px`; $('zoom-fit').textContent = `${Math.round(zoom * 100)}%`; paintEditor();
}
async function maskGuide(blob) {
  const bitmap = await createImageBitmap(blob, { resizeWidth: 1024, resizeHeight: 1024, resizeQuality: 'high' });
  const source = document.createElement('canvas'); source.width = source.height = 1024; const c = source.getContext('2d', { willReadFrequently: true }); c.drawImage(bitmap, 0, 0); bitmap.close();
  const data = c.getImageData(0, 0, 1024, 1024); const edges = c.createImageData(1024, 1024);
  for (let y = 1; y < 1023; y++) for (let x = 1; x < 1023; x++) {
    const p = (y * 1024 + x) * 4; const a = data.data[p + 3]; if (!a) continue;
    const edge = data.data[p - 4 + 3] < 64 || data.data[p + 4 + 3] < 64 || data.data[p - 4096 + 3] < 64 || data.data[p + 4096 + 3] < 64;
    edges.data[p] = 76; edges.data[p + 1] = 122; edges.data[p + 2] = 65; edges.data[p + 3] = edge ? 160 : Math.round(a * .12);
  }
  c.putImageData(edges, 0, 0); return source;
}
async function switchModel(id) {
  const requested = catalog.models.find(m => m.id === id); if (!requested) throw new Error('Неизвестная модель.');
  const token = ++loadToken; $('model-loader').hidden = false; $('model-select').disabled = true; $('part-select').disabled = true; $('load-progress').textContent = 'Загружаем детали и развёртки…'; updateButtons();
  model = requested; part = null; maskGuides = new Map(); textures = new Map();
  if (!workspaces.has(id)) {
    const parts = Object.fromEntries(model.parts.map(p => [p.id, { color: p.color, transparent: false, selectedId: null, layers: [] }]));
    const history = new History(); history.push(parts); workspaces.set(id, { parts, history, dirty: false });
  }
  workspace = workspaces.get(id); $('model-select').value = id;
  $('part-select').replaceChildren(...model.parts.map(p => { const option = element('option', '', `${p.name}${p.hasMesh ? '' : ' · только 2D'}`); option.value = p.id; return option; }));
  let count = 0;
  try {
    for (const p of model.parts) { const texture = document.createElement('canvas'); texture.width = texture.height = 1024; compose(texture, workspace.parts[p.id], assets, { transparent: false }); textures.set(p.id, texture); }
    const guidesPromise = Promise.all(model.parts.map(async p => {
      const response = await fetch(p.mask); if (!response.ok) throw new Error(`Не загрузилась развёртка: ${p.name}`);
      const guide = await maskGuide(await response.blob()); if (token !== loadToken) return;
      maskGuides.set(p.id, guide); $('load-progress').textContent = `Развёртки: ${++count} / ${model.parts.length}`;
    }));
    const viewPromise = viewer ? viewer.load(model.model, textures, () => token === loadToken) : Promise.resolve();
    await Promise.all([guidesPromise, viewPromise]); if (token !== loadToken) return;
    $('mesh-count').textContent = `${model.parts.filter(p => p.hasMesh).length} деталей`;
    $('model-loader').hidden = true; $('part-select').disabled = false; $('model-select').disabled = false;
    selectPart(model.parts[0].id); fitCanvas(1); updateButtons();
  } catch (error) {
    if (token !== loadToken) return;
    $('load-progress').textContent = error.message; $('model-select').disabled = false; toast('Не удалось загрузить модель. Проверьте соединение и выберите её ещё раз.'); console.error(error);
  }
}
async function prepareAsset(blob, name = 'Картинка') {
  if (blob.size > 25 * 1024 * 1024) throw new Error('Картинка слишком большая. Выберите файл до 25 МБ.');
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width > 16384 || bitmap.height > 16384 || bitmap.width * bitmap.height > 64000000) { bitmap.close(); throw new Error('Изображение слишком большое. Уменьшите его до 8 000 пикселей по стороне.'); }
  let image = bitmap;
  if (Math.max(bitmap.width, bitmap.height) > 4096) {
    const scale = 4096 / Math.max(bitmap.width, bitmap.height); image = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * scale), resizeHeight: Math.round(bitmap.height * scale), resizeQuality: 'high' }); bitmap.close();
  }
  const thumbnailCanvas = document.createElement('canvas'); thumbnailCanvas.width = thumbnailCanvas.height = 48;
  const scale = Math.min(48 / image.width, 48 / image.height); thumbnailCanvas.getContext('2d').drawImage(image, (48 - image.width * scale) / 2, (48 - image.height * scale) / 2, image.width * scale, image.height * scale);
  const asset = { id: uuid(), bitmap: image, name, thumbnail: thumbnailCanvas.toDataURL('image/png') }; return asset;
}
async function addImages(files) {
  const doc = activeDocument(); const targetModel = model?.id; const targetPart = part?.id; if (!doc || busy) return;
  const accepted = [...files].filter(f => ['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(f.type));
  if (!accepted.length) { toast('Выберите картинки PNG, JPG, WebP или AVIF.'); return; }
  if (doc.layers.length + accepted.length > 32) { toast('В одной детали доступно до 32 слоёв.'); return; }
  busy = true; updateButtons(); const prepared = [];
  try {
    for (const file of accepted) prepared.push(await prepareAsset(file, file.name.replace(/\.[^.]+$/, '')));
    if (model.id !== targetModel || part.id !== targetPart) throw new Error('Деталь изменилась во время загрузки. Добавьте картинки ещё раз.');
    for (const asset of prepared) {
      assets.set(asset.id, asset); const fit = Math.min(.64 / asset.bitmap.width, .64 / asset.bitmap.height);
      const layer = { id: uuid(), assetId: asset.id, name: asset.name.slice(0, 100), x: .5, y: .5, w: asset.bitmap.width * fit, h: asset.bitmap.height * fit, angle: 0, opacity: 1, visible: true, flipX: false, flipY: false, crop: { x: 0, y: 0, w: 1, h: 1 } };
      doc.layers.push(layer); doc.selectedId = layer.id;
    }
    commit(); refresh(); toast(`Добавлено ${prepared.length === 1 ? 'изображение' : `изображений: ${prepared.length}`}`);
  } catch (error) { prepared.forEach(asset => { if (!assets.has(asset.id)) asset.bitmap.close(); }); toast(error.message); }
  finally { busy = false; updateButtons(); $('image-input').value = ''; }
}
function point(event, surface = canvas) { const r = surface.getBoundingClientRect(); return { x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height }; }
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || busy || !activeDocument()) return;
  const p = point(event); const doc = activeDocument(); let layer = activeLayer(); let action = 'move'; let handle;
  if (layer) {
    const h = selectionHandles(layer); const hit = v => Math.hypot(v.x - p.x, v.y - p.y) * canvas.getBoundingClientRect().width < 12;
    handle = [...h.corners, ...h.sides].find(hit); if (handle) action = 'resize'; else if (hit(h.rotation)) action = 'rotate';
  }
  if (action === 'move') {
    layer = [...doc.layers].reverse().find(l => l.visible && hitLayer(l, p)); doc.selectedId = layer?.id || null;
  }
  refresh(); if (!layer) return;
  pointer = { action, layer, start: p, original: structuredClone(layer), handle };
  canvas.setPointerCapture(event.pointerId); canvas.focus(); event.preventDefault();
});
canvas.addEventListener('pointermove', event => {
  if (!pointer) {
    const layer = activeLayer(); const p = point(event); let cursor = 'default';
    if (layer) {
      const h = selectionHandles(layer); const hit = v => Math.hypot(v.x - p.x, v.y - p.y) * canvas.getBoundingClientRect().width < 12;
      const handle = [...h.corners, ...h.sides].find(hit);
      if (handle) { const angle = ((Math.atan2(handle.sy, handle.sx) * 180 / Math.PI + layer.angle) % 180 + 180) % 180; cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'][Math.round(angle / 45)]; }
      else if (hit(h.rotation)) cursor = 'grab'; else if (activeDocument().layers.some(l => l.visible && hitLayer(l, p))) cursor = 'move';
    }
    canvas.style.cursor = cursor; return;
  }
  const p = point(event); const { original: old, layer, action, handle } = pointer;
  if (action === 'move') { layer.x = old.x + p.x - pointer.start.x; layer.y = old.y + p.y - pointer.start.y; }
  if (action === 'rotate') { layer.angle = Math.atan2(p.y - old.y, p.x - old.x) * 180 / Math.PI + 90; if (event.shiftKey) layer.angle = Math.round(layer.angle / 15) * 15; }
  if (action === 'resize') resizeLayer(layer, old, handle, p, $('lock-aspect').checked || event.shiftKey);
  schedulePaint();
});
function finishPointer() { if (!pointer) return; pointer = null; commit(); refresh(); }
canvas.addEventListener('pointerup', finishPointer); canvas.addEventListener('pointercancel', finishPointer); canvas.addEventListener('lostpointercapture', finishPointer);

function restoreHistory(value) { if (!value) return; workspace.parts = value; for (const id of textures.keys()) renderTexture(id); workspace.dirty = true; refresh(); }
$('undo').addEventListener('click', () => restoreHistory(workspace.history.undo())); $('redo').addEventListener('click', () => restoreHistory(workspace.history.redo()));
$('part-select').addEventListener('change', event => { if (busy) { event.target.value = part.id; return; } selectPart(event.target.value); });
$('model-select').addEventListener('change', event => { if (busy) { event.target.value = model.id; return; } switchModel(event.target.value); });
$('add-images').addEventListener('click', () => $('image-input').click()); $('image-input').addEventListener('change', event => addImages(event.target.files));
$('delete-layer').addEventListener('click', () => { const doc = activeDocument(); const layer = activeLayer(); if (!layer) return; doc.layers = doc.layers.filter(l => l.id !== layer.id); doc.selectedId = doc.layers.at(-1)?.id || null; commit(); refresh(); });
$('duplicate-layer').addEventListener('click', () => { const doc = activeDocument(); const layer = activeLayer(); if (!layer) return; if (doc.layers.length >= 32) { toast('В одной детали доступно до 32 слоёв.'); return; } const copy = structuredClone(layer); copy.id = uuid(); copy.name = `${layer.name} — копия`.slice(0, 100); copy.x += .02; copy.y += .02; doc.layers.splice(doc.layers.indexOf(layer) + 1, 0, copy); doc.selectedId = copy.id; commit(); refresh(); });
for (const [id, step] of [['layer-up', 1], ['layer-down', -1]]) $(id).addEventListener('click', () => { const doc = activeDocument(); const index = doc.layers.indexOf(activeLayer()); if (index < 0 || !doc.layers[index + step]) return; [doc.layers[index], doc.layers[index + step]] = [doc.layers[index + step], doc.layers[index]]; commit(); refresh(); });
for (const [id, key] of [['flip-x', 'flipX'], ['flip-y', 'flipY']]) $(id).addEventListener('click', () => { const layer = activeLayer(); if (!layer) return; layer[key] = !layer[key]; commit(); refresh(); });
$('layer-name').addEventListener('change', event => { const layer = activeLayer(); if (!layer) return; layer.name = event.target.value.trim().slice(0, 100) || 'Картинка'; commit(); refresh(); });
$('layer-opacity').addEventListener('input', event => { const layer = activeLayer(); if (!layer) return; layer.opacity = Number(event.target.value) / 100; schedulePaint(); });
$('layer-opacity').addEventListener('change', () => { commit(); refresh(); });
for (const [id, key] of [['layer-x', 'x'], ['layer-y', 'y'], ['layer-angle', 'angle'], ['layer-width', 'w'], ['layer-height', 'h']]) $(id).addEventListener('change', event => {
  const layer = activeLayer(); const number = Number(event.target.value); if (!layer || !Number.isFinite(number) || event.target.value === '') { updateProperties(); return; }
  if (key === 'w' || key === 'h') {
    let size = clamp(number / 100, .005, 10); const other = key === 'w' ? 'h' : 'w';
    if ($('lock-aspect').checked) { const scale = clamp(size / layer[key], Math.max(.005 / layer.w, .005 / layer.h), Math.min(10 / layer.w, 10 / layer.h)); layer[other] *= scale; size = layer[key] * scale; }
    layer[key] = size;
  }
  else layer[key] = key === 'angle' ? clamp(number, -360, 360) : clamp(number / 100, -10, 10);
  commit(); refresh();
});
for (const [id, axis] of [['center-x', 'x'], ['center-y', 'y']]) $(id).addEventListener('click', () => { const layer = activeLayer(); if (!layer) return; layer[axis] = .5; commit(); refresh(); });
$('reset-transform').addEventListener('click', () => { const layer = activeLayer(); if (!layer) return; const image = assets.get(layer.assetId).bitmap; const w = image.width * layer.crop.w, h = image.height * layer.crop.h; const fit = .64 / Math.max(w, h); Object.assign(layer, { x: .5, y: .5, w: w * fit, h: h * fit, angle: 0, flipX: false, flipY: false }); commit(); refresh(); });
$('base-color').addEventListener('input', event => { activeDocument().color = event.target.value; schedulePaint(); }); $('base-color').addEventListener('change', () => { commit(); refresh(); });
$('transparent-base').addEventListener('change', event => { activeDocument().transparent = event.target.checked; commit(); refresh(); });
$('show-guide').addEventListener('change', paintEditor);
$('guide-opacity').addEventListener('input', paintEditor);
$('zoom-in').addEventListener('click', () => fitCanvas(zoom * 1.25)); $('zoom-out').addEventListener('click', () => fitCanvas(zoom / 1.25)); $('zoom-fit').addEventListener('click', () => { fitCanvas(1); $('uv-stage').scrollTo(0, 0); });
$('uv-stage').addEventListener('wheel', event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); fitCanvas(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)); } }, { passive: false });
new ResizeObserver(() => fitCanvas()).observe($('uv-stage'));
$('camera-reset').addEventListener('click', () => viewer?.reset()); $('part-focus').addEventListener('click', () => viewer?.focus(part.id)); $('isolate-part').addEventListener('change', () => viewer?.select(part.id, $('isolate-part').checked));
$('reset-part').addEventListener('click', () => { const doc = activeDocument(); if (!doc.layers.length) return; if (!confirm('Убрать все слои этой детали? Это действие можно отменить.')) return; doc.layers = []; doc.selectedId = null; commit(); refresh(); });

let dragDepth = 0;
$('uv-stage').addEventListener('dragenter', event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth++; $('uv-stage').classList.add('drag-over'); } });
$('uv-stage').addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
$('uv-stage').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('uv-stage').classList.remove('drag-over'); } });
$('uv-stage').addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('uv-stage').classList.remove('drag-over'); addImages(event.dataTransfer.files); });
window.addEventListener('dragover', event => event.preventDefault()); window.addEventListener('drop', event => event.preventDefault());
document.addEventListener('keydown', event => {
  if (busy || !workspace || $('crop-dialog').open || $('help-dialog').open || event.target.closest('input,textarea,select')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); restoreHistory(event.shiftKey ? workspace.history.redo() : workspace.history.undo()); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); restoreHistory(workspace.history.redo()); return; }
  const layer = activeLayer(); if (!layer) return;
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); $('delete-layer').click(); }
  if (event.key.startsWith('Arrow')) { event.preventDefault(); const distance = (event.shiftKey ? 10 : 1) / 1024; if (event.key === 'ArrowLeft') layer.x -= distance; if (event.key === 'ArrowRight') layer.x += distance; if (event.key === 'ArrowUp') layer.y -= distance; if (event.key === 'ArrowDown') layer.y += distance; commit(); refresh(); }
});
window.addEventListener('beforeunload', event => { if ([...workspaces.values()].some(w => w.dirty)) { event.preventDefault(); event.returnValue = ''; } });
$('help-button').addEventListener('click', () => $('help-dialog').showModal()); $('help-close').addEventListener('click', () => $('help-dialog').close());

// Cropping works on the source picture. Source pixels outside the selected box
// remain available for resetting the crop; the layer keeps its placement.
const cropCanvas = $('crop-canvas'); const cropContext = cropCanvas.getContext('2d');
function cropFrame() {
  const image = assets.get(cropState.layer.assetId).bitmap; const scale = Math.min(860 / image.width, 520 / image.height);
  return { x: (900 - image.width * scale) / 2, y: (560 - image.height * scale) / 2, w: image.width * scale, h: image.height * scale, image };
}
function paintCrop() {
  const f = cropFrame(); const c = cropState.rect; cropContext.clearRect(0, 0, 900, 560); cropContext.fillStyle = '#29313a'; cropContext.fillRect(0, 0, 900, 560); cropContext.drawImage(f.image, f.x, f.y, f.w, f.h);
  cropContext.fillStyle = '#0d172bae'; cropContext.fillRect(f.x, f.y, f.w, f.h);
  if (c) {
    const x = f.x + c.x * f.w, y = f.y + c.y * f.h, w = c.w * f.w, h = c.h * f.h;
    cropContext.drawImage(f.image, c.x * f.image.width, c.y * f.image.height, c.w * f.image.width, c.h * f.image.height, x, y, w, h);
    cropContext.strokeStyle = '#b8ed42'; cropContext.lineWidth = 2; cropContext.strokeRect(x, y, w, h); cropContext.fillStyle = '#b8ed42';
    for (const px of [x, x + w]) for (const py of [y, y + h]) cropContext.fillRect(px - 4, py - 4, 8, 8);
    $('crop-size').textContent = `${Math.round(c.w * f.image.width)} × ${Math.round(c.h * f.image.height)} px`;
  } else $('crop-size').textContent = 'Выделите область';
  $('crop-apply').disabled = !c || c.w < .001 || c.h < .001;
  $('crop-copy').disabled = $('crop-apply').disabled || activeDocument().layers.length >= 32;
}
$('crop-layer').addEventListener('click', () => { const layer = activeLayer(); if (!layer) return; cropState = { layer, rect: { ...layer.crop }, drag: null }; $('crop-dialog').showModal(); paintCrop(); });
$('crop-close').addEventListener('click', () => $('crop-dialog').close());
$('crop-new').addEventListener('click', () => { cropState.rect = null; paintCrop(); }); $('crop-reset').addEventListener('click', () => { cropState.rect = { x: 0, y: 0, w: 1, h: 1 }; paintCrop(); });
function cropPoint(event) { const p = point(event, cropCanvas); const f = cropFrame(); return { x: clamp((p.x * 900 - f.x) / f.w, 0, 1), y: clamp((p.y * 560 - f.y) / f.h, 0, 1) }; }
cropCanvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return; const p = cropPoint(event); const c = cropState.rect; const f = cropFrame(); let mode = 'new'; let corner;
  if (c) {
    corner = [0, 1].flatMap(x => [0, 1].map(y => ({ x: c.x + x * c.w, y: c.y + y * c.h, sx: x, sy: y }))).find(v => Math.hypot((v.x - p.x) * f.w, (v.y - p.y) * f.h) < 15);
    if (corner) mode = 'resize'; else if (!event.shiftKey && p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) mode = 'move';
  }
  cropState.drag = { mode, corner, start: p, original: c ? { ...c } : null }; cropCanvas.setPointerCapture(event.pointerId); event.preventDefault();
});
cropCanvas.addEventListener('pointermove', event => {
  const d = cropState?.drag; if (!d) return; const p = cropPoint(event);
  if (d.mode === 'new') cropState.rect = { x: Math.min(p.x, d.start.x), y: Math.min(p.y, d.start.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
  if (d.mode === 'move') cropState.rect = { ...d.original, x: clamp(d.original.x + p.x - d.start.x, 0, 1 - d.original.w), y: clamp(d.original.y + p.y - d.start.y, 0, 1 - d.original.h) };
  if (d.mode === 'resize') { const anchor = { x: d.corner.sx ? d.original.x : d.original.x + d.original.w, y: d.corner.sy ? d.original.y : d.original.y + d.original.h }; cropState.rect = { x: Math.min(anchor.x, p.x), y: Math.min(anchor.y, p.y), w: Math.abs(anchor.x - p.x), h: Math.abs(anchor.y - p.y) }; }
  paintCrop();
});
cropCanvas.addEventListener('pointerup', () => { cropState.drag = null; }); cropCanvas.addEventListener('pointercancel', () => { if (cropState) cropState.drag = null; });
$('crop-apply').addEventListener('click', () => { if (!cropState.rect || cropState.rect.w < .001 || cropState.rect.h < .001) return; applyCrop(cropState.layer, cropState.rect); commit(); refresh(); $('crop-dialog').close(); toast('Обрезка применена'); });
$('crop-copy').addEventListener('click', () => { const doc = activeDocument(); if (!cropState.rect || cropState.rect.w < .001 || cropState.rect.h < .001 || doc.layers.length >= 32) return; const copy = structuredClone(cropState.layer); copy.id = uuid(); copy.name = `${copy.name} — область`.slice(0, 100); applyCrop(copy, cropState.rect); doc.layers.splice(doc.layers.indexOf(cropState.layer) + 1, 0, copy); doc.selectedId = copy.id; commit(); refresh(); $('crop-dialog').close(); toast('Область добавлена отдельным слоем: её можно перемещать'); });

function download(blob, name) { const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
$('show-base').addEventListener('change', paintEditor);
$('download-uv').addEventListener('click', () => exporting(async () => {
  const selectedPart = part;
  const response = await fetch(selectedPart.mask);
  if (!response.ok) throw new Error('Не удалось скачать UV-развёртку. Попробуйте ещё раз.');
  // Download the untouched source PNG: no canvas, tint, layers or resizing.
  download(await response.blob(), `${selectedPart.id}_MASK.png`);
  toast(`UV-развёртка сохранена · ${selectedPart.width} × ${selectedPart.height}`);
}));
const blobOf = (surface, type = 'image/png') => new Promise((resolve, reject) => surface.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось сохранить изображение.')), type));
function exportCanvas(p, doc, resolution = $('export-size').value) {
  const output = document.createElement('canvas'); const size = Number(resolution); output.width = size || p.width; output.height = size || p.height; compose(output, doc, assets); return output;
}
async function exporting(action) { if (busy || !part) return; busy = true; updateButtons(); status('Готовим файлы…'); try { await action(); } catch (error) { toast(error.message); console.error(error); } finally { busy = false; updateButtons(); status(`${model.name} · ${part.name}`); } }
$('export-part').addEventListener('click', () => exporting(async () => { const blob = await blobOf(exportCanvas(part, activeDocument())); download(blob, `${part.id}.png`); toast('PNG сохранён без UV-подсказки'); }));
$('export-all').addEventListener('click', () => exporting(async () => {
  const selectedModel = model; const docs = snapshot(); const resolution = $('export-size').value; const files = {};
  const names = [];
  for (const p of selectedModel.parts) { status(`Сохраняем ${p.name}…`); const output = exportCanvas(p, docs[p.id], resolution); const blob = await blobOf(output); files[`${p.id}.png`] = new Uint8Array(await blob.arrayBuffer()); names.push({ partId: p.id, part: p.name, file: `${p.id}.png`, width: output.width, height: output.height, hasMesh: p.hasMesh }); output.width = output.height = 1; }
  files['pack.json'] = strToU8(JSON.stringify({ format: 'livery-textures', version: 1, vehicleId: selectedModel.id, vehicleName: selectedModel.name, textures: names }, null, 2));
  download(new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), `${selectedModel.id}-graphics.zip`); workspace.dirty = false; toast('Набор текстур сохранён в ZIP');
}));
async function assetData(asset) { const c = document.createElement('canvas'); c.width = asset.bitmap.width; c.height = asset.bitmap.height; c.getContext('2d').drawImage(asset.bitmap, 0, 0); return c.toDataURL('image/png'); }
$('project-save-mobile').addEventListener('click', () => $('project-save').click());
$('project-save').addEventListener('click', () => exporting(async () => {
  const parts = snapshot(); const ids = new Set(Object.values(parts).flatMap(doc => doc.layers.map(l => l.assetId))); const savedAssets = {};
  for (const id of ids) savedAssets[id] = { name: assets.get(id).name, image: await assetData(assets.get(id)) };
  download(new Blob([JSON.stringify({ format: 'livery-studio-project', version: 1, modelId: model.id, parts, assets: savedAssets })], { type: 'application/json' }), `${model.id}.livery.json`); workspace.dirty = false; toast('Проект сохранён вместе со слоями и картинками');
}));
$('project-open').addEventListener('click', () => { if (!busy) $('project-input').click(); });
function validateProject(value) {
  if (!value || value.format !== 'livery-studio-project' || value.version !== 1 || !catalog.models.some(m => m.id === value.modelId)) throw new Error('Это не поддерживаемый проект Livery Studio.');
  const definition = catalog.models.find(m => m.id === value.modelId); const documents = {}; const ids = new Set();
  if (!value.parts || !value.assets || typeof value.parts !== 'object' || typeof value.assets !== 'object') throw new Error('Файл проекта повреждён.');
  for (const p of definition.parts) {
    const doc = value.parts[p.id]; if (!doc || !/^#[0-9a-f]{6}$/i.test(doc.color) || !Array.isArray(doc.layers) || doc.layers.length > 32) throw new Error('Некорректные данные детали.');
    const layers = doc.layers.map(l => {
      if (!l || typeof l.id !== 'string' || l.id.length > 100 || typeof l.assetId !== 'string' || typeof l.name !== 'string' || !['x', 'y', 'w', 'h', 'angle', 'opacity'].every(k => Number.isFinite(l[k])) || Math.abs(l.x) > 10 || Math.abs(l.y) > 10 || l.w <= 0 || l.h <= 0 || l.w > 10 || l.h > 10 || Math.abs(l.angle) > 100000 || l.opacity < 0 || l.opacity > 1) throw new Error('Некорректный слой в проекте.');
      const c = l.crop; if (!c || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(c[k])) || c.x < 0 || c.y < 0 || c.w <= 0 || c.h <= 0 || c.x + c.w > 1.000001 || c.y + c.h > 1.000001) throw new Error('Некорректная область обрезки.');
      if (!value.assets[l.assetId] || !/^data:image\/png;base64,/.test(value.assets[l.assetId].image)) throw new Error('В проекте отсутствует картинка.');
      ids.add(l.assetId);
      return { id: uuid(), assetId: l.assetId, name: l.name.slice(0, 100), x: l.x, y: l.y, w: l.w, h: l.h, angle: l.angle, opacity: l.opacity, visible: !!l.visible, flipX: !!l.flipX, flipY: !!l.flipY, crop: { x: c.x, y: c.y, w: c.w, h: c.h } };
    });
    documents[p.id] = { color: doc.color, transparent: !!doc.transparent, selectedId: layers.at(-1)?.id || null, layers };
  }
  if (ids.size > 128) throw new Error('В проекте слишком много картинок.');
  return { definition, documents, ids };
}
$('project-input').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file || busy) return; busy = true; updateButtons(); const prepared = [];
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('Проект слишком большой. Максимум 100 МБ.');
    const value = JSON.parse(await file.text()); const { definition, documents, ids } = validateProject(value); const replacements = new Map();
    for (const id of ids) { const encoded = value.assets[id].image.split(',')[1]; const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); const asset = await prepareAsset(new Blob([bytes], { type: 'image/png' }), String(value.assets[id].name || 'Картинка').slice(0, 100)); prepared.push(asset); replacements.set(id, asset.id); }
    for (const doc of Object.values(documents)) for (const layer of doc.layers) layer.assetId = replacements.get(layer.assetId);
    prepared.forEach(asset => assets.set(asset.id, asset)); const history = new History(); history.push(documents); workspaces.set(definition.id, { parts: documents, history, dirty: false });
    await switchModel(definition.id); toast('Проект открыт: слои и картинки восстановлены');
  } catch (error) { prepared.forEach(asset => { if (!assets.has(asset.id)) asset.bitmap.close(); }); toast(error instanceof SyntaxError ? 'Не удалось прочитать файл проекта.' : error.message); }
  finally { busy = false; updateButtons(); $('project-input').value = ''; }
});

async function initialize() {
  const response = await fetch('./assets/catalog.json', { cache: 'no-cache' }); if (!response.ok) throw new Error('Каталог моделей не загрузился.'); catalog = await response.json();
  $('model-select').replaceChildren(...catalog.models.map(m => { const option = element('option', '', m.name); option.value = m.id; return option; }));
  try { viewer = new Viewer($('viewer'), id => { if (!busy) selectPart(id); }); }
  catch (error) { console.warn('3D unavailable', error); toast('3D недоступно в этом браузере. Развёртки и экспорт продолжают работать.'); $('camera-reset').disabled = true; }
  await switchModel(catalog.defaultModel);
  // Local diagnostics for browser tests; no image bytes are exposed here.
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') window.liveryDiagnostics = () => ({ modelId: model.id, partId: part.id, meshParts: viewer?.parts.size || 0, dirty: workspace.dirty, layerCount: activeDocument().layers.length, layers: structuredClone(activeDocument().layers), textureVersions: [...viewer?.parts || []].map(([id, meshes]) => ({ id, versions: meshes.map(m => m.material.map.version) })) });
}
initialize().catch(error => { status(error.message); $('load-progress').textContent = error.message; toast('Не удалось запустить редактор. Обновите страницу.'); console.error(error); });
