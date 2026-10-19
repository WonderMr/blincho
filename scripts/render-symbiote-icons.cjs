// Rebuild the checked-in runtime assets after changing the approved source art.
// Requires Sharp as a development tool, or BLINCHO_SHARP_MODULE pointing to it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require(process.env.BLINCHO_SHARP_MODULE || 'sharp');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'design/symbiote');
const output = path.join(root, 'public/symbiote');
const layers = JSON.parse(fs.readFileSync(path.join(source, 'layers.json')));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  const base = fs.readFileSync(path.join(source, layers.base));
  const master = fs.readFileSync(path.join(source, layers.master));
  const uri = bytes => 'data:image/png;base64,' + bytes.toString('base64');
  fs.mkdirSync(output, { recursive: true });
  await sharp(base).resize(512, 512).png({ compressionLevel: 9 }).toFile(path.join(output, 'install.png'));
  const variants = [];
  for (let mask = 0; mask < 64; mask++) {
    const selected = layers.modules.filter(module => mask & module.bit);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layers.size}" height="${layers.size}" viewBox="0 0 ${layers.canvas} ${layers.canvas}"><defs><filter id="edge" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.3"/></filter><mask id="modules"><g fill="white" filter="url(#edge)">${selected.map(module => `<path d="${module.path}"/>`).join('')}</g></mask></defs><image href="${uri(base)}" width="${layers.canvas}" height="${layers.canvas}"/><image href="${uri(master)}" width="${layers.canvas}" height="${layers.canvas}" mask="url(#modules)"/></svg>`;
    const buffer = await sharp(mask === 0 ? base : mask === 63 ? master : Buffer.from(svg))
      .resize(layers.size, layers.size).png({ compressionLevel: 9 }).toBuffer();
    const file = mask.toString(16).padStart(2, '0') + '.png';
    fs.writeFileSync(path.join(output, file), buffer);
    variants.push({ mask, file, perks: selected.map(module => module.id), sha256: digest(buffer) });
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
    width: layers.size, height: layers.size,
    sources: { base: digest(base), master: digest(master) }, variants,
  }, null, 2) + '\n');
  console.log(`Rendered ${variants.length} Symbiote icons at ${layers.size}px.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
