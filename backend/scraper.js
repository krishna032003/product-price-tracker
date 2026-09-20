const { chromium } = require('playwright');
const path = require('path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Normalizes unicode, rejects ambiguous/multiple prices, preserves decimals.
 * @param {string} rawText
 * @returns {{rawText: string, numericPrice: number, displayPrice: string}|null}
 */
function parseMoney(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const normalized = rawText.normalize('NFKC').trim();

  // Reject ambiguous text containing multiple prices
  const currencyMatches = normalized.match(/₹|Rs\.?|INR/gi) || [];
  if (currencyMatches.length > 1) return null;

  let clean = normalized;
  if (/\d+\.\d{3},\d{2}/.test(clean)) {
    // European style e.g. 4.604,50 -> 4604.50
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else {
    // Standard Indian / International format: strip commas, keep decimal point
    clean = clean.replace(/,/g, '');
  }

  const match = clean.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const numericPrice = parseFloat(match[1]);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return null;

  return {
    rawText: rawText,
    numericPrice: numericPrice,
    displayPrice: '₹' + numericPrice.toLocaleString('en-IN', {
      minimumFractionDigits: numericPrice % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    })
  };
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
 * Extracts product ID from URL path (e.g. '/product/434' -> '434')
 */
function extractProductIdFromUrl(urlStr) {
  try {
    const pathname = new URL(urlStr).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const prodIdx = parts.indexOf('product');
    if (prodIdx !== -1 && parts[prodIdx + 1]) {
      return parts[prodIdx + 1];
    }
    return parts[parts.length - 1] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Scrapes product page with anti-bot unlock, bounded timeouts, and transparent attempt logging.
 */
async function runScraper(url, targetProductId = null, headed = false, onAttempt = null) {
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

      // Exact product ID comparison from URL path
      if (targetProductId) {
        const actualId = extractProductIdFromUrl(page.url());
        if (actualId !== String(targetProductId)) {
          throw new Error(`Product identity mismatch: expected ID "${targetProductId}", but page URL is "${page.url()}" (parsed: "${actualId}")`);
        }
      }

      // Dismiss cookie banner
      const cookieAccept = page.getByRole('button', { name: /accept/i });
      if (await cookieAccept.isVisible().catch(() => false)) {
        await cookieAccept.click().catch(() => {});
      }
      await page.evaluate(() => {
        document.querySelectorAll('.cookie-overlay, .cookie-banner, [class*="cookie"]').forEach(el => el.remove());
      }).catch(() => {});
      await delay(400);

      // Locate price block and perform simulated cursor movement to satisfy bot challenge
      const priceBlock = page.locator('.price-block');
      await priceBlock.waitFor({ state: 'visible', timeout: 15000 });
      const box = await priceBlock.boundingBox();
      if (box) {
        for (let s = 0; s < 12; s++) {
          await page.mouse.move(box.x + 12 + s * 8, box.y + 12 + (s % 3) * 6);
          await delay(90);
        }
      }

      // Correct Playwright API call: options is the 3rd argument (after pageFunction and undefined arg)
      const revealBtn = page.getByRole('button', { name: /reveal price/i });
      await page.waitForFunction(() => {
        const btn = document.querySelector('button[aria-label="Reveal price"]') || 
                    [...document.querySelectorAll('button')].find(b => /reveal price/i.test(b.textContent));
        return btn && !btn.hasAttribute('disabled');
      }, undefined, { timeout: 15000 });

      // Click the enabled button naturally
      await revealBtn.click();

      // Handle outcome: price resolution vs transient "Try again" error
      const outcome = await Promise.race([
        page.locator('.price-success').waitFor({ state: 'visible', timeout: 18000 }).then(() => 'success'),
        page.locator('.price-block button:has-text("Try again")').waitFor({ state: 'visible', timeout: 18000 }).then(() => 'retry')
      ]);

      if (outcome === 'retry') {
        console.log(`[Attempt ${attempt}] Store returned transient error, recording in-page recovery...`);
        if (onAttempt) {
          try {
            await onAttempt({
              status: 'RETRIED',
              durationMs: Date.now() - attemptStartTime,
              errorMessage: 'Transient store error encountered (clicked "Try again")',
              attempt
            });
          } catch (logErr) {
            console.error('[In-page Log Warning]:', logErr.message);
          }
        }
        const tryAgain = page.locator('.price-block button:has-text("Try again")');
        if (await tryAgain.count() > 0) {
          await tryAgain.first().click();
        }
        await page.locator('.price-success').waitFor({ state: 'visible', timeout: 18000 });
      }

      await delay(400);

      // Extract resolved current deal price using leaf node filtering
      const quote = await page.locator('.price-success').evaluate(node => {
        const priceMain = node.querySelector('.price-main') || node;
        const candidates = [...priceMain.querySelectorAll('*')];

        const validPriceNodes = candidates.filter(el => {
          if (el.children.length > 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true') {
            return false;
          }
          if (style.textDecorationLine?.includes('line-through') || style.textDecoration?.includes('line-through')) {
            return false;
          }
          const text = (el.textContent || '').trim();
          if (/deal price/i.test(text) || /% off/i.test(text) || /updating/i.test(text)) {
            return false;
          }
          return /[0-9\uFF10-\uFF19]/.test(text.normalize('NFKC'));
        });

        const currentPriceNode = validPriceNodes[0] || null;
        const stockNode = node.querySelector('.stock-badge') || 
                          [...node.querySelectorAll('*')].find(el => 
                            el.children.length === 0 && /(?:in stock|left|out of stock)/i.test(el.textContent || '')
                          );

        const sellerNode = [...node.querySelectorAll('*')].find(el => 
          el.children.length === 0 && /sold by/i.test(el.textContent || '')
        );

        return {
          rawPrice: currentPriceNode ? currentPriceNode.textContent.trim() : null,
          rawStock: stockNode ? stockNode.textContent.trim() : null,
          seller: sellerNode ? sellerNode.textContent.replace(/sold by/i, '').trim() : null
        };
      });

      console.log(`[Attempt ${attempt}] Scraped quote:`, quote);

      await page.close();
      await context.close();
      await browser.close();

      const parsedPrice = parseMoney(quote.rawPrice);
      const stockStatus = parseStock(quote.rawStock);

      if (!parsedPrice) {
        throw new Error(`Price resolution failed or ambiguous: "${quote.rawPrice}"`);
      }

      const attemptDuration = Date.now() - attemptStartTime;
      const isStockIncomplete = (stockStatus === 'Unknown');

      if (onAttempt) {
        try {
          await onAttempt({
            status: 'SUCCESS',
            durationMs: attemptDuration,
            priceRaw: parsedPrice.displayPrice,
            stockStatus: stockStatus,
            errorMessage: isStockIncomplete ? 'Incomplete extraction: stock information was missing or unparseable' : null,
            attempt
          });
        } catch (logErr) {
          console.error('[Attempt Success Log Warning]:', logErr.message);
        }
      }

      return {
        priceRaw: parsedPrice.displayPrice,
        numericPrice: parsedPrice.numericPrice,
        rawText: parsedPrice.rawText,
        stockStatus: stockStatus,
        isIncompleteStock: isStockIncomplete,
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
        try {
          await onAttempt({
            status: isLast ? 'FAILED' : 'RETRIED',
            durationMs: attemptDuration,
            errorMessage: err.message,
            attempt
          });
        } catch (logErr) {
          console.error('[Attempt Failure Log Warning]:', logErr.message);
        }
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

module.exports = { runScraper, parseStock, parseMoney, extractProductIdFromUrl };
