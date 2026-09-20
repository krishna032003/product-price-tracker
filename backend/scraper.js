const { chromium } = require('playwright');
const path = require('path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Normalizes unicode, extracts price, validates finite positive number.
 * @param {string} rawText
 * @returns {{rawText: string, numericPrice: number, displayPrice: string}|null}
 */
function parseMoney(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  // Match currency symbol followed by numbers (e.g. â‚¹ 4,604 or â‚¹4604 or â‚¹35,503.00)
  const match = normalized.match(/(?:[â‚¹\u20B9\uFFE6]|Rs\.?|INR)\s*([0-9\uFF10-\uFF19][0-9\uFF10-\uFF19,.]*)/i) ||
                normalized.match(/([0-9\uFF10-\uFF19][0-9\uFF10-\uFF19,.]*)/);
  if (!match) return null;

  let clean = match[1] || match[0];
  if (/\d+\.\d{3},\d{2}/.test(clean)) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (/[,.]\d{2}$/.test(clean)) {
    clean = clean.slice(0, -3).replace(/[,.]/g, '');
  } else {
    clean = clean.replace(/[,.]/g, '');
  }

  const numericPrice = parseFloat(clean);
  if (!Number.isFinite(numericPrice) || numericPrice <= 50 || numericPrice > 10000000) return null;

  return {
    rawText: rawText,
    numericPrice: numericPrice,
    displayPrice: '\u20B9' + numericPrice.toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
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
        slowMo: headed ? 120 : 0,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
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
        for (let s = 0; s < 14; s++) {
          await page.mouse.move(box.x + 12 + s * 8, box.y + 12 + (s % 3) * 6);
          await delay(75);
        }
      }

      // Correct Playwright API call: wait until button is enabled
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

      // Extract resolved current deal price
      const quote = await page.locator('.price-success').evaluate(node => {
        const priceBlock = node.querySelector('.price-main') || node;
        const candidates = [...priceBlock.querySelectorAll('*')];

        // 1. Look for the large deal price element
        const dealPriceEl = candidates.find(el => {
          const style = window.getComputedStyle(el);
          const isStruck = style.textDecorationLine?.includes('line-through') || style.textDecoration?.includes('line-through');
          const isHidden = style.display === 'none' || style.visibility === 'hidden';
          return !isStruck && !isHidden && (style.fontSize === '2.4rem' || el.style.fontSize === '2.4rem' || el.classList.contains('price-current') || el.classList.contains('deal-price'));
        });

        // 2. Fallback: find any element with rupee symbol and digits that is NOT struck through
        const rupeeEl = dealPriceEl || candidates.find(el => {
          const style = window.getComputedStyle(el);
          const isStruck = style.textDecorationLine?.includes('line-through') || style.textDecoration?.includes('line-through');
          const isHidden = style.display === 'none' || style.visibility === 'hidden';
          const text = (el.textContent || '').normalize('NFKC');
          return !isStruck && !isHidden && /(?:[â‚¹\u20B9\uFFE6]|Rs\.?)\s*\d+/i.test(text);
        });

        const rawPriceText = rupeeEl ? rupeeEl.textContent.trim() : priceBlock.textContent.trim();

        // Stock element
        const stockNode = node.querySelector('.stock-badge') || 
                          [...node.querySelectorAll('*')].find(el => 
                            el.children.length === 0 && /(?:in stock|left|out of stock)/i.test(el.textContent || '')
                          );

        // Seller element
        const sellerNode = [...node.querySelectorAll('*')].find(el => 
          el.children.length === 0 && /sold by/i.test(el.textContent || '')
        );

        return {
          rawPrice: rawPriceText,
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
            status: 'FAILED',
            durationMs: attemptDuration,
            errorMessage: err.message,
            attempt
          });
        } catch (logErr) {
          console.error('[Attempt Fail Log Warning]:', logErr.message);
        }
      }

      if (!isLast) {
        const waitMs = 1500 * attempt;
        console.log(`Waiting ${waitMs}ms before attempt ${attempt + 1}...`);
        await delay(waitMs);
      }
    }
  }

  throw new Error(`Scraper exceeded ${MAX_ATTEMPTS} attempts. Last failure: ${lastError?.message || 'unknown error'}`);
}

module.exports = { runScraper, extractProductIdFromUrl, parseMoney };