const { chromium } = require('playwright');
const delay = ms => new Promise(r => setTimeout(r, ms));

function parseMoney(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  const match = normalized.match(/(?:[₹\u20B9\uFFE6]|Rs\.?|INR)\s*([0-9\uFF10-\uFF19][0-9\uFF10-\uFF19,.]*)/i) ||
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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://demo.inelabteamdev.com/product/878', { waitUntil: 'domcontentloaded' });
  
  // 1. Remove cookie overlay
  await page.evaluate(() => {
    document.querySelectorAll('.cookie-overlay, .cookie-banner, [class*="cookie"], .backdrop, .modal-backdrop').forEach(el => el.remove());
    if (document.body) {
      document.body.style.pointerEvents = 'auto';
      document.body.style.overflow = 'auto';
    }
  }).catch(() => {});

  // 2. Bot challenge simulation
  const priceBlock = page.locator('.price-block');
  await priceBlock.waitFor({ state: 'visible', timeout: 10000 });
  const box = await priceBlock.boundingBox();
  if (box) {
    for (let s = 0; s < 14; s++) {
      await page.mouse.move(box.x + 12 + s * 8, box.y + 12 + (s % 3) * 6);
      await delay(75);
    }
  }

  // 3. Wait until reveal button is enabled
  const revealBtn = page.locator('button[aria-label="Reveal price"], button:has-text("Reveal price")');
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[aria-label="Reveal price"]') || 
                [...document.querySelectorAll('button')].find(b => /reveal price/i.test(b.textContent));
    return btn && !btn.hasAttribute('disabled');
  }, undefined, { timeout: 15000 });

  // Clear cookie overlay again right before click to guarantee zero pointer interception
  await page.evaluate(() => {
    document.querySelectorAll('.cookie-overlay, .cookie-banner, [class*="cookie"]').forEach(el => el.remove());
  }).catch(() => {});

  await revealBtn.first().click({ force: true });

  // 4. Wait for price resolution or try again
  const outcome = await Promise.race([
    page.waitForFunction(() => !!document.querySelector('.price-main, .price-success'), undefined, { timeout: 18000 }).then(() => 'success'),
    page.waitForFunction(() => {
      const pb = document.querySelector('.price-block');
      return pb && [...pb.querySelectorAll('button')].some(b => /try again/i.test(b.textContent));
    }, undefined, { timeout: 18000 }).then(() => 'retry')
  ]);

  console.log('Outcome:', outcome);

  if (outcome === 'retry') {
    const tryAgain = page.locator('.price-block button:has-text("Try again"), button:has-text("Try Again")');
    if (await tryAgain.count() > 0) {
      await tryAgain.first().click({ force: true });
    }
    await page.waitForFunction(() => !!document.querySelector('.price-main, .price-success'), undefined, { timeout: 18000 });
  }

  await delay(300);

  // 5. Extract resolved current deal price
  const quote = await page.evaluate(() => {
    const priceMain = document.querySelector('.price-main, .price-success');
    if (!priceMain) return null;

    const candidates = [...priceMain.querySelectorAll('*')];

    // Deal price element (e.g. fontSize: 2.4rem or deal-price class)
    const dealPriceEl = candidates.find(el => {
      const style = window.getComputedStyle(el);
      const isStruck = style.textDecorationLine?.includes('line-through') || style.textDecoration?.includes('line-through');
      const isHidden = style.display === 'none' || style.visibility === 'hidden';
      return !isStruck && !isHidden && (style.fontSize === '2.4rem' || el.style.fontSize === '2.4rem' || el.classList.contains('price-current') || el.classList.contains('deal-price'));
    });

    let rawPrice = '';
    if (dealPriceEl) {
      rawPrice = dealPriceEl.innerText || dealPriceEl.textContent;
    } else {
      const rupeeCandidate = candidates.find(el => {
        const txt = (el.innerText || el.textContent || '').trim();
        const style = window.getComputedStyle(el);
        const isStruck = style.textDecorationLine?.includes('line-through') || style.textDecoration?.includes('line-through');
        const isHidden = style.display === 'none' || style.visibility === 'hidden';
        return !isStruck && !isHidden && /(?:[₹\u20B9\uFFE6]|Rs\.?|INR)/i.test(txt) && /\d/.test(txt);
      });
      rawPrice = rupeeCandidate ? (rupeeCandidate.innerText || rupeeCandidate.textContent) : (priceMain.innerText || priceMain.textContent);
    }

    const stockEl = document.querySelector('.stock-badge, .price-facets, .st-k2, [class*="stock"]');
    const rawStock = stockEl ? (stockEl.innerText || stockEl.textContent) : '';

    return { rawPrice, rawStock };
  });

  console.log('Extracted quote:', quote);
  console.log('Parsed Money:', parseMoney(quote.rawPrice));

  await browser.close();
})();
