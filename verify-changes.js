const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  console.log('\n=== TEST 1: Navigate vod.html → vodDetail.html (with referrer) ===');
  const page1 = await context.newPage();

  // Collect console messages
  const consoleLogs = [];
  page1.on('console', msg => {
    if (msg.type() !== 'log') consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });

  // Navigate to vod.html first
  await page1.goto('http://localhost:5080/vod.html');
  await page1.waitForTimeout(500);

  // Now navigate to vodDetail.html (page1's referrer should be vod.html)
  await page1.goto('http://localhost:5080/vodDetail.html?id=course1', { waitUntil: 'domcontentloaded' });
  await page1.waitForTimeout(1000); // Let CMS sync run

  // Check button text
  const btnText1 = await page1.locator('#pcBackBtn').textContent();
  console.log('Button text:', btnText1);

  // Check button href
  const btnHref1 = await page1.locator('#pcBackBtn').getAttribute('href');
  console.log('Button href:', btnHref1);

  // Check phone/hours
  const phone1 = await page1.locator('.pc-contact .phone').textContent();
  const hours1 = await page1.locator('.pc-contact .hours').textContent();
  console.log('Phone:', phone1);
  console.log('Hours:', hours1);

  // Test back button click (should trigger history.back)
  const navPromise = page1.waitForNavigation({ timeout: 2000 }).catch(() => 'no-nav');
  await page1.locator('#pcBackBtn').click();
  const navResult = await navPromise;

  const finalUrl1 = page1.url();
  console.log('URL after back button click:', finalUrl1);
  console.log('Navigation triggered:', navResult !== 'no-nav' ? 'yes (history.back)' : 'no (JS prevented)');

  if (consoleLogs.length > 0) {
    console.log('Console errors/warnings:');
    consoleLogs.forEach(log => console.log('  ', log));
  } else {
    console.log('Console: no errors/warnings');
  }

  await page1.close();

  console.log('\n=== TEST 2: Direct vodDetail.html navigation (NO referrer) ===');
  const page2 = await context.newPage();

  const consoleLogs2 = [];
  page2.on('console', msg => {
    if (msg.type() !== 'log') consoleLogs2.push(`[${msg.type()}] ${msg.text()}`);
  });

  // Direct navigation with no referrer
  await page2.goto('http://localhost:5080/vodDetail.html?id=course2');
  await page2.waitForTimeout(1000); // Let CMS sync run

  const btnText2 = await page2.locator('#pcBackBtn').textContent();
  console.log('Button text:', btnText2);

  const btnHref2 = await page2.locator('#pcBackBtn').getAttribute('href');
  console.log('Button href:', btnHref2);

  // Check phone/hours
  const phone2 = await page2.locator('.pc-contact .phone').textContent();
  const hours2 = await page2.locator('.pc-contact .hours').textContent();
  console.log('Phone:', phone2);
  console.log('Hours:', hours2);

  if (consoleLogs2.length > 0) {
    console.log('Console errors/warnings:');
    consoleLogs2.forEach(log => console.log('  ', log));
  } else {
    console.log('Console: no errors/warnings');
  }

  await page2.close();

  await context.close();
  await browser.close();

  console.log('\n✓ Tests complete');
})();
