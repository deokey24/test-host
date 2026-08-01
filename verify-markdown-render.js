const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Capture network errors and console messages
  const resourceErrors = [];
  const consoleErrors = [];

  page.on('requestfailed', req => {
    resourceErrors.push({ url: req.url(), failure: req.failure()?.errorText });
  });

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto('http://localhost:5080/vodDetail.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Get intro section HTML
  const introHtml = await page.locator('#intro').innerHTML();

  // Check for key sections as H2 headings
  const hasHeading1 = /<h2[^>]*>학습 관리 방식<\/h2>/.test(introHtml);
  const hasHeading2 = /<h2[^>]*>첨삭 프로세스<\/h2>/.test(introHtml);

  // Check for list items under sections
  const bulletCount = (introHtml.match(/<li>/g) || []).length;

  // Check for earlier content
  const hasOldContent = introHtml.includes('차원') && introHtml.includes('이런 분들께 추천해요');

  console.log('=== MARKDOWN RENDERING VERIFICATION ===');
  console.log('✓ 학습 관리 방식 (H2 heading):', hasHeading1);
  console.log('✓ 첨삭 프로세스 (H2 heading):', hasHeading2);
  console.log('✓ List items found:', bulletCount);
  console.log('✓ Earlier content intact:', hasOldContent);
  console.log('');
  console.log('Browser Console Errors:', consoleErrors.length === 0 ? 'None' : consoleErrors.length);
  if (consoleErrors.length > 0) {
    consoleErrors.forEach(e => console.log('  - ' + e));
  }
  console.log('');
  console.log('Network 404s:', resourceErrors.length === 0 ? 'None (expected)' : resourceErrors.length);

  await browser.close();
})();
