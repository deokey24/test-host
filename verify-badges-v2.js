const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Capture ALL console messages
  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push({
    type: msg.type(),
    text: msg.text(),
    location: msg.location()
  }));

  await page.goto('http://localhost:5080/vod.html', { waitUntil: 'networkidle2' });

  // Extract course info from the DOM
  const courses = await page.evaluate(() => {
    const courseEls = document.querySelectorAll('.course-row');
    return Array.from(courseEls).map((el, i) => ({
      id: el.dataset.courseId,
      title: el.querySelector('.course-row__info h3')?.textContent.trim(),
      badgeSpans: Array.from(el.querySelectorAll('.meta-row span')).map(s => ({
        icon: s.querySelector('svg') ? 'has-icon' : 'no-icon',
        text: s.textContent.trim()
      }))
    }));
  });

  console.log('=== COURSE BADGE VERIFICATION ===\n');
  courses.forEach((c, i) => {
    console.log(`[${i + 1}] ${c.title}`);
    if (c.badgeSpans.length === 0) {
      console.log('    → No badges (correctly handled)');
    } else {
      c.badgeSpans.forEach(span => {
        console.log(`    → ${span.text}`);
      });
    }
    console.log('');
  });

  const errors = consoleLogs.filter(c => c.type === 'error');
  const warnings = consoleLogs.filter(c => c.type === 'warning');

  console.log(`\n=== CONSOLE ERRORS: ${errors.length} ===`);
  errors.forEach(e => console.log(`  • ${e.text}`));

  console.log(`\n=== CONSOLE WARNINGS: ${warnings.length} ===`);
  warnings.slice(0, 5).forEach(w => console.log(`  • ${w.text}`));

  await browser.close();
})().catch(console.error);
