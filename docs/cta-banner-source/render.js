// 하단 CTA 배너 이미지 렌더러
//   docs/cta-banner-source/cta-banner.html 의 #pc / #mo 무대를 CSS 픽셀 = 출력 픽셀 1:1로 캡처한다.
//   실행: node docs/cta-banner-source/render.js   (프로젝트 루트에서)
const playwright = require('playwright');
const path = require('path');

const SRC = 'file:///' + path.resolve(__dirname, 'cta-banner.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '../../public-figma/assets/home');

const TARGETS = [
  { id: 'pc', file: 'cta-banner-pc.png', w: 1080, h: 500 },
  { id: 'mo', file: 'cta-banner-mobile.png', w: 720, h: 600 },
];

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(SRC, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready); // Pretendard CDN 로드 대기
  await page.waitForTimeout(600);

  for (const t of TARGETS) {
    const el = page.locator('#' + t.id);
    const box = await el.boundingBox();
    const dest = path.join(OUT, t.file);
    await el.screenshot({ path: dest });
    const ok = Math.round(box.width) === t.w && Math.round(box.height) === t.h;
    console.log(`${ok ? 'OK ' : 'NG '} ${t.file}  ${Math.round(box.width)} x ${Math.round(box.height)}  (목표 ${t.w} x ${t.h})`);
  }

  await browser.close();
})();
