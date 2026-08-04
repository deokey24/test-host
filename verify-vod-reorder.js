// 관리자 "VOD 강좌 목록" 드래그 순서 변경 검증 (관리자 화면 → DB → 실제 VOD 페이지까지 한 번에).
// 마지막 행을 맨 위로 끌어올린 뒤 vod.html 카드 순서가 따라 바뀌는지 확인하고, 원래 순서로 되돌려 놓는다.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const PASSWORD = (fs.readFileSync('.env', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1].trim();

const adminRows = (page) => page.$$eval('#vodList tr', rows =>
  rows.map(r => `${r.cells[0].innerText.trim().replace(/\s+/g, ' ')} ${r.cells[1].innerText.trim()} (id=${r.dataset.id})`));
const siteCards = (page) => page.$$eval('#courseList .course-row__info h3', els =>
  els.map((el, i) => `${i + 1}. ${el.textContent.trim()}`));

const show = (label, rows) => { console.log(`\n[${label}]`); rows.forEach(r => console.log('  ' + r)); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

  // ── 관리자 화면 열기 ──
  const admin = await ctx.newPage();
  await admin.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await admin.fill('input[type="password"]', PASSWORD);
  await admin.click('button[type="submit"]');
  await admin.waitForSelector('.side-link[data-target="vodSection"]', { timeout: 10000 });
  await admin.click('.side-link[data-target="vodSection"]');   // 섹션이 숨겨져 있어 먼저 열어야 한다
  await admin.waitForSelector('#vodList tr', { timeout: 10000 });

  const adminBefore = await adminRows(admin);
  const originalIds = await admin.$$eval('#vodList tr', rows => rows.map(r => r.dataset.id));
  show('관리자 화면 - 변경 전', adminBefore);
  await admin.locator('#vodList').screenshot({ path: 'reorder-admin-before.png' });

  // ── 실제 VOD 페이지(로그인 불필요) 순서 확인 ──
  const site = await ctx.newPage();
  await site.goto(`${BASE}/vod.html`, { waitUntil: 'networkidle' });
  await site.waitForSelector('#courseList .course-row', { timeout: 10000 });
  const siteBefore = await siteCards(site);
  show('VOD 페이지 - 변경 전', siteBefore);
  await site.locator('#courseList').screenshot({ path: 'reorder-site-before.png' });

  // ── 맨 아래 행 핸들을 맨 위로 드래그 ──
  const rowCount = originalIds.length;
  const handle = await admin.$(`#vodList tr:nth-child(${rowCount}) .drag-handle`);
  const firstRow = await admin.$('#vodList tr:nth-child(1)');
  const h = await handle.boundingBox();
  const r1 = await firstRow.boundingBox();
  const targetY = r1.y + r1.height / 2 - 4;   // 1행 중앙보다 위 → 1행 앞으로 삽입돼야 한다
  await admin.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await admin.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await admin.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + ((targetY - (h.y + h.height / 2)) * i) / 8);
    await admin.waitForTimeout(30);
  }
  await admin.mouse.up();

  await admin.waitForFunction(
    () => document.getElementById('vodListStatus').textContent.trim() !== '', null, { timeout: 10000 });
  console.log(`\n[저장 상태] "${(await admin.textContent('#vodListStatus')).trim()}" ` +
    `(class=${await admin.getAttribute('#vodListStatus', 'class')})`);

  const adminAfter = await adminRows(admin);
  show('관리자 화면 - 드래그 후', adminAfter);
  await admin.locator('#vodList').screenshot({ path: 'reorder-admin-after.png' });

  // ── 실제 VOD 페이지에 반영됐는지 새로고침해서 확인 ──
  await site.reload({ waitUntil: 'networkidle' });
  await site.waitForSelector('#courseList .course-row', { timeout: 10000 });
  const siteAfter = await siteCards(site);
  show('VOD 페이지 - 드래그 후(새로고침)', siteAfter);
  await site.locator('#courseList').screenshot({ path: 'reorder-site-after.png' });

  // ── 원래 순서로 복구 ──
  const restoreStatus = await admin.evaluate((ids) =>
    fetch('/admin/api/vod-courses/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
    }).then(r => r.status), originalIds);
  await site.reload({ waitUntil: 'networkidle' });
  await site.waitForSelector('#courseList .course-row', { timeout: 10000 });
  const siteRestored = await siteCards(site);
  show(`복구(HTTP ${restoreStatus}) 후 VOD 페이지`, siteRestored);

  console.log('\n=== 판정 ===');
  console.log('관리자 화면 순서 변경됨 :', JSON.stringify(adminBefore) !== JSON.stringify(adminAfter));
  console.log('VOD 페이지에 반영됨    :', JSON.stringify(siteBefore) !== JSON.stringify(siteAfter));
  console.log('맨 아래 강좌가 1번으로 :', siteAfter[0].includes(siteBefore[siteBefore.length - 1].replace(/^\d+\.\s*/, '')));
  console.log('원래 순서로 복구됨     :', JSON.stringify(siteRestored) === JSON.stringify(siteBefore));

  await browser.close();
})();
