const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://demo.inelabteamdev.com/product/975');
  await page.waitForSelector('.price-block');
  const box = await page.locator('.price-block').boundingBox();
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(box.x + 10 + i * 2, box.y + 10 + (i % 3) * 5);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(600);
  const btn = page.locator('button:has-text("Reveal price")');
  console.log('Button disabled before click?', await btn.getAttribute('disabled'));
  await btn.click();
  console.log('Clicked reveal price');
  for (let s = 1; s <= 5; s++) {
    await page.waitForTimeout(1000);
    const html = await page.locator('.price-block').innerHTML();
    console.log('[+' + s + 's] HTML:\n', html);
  }
  await browser.close();
})();
