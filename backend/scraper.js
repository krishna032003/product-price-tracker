const { chromium } = require('playwright');
const path = require('path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Normalizes unicode (including full-width digits like ４,６０４) and extracts numeric price.
 */
function parseMoney(value) {
  if (!value || typeof value !== 'string') return null;
  // Use NFKC normalization to convert full-width unicode numbers to standard ASCII digits
  const normalized = value.normalize('NFKC');
  const clean = normalized.replace(/[^\d]/g, '');
  return clean ? '₹' + Number(clean).toLocaleString('en-IN') : null;
}

/**
 * Extracts stock information. Defaults to 'Unknown' unless explicitly declared.
 */
function parseStock(value) {
  if (!value || typeof value !== 'string') return 'Unknown';
  const trimmed = value.trim();
  if (/out of stock/i.test(trimmed)) return 'Out of stock';
  const match = trimmed.match(/(\d+)\s*(?:left|in stock)/i);
  if (match) return match[1] + ' in stock';
  if (/in stock/i.test(trimmed)) return 'In stock';
  return 'Unknown';
}

/**
 * Scrapes product page with anti-bot unlock, bounded timeouts, and attempt callback.
 */
async function runScraper(url, headed = false, onAttempt = null) {
  let lastError = null;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let browser = null;
    const attemptStartTime = Date.now();

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

      console.log(`[Attempt ${attempt}/${MAX_ATTEMPTS}] Navigating to: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Dismiss cookie banner
      const cookieAccept = page.getByRole('button', { name: /accept/i });
      if (await cookieAccept.isVisible().catch(() => false)) {
        await cookieAccept.click().catch(() => {});
      }
      await page.evaluate(() => {
        document.querySelectorAll('.cookie-overlay, .cookie-banner, [class*="cookie"]').forEach(el => el.remove());
      }).catch(() => {});
      await delay(500);

      // Locate price reveal button (15s timeout)
      const button = page.getByRole('button', { name: /reveal price/i });
      await button.waitFor({ state: 'visible', timeout: 15000 });
      const box = await button.boundingBox();
      if (!box) throw new Error('Reveal-price button has no visible bounds');

      // Human-like cursor interaction over button to trigger anti-bot unlock
      for (let step = 0; step < 10; step++) {
        await page.mouse.move(box.x + 8 + step * 4, box.y + 8 + (step % 3) * 3);
        await delay(80);
      }
      await delay(600);
      await button.click({ force: true });

      // Handle price success or transient error retry
      const outcome = await Promise.race([
        page.locator('.price-success').waitFor({ state: 'visible', timeout: 18000 }).then(() => 'success'),
        page.locator('.price-block button:has-text("Try again")').waitFor({ state: 'visible', timeout: 18000 }).then(() => 'retry')
      ]);

      if (outcome === 'retry') {
        console.log(`[Attempt ${attempt}] Store returned transient error, clicking 'Try again'...`);
        const tryAgain = page.locator('.price-block button:has-text("Try again")');
        if (await tryAgain.count() > 0) {
          await tryAgain.first().click({ force: true });
        }
        await page.locator('.price-success').waitFor({ state: 'visible', timeout: 18000 });
      }

      await delay(500);

      // Extract resolved current deal price and stock
      const quote = await page.locator('.price-success').evaluate(node => {
        // Prioritize specific current deal price element over old strike-through price
        const priceNode = [...node.querySelectorAll('.price-main > *')]
          .find(el => el.style && el.style.fontSize === '2.4rem') || 
          node.querySelector('.deal-price') || 
          node.querySelector('.price-main') || 
          node.querySelector('.current-price');
        
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
        throw new Error('Price was empty or invalid after resolution');
      }

      const attemptDuration = Date.now() - attemptStartTime;

      // Note if stock extraction was incomplete
      let note = null;
      if (stockStatus === 'Unknown') {
        note = 'Incomplete extraction: stock information was missing or unparseable';
      }

      if (onAttempt) {
        await onAttempt({
          status: 'SUCCESS',
          durationMs: attemptDuration,
          priceRaw,
          stockStatus,
          errorMessage: note,
          attempt
        });
      }

      return {
        priceRaw,
        stockStatus,
        isIncompleteStock: stockStatus === 'Unknown',
        seller: quote.seller || 'INE Official Store'
      };

    } catch (err) {
      lastError = err;
      const attemptDuration = Date.now() - attemptStartTime;
      const isLast = (attempt === MAX_ATTEMPTS);
      console.warn(`[Attempt ${attempt}/${MAX_ATTEMPTS}] Scrape error: ${err.message}`);

      if (browser) {
        await browser.close().catch(() => {});
      }

      if (onAttempt) {
        await onAttempt({
          status: isLast ? 'FAILED' : 'RETRIED',
          durationMs: attemptDuration,
          errorMessage: err.message,
          attempt
        });
      }

      if (!isLast) {
        const waitMs = 1500 * attempt;
        console.log(`Waiting ${waitMs}ms before retry attempt ${attempt + 1}...`);
        await delay(waitMs);
      }
    }
  }

  throw new Error(`Scrape failed after ${MAX_ATTEMPTS} attempts: ${lastError ? lastError.message : 'Unknown error'}`);
}

module.exports = { runScraper, parseStock, parseMoney };
