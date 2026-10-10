import assert from 'node:assert/strict';
import { removeBackground } from '../src/background.js';

const width = 64, height = 64, data = new Uint8ClampedArray(width * height * 4).fill(255);
function colour(x, y, rgba) { data.set(rgba, (y * width + x) * 4); }
for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) if (x < 24 || x >= 40 || y < 24 || y >= 40) colour(x, y, [210, 20, 30, 255]);
colour(32, 20, [210, 20, 30, 64]); colour(1, 1, [245, 245, 245, 255]); colour(2, 2, [255, 255, 255, 0]);
const source = { data, width, height }, before = data.slice();
const options = { x: .05, y: .05, tolerance: 5, softness: 0 };
const connected = await removeBackground(source, options);
const alpha = (result, x, y) => result.data[(y * width + x) * 4 + 3];
assert.equal(alpha(connected, 5, 5), 0); assert.equal(alpha(connected, 32, 32), 255);
assert.equal(alpha(connected, 32, 20), 64); assert.equal(alpha(connected, 2, 2), 0);
assert.deepEqual(data, before);
const all = await removeBackground(source, { ...options, all: true });
assert.equal(alpha(all, 32, 32), 0); assert.equal(alpha(all, 32, 16), 255);
const interior = await removeBackground(source, { ...options, x: .5, y: .5 });
assert.equal(alpha(interior, 32, 32), 0); assert.equal(alpha(interior, 5, 5), 255);
const soft = await removeBackground(source, { ...options, tolerance: 0, softness: 10, all: true });
assert.ok(alpha(soft, 1, 1) > 0 && alpha(soft, 1, 1) < 255);
await assert.rejects(removeBackground(source, { ...options, x: 2 / width, y: 2 / height }), /видимый цвет/);
await assert.rejects(removeBackground(source, options, { cancelled: () => true }), { name: 'AbortError' });
// Maximum supported input: check a complete connected fill and cooperative
// yielding, rather than extrapolating from a tiny logo.
const big = { width: 4096, height: 4096, data: new Uint8ClampedArray(4096 * 4096 * 4).fill(255) };
const started = performance.now(); let yields = 0;
const result = await removeBackground(big, options, { progress: () => yields++ });
assert.equal(result.removed, 4096 * 4096); assert.ok(yields > 1); assert.equal(big.data[3], 255);
console.log(JSON.stringify({ passed: true, checks: ['connected background, enclosed foreground holes', 'all-colour and interior-only removal', 'soft edges and existing alpha', 'immutable source and cancellation', '4096px complete fill with UI yielding'], maxImageMs: Math.round(performance.now() - started) }));
