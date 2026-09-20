const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://demo.inelabteamdev.com/product/975');
  
  // Dismiss cookie overlay
  const cookieAccept = page.locator('button:has-text("ACCEPT")');
  if (await cookieAccept.count() > 0) {
    console.log('Clicking cookie ACCEPT...');
    await cookieAccept.first().click();
    await page.waitForTimeout(500);
  }

  await page.waitForSelector('.price-block');
  const box = await page.locator('.price-block').boundingBox();
  
  // Dwell with mouse movement
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(box.x + 20 + i * 2, box.y + 20 + (i % 4) * 5);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(600);

  const btn = page.locator('button:has-text("Reveal price")');
  console.log('Button disabled?', await btn.getAttribute('disabled'));
  
  // Click reveal price
  await btn.click({ force: true });
  console.log('Clicked Reveal price successfully without overlay blocking!');

  // Wait for price resolution
  for (let s = 1; s <= 10; s++) {
    await page.waitForTimeout(1000);
    const text = await page.locator('.price-block').innerText();
    console.log('[+' + s + 's] Price block text:', text.replace(/\n/g, ' | '));
    if (text.includes('?') || text.includes('Rs') || text.includes('In stock')) {
      console.log('SUCCESS: Price revealed!');
      break;
    }
  }

  await browser.close();
})();
