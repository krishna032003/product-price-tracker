const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  page.on('request', req => {
    if (req.url().includes('/api/') || req.url().includes('challenge') || req.url().includes('price')) {
      console.log('REQUEST:', req.method(), req.url());
    }
  });
  page.on('response', async res => {
    if (res.url().includes('/api/') || res.url().includes('price')) {
      console.log('RESPONSE:', res.status(), res.url());
      try { console.log('BODY:', await res.text()); } catch(e){}
    }
  });
  await page.goto('https://demo.inelabteamdev.com/product/975');
  await page.waitForSelector('.price-block');
  const box = await page.locator('.price-block').boundingBox();
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(box.x + 10 + i * 2, box.y + 10 + (i % 3) * 5);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(600);
  const btn = page.locator('button:has-text("Reveal price")');
  await btn.click();
  console.log('Clicked button');
  await page.waitForTimeout(5000);
  await browser.close();
})();
