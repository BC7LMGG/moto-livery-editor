// Colour-based cutout. Pixels stay in the browser; the source is never mutated.
// A span flood fill bounds memory to one visited byte per pixel instead of a
// second full-size pixel queue. Transparent pixels connect background regions.
export async function removeBackground(source, { x, y, tolerance = 12, softness = 4, all = false }, { cancelled = () => false, progress = () => {} } = {}) {
  const { width, height } = source;
  const data = new Uint8ClampedArray(source.data);
  const seedX = Math.max(0, Math.min(width - 1, Math.floor(x * width)));
  const seedY = Math.max(0, Math.min(height - 1, Math.floor(y * height)));
  const seed = (seedY * width + seedX) * 4;
  const colour = [...source.data.slice(seed, seed + 3)];
  if (!source.data[seed + 3]) throw new Error('Нажмите на видимый цвет фона, а не на прозрачную область.');
  const threshold = Math.max(0, Math.min(100, tolerance)) * 4.4167295593;
  const feather = Math.max(0, Math.min(30, softness)) * 4.4167295593;
  const limit = (threshold + feather) ** 2;
  const distance = i => (data[i] - colour[0]) ** 2 + (data[i + 1] - colour[1]) ** 2 + (data[i + 2] - colour[2]) ** 2;
  const matches = p => !data[p * 4 + 3] || distance(p * 4) <= limit;
  let removed = 0, processed = 0, ticks = 0;
  const erase = p => {
    const i = p * 4; if (!data[i + 3]) return;
    const alpha = feather ? Math.max(0, Math.min(1, (Math.sqrt(distance(i)) - threshold) / feather)) : 0;
    const next = Math.round(data[i + 3] * alpha);
    if (next < data[i + 3]) removed++;
    data[i + 3] = next;
  };
  const breathe = async () => {
    if (cancelled()) throw new DOMException('Cancelled', 'AbortError');
    progress(Math.min(99, Math.round(processed / (width * height) * 100)));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  if (all) {
    for (let p = 0; p < width * height; p++) {
      if (matches(p)) erase(p);
      if (++processed % 65536 === 0) await breathe();
    }
  } else {
    const visited = new Uint8Array(width * height), stack = [seedY * width + seedX];
    while (stack.length) {
      const p = stack.pop(); if (visited[p] || !matches(p)) continue;
      const row = Math.floor(p / width), rowStart = row * width, rowEnd = rowStart + width;
      let left = p, right = p;
      while (left > rowStart && !visited[left - 1] && matches(left - 1)) left--;
      while (right + 1 < rowEnd && !visited[right + 1] && matches(right + 1)) right++;
      let above = false, below = false;
      for (let q = left; q <= right; q++) {
        visited[q] = 1; erase(q); processed++;
        const top = row > 0 && !visited[q - width] && matches(q - width);
        const bottom = row + 1 < height && !visited[q + width] && matches(q + width);
        if (top && !above) stack.push(q - width); if (bottom && !below) stack.push(q + width);
        above = top; below = bottom;
      }
      if ((ticks += right - left + 1) >= 65536) { ticks = 0; await breathe(); }
    }
  }
  if (cancelled()) throw new DOMException('Cancelled', 'AbortError');
  progress(100);
  return { data, width, height, removed, colour };
}
