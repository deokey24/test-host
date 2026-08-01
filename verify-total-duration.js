const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();

  // Collect console messages and network errors
  const consoleLogs = [];
  const networkErrors = [];

  page.on('console', (msg) => {
    consoleLogs.push({ type: msg.type(), text: msg.text(), args: msg.args().length });
  });

  page.on('pageerror', (error) => {
    consoleLogs.push({ type: 'error', text: error.toString() });
  });

  page.on('response', (response) => {
    if (!response.ok() && response.request().resourceType() === 'xhr') {
      networkErrors.push({
        url: response.url(),
        status: response.status(),
        statusText: response.statusText()
      });
    }
  });

  try {
    console.log('1. Navigating to admin login page...');
    await page.goto('http://localhost:5080/admin', { waitUntil: 'networkidle' });

    // Check if we're on login page and log in
    const loginPasswordInput = await page.$('input[name="password"]');
    if (loginPasswordInput) {
      console.log('2. Logging in with password...');
      await page.fill('input[name="password"]', '4072');
      await page.click('button[type="submit"]');
      try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 });
      } catch (e) {
        console.log('   Navigation timeout, continuing anyway...');
      }
      await page.waitForTimeout(1000);
    } else {
      console.log('2. Already logged in, proceeding...');
    }

    console.log('3. Waiting for admin page to fully load...');
    try {
      await page.waitForSelector('button[data-target="vodSection"]', { timeout: 10000 });
    } catch (e) {
      console.log('   Selector not found, checking page content...');
      const content = await page.content();
      if (content.includes('vodSection')) {
        console.log('   vodSection found in HTML, waiting a bit more...');
        await page.waitForTimeout(2000);
      }
    }

    console.log('4. Clicking VOD 강좌 section...');
    const vodBtn = await page.$('button[data-target="vodSection"]');
    if (vodBtn) {
      await vodBtn.click();
      await page.waitForTimeout(2000);
    } else {
      console.log('   ERROR: Could not find vodSection button');
      const buttons = await page.$$eval('button[data-target]', els => els.map(e => e.getAttribute('data-target')));
      console.log('   Available buttons:', buttons);
    }

    // Debug: Check what's loaded on the page
    const sections = await page.$$eval('.admin-section.active', els => els.map(e => e.id));
    console.log('   Active sections:', sections);
    const pageTitle = await page.$eval('#sectionTitle', el => el.textContent);
    console.log('   Page title:', pageTitle);

    console.log('5. Finding course id 11 edit button...');
    // Wait for courses to load and find the one with id 11
    try {
      await page.waitForSelector('button[data-edit-vod]', { timeout: 5000 });
    } catch (e) {
      console.log('   Waiting for course buttons timed out, checking table...');
    }

    // Check what's in the table
    const tableRows = await page.$$eval('#vodList tr', els => {
      return els.map(e => ({
        html: e.innerHTML.substring(0, 300)
      }));
    });
    console.log(`   Table has ${tableRows.length} rows`);
    if (tableRows.length > 0) {
      console.log(`   First row sample: ${tableRows[0].html}`);
    }

    // Click edit button for course 11
    const editButton = await page.$('button[data-edit-vod="11"]');
    if (!editButton) {
      console.log('ERROR: Could not find edit button for course 11');
      const availableButtons = await page.$$eval('button[data-edit-vod]', els => els.map(e => e.getAttribute('data-edit-vod')));
      console.log('Available course edit buttons:', availableButtons);
    } else {
      await editButton.click();
      await page.waitForTimeout(2000);

      console.log('6. Edit form opened. Checking title tab (총 학습시간)...');
      const totalDurationInput = await page.$('#vfTotalDurationText');
      if (totalDurationInput) {
        const value = await totalDurationInput.inputValue();
        console.log(`   TITLE TAB - Total duration value: "${value}"`);
        if (value && value.trim() !== '') {
          console.log('   ✓ SUCCESS: 총 학습시간 shows computed value');
        } else {
          console.log('   ✗ FAIL: 총 학습시간 is empty');
        }
      } else {
        console.log('   ✗ ERROR: Could not find #vfTotalDurationText input');
      }

      console.log('\n7. Clicking curriculum tab...');
      const curriculumTab = await page.$('button[data-vod-tab="curriculum"]');
      if (curriculumTab) {
        await curriculumTab.click();
        await page.waitForTimeout(500);

        console.log('8. Checking for lecture duration displays...');
        try {
          const durationTexts = await page.$$eval('[class*="duration"], .lecture-duration', els => {
            return els.map(e => ({
              text: e.textContent?.trim(),
              class: e.className
            }));
          });

          if (durationTexts.length > 0) {
            console.log('   Found duration text elements:');
            durationTexts.slice(0, 5).forEach((d, i) => {
              console.log(`   [${i}] "${d.text}" (class: ${d.class})`);
            });
            console.log('   ✓ SUCCESS: Lecture durations are displayed');
          } else {
            console.log('   No duration class elements found, checking lecture row content...');
            const lectureRows = await page.$$eval('tr, .lecture-row', els => {
              return els.map(e => ({
                text: e.textContent?.substring(0, 150)
              }));
            });
            console.log('   Sample lecture rows:');
            lectureRows.slice(0, 5).forEach((r, i) => {
              if (r.text && r.text.length > 20) {
                console.log(`   [${i}] ${r.text.replace(/\n/g, ' | ').substring(0, 100)}`);
              }
            });
          }
        } catch (e) {
          console.log('   Error checking duration elements:', e.message);
        }
      } else {
        console.log('   ✗ ERROR: Could not find curriculum tab button');
      }

      console.log('\n9. Taking screenshots...');
      const timestamp = Date.now();

      // Click back to title tab for first screenshot
      const titleTab = await page.$('button[data-vod-tab="title"]');
      if (titleTab) {
        await titleTab.click();
        await page.waitForTimeout(300);

        // Scroll to find the total duration field
        const durationInput = await page.$('#vfTotalDurationText');
        if (durationInput) {
          await durationInput.scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
        }
      }
      await page.screenshot({ path: `title-tab-${timestamp}.png`, fullPage: false });
      console.log(`   Saved: title-tab-${timestamp}.png`);

      // Screenshot curriculum tab with lecture durations
      const currTab = await page.$('button[data-vod-tab="curriculum"]');
      if (currTab) {
        await currTab.click();
        await page.waitForTimeout(300);

        // Get sample lecture durations from the page
        const lectureSample = await page.$$eval('tr', rows => {
          const result = [];
          rows.slice(0, 10).forEach(row => {
            const lectureNumber = row.querySelector('td:first-child')?.textContent?.trim();
            const lectureTitle = row.querySelector('td:nth-child(2) .searchable-select-label')?.textContent?.trim();
            const durationText = row.textContent;
            if (lectureNumber !== undefined && lectureTitle) {
              result.push({ lectureNumber, lectureTitle, hasDuration: durationText.includes(':') });
            }
          });
          return result;
        });

        if (lectureSample.length > 0) {
          console.log('   Sample lecture durations visible:');
          lectureSample.slice(0, 5).forEach(l => {
            console.log(`   - Lecture ${l.lectureNumber}: ${l.lectureTitle} (duration: ${l.hasDuration ? 'yes' : 'no'})`);
          });
        }

        // Scroll to top of curriculum to see lecture list
        const lectureList = await page.$('#vodLectureList');
        if (lectureList) {
          await lectureList.scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
        }

        await page.screenshot({ path: `curriculum-tab-${timestamp}.png`, fullPage: false });
        console.log(`   Saved: curriculum-tab-${timestamp}.png`);
      }
    }

    console.log('\n10. Checking console logs for errors...');
    const errorLogs = consoleLogs.filter(log => log.type === 'error' || log.type === 'pageError');
    if (errorLogs.length > 0) {
      console.log(`   ✗ Found ${errorLogs.length} console errors:`);
      errorLogs.forEach(log => {
        console.log(`   - ${log.text}`);
      });
    } else {
      console.log('   ✓ No console errors detected');
    }

    console.log('\n11. Checking network errors...');
    if (networkErrors.length > 0) {
      console.log(`   ✗ Found ${networkErrors.length} API errors:`);
      networkErrors.forEach(err => {
        console.log(`   - ${err.status} ${err.statusText}: ${err.url}`);
      });
    } else {
      console.log('   ✓ No network errors detected');
    }

    const warningLogs = consoleLogs.filter(log => log.type === 'warning');
    if (warningLogs.length > 0) {
      console.log(`   Found ${warningLogs.length} warnings:`);
      warningLogs.slice(0, 3).forEach(log => {
        console.log(`   - ${log.text}`);
      });
    }

  } catch (error) {
    console.error('ERROR during test:', error.message);
  } finally {
    await browser.close();
    console.log('\nTest complete.');
  }
})();
