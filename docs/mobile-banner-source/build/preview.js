// 390px 폭 실축 미리보기 시트 — 검수용 (상단 260px / 중간 144px 높이)
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'mobile-banner-out');
const FILES = [
  'top-1-8월신규반-mobile.png', 'top-2-연세대대관-mobile.png', 'top-3-고려대대관-mobile.png',
  'top-4-dockpass신설-mobile.png', 'mid-1-합격자88명-mobile.png',
];

(async () => {
  const imgs = FILES.map(f =>
    `<img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, f)).toString('base64')}" style="width:390px;display:block">`
  ).join('<div style="height:12px"></div>');
  const html = `<!doctype html><body style="margin:0;background:#888;padding:10px;width:410px">${imgs}</body>`;

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 1500, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(OUT, '_preview-390px.png'), fullPage: true });
  console.log('preview saved');
  await browser.close();
})();
