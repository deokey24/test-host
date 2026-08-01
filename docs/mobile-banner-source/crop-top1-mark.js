// top-1 로고(다이아몬드+DOCK PASS)만 재크롭 — 독편사 텍스트 줄(y136~) 제외
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.goto('about:blank');
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'top-1-8월신규반.png')).toString('base64');
  const out = await page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const cv = document.createElement('canvas');
    cv.width = 180; cv.height = 112;
    cv.getContext('2d').drawImage(img, 10, 20, 180, 112, 0, 0, 180, 112);
    return cv.toDataURL('image/png');
  }, dataUrl);
  fs.writeFileSync(path.join(__dirname, 'crops', 'top1-mark.png'), Buffer.from(out.split(',')[1], 'base64'));
  console.log('saved top1-mark.png');
  await browser.close();
})();
