const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  try {
    console.log('1. Navigating to http://localhost:3000/vod.html...');
    await page.goto('http://localhost:3000/vod.html', { waitUntil: 'networkidle' });

    // Wait for chips to load
    console.log('2. Waiting for category chips to render...');
    await page.waitForSelector('#categoryChips .chip', { timeout: 5000 });

    // Get all chips
    const chips = await page.locator('#categoryChips .chip').all();
    console.log(`   Found ${chips.length} category chips`);

    const chipLabels = [];
    for (const chip of chips) {
      const text = await chip.textContent();
      const dataFilter = await chip.getAttribute('data-filter');
      chipLabels.push(`"${text.trim()}" (filter="${dataFilter}")`);
    }
    console.log(`   Chips: ${chipLabels.join(', ')}`);

    // Verify expected chips
    const expectedChips = ['전체 강좌', '독해', '프리미엄', '유형별', '연세대', '자료해석'];
    const actualTexts = chipLabels.map(c => c.match(/"([^"]+)"/)[1]);
    const chipsMatch = expectedChips.every(c => actualTexts.includes(c));
    console.log(`   ✓ All expected chips present: ${chipsMatch}`);

    // Get initial course count
    console.log('3. Checking initial course list (전체 강좌)...');
    const initialCards = await page.locator('#courseList .course-row').count();
    console.log(`   Found ${initialCards} courses`);

    // Test: Click "독해" chip
    console.log('4. Clicking "독해" chip...');
    const dokhaehChip = chips.find(async (c) => (await c.textContent()).includes('독해'));
    await chips[1].click(); // "독해" should be second chip
    await page.waitForTimeout(300); // Wait for debounce
    const dokhaeCards = await page.locator('#courseList .course-row').count();
    console.log(`   After filtering by "독해": ${dokhaeCards} courses (expected 2)`);

    // Get the active chip
    const activeChip = await page.locator('#categoryChips .chip.active');
    const activeText = await activeChip.textContent();
    console.log(`   Active chip: "${activeText.trim()}"`);

    // Test: Click "프리미엄" chip (should have 0 courses)
    console.log('5. Clicking "프리미엄" chip (0 courses)...');
    const premiumChip = chips[2]; // "프리미엄"
    await premiumChip.click();
    await page.waitForTimeout(300);
    const premiumCards = await page.locator('#courseList .course-row').count();
    const emptyMsg = await page.locator('#courseList').evaluate(el => {
      const emptyState = el.textContent;
      return emptyState.includes('조건에 맞는 강좌가 없습니다') || emptyState.includes('없습니다');
    });
    console.log(`   After filtering by "프리미엄": ${premiumCards} courses`);
    console.log(`   Empty state message present: ${emptyMsg}`);

    // Test: Click "전체 강좌" to reset
    console.log('6. Clicking "전체 강좌" to reset...');
    const allChip = chips[0];
    await allChip.click();
    await page.waitForTimeout(300);
    const resetCards = await page.locator('#courseList .course-row').count();
    console.log(`   After reset: ${resetCards} courses`);

    // Test: Search for "독해"
    console.log('7. Testing search: typing "독해"...');
    const searchInput = await page.locator('#courseSearchInput');
    await searchInput.fill('독해');
    await page.waitForTimeout(400); // Wait for debounce
    const searchCards = await page.locator('#courseList .course-row').count();
    console.log(`   After search for "독해": ${searchCards} courses`);

    // Clear search
    console.log('8. Clearing search box...');
    await searchInput.fill('');
    await page.waitForTimeout(400);
    const afterClearCards = await page.locator('#courseList .course-row').count();
    console.log(`   After clearing search: ${afterClearCards} courses`);

    // Test: Width comparison
    console.log('9. Measuring width of .filterbar vs .course-row...');
    const widths = await page.evaluate(() => {
      const filterbar = document.querySelector('.filterbar');
      const courseRow = document.querySelector('.course-row');

      if (!filterbar || !courseRow) {
        return { error: 'filterbar or course-row not found' };
      }

      const filterbarWidth = filterbar.offsetWidth;
      const courseRowWidth = courseRow.offsetWidth;
      const difference = Math.abs(filterbarWidth - courseRowWidth);

      return {
        filterbarWidth,
        courseRowWidth,
        difference,
        withinTolerance: difference <= 5
      };
    });

    if (widths.error) {
      console.log(`   ERROR: ${widths.error}`);
    } else {
      console.log(`   .filterbar width: ${widths.filterbarWidth}px`);
      console.log(`   .course-row width: ${widths.courseRowWidth}px`);
      console.log(`   Difference: ${widths.difference}px`);
      console.log(`   ✓ Widths match (within 5px): ${widths.withinTolerance}`);
    }

    // Console errors
    console.log('10. Console errors during test:');
    if (consoleErrors.length === 0) {
      console.log('   ✓ No console errors');
    } else {
      consoleErrors.forEach(e => console.log(`   ERROR: ${e}`));
    }

    console.log('\n=== SUMMARY ===');
    console.log(`Chips loaded: ${chipsMatch ? '✓' : '✗'}`);
    console.log(`Filter by category works: ${dokhaeCards > 0 ? '✓' : '✗'}`);
    console.log(`Empty state on 0 results: ${emptyMsg ? '✓' : '✗'}`);
    console.log(`Reset to all courses works: ${resetCards === initialCards ? '✓' : '✗'}`);
    console.log(`Search filters live: ${searchCards > 0 ? '✓' : '✗'}`);
    console.log(`Width match (filterbar vs course-row): ${widths.withinTolerance ? '✓' : '✗'}`);
    console.log(`Console clean: ${consoleErrors.length === 0 ? '✓' : '✗'}`);

  } catch (error) {
    console.error('Test failed:', error.message);
  } finally {
    await browser.close();
  }
})();
