// 원본 데스크톱 배너에서 모바일 배너 제작에 재사용할 그래픽 요소를 크롭 + 색상 샘플링
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT = path.join(SRC, 'crops');

const CROPS = [
  { file: 'top-1-8월신규반.png', name: 'top1-logo', x: 10, y: 8, w: 180, h: 162 },
  { file: 'top-2-연세대대관.png', name: 'top2-building', x: 0, y: 0, w: 330, h: 180 },
  { file: 'top-2-연세대대관.png', name: 'top2-logo', x: 1050, y: 5, w: 230, h: 165 },
  { file: 'top-3-고려대대관.png', name: 'top3-building', x: 0, y: 0, w: 330, h: 180 },
  { file: 'top-3-고려대대관.png', name: 'top3-logo', x: 1050, y: 5, w: 230, h: 165 },
  { file: 'top-4-dockpass신설.png', name: 'top4-logo', x: 25, y: 10, w: 175, h: 145 },
  { file: 'top-4-dockpass신설.png', name: 'top4-laptop', x: 985, y: 0, w: 295, h: 180 },
  { file: 'mid-1-합격자88명.png', name: 'mid-logo', x: 20, y: 5, w: 150, h: 90 },
  { file: 'mid-1-합격자88명.png', name: 'mid-88', x: 510, y: 0, w: 275, h: 100 },
  { file: 'mid-1-합격자88명.png', name: 'mid-trophy', x: 1135, y: 0, w: 145, h: 100 },
];

const SAMPLES = [
  { file: 'top-1-8월신규반.png', label: 'top1', points: { bg: [700, 165], headlineDark: [300, 45], headlineBlue: [560, 45], infoBoxBg: [500, 140], infoText: [300, 100], buttonBg: [960, 92], badgeBg: [1185, 75] } },
  { file: 'top-2-연세대대관.png', label: 'top2', points: { bg: [700, 165], skyBlue: [500, 100], white: [200, 95], boxBg: [845, 90], boxText: [830, 65] } },
  { file: 'top-3-고려대대관.png', label: 'top3', points: { bg: [700, 165], pink: [500, 100], white: [200, 95], boxBg: [845, 90], boxText: [830, 65] } },
  { file: 'top-4-dockpass신설.png', label: 'top4', points: { bg: [600, 20], blueSub: [300, 30], white: [300, 90], blueAccent: [720, 90], body: [300, 150] } },
  { file: 'mid-1-합격자88명.png', label: 'mid', points: { bg: [450, 15], white: [400, 60], num88: [620, 50], blue222: [990, 65], year: [370, 30] } },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const dataUrls = {};
  for (const f of new Set(CROPS.map(c => c.file))) {
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

  for (const s of SAMPLES) {
    const colors = await page.evaluate(async (dataUrl, points) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const result = {};
      for (const [k, [x, y]] of Object.entries(points)) {
        const d = ctx.getImageData(x, y, 1, 1).data;
        result[k] = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      }
      return result;
    }, dataUrls[s.file], s.points);
    console.log(s.label, JSON.stringify(colors));
  }

  await browser.close();
})();
