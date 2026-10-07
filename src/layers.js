export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const radians = degrees => degrees * Math.PI / 180;
export function rotate(x, y, degrees) { const a = radians(degrees); return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }; }
export function worldToLocal(layer, point) { return rotate(point.x - layer.x, point.y - layer.y, -layer.angle); }
export function localToWorld(layer, x, y) { const p = rotate(x, y, layer.angle); return { x: p.x + layer.x, y: p.y + layer.y }; }
export function hitLayer(layer, point) { const p = worldToLocal(layer, point); return Math.abs(p.x) <= layer.w / 2 && Math.abs(p.y) <= layer.h / 2; }
// Keep the opposite edge/corner fixed, including when the layer is rotated.
// A zero handle axis denotes an edge midpoint: stretch only the other axis.
export function resizeLayer(layer, original, handle, point, keepAspect = false) {
  const { sx, sy } = handle;
  const anchor = localToWorld(original, -sx * original.w / 2, -sy * original.h / 2);
  const local = rotate(point.x - anchor.x, point.y - anchor.y, -original.angle);
  let w = sx ? clamp(sx * local.x, .005, 10) : original.w;
  let h = sy ? clamp(sy * local.y, .005, 10) : original.h;
  if (keepAspect) {
    const requested = sx && sy ? Math.max(w / original.w, h / original.h) : sx ? w / original.w : h / original.h;
    const scale = clamp(requested, Math.max(.005 / original.w, .005 / original.h), Math.min(10 / original.w, 10 / original.h));
    w = original.w * scale; h = original.h * scale;
  }
  const center = rotate(sx * w / 2, sy * h / 2, original.angle);
  Object.assign(layer, { x: anchor.x + center.x, y: anchor.y + center.y, w, h });
}
export function drawLayer(ctx, layer, image, width, height) {
  if (!layer.visible || layer.opacity <= 0) return;
  const c = layer.crop;
  ctx.save(); ctx.translate(layer.x * width, layer.y * height); ctx.rotate(radians(layer.angle)); ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1); ctx.globalAlpha = layer.opacity;
  ctx.drawImage(image, c.x * image.width, c.y * image.height, c.w * image.width, c.h * image.height, -layer.w * width / 2, -layer.h * height / 2, layer.w * width, layer.h * height);
  ctx.restore();
}
// The preview and export share this compositor. Guides and selection frames are
// painted only on the editor canvas after composition, never on texture canvases.
export function compose(canvas, document, assets, { transparent = document.transparent } = {}) {
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!transparent) { ctx.fillStyle = document.color; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  for (const layer of document.layers) {
    const asset = assets.get(layer.assetId); if (asset) drawLayer(ctx, layer, asset.bitmap, canvas.width, canvas.height);
  }
  return canvas;
}
export function applyCrop(layer, crop) {
  const old = layer.crop;
  const dx = ((crop.x + crop.w / 2) - (old.x + old.w / 2)) / old.w * layer.w * (layer.flipX ? -1 : 1);
  const dy = ((crop.y + crop.h / 2) - (old.y + old.h / 2)) / old.h * layer.h * (layer.flipY ? -1 : 1);
  const shift = rotate(dx, dy, layer.angle);
  layer.x += shift.x; layer.y += shift.y; layer.w *= crop.w / old.w; layer.h *= crop.h / old.h; layer.crop = { ...crop };
}
export class History {
  constructor() { this.entries = []; this.index = -1; }
  push(value) {
    const serialized = JSON.stringify(value);
    if (serialized === this.entries[this.index]) return;
    this.entries.splice(this.index + 1); this.entries.push(serialized);
    if (this.entries.length > 60) this.entries.shift();
    this.index = this.entries.length - 1;
  }
  undo() { return this.index > 0 ? JSON.parse(this.entries[--this.index]) : null; }
  redo() { return this.index < this.entries.length - 1 ? JSON.parse(this.entries[++this.index]) : null; }
  get canUndo() { return this.index > 0; } get canRedo() { return this.index < this.entries.length - 1; }
}
