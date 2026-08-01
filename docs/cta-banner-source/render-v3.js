// 하단 CTA 배너 C안 / D안 / E안 렌더러
//   실행: node docs/cta-banner-source/render-v3.js   (프로젝트 루트에서)
const playwright = require('playwright');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = 'file:///' + path.resolve(__dirname, 'cta-banner-v3.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '../cta-banner-out');

const TARGETS = [
  { id: 'c-pc', file: 'ctaC-pc', w: 1080, h: 500 },
  { id: 'c-mo', file: 'ctaC-mobile', w: 720, h: 600 },
  { id: 'd-pc', file: 'ctaD-pc', w: 1080, h: 500 },
  { id: 'd-mo', file: 'ctaD-mobile', w: 720, h: 600 },
  { id: 'e-pc', file: 'ctaE-pc', w: 1080, h: 500 },
  { id: 'e-mo', file: 'ctaE-mobile', w: 720, h: 600 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(SRC, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);

  for (const t of TARGETS) {
    const el = page.locator('#' + t.id);
    const box = await el.boundingBox();
    const png = path.join(OUT, t.file + '.png');
    await el.screenshot({ path: png });
    await sharp(png).webp({ quality: 90 }).toFile(path.join(OUT, t.file + '.webp'));
    const kb = f => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + 'KB';
    const ok = Math.round(box.width) === t.w && Math.round(box.height) === t.h;
    console.log(`${ok ? 'OK ' : 'NG '} ${t.file.padEnd(14)} ${Math.round(box.width)}x${Math.round(box.height)}` +
                `  PNG ${kb(t.file + '.png').padStart(6)}  WebP ${kb(t.file + '.webp').padStart(6)}`);
  }
  await browser.close();
})();
