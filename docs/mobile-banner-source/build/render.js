// build/*.html → 1080×720(상단)/1080×400(중간) PNG 렌더
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BUILD = __dirname;
const OUT = path.resolve(BUILD, '..', '..', 'mobile-banner-out');

const PAGES = [
  { html: 'top-1.html', out: 'top-1-8월신규반-mobile.png', w: 1080, h: 720 },
  { html: 'top-2.html', out: 'top-2-연세대대관-mobile.png', w: 1080, h: 720 },
  { html: 'top-3.html', out: 'top-3-고려대대관-mobile.png', w: 1080, h: 720 },
  { html: 'top-4.html', out: 'top-4-dockpass신설-mobile.png', w: 1080, h: 720 },
  { html: 'mid-1.html', out: 'mid-1-합격자88명-mobile.png', w: 1080, h: 400 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  for (const p of PAGES) {
    await page.setViewport({ width: p.w, height: p.h, deviceScaleFactor: 1 });
    await page.goto('file://' + path.join(BUILD, p.html), { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
      bw: document.body.scrollWidth, bh: document.body.scrollHeight,
    }));
    const outPath = path.join(OUT, p.out);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: p.w, height: p.h } });
    const kb = Math.round(fs.statSync(outPath).size / 1024);
    console.log(`${p.out}  ${p.w}x${p.h}  ${kb}KB  content:${overflow.bw}x${overflow.bh}${overflow.bh > p.h || overflow.bw > p.w ? '  ⚠ OVERFLOW' : ''}`);
  }
  await browser.close();
})();
