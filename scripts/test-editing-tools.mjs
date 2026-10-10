import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.EDITOR_URL || 'http://127.0.0.1:8794/moto-livery-editor/';
await mkdir('outputs/tests', { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(error.message)); page.on('request', r => requests.push({ url: r.url(), method: r.method() })); page.on('dialog', dialog => dialog.accept());
async function number(id, value) { await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab'); }
async function transform() { return page.evaluate(() => Object.fromEntries([['x', 'layer-x'], ['y', 'layer-y'], ['w', 'layer-width'], ['h', 'layer-height'], ['angle', 'layer-angle']].map(([key, id]) => [key, Number(document.getElementById(id).value) / (key === 'angle' ? 1 : 100)]))); }
async function download(id, name) { const pending = page.waitForEvent('download'); await page.locator(`#${id}`).click(); const result = await pending; const path = `outputs/tests/${name}`; await result.saveAs(path); return readFile(path); }
async function project(name) { const data = JSON.parse(await download('project-save', name)); const doc = data.parts[await page.locator('#part-select').inputValue()]; return { data, doc, layer: doc.layers.find(l => l.id === doc.selectedId) }; }
async function rgba(dataUrl, x, y) { return page.evaluate(async ({ dataUrl, x, y }) => { const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0)); const b = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; const ctx = c.getContext('2d'); ctx.drawImage(b, 0, 0); const pixel = [...ctx.getImageData(Math.floor(x * b.width), Math.floor(y * b.height), 1, 1).data]; b.close(); return pixel; }, { dataUrl, x, y }); }
async function pickBackground() { const box = await page.locator('#background-canvas').boundingBox(); await page.mouse.click(box.x + box.width * .1, box.y + box.height * .3); await page.waitForFunction(() => !document.querySelector('#background-apply').disabled); }
try {
  await page.goto(base); await page.locator('#model-loader').waitFor({ state: 'hidden', timeout: 60000 });
  await page.locator('#help-button').click(); let box = await page.locator('#help-dialog').boundingBox();
  assert.ok(Math.abs(box.x + box.width / 2 - 800) < 2 && Math.abs(box.y + box.height / 2 - 500) < 2);
  for (const text of ['скачайте текстуры', 'Загрузите PNG в Roblox', 'Добавьте ID в тюнинге']) assert.ok((await page.locator('#help-dialog').textContent()).includes(text));
  await page.screenshot({ path: 'outputs/tests/instructions-20261010.png' }); await page.locator('#help-done').click(); checks.push('centred instruction: export PNG, upload to Roblox, tuning IDs');
  const logo = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 200; const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 320, 200); ctx.fillStyle = '#dc1428'; ctx.fillRect(100, 60, 120, 80); ctx.fillStyle = '#fff'; ctx.fillRect(140, 80, 40, 40); return c.toDataURL('image/png').split(',')[1]; });
  await page.locator('#image-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(logo, 'base64') }); await page.waitForFunction(() => document.querySelector('#layer-count').textContent === '1');
  await number('layer-width', 250); await number('layer-height', 140); await number('layer-x', 120); await number('layer-angle', 27);
  const oversized = await transform(); await page.locator('#zoom-layer').click(); assert.deepEqual(await transform(), oversized);
  const stage = await page.locator('#uv-stage').boundingBox();
  for (const h of await page.locator('#selection-overlay rect, #selection-overlay circle').all()) { const bounds = await h.boundingBox(); assert.ok(bounds.x >= stage.x && bounds.y >= stage.y && bounds.x + bounds.width <= stage.x + stage.width + 1 && bounds.y + bounds.height <= stage.y + stage.height + 1, `handle outside viewport: ${JSON.stringify(bounds)}`); }
  await page.screenshot({ path: 'outputs/tests/oversized-layer-20261010.png', fullPage: true });
  const handle = await page.locator('#selection-overlay [data-handle="1,0"]').boundingBox(), uv = await page.locator('#uv-canvas').boundingBox(), a = oversized.angle * Math.PI / 180;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 - .5 * uv.width * Math.cos(a), handle.y + handle.height / 2 - .5 * uv.width * Math.sin(a), { steps: 8 }); await page.mouse.up();
  const resized = await transform(); assert.ok(Math.abs(resized.w - 2) < .01); assert.ok(Math.abs(resized.h - oversized.h) < .01);
  await page.locator('#undo').click(); assert.deepEqual(await transform(), oversized); checks.push('oversized rotated layer: all outside handles visible and independently resizable; zoom changes no pixels');
  await page.locator('#fit-layer').click(); const fitted = await transform();
  assert.equal(fitted.x, .5); assert.equal(fitted.y, .5); assert.equal(fitted.angle, 27); assert.ok(Math.abs(fitted.w / fitted.h - oversized.w / oversized.h) < .01);
  assert.ok(Math.abs(Math.cos(a)) * fitted.w + Math.abs(Math.sin(a)) * fitted.h <= .801);
  await page.locator('#reset-transform').click(); for (let i = 0; i < 16; i++) await page.locator('#zoom-out').click(); assert.equal(await page.locator('#zoom-fit').textContent(), '5%'); await page.locator('#zoom-fit').click(); checks.push('fit actual layer preserves proportions and rotation; viewport zoom reaches 5%');
  box = await page.locator('#uv-canvas').boundingBox(); await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2); assert.ok(await page.locator('#crop-dialog').isVisible());
  await page.locator('#crop-new').click(); const crop = await page.locator('#crop-canvas').boundingBox();
  await page.mouse.move(crop.x + crop.width * .25, crop.y + crop.height * .25); await page.mouse.down(); await page.mouse.move(crop.x + crop.width * .75, crop.y + crop.height * .75, { steps: 8 }); await page.mouse.up(); await page.locator('#crop-apply').click();
  const cropped = await project('cropped-20261010.livery.json'); assert.ok(cropped.layer.crop.w < 1 && cropped.layer.crop.h < 1); await page.locator('#undo').click(); checks.push('double-click selects and crops a picture; crop undo retains original pixels');
  await page.locator('#duplicate-layer').click(); const before = await project('before-cutout-20261010.livery.json'); const beforeTransform = await transform();
  await page.locator('#remove-background').click(); await pickBackground(); await page.screenshot({ path: 'outputs/tests/remove-background-20261010.png' });
  await page.locator('#background-reset').click(); assert.ok(await page.locator('#background-apply').isDisabled()); await pickBackground();
  await page.locator('#background-original').check(); await page.locator('#background-original').uncheck(); await page.locator('#background-apply').click(); await page.locator('#background-dialog').waitFor({ state: 'hidden' });
  const connected = await project('connected-cutout-20261010.livery.json');
  assert.deepEqual(await transform(), beforeTransform); assert.equal(connected.doc.layers.length, 2); assert.notEqual(connected.doc.layers[0].assetId, connected.layer.assetId);
  const connectedImage = connected.data.assets[connected.layer.assetId].image;
  assert.equal((await rgba(connectedImage, .1, .1))[3], 0); assert.deepEqual(await rgba(connectedImage, .36, .35), [220, 20, 40, 255]); assert.deepEqual(await rgba(connectedImage, .5, .5), [255, 255, 255, 255]);
  assert.equal((await rgba(connected.data.assets[connected.doc.layers[0].assetId].image, .1, .1))[3], 255);
  await page.locator('#undo').click(); let undo = await project('undo-cutout-20261010.livery.json'); assert.equal((await rgba(undo.data.assets[undo.layer.assetId].image, .1, .1))[3], 255);
  await page.locator('#redo').click(); checks.push('background cutout preserves placement, duplicate source, logo interior and undo/redo');
  await page.locator('#undo').click(); await page.locator('#remove-background').click(); await pickBackground(); await page.locator('#background-mode').selectOption('all'); await page.waitForFunction(() => !document.querySelector('#background-apply').disabled); await page.locator('#background-apply').click(); await page.locator('#background-dialog').waitFor({ state: 'hidden' });
  const all = await project('all-cutout-20261010.livery.json'); assert.equal((await rgba(all.data.assets[all.layer.assetId].image, .5, .5))[3], 0); checks.push('all-colour removal clears enclosed spaces inside lettering');
  await page.locator('#remove-background').click(); await page.locator('#background-close').click(); assert.deepEqual(await transform(), beforeTransform);
  await page.locator('.layer-row').last().locator('.visibility').click(); await page.locator('.layer-row').first().click(); await page.locator('#transparent-base').check(); await page.locator('#export-size').selectOption('1024');
  const png = await download('export-part', 'cutout-export-20261010.png'); assert.equal((await rgba(`data:image/png;base64,${png.toString('base64')}`, .25, .4))[3], 0);
  await page.locator('#reset-part').click(); await page.locator('#project-input').setInputFiles({ name: 'restore.livery.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(all.data)) }); await page.waitForFunction(() => document.querySelector('#layer-count').textContent === '2');
  const restored = await project('restored-cutout-20261010.livery.json'); assert.equal((await rgba(restored.data.assets[restored.layer.assetId].image, .5, .5))[3], 0); checks.push('transparent PNG export and project reopening retain processed images');
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#help-button').click(); box = await page.locator('#help-dialog').boundingBox(); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
  await page.locator('#help-close').click(); await page.locator('#remove-background').click(); await page.screenshot({ path: 'outputs/tests/mobile-cutout-20261010.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); assert.equal(await page.locator('#background-dialog').evaluate(d => d.scrollWidth > d.clientWidth + 1), false); await page.locator('#background-close').click(); checks.push('instruction and cutout dialogs fit mobile without horizontal overflow');
  assert.deepEqual(errors, []); assert.ok(requests.every(r => r.method === 'GET' && new URL(r.url).origin === new URL(base).origin));
  const result = { passed: true, checkedAt: new Date().toISOString(), base, checks, requests: requests.length, errors }; await writeFile('outputs/tests/editing-tools-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser.close(); }
