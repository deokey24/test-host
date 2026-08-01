const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Capture console messages
  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push({
    type: msg.type(),
    text: msg.text()
  }));

  await page.goto('http://localhost:5080/vod.html', { waitUntil: 'networkidle2' });

  // Extract course info from the DOM
  const courses = await page.evaluate(() => {
    const courseEls = document.querySelectorAll('.course-row');
    return Array.from(courseEls).map(el => ({
      title: el.querySelector('.course-row__info h3')?.textContent.trim(),
      meta: el.querySelector('.meta-row')?.textContent.trim()
    }));
  });

  console.log('=== COURSES RENDERED ===');
  courses.forEach((c, i) => {
    console.log(`\n[${i + 1}] ${c.title}`);
    console.log(`    Meta: ${c.meta || '(no badges)'}`);
  });

  if (consoleLogs.length > 0) {
    console.log('\n=== CONSOLE ERRORS/WARNINGS ===');
    consoleLogs.filter(c => c.type === 'error' || c.type === 'warning').forEach(c => {
      console.log(`${c.type.toUpperCase()}: ${c.text}`);
    });
  }

  await browser.close();
})().catch(console.error);
