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

    // The store requires mouse hover over the price area to trigger the "Reveal price" button.
    // The price block usually has class "price-block"
    const priceBlockSelector = '.price-block';
    
    // Wait for the price block to appear on screen
    await page.waitForSelector(priceBlockSelector, { state: 'visible', timeout: 15000 });

    // The store's anti-bot logic expects at least 8 mouse moves over 600+ ms.
    const priceBlock = await page.locator(priceBlockSelector);
    const boundingBox = await priceBlock.boundingBox();

    if (!boundingBox) {
      throw new Error("Could not find bounding box for price block");
    }

    // Simulate human-like mouse movement over the element to unlock it
    // Start at top-left of the box
    let currentX = boundingBox.x + 10;
    let currentY = boundingBox.y + 10;
    await page.mouse.move(currentX, currentY);

    // We need at least 8 moves and ~600ms dwell time, so we do 15 moves with 50ms gaps
    for (let i = 0; i < 15; i++) {
      currentX += (Math.random() * 10) - 2; // move slightly
      currentY += (Math.random() * 10) - 2;
      await page.mouse.move(currentX, currentY);
      await page.waitForTimeout(60); 
    }

    // Now wait an extra 500ms to ensure the "minDwellMs" (600) constraint is passed
    await page.waitForTimeout(500);

    // The "Reveal price" button should now be enabled.
    // Let's find it. It might be disabled initially, so we wait for it to be enabled.
    const revealBtn = page.locator('button:has-text("Reveal price")');
    
    // We check if it exists, as sometimes the site might not require hover if cached or logic changes
    if (await revealBtn.count() > 0) {
       // Wait for the button to be enabled
       await expectEnabled(revealBtn, 10000);
       
       // Click it!
       await revealBtn.click();
    }

    // Now the site fetches the price. It goes through phase: 'loading', 'retrying', 'success', or 'error'
    // We wait for the spinner to disappear and the final state to render.
    // We look for either the price value class or a success text, OR an error state.
    
    // Wait until it's no longer idle/loading/retrying
    // The layout defines dynamic classes like `.pv-q9` for price. Since the class is dynamic, 
    // it's better to look for the container `.price-block` NOT having `.price-idle` or `.spinner`.
    // We can just wait for text containing currency symbol (e.g. ₹ or Rs.) or for "Try again" button.
    
    let priceRaw = null;
    let stockStatus = null;
    
    // Retry loop for the scraper to handle "Try again" errors that the store intentionally throws
    for (let attempts = 1; attempts <= 3; attempts++) {
        try {
            // Wait for either the price to show up, OR the error block to show up
            const result = await Promise.race([
                page.waitForSelector('.price-block:not(.price-idle):not(:has(.spinner)) button:has-text("Try again")', { timeout: 15000 }).then(() => 'error'),
                page.waitForSelector('.price-block:not(.price-idle):not(:has(.spinner)) strong', { timeout: 15000 }).then(() => 'success'),
                // Some layouts might use 'b' or 'span' for the price tag
                page.waitForSelector('.price-block:not(.price-idle):not(:has(.spinner)) :text-matches("₹|Rs|/-", "g")', { timeout: 15000 }).then(() => 'success')
            ]);

            if (result === 'error') {
                if (attempts < 3) {
                    console.log(`Store returned error state on attempt ${attempts}. Clicking 'Try again'...`);
                    await page.locator('button:has-text("Try again")').click();
                    continue; // Loop back and wait again
                } else {
                    throw new Error("Store repeatedly returned error state after multiple try again attempts.");
                }
            }
            
            // If success, we extract the data
            // Since classes are obfuscated, we use DOM structure and regex.
            // Price usually has currency symbols.
            const priceBlockText = await page.locator('.price-block').innerText();
            
            // Regex to find things like "₹ 42,900" or "Rs. 42,900.00"
            const priceMatch = priceBlockText.match(/(?:₹|Rs\.?)\s*[\d,.]+(?:\/-)?/i);
            if (priceMatch) {
                priceRaw = priceMatch[0].trim();
            }

            // Stock usually has "In stock", "Out of stock", "left"
            const stockMatch = priceBlockText.match(/(In stock|Out of stock|Only \d+ left|Selling fast.*?left|\d+ in stock|Hurry, just \d+ left)/i);
            if (stockMatch) {
                stockStatus = stockMatch[0].trim();
            }

            if (!priceRaw) {
               throw new Error(`Could not parse price from block text: ${priceBlockText}`);
            }

            // Success! Break out of retry loop
            break;

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
