const { chromium } = require('playwright');
const path = require('path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseMoney(value) {
  if (!value) return null;
  const clean = value.replace(/[^\d]/g, '');
  return clean ? '₹' + Number(clean).toLocaleString('en-IN') : value;
}

function parseStock(value) {
  if (!value) return 'Unknown';
  if (/out of stock/i.test(value)) return 'Out of stock';
  const match = value.match(/(\d+)\s*(?:left|in stock)/i);
  if (match) return match[1] + ' in stock';
  return value.trim();
}

/**
 * Scrape the mock store product page for price and stock.
 * @param {string} url - The URL of the product page
 * @param {boolean} headed - Whether to run in headed mode
 * @returns {Promise<{priceRaw: string, stockStatus: string, seller: string}>}
 */
async function runScraper(url, headed = false) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let browser = null;
    try {
      browser = await chromium.launch({
        headless: !headed,
        slowMo: headed ? 120 : 0
      });

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        recordVideo: headed ? { dir: path.resolve(__dirname, '../recordings'), size: { width: 1280, height: 720 } } : undefined
      });

      const page = await context.newPage();
      page.setDefaultTimeout(25000);

      console.log(`[Attempt ${attempt}] Navigating to: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Dismiss cookie banner and remove overlay
      const cookieAccept = page.getByRole('button', { name: /accept/i });
      if (await cookieAccept.isVisible().catch(() => false)) {
        await cookieAccept.click().catch(() => {});
      }
      await page.evaluate(() => {
        document.querySelectorAll('.cookie-overlay, .cookie-banner, [class*="cookie"]').forEach(el => el.remove());
      }).catch(() => {});
      await delay(500);

      // Find the reveal button
      const button = page.getByRole('button', { name: /reveal price/i });
      await button.waitFor({ state: 'visible', timeout: 15000 });
      const box = await button.boundingBox();
      if (!box) throw new Error('Reveal-price button has no visible bounds');

      // Natural mouse movement over the button to trigger anti-bot verification
      for (let step = 0; step < 10; step++) {
        await page.mouse.move(box.x + 8 + step * 4, box.y + 8 + (step % 3) * 3);
        await delay(80);
      }
      await delay(600);
      await button.click({ force: true });

      // Check if .price-success resolves or if a 'Try again' error button appears
      const outcome = await Promise.race([
        page.locator('.price-success').waitFor({ state: 'visible', timeout: 18000 }).then(() => 'success'),
        page.locator('.price-block button:has-text("Try again")').waitFor({ state: 'visible', timeout: 18000 }).then(() => 'retry')
      ]);

      if (outcome === 'retry') {
        console.log(`[Attempt ${attempt}] Store gave transient error, clicking 'Try again'...`);
        const tryAgain = page.locator('.price-block button:has-text("Try again")');
        if (await tryAgain.count() > 0) {
          await tryAgain.first().click({ force: true });
        }
        await page.locator('.price-success').waitFor({ state: 'visible', timeout: 18000 });
      }

      await delay(500);

      // Extract resolved price and stock from .price-success
      const quote = await page.locator('.price-success').evaluate(node => {
        const priceNode = [...node.querySelectorAll('.price-main > *')]
          .find(el => el.style && el.style.fontSize === '2.4rem') || node.querySelector('.price-main');
        
        const stockNode = node.querySelector('.stock-badge') || [...node.querySelectorAll('*')]
          .find(el => /(?:in stock|left|out of stock)/i.test(el.textContent || ''));

        const sellerNode = [...node.querySelectorAll('*')]
          .find(el => /sold by/i.test(el.textContent || ''));

        return {
          rawPrice: priceNode ? priceNode.textContent.trim() : null,
          rawStock: stockNode ? stockNode.textContent.trim() : null,
          seller: sellerNode ? sellerNode.textContent.replace(/sold by/i, '').trim() : null
        };
      });

      console.log(`[Attempt ${attempt}] Raw scraped quote:`, quote);

      await page.close();
      await context.close();
      await browser.close();

      const priceRaw = parseMoney(quote.rawPrice);
      const stockStatus = parseStock(quote.rawStock);

      if (!priceRaw) {
        throw new Error('Price was empty after resolution');
      }

      return {
        priceRaw,
        stockStatus,
        seller: quote.seller || 'INE Official Store'
      };

    } catch (err) {
      lastError = err;
      console.warn(`[Attempt ${attempt}] Scrape error: ${err.message}`);
      if (browser) {
        await browser.close().catch(() => {});
      }
      if (attempt < 3) {
        const waitMs = 1500 * attempt;
        console.log(`Waiting ${waitMs}ms before retry...`);
        await delay(waitMs);
      }
    }
  }

  throw new Error(`Scrape failed after 3 attempts: ${lastError ? lastError.message : 'Unknown'}`);
}

module.exports = { runScraper };
