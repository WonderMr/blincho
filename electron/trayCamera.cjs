// Colors have equal red/blue channels, so the stencil is identical for the
// RGBA and BGRA native bitmaps returned on supported desktop architectures.
const CAMERA = ['........', '.#####..', '.#...#.#', '.#.o.###', '.#...###', '.#####.#', '........', '........'];
function withCameraBadge(bitmap, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || bitmap.length !== width * height * 4) throw new TypeError('Invalid tray bitmap');
  const output = Buffer.from(bitmap);
  const unit = Math.max(1, Math.floor(Math.min(width, height) / 16));
  const left = Math.max(0, width - 8 * unit);
  const centerX = left + 3.5 * unit, centerY = 3.5 * unit;
  for (let y = 0; y < Math.min(8 * unit, height); y++) for (let x = Math.max(0, left - unit); x < width; x++) {
    const offset = (y * width + x) * 4;
    if ((x + 0.5 - centerX) ** 2 + (y + 0.5 - centerY) ** 2 <= (4.5 * unit) ** 2) output.set([32, 47, 32, 255], offset);
    if (x >= left) {
      const glyph = CAMERA[Math.floor(y / unit)]?.[Math.floor((x - left) / unit)];
      if (glyph === '#') output.set([255, 255, 255, 255], offset);
      if (glyph === 'o') output.set([38, 210, 38, 255], offset);
    }
  }
  return output;
}
module.exports = { withCameraBadge };
