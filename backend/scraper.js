const { chromium } = require('playwright');

/**
 * Scrape the mock store product page for price and stock.
 * Uses Playwright to render the page, handle the anti-bot hover logic, and extract the data.
 * @param {string} url - The URL of the product page
 * @param {boolean} headed - Whether to run in headed mode for observation
 * @returns {Promise<{priceRaw: string, stockStatus: string, seller: string}>}
 */
async function runScraper(url, headed = false) {
  // We use chromium. Playwright can run headed or headless.
  const browser = await chromium.launch({
    headless: !headed,
    // Add slowMo in headed mode so the observer can watch what happens
    slowMo: headed ? 200 : 0
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    // Add a reasonable timeout for the initial load
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 1. Dismiss cookie banner if present (prevents click interception)
    const cookieAccept = page.locator('button:has-text("ACCEPT")');
    if (await cookieAccept.count() > 0) {
      try {
        await cookieAccept.first().click();
        await page.waitForTimeout(300);
      } catch (e) {}
    }

    // 2. The store requires mouse hover over the price area to trigger the "Reveal price" button.
    const priceBlockSelector = '.price-block';
    await page.waitForSelector(priceBlockSelector, { state: 'visible', timeout: 15000 });

    const priceBlock = page.locator(priceBlockSelector);
    const boundingBox = await priceBlock.boundingBox();
    if (!boundingBox) {
      throw new Error("Could not find bounding box for price block");
    }

    // 3. Simulate human-like mouse movement over the element to unlock it
    let currentX = boundingBox.x + 20;
    let currentY = boundingBox.y + 20;
    await page.mouse.move(currentX, currentY);

    for (let i = 0; i < 20; i++) {
      currentX += (Math.random() * 8) - 2;
      currentY += (Math.random() * 8) - 2;
      await page.mouse.move(currentX, currentY);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(600);

    // 4. Click the "Reveal price" button
    const revealBtn = page.locator('button:has-text("Reveal price")');
    for (let clickAttempt = 0; clickAttempt < 5; clickAttempt++) {
      const isIdle = await page.evaluate(() => {
        const el = document.querySelector('.price-block');
        return el ? el.classList.contains('price-idle') : false;
      });

      if (!isIdle) break;

      if (await revealBtn.count() > 0) {
        try {
          await revealBtn.first().click({ force: true });
        } catch (e) {}
      }
      await page.waitForTimeout(800);
    }

    // 5. Wait for price resolution or error/retry state
    let priceRaw = null;
    let stockStatus = null;
    let seller = null;

    for (let attempts = 1; attempts <= 4; attempts++) {
      try {
        // Wait for either the price to show up, OR the error block with 'Try again'
        const result = await Promise.race([
          page.waitForSelector('.price-block button:has-text("Try again")', { timeout: 15000 }).then(() => 'error'),
          page.waitForSelector('.price-block:not(.price-idle):not(:has(.spinner))', { timeout: 15000 }).then(() => 'resolved')
        ]);

        if (result === 'error') {
          if (attempts < 4) {
            console.log(`Store returned error state on attempt ${attempts}. Clicking 'Try again'...`);
            const tryAgainBtn = page.locator('.price-block button:has-text("Try again")');
            if (await tryAgainBtn.count() > 0) {
              await tryAgainBtn.first().click({ force: true });
            }
            await page.waitForTimeout(1000);
            continue;
          } else {
            throw new Error("Store repeatedly returned error state after multiple try again attempts.");
          }
        }

        // Wait a small moment for all DOM text nodes to settle
        await page.waitForTimeout(600);

        const priceBlockText = await page.locator('.price-block').innerText();

        // Extract all currency matches (e.g. ₹,183,305 and ₹,170,809)
        const matches = priceBlockText.match(/(?:₹|Rs\.?)\s*[\d,.]+(?:\/-)?/gi);
        if (matches && matches.length > 0) {
          // If multiple, usually the second one is selling price after MRP, or take the smallest
          priceRaw = matches.length > 1 ? matches[1].trim() : matches[0].trim();
        }

        // Extract stock status
        const stockMatch = priceBlockText.match(/(In stock|Out of stock|Only \d+ left|Selling fast.*?left|\d+ in stock|Hurry, just \d+ left)/i);
        if (stockMatch) {
          stockStatus = stockMatch[0].trim();
        }

        // Extract seller
        const sellerMatch = priceBlockText.match(/Sold by\s+([^|\n]+)/i);
        if (sellerMatch) {
          seller = sellerMatch[1].trim();
        }

        if (priceRaw) {
          break; // Success!
        }
      } catch (e) {
        if (e.message.includes('Timeout')) {
          throw new Error("Timeout waiting for price to resolve.");
        }
        throw e;
      }
    }

    return {
       priceRaw,
       stockStatus: stockStatus || 'Unknown'
    };

  } finally {
    await browser.close();
  }
}

// Helper to wait for a locator to be enabled
async function expectEnabled(locator, timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const disabled = await locator.getAttribute('disabled');
        if (disabled === null) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error("Timeout waiting for button to become enabled");
}

module.exports = { runScraper };
