const { runScraper } = require('./scraper');

async function test() {
  const url = process.argv[2] || 'https://demo.inelabteamdev.com/product/237';
  console.log(`Running headed scraper test on: ${url}`);
  console.log('You should see the browser open and the mouse hover over the price area to trigger the "Reveal price" button.');
  
  try {
    const result = await runScraper(url, true);
    console.log('\n--- SCRAPE SUCCESS ---');
    console.log('Result:', result);
    console.log('----------------------\n');
  } catch (err) {
    console.error('\n--- SCRAPE FAILED ---');
    console.error(err);
    console.error('----------------------\n');
  }
}

test();
