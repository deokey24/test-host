// 건물 크롭 재작업(글자 제외) + 박스 단위 색상 정밀 샘플링
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT = path.join(SRC, 'crops');

const CROPS = [
  { file: 'top-2-연세대대관.png', name: 'top2-building', x: 0, y: 0, w: 200, h: 180 },
  { file: 'top-3-고려대대관.png', name: 'top3-building', x: 0, y: 0, w: 200, h: 180 },
];

// box: [x1,y1,x2,y2] — maxChroma: 글자색 추출용, median: 배경색 추출용
const BOXES = [
  { file: 'top-1-8월신규반.png', label: 'top1-blueHead', box: [500, 30, 700, 60], mode: 'maxChroma' },
  { file: 'top-1-8월신규반.png', label: 'top1-darkHead', box: [240, 30, 460, 60], mode: 'darkest' },
  { file: 'top-1-8월신규반.png', label: 'top1-infoText', box: [240, 95, 400, 125], mode: 'darkest' },
  { file: 'top-1-8월신규반.png', label: 'top1-infoBoxBg', box: [600, 125, 650, 138], mode: 'median' },
  { file: 'top-1-8월신규반.png', label: 'top1-pageBg', box: [640, 160, 700, 175], mode: 'median' },
  { file: 'top-2-연세대대관.png', label: 'top2-sky', box: [330, 80, 500, 130], mode: 'maxChroma' },
  { file: 'top-2-연세대대관.png', label: 'top2-bgTop', box: [640, 5, 700, 15], mode: 'median' },
  { file: 'top-2-연세대대관.png', label: 'top2-bgBot', box: [640, 165, 700, 175], mode: 'median' },
  { file: 'top-2-연세대대관.png', label: 'top2-boxText', box: [800, 55, 930, 125], mode: 'maxChroma' },
  { file: 'top-3-고려대대관.png', label: 'top3-pink', box: [330, 80, 500, 130], mode: 'maxChroma' },
  { file: 'top-3-고려대대관.png', label: 'top3-bgTop', box: [640, 5, 700, 15], mode: 'median' },
  { file: 'top-3-고려대대관.png', label: 'top3-bgBot', box: [640, 165, 700, 175], mode: 'median' },
  { file: 'top-3-고려대대관.png', label: 'top3-boxText', box: [800, 55, 930, 125], mode: 'maxChroma' },
  { file: 'top-4-dockpass신설.png', label: 'top4-subBlue', box: [230, 20, 550, 45], mode: 'maxChroma' },
  { file: 'top-4-dockpass신설.png', label: 'top4-accent', box: [680, 65, 800, 120], mode: 'maxChroma' },
  { file: 'top-4-dockpass신설.png', label: 'top4-bg', box: [550, 100, 620, 140], mode: 'median' },
  { file: 'mid-1-합격자88명.png', label: 'mid-222', box: [950, 45, 1010, 80], mode: 'maxChroma' },
  { file: 'mid-1-합격자88명.png', label: 'mid-year', box: [330, 15, 430, 40], mode: 'maxChroma' },
  { file: 'mid-1-합격자88명.png', label: 'mid-bg', box: [450, 8, 500, 20], mode: 'median' },
];

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const dataUrls = {};
  for (const f of new Set([...CROPS.map(c => c.file), ...BOXES.map(b => b.file)])) {
    dataUrls[f] = 'data:image/png;base64,' + fs.readFileSync(path.join(SRC, f)).toString('base64');
  }

  for (const c of CROPS) {
    const out = await page.evaluate(async (dataUrl, c) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const cv = document.createElement('canvas');
      cv.width = c.w; cv.height = c.h;
      cv.getContext('2d').drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
      return cv.toDataURL('image/png');
    }, dataUrls[c.file], c);
    fs.writeFileSync(path.join(OUT, c.name + '.png'), Buffer.from(out.split(',')[1], 'base64'));
    console.log('crop saved:', c.name);
  }

  for (const b of BOXES) {
    const color = await page.evaluate(async (dataUrl, box, mode) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const [x1, y1, x2, y2] = box;
      const d = ctx.getImageData(x1, y1, x2 - x1, y2 - y1).data;
      const px = [];
      for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
      const hex = p => '#' + p.map(v => v.toString(16).padStart(2, '0')).join('');
      if (mode === 'maxChroma') {
        let best = px[0], bc = -1;
        for (const p of px) {
          const c = Math.max(...p) - Math.min(...p);
          if (c > bc) { bc = c; best = p; }
        }
        return hex(best);
      }
      if (mode === 'darkest') {
        let best = px[0], bl = 1e9;
        for (const p of px) {
          const l = p[0] + p[1] + p[2];
          if (l < bl) { bl = l; best = p; }
        }
        return hex(best);
      }
      px.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
      return hex(px[Math.floor(px.length / 2)]);
    }, dataUrls[b.file], b.box, b.mode);
    console.log(b.label, color);
  }

  await browser.close();
})();
