// 건물 재크롭(원본 헤드라인 글자 제외) + 로고/트로피 크롭의 배경 모서리 색 샘플링
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT = path.join(SRC, 'crops');

const CROPS = [
  { file: 'top-2-연세대대관.png', name: 'top2-building', x: 0, y: 0, w: 142, h: 180 },
  { file: 'top-3-고려대대관.png', name: 'top3-building', x: 0, y: 0, w: 142, h: 180 },
];

// 크롭 PNG 자체의 모서리/배경 색 샘플
const CORNER = [
  { file: 'crops/top2-logo.png', label: 'top2-logo-bg', points: [[6, 6], [6, 158], [224, 6], [115, 4]] },
  { file: 'crops/top3-logo.png', label: 'top3-logo-bg', points: [[6, 6], [6, 158], [224, 6], [115, 4]] },
  { file: 'crops/top4-logo.png', label: 'top4-logo-bg', points: [[6, 6], [6, 138], [168, 6], [88, 4]] },
  { file: 'crops/mid-logo.png', label: 'mid-logo-bg', points: [[5, 5], [5, 84], [144, 5], [75, 4]] },
  { file: 'crops/mid-trophy.png', label: 'mid-trophy-bg', points: [[4, 4], [4, 95], [140, 4], [140, 95]] },
  { file: 'crops/mid-88.png', label: 'mid-88-bg', points: [[4, 4], [4, 95], [270, 4], [270, 95]] },
];

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const load = f => 'data:image/png;base64,' + fs.readFileSync(path.join(SRC, f)).toString('base64');

  for (const c of CROPS) {
    const out = await page.evaluate(async (dataUrl, c) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const cv = document.createElement('canvas');
      cv.width = c.w; cv.height = c.h;
      cv.getContext('2d').drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
      return cv.toDataURL('image/png');
    }, load(c.file), c);
    fs.writeFileSync(path.join(OUT, c.name + '.png'), Buffer.from(out.split(',')[1], 'base64'));
    console.log('crop saved:', c.name);
  }

  for (const s of CORNER) {
    const colors = await page.evaluate(async (dataUrl, points) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return points.map(([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      });
    }, load(s.file), s.points);
    console.log(s.label, colors.join(' '));
  }

  await browser.close();
})();
