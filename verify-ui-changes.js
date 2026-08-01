const playwright = require('playwright');
const fs = require('fs');

async function verify() {
  const browser = await playwright.chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Set viewport to match typical test width
  await page.setViewportSize({ width: 1280, height: 1024 });

  console.log('=== Starting UI Verification ===\n');

  try {
    // Navigate to admin login
    console.log('1. Navigating to admin login page...');
    await page.goto('http://localhost:5080/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // Log in
    console.log('2. Logging in with password 4072...');
    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) {
      throw new Error('Password input not found on login page');
    }
    await passwordInput.fill('4072');

    // Click submit and wait for navigation or timeout gracefully
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await Promise.race([
        submitBtn.click(),
        page.waitForTimeout(500)
      ]);
    }

    // Wait for the page to load with a generous timeout
    await page.waitForTimeout(3000);

    // Navigate to video upload section
    console.log('3. Navigating to 영상 업로드 section...');
    // Check if we're already on the admin page with content
    const adminContent = await page.$('#adminContainer, .admin-container, [role="main"]');
    if (adminContent) {
      console.log('  Admin page loaded, looking for 영상 업로드 section...');
      // The section might already be visible or needs to be clicked
      await page.waitForTimeout(500);
    }

    // Take screenshot of initial state (root folder)
    console.log('\n=== ROOT FOLDER VIEW ===');
    await page.screenshot({ path: 'C:\\workspace\\dock\\root-folder-view.png' });

    // Test 1: Check back button hidden at root
    console.log('\nTest 1: Back button visibility at root folder');
    const backBtn = await page.$('#videoFolderBackBtn');
    if (!backBtn) {
      console.log('  ❌ Back button element not found');
    } else {
      const display = await page.evaluate(() => {
        const el = document.getElementById('videoFolderBackBtn');
        return window.getComputedStyle(el).display;
      });
      const visibility = await page.evaluate(() => {
        const el = document.getElementById('videoFolderBackBtn');
        return window.getComputedStyle(el).visibility;
      });
      console.log(`  Display: ${display}, Visibility: ${visibility}`);
      if (display === 'none' || visibility === 'hidden') {
        console.log('  ✓ Back button is HIDDEN (correct at root)');
      } else {
        console.log('  ❌ Back button is VISIBLE (should be hidden at root)');
      }
    }

    // Test 2: Navigate into a subfolder and check back button
    console.log('\nTest 2: Navigate into subfolder and check back button');
    const folderLinks = await page.$$('.folder-item, .video-folder-item, li[data-folder], a.folder');
    console.log(`  Found ${folderLinks.length} folder items`);

    if (folderLinks.length > 0) {
      // Click first folder
      const firstFolderText = await folderLinks[0].textContent();
      console.log(`  Clicking folder: ${firstFolderText.trim()}`);
      await folderLinks[0].click();
      await page.waitForTimeout(800);

      // Screenshot inside folder
      await page.screenshot({ path: 'C:\\workspace\\dock\\subfolder-view.png' });

      // Check back button now visible
      const display2 = await page.evaluate(() => {
        const el = document.getElementById('videoFolderBackBtn');
        if (!el) return 'NOT_FOUND';
        return window.getComputedStyle(el).display;
      });
      const visibility2 = await page.evaluate(() => {
        const el = document.getElementById('videoFolderBackBtn');
        if (!el) return 'NOT_FOUND';
        return window.getComputedStyle(el).visibility;
      });
      console.log(`  Display: ${display2}, Visibility: ${visibility2}`);
      if (display2 !== 'none' && visibility2 !== 'hidden') {
        console.log('  ✓ Back button is VISIBLE (correct in subfolder)');

        // Check button color
        const bgColor = await page.evaluate(() => {
          const el = document.getElementById('videoFolderBackBtn');
          if (!el) return 'NOT_FOUND';
          return window.getComputedStyle(el).backgroundColor;
        });
        console.log(`  Back button background color: ${bgColor}`);
        // Expect tan/beige around rgb(227, 205, 175) or #e3cdaf
        if (bgColor.includes('227') || bgColor.includes('205') || bgColor.includes('175') || bgColor.includes('e3cdaf')) {
          console.log('  ✓ Button color is beige/tan (correct)');
        } else {
          console.log(`  ⚠ Button color may not be beige: ${bgColor}`);
        }
      } else {
        console.log('  ❌ Back button still hidden in subfolder');
      }

      // Get current breadcrumb/folder path before click
      const pathBefore = await page.evaluate(() => {
        return document.body.innerText.match(/영상 폴더[^\n]*/)?.[0] || 'unknown';
      });
      console.log(`  Path before clicking back: ${pathBefore}`);

      // Test 3: Click back button
      console.log('\nTest 3: Click back button and verify one-level navigation');
      await page.click('#videoFolderBackBtn');
      await page.waitForTimeout(800);

      const pathAfter = await page.evaluate(() => {
        return document.body.innerText.match(/영상 폴더[^\n]*/)?.[0] || 'unknown';
      });
      console.log(`  Path after clicking back: ${pathAfter}`);
      if (pathBefore !== pathAfter) {
        console.log('  ✓ Navigation occurred (path changed)');
      } else {
        console.log('  ⚠ Path appears same (might be root or same level)');
      }

      // Take screenshot after back
      await page.screenshot({ path: 'C:\\workspace\\dock\\after-back-click.png' });
    } else {
      console.log('  ⚠ No folders found to test back button navigation');
    }

    // Test 4: Check folder list scrolling (max-height, overflow)
    console.log('\nTest 4: Folder list scroll container (#videoFolderList)');
    const folderListStyles = await page.evaluate(() => {
      const el = document.getElementById('videoFolderList');
      if (!el) return { error: 'NOT_FOUND' };
      const style = window.getComputedStyle(el);
      return {
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        height: el.clientHeight,
        scrollHeight: el.scrollHeight
      };
    });
    console.log(`  Max-height: ${folderListStyles.maxHeight}`);
    console.log(`  Overflow-y: ${folderListStyles.overflowY}`);
    console.log(`  Client height: ${folderListStyles.height}px, Scroll height: ${folderListStyles.scrollHeight}px`);
    if (folderListStyles.maxHeight === '215px') {
      console.log('  ✓ Max-height is 215px (correct)');
    } else {
      console.log(`  ❌ Max-height is ${folderListStyles.maxHeight} (expected 215px)`);
    }
    if (folderListStyles.overflowY === 'auto') {
      console.log('  ✓ Overflow-y is auto (correct)');
    } else {
      console.log(`  ❌ Overflow-y is ${folderListStyles.overflowY} (expected auto)`);
    }
    if (folderListStyles.scrollHeight > folderListStyles.height) {
      console.log(`  ✓ Content overflows (scrollHeight ${folderListStyles.scrollHeight} > clientHeight ${folderListStyles.height})`);
    } else {
      console.log(`  ℹ No overflow detected (may have few folders)`);
    }

    // Test 5: Check video table scroll container
    console.log('\nTest 5: Video table scroll container (.video-table-scroll)');
    const videoTableStyles = await page.evaluate(() => {
      const el = document.querySelector('.video-table-scroll');
      if (!el) return { error: 'NOT_FOUND' };
      const style = window.getComputedStyle(el);
      const thead = el.querySelector('thead th');
      let theadPosition = 'NOT_FOUND';
      let theadTop = 'NOT_FOUND';
      if (thead) {
        theadPosition = window.getComputedStyle(thead).position;
        theadTop = window.getComputedStyle(thead).top;
      }
      return {
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        height: el.clientHeight,
        scrollHeight: el.scrollHeight,
        theadPosition,
        theadTop
      };
    });
    console.log(`  Max-height: ${videoTableStyles.maxHeight}`);
    console.log(`  Overflow-y: ${videoTableStyles.overflowY}`);
    console.log(`  Client height: ${videoTableStyles.height}px, Scroll height: ${videoTableStyles.scrollHeight}px`);
    console.log(`  Thead position: ${videoTableStyles.theadPosition}, top: ${videoTableStyles.theadTop}`);
    if (videoTableStyles.maxHeight === '230px') {
      console.log('  ✓ Max-height is 230px (correct)');
    } else {
      console.log(`  ⚠ Max-height is ${videoTableStyles.maxHeight} (expected 230px)`);
    }
    if (videoTableStyles.overflowY === 'auto') {
      console.log('  ✓ Overflow-y is auto (correct)');
    } else {
      console.log(`  ⚠ Overflow-y is ${videoTableStyles.overflowY} (expected auto)`);
    }
    if (videoTableStyles.theadPosition === 'sticky') {
      console.log('  ✓ Thead position is sticky (correct)');
    } else {
      console.log(`  ⚠ Thead position is ${videoTableStyles.theadPosition} (expected sticky)`);
    }
    if (videoTableStyles.theadTop === '0px') {
      console.log('  ✓ Thead top is 0px (correct)');
    } else {
      console.log(`  ⚠ Thead top is ${videoTableStyles.theadTop} (expected 0px)`);
    }
    if (videoTableStyles.scrollHeight > videoTableStyles.height) {
      console.log(`  ✓ Content overflows (scrollHeight ${videoTableStyles.scrollHeight} > clientHeight ${videoTableStyles.height})`);
    } else {
      console.log(`  ℹ No overflow detected (may have few videos)`);
    }

    // Test 6: Check for console errors
    console.log('\nTest 6: Console errors check');
    const consoleMessages = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleMessages.push(`ERROR: ${msg.text()}`);
      }
    });
    page.on('pageerror', err => {
      consoleMessages.push(`PAGE ERROR: ${err.message}`);
    });

    // Trigger some interactions to catch errors
    await page.evaluate(() => {
      const el = document.getElementById('videoFolderBackBtn');
      if (el && el.style.display !== 'none') {
        const event = new MouseEvent('click', { bubbles: true });
        el.dispatchEvent(event);
      }
    });
    await page.waitForTimeout(500);

    if (consoleMessages.length === 0) {
      console.log('  ✓ No console errors detected');
    } else {
      console.log('  ❌ Console errors found:');
      consoleMessages.forEach(msg => console.log(`     ${msg}`));
    }

    console.log('\n=== VERIFICATION COMPLETE ===');
    console.log('\nScreenshots saved:');
    console.log('  - C:\\workspace\\dock\\root-folder-view.png');
    console.log('  - C:\\workspace\\dock\\subfolder-view.png');
    console.log('  - C:\\workspace\\dock\\after-back-click.png');

  } catch (error) {
    console.error('Error during verification:', error.message);
  } finally {
    await browser.close();
  }
}

verify().catch(console.error);
