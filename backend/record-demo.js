const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runDemo() {
  const outputDir = path.resolve(__dirname, '../recordings');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log('--- Starting Playwright Video Demo Recording ---');
  console.log(`Saving recording to: ${outputDir}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 150
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: outputDir,
      size: { width: 1280, height: 720 }
    }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  async function scrapeProduct(id) {
    console.log(`\nNavigating to product ${id}...`);
    await page.goto(`https://demo.inelabteamdev.com/product/${id}`, { waitUntil: 'domcontentloaded' });
    await delay(1500);

    // Handle cookie banner
    const cookieBtn = page.getByRole('button', { name: /accept/i });
    if (await cookieBtn.isVisible().catch(() => false)) {
      await cookieBtn.click().catch(() => {});
      await delay(800);
    }

    // Find and hover over the price reveal area
    console.log('Simulating mouse movements over price unlock area...');
    const revealBtn = page.getByRole('button', { name: /reveal price/i });
    await revealBtn.waitFor({ state: 'visible', timeout: 15000 });
    const box = await revealBtn.boundingBox();
    if (box) {
      for (let s = 0; s < 12; s++) {
        await page.mouse.move(box.x + 10 + s * 5, box.y + 10 + (s % 3) * 4);
        await delay(120);
      }
    }
    await delay(1000);

    console.log('Clicking "Reveal price"...');
    await revealBtn.click();

    // Check for success or error retry
    const outcome = await Promise.race([
      page.locator('.price-success').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'success'),
      page.locator('.price-block button:has-text("Try again")').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'retry')
    ]);

    if (outcome === 'retry') {
      console.log('Transient error detected! Triggering automatic retry...');
      await delay(1000);
      const tryAgain = page.locator('.price-block button:has-text("Try again")');
      if (await tryAgain.count() > 0) {
        await tryAgain.first().click();
      }
      await page.locator('.price-success').waitFor({ state: 'visible', timeout: 15000 });
    }

    await delay(2000);
    const quote = await page.locator('.price-success').innerText();
    console.log(`Product ${id} scraped successfully!`);
    await delay(3000);
  }

  try {
    // 1. First Product demonstration
    await scrapeProduct('1');

    // 2. Second Product demonstration
    await scrapeProduct('237');

    // 3. Third Product demonstration
    await scrapeProduct('5');

    console.log('\nDemonstration complete! Finalizing video file...');
  } catch (err) {
    console.error('Demo error:', err);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
    console.log('Video recording finalized!');
  }
}

runDemo();
