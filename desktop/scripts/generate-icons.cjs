const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const assets = path.resolve(__dirname, '..', 'assets');
const svg = path.join(assets, 'icon.svg');
const png = path.join(assets, 'icon.png');
const ico = path.join(assets, 'icon.ico');

(async () => {
  const pngBuffer = await sharp(svg).resize(256, 256).png().toBuffer();
  fs.writeFileSync(png, pngBuffer);
  fs.writeFileSync(ico, await pngToIco(pngBuffer));
  console.log(`Generated ${png} and ${ico}`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
