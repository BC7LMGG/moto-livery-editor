import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';

const base = process.env.EDITOR_URL || 'http://127.0.0.1:8794/moto-livery-editor/';
const hosted = !new URL(base).hostname.match(/^(localhost|127\.0\.0\.1)$/);
await mkdir('outputs/tests', { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const errors = [], requests = [], checks = [];
page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push({ url: r.url(), method: r.method() }));
page.on('dialog', d => d.accept());
async function loaded() { await page.locator('#model-loader').waitFor({ state: 'hidden', timeout: 60000 }); await page.waitForFunction(() => !document.querySelector('#add-images').disabled); }
async function diagnostics() { return page.evaluate(() => window.liveryDiagnostics()); }
async function download(id, name) { const pending = page.waitForEvent('download'); await page.locator(`#${id}`).click(); const result = await pending; const file = `outputs/tests/${name}`; await result.saveAs(file); return readFile(file); }
async function pixel(bytes, x = .5, y = .5) {
  return page.evaluate(async ({ data, x, y }) => { const bitmap = await createImageBitmap(new Blob([Uint8Array.from(data)], { type: 'image/png' })); const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); const result = { width: bitmap.width, height: bitmap.height, rgba: [...ctx.getImageData(Math.floor(x * bitmap.width), Math.floor(y * bitmap.height), 1, 1).data] }; bitmap.close(); return result; }, { data: [...bytes], x, y });
}
async function fixture(color, width, height) { const data = await page.evaluate(({ color, width, height }) => { const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); return c.toDataURL('image/png').split(',')[1]; }, { color, width, height }); return Buffer.from(data, 'base64'); }
async function number(id, value) { await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab'); }
try {
  await page.goto(base); await loaded();
  assert.equal(await page.locator('#model-select option').count(), 16);
  assert.equal(await page.locator('#part-select option').count(), 5);
  if (!hosted) { const initial = await diagnostics(); assert.equal(initial.meshParts, 4); assert.equal(initial.modelId, 'KWSKX250F'); }
  await page.screenshot({ path: 'outputs/tests/desktop-empty.png', fullPage: true }); checks.push('KX250F: all four meshes, five masks, lazy catalog');
  await page.locator('#export-size').selectOption('1024');
  const guideOn = await download('export-part', 'empty-guide-on.png'); await page.locator('#show-guide').uncheck(); const guideOff = await download('export-part', 'empty-guide-off.png');
  assert.deepEqual(guideOn, guideOff); assert.deepEqual((await pixel(guideOn, .03, .03)).rgba, [184, 237, 66, 255]); checks.push('UV guide excluded from PNG, exact base color');
  await page.locator('#show-guide').check();
  const red = await fixture('#ff0000', 800, 400); const blue = await fixture('#0000ff', 400, 400);
  await page.locator('#image-input').setInputFiles([{ name: 'Red graphic.png', mimeType: 'image/png', buffer: red }, { name: 'Blue graphic.png', mimeType: 'image/png', buffer: blue }]);
  await page.waitForFunction(() => document.querySelector('#layer-count').textContent === '2' && !document.querySelector('#export-part').disabled);
  const topBlue = await download('export-part', 'two-layers-blue-top.png'); assert.deepEqual((await pixel(topBlue)).rgba, [0, 0, 255, 255]);
  await page.locator('#layer-opacity').evaluate(e => { e.value = '50'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  const translucent = (await pixel(await download('export-part', 'opacity-50.png'))).rgba; assert.ok(translucent[0] >= 126 && translucent[0] <= 128 && translucent[2] >= 127 && translucent[2] <= 129);
  await page.locator('#layer-down').click(); assert.deepEqual((await pixel(await download('export-part', 'red-top.png'))).rgba, [255, 0, 0, 255]); checks.push('multiple images, layer order, opacity, compositor');
  await page.locator('.layer-row').first().click();
  await number('layer-angle', 30); await number('layer-width', 55); await page.locator('#flip-x').click();
  if (!hosted) { const changed = (await diagnostics()).layers.at(-1); assert.equal(changed.angle, 30); assert.equal(changed.flipX, true); assert.ok(Math.abs(changed.w - .55) < 1e-6); }
  const bounds = await page.locator('#uv-canvas').boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .56, bounds.y + bounds.height * .54, { steps: 5 }); await page.mouse.up();
  if (!hosted) { const moved = (await diagnostics()).layers.at(-1); assert.ok(Math.abs(moved.x - .56) < .005); assert.ok(Math.abs(moved.y - .54) < .005); }
  await page.locator('#undo').click(); await page.locator('#redo').click(); checks.push('rotation, scale, flip, pointer movement, undo/redo');
  await page.locator('#crop-layer').click(); await page.locator('#crop-new').click(); const cropBox = await page.locator('#crop-canvas').boundingBox();
  // Source picture: 800x400 inside 900x560 canvas, native fit 860x430.
  await page.mouse.move(cropBox.x + cropBox.width * (20 + .25 * 860) / 900, cropBox.y + cropBox.height * (65 + .25 * 430) / 560); await page.mouse.down();
  await page.mouse.move(cropBox.x + cropBox.width * (20 + .75 * 860) / 900, cropBox.y + cropBox.height * (65 + .75 * 430) / 560, { steps: 6 }); await page.mouse.up();
  await page.locator('#crop-apply').click();
  if (!hosted) { const cropped = (await diagnostics()).layers.at(-1); assert.ok(Math.abs(cropped.crop.w - .5) < .01); assert.ok(Math.abs(cropped.crop.h - .5) < .01); assert.ok(Math.abs(cropped.w - .275) < .01); }
  checks.push('source-region crop preserves pixel placement');
  await page.locator('#duplicate-layer').click(); assert.equal(await page.locator('.layer-row').count(), 3); await page.locator('#delete-layer').click(); assert.equal(await page.locator('.layer-row').count(), 2); await page.locator('#undo').click(); assert.equal(await page.locator('.layer-row').count(), 3);
  checks.push('duplicate, delete, restore');
  const beforeCopy = hosted ? null : (await diagnostics()).layers;
  await page.locator('#crop-layer').click(); await page.locator('#crop-copy').click(); assert.equal(await page.locator('.layer-row').count(), 4);
  if (!hosted) {
    const afterCopy = (await diagnostics()).layers;
    assert.deepEqual(afterCopy.slice(0, 3), beforeCopy);
    assert.notEqual(afterCopy.at(-1).id, beforeCopy.at(-1).id);
    assert.equal(afterCopy.at(-1).assetId, beforeCopy.at(-1).assetId);
    assert.deepEqual(afterCopy.at(-1).crop, beforeCopy.at(-1).crop);
  }
  await page.locator('#undo').click(); assert.equal(await page.locator('.layer-row').count(), 3);
  checks.push('cropped region becomes an independent layer, original retained');
  const visibilityRow = page.locator('.layer-row').first(); await visibilityRow.locator('.visibility').click(); assert.ok(await visibilityRow.evaluate(e => e.classList.contains('invisible'))); await page.locator('#undo').click();
  if (!hosted) { const changed = (await diagnostics()).textureVersions.find(p => p.id.includes('_1119_')); assert.ok(changed.versions.every(v => v > 1)); }
  checks.push('layer visibility and live 3D texture updates');
  await page.screenshot({ path: 'outputs/tests/desktop-editor.png', fullPage: true });
  const project = await download('project-save', 'KWSKX250F.livery.json'); const data = JSON.parse(project); assert.equal(data.format, 'livery-studio-project'); assert.equal(Object.keys(data.assets).length, 2);
  await page.locator('#reset-part').click(); assert.equal(await page.locator('.layer-row').count(), 0);
  await page.locator('#project-input').setInputFiles({ name: 'restore.livery.json', mimeType: 'application/json', buffer: project }); await loaded(); await page.waitForFunction(() => document.querySelector('#layer-count').textContent === '3');
  checks.push('local project save/open restores assets and layers');
  const packBytes = await download('export-all', 'KWSKX250F-graphics.zip'); const pack = unzipSync(packBytes); const meta = JSON.parse(new TextDecoder().decode(pack['pack.json']));
  assert.equal(meta.vehicleId, 'KWSKX250F'); assert.equal(meta.textures.length, 5); assert.equal(Object.keys(pack).filter(n => n.endsWith('.png')).length, 5); assert.ok(meta.textures.every(t => t.width === 1024 && t.height === 1024));
  const seat = meta.textures.find(t => t.partId.includes('_1120_')); assert.deepEqual((await pixel(pack[seat.file])).rgba, [48, 52, 59, 255]); checks.push('ZIP: all five parts, clean PNGs, manifest, selected resolution');
  await page.locator('#transparent-base').check(); const transparent = await download('export-part', 'transparent.png'); assert.equal((await pixel(transparent, .01, .01)).rgba[3], 0); checks.push('transparent PNG');
  const bad = { ...data, modelId: 'unknown-model' }; await page.locator('#project-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) }); await page.waitForTimeout(200); assert.equal(await page.locator('#model-select').inputValue(), 'KWSKX250F');
  const modelIds = await page.locator('#model-select option').evaluateAll(options => options.map(o => o.value));
  for (const id of modelIds) { await page.locator('#model-select').selectOption(id); await loaded(); if (!hosted) { const state = await diagnostics(); assert.equal(state.modelId, id); assert.ok(state.meshParts >= 1); } }
  checks.push('all 16 model bundles load and assemble');
  await page.locator('#model-select').selectOption('KWSKX250F'); await loaded(); assert.equal(await page.locator('.layer-row').count(), 3); checks.push('in-session edits retained across models');
  const lightId = await page.locator('#part-select option').evaluateAll(options => options.find(o => o.value.includes('_1110_')).value); await page.locator('#part-select').selectOption(lightId); assert.equal(await page.locator('#part-focus').isDisabled(), true);
  await page.locator('#part-select').selectOption(data.parts ? Object.keys(data.parts).find(k => k.includes('_1119_')) : '');
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300); await page.screenshot({ path: 'outputs/tests/mobile-editor.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); assert.equal(overflow, false); checks.push('mobile layout without horizontal overflow');
  assert.equal(await page.locator('#project-save-mobile').isVisible(), true); const mobileProject = JSON.parse(await download('project-save-mobile', 'mobile.livery.json')); assert.equal(mobileProject.modelId, 'KWSKX250F'); checks.push('mobile project saving');
  assert.deepEqual(errors, []); assert.ok(requests.every(r => r.method === 'GET' && new URL(r.url).origin === new URL(base).origin)); checks.push('no JavaScript errors; images never uploaded; all resources on own origin');
  const result = { passed: true, checkedAt: new Date().toISOString(), base, hosted, checks, requests: requests.length, errors };
  await writeFile('outputs/tests/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser.close(); }
