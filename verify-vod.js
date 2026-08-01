const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Navigate to the page
  console.log('Navigating to http://localhost:3000/vod.html...');
  await page.goto('http://localhost:3000/vod.html', { waitUntil: 'networkidle' });

  // Wait for course cards to load (they are fetched via /api/vod-courses)
  console.log('Waiting for course list to load...');
  await page.waitForSelector('#courseList article.course-row', { timeout: 5000 }).catch(() => {
    console.warn('Course cards did not load within timeout');
  });

  // Give a bit more time for rendering
  await page.waitForTimeout(500);

  // Check for roadmap section
  const hasRoadmap = await page.evaluate(() => {
    return document.body.innerText.includes('로드맵');
  });

  // Get course card titles
  const courseTitles = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#courseList .course-row__info h3')).map(el => el.textContent.trim());
  });

  // Check pagination
  const paginationHtml = await page.evaluate(() => {
    return document.getElementById('coursePagination').innerHTML;
  });

  // Check for loading placeholder
  const hasLoadingPlaceholder = await page.evaluate(() => {
    const el = document.getElementById('courseList');
    return el ? el.innerText.includes('불러오는 중') : false;
  });

  // Check for empty state
  const hasEmptyState = await page.evaluate(() => {
    const el = document.getElementById('courseList');
    return el ? el.innerText.includes('등록된 강좌가 없습니다') : false;
  });

  // Get console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Check network errors
  const networkErrors = [];
  page.on('response', response => {
    if (!response.ok() && response.url().includes('/api/')) {
      networkErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  // Take a screenshot
  const screenshotPath = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--workspace-dock\\28a9d562-f3bc-4406-92be-2a25a9f18635\\scratchpad\\vod-page-screenshot.png';
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot saved to ${screenshotPath}`);

  // Output results
  console.log('\n=== VERIFICATION RESULTS ===\n');
  console.log(`Roadmap section removed: ${!hasRoadmap}`);
  console.log(`Has loading placeholder: ${hasLoadingPlaceholder}`);
  console.log(`Has empty state: ${hasEmptyState}`);
  console.log(`Course cards rendered: ${courseTitles.length} courses found`);
  console.log(`Course titles: ${JSON.stringify(courseTitles, null, 2)}`);
  console.log(`\nPagination HTML length: ${paginationHtml.length} chars`);
  console.log(`Pagination buttons: ${(paginationHtml.match(/<button/g) || []).length}`);

  if (consoleErrors.length > 0) {
    console.log(`\nConsole errors detected:`);
    consoleErrors.forEach(err => console.log(`  - ${err}`));
  } else {
    console.log(`\nNo console errors detected`);
  }

  if (networkErrors.length > 0) {
    console.log(`\nNetwork errors detected:`);
    networkErrors.forEach(err => console.log(`  - ${err}`));
  } else {
    console.log(`No API errors detected`);
  }

  await browser.close();
})();
