require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { runScraper } = require('./scraper');

const app = express();
app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

// Ensure database connection
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', supabase: !!supabase });
});

// Endpoint triggered by external cron job (e.g., cron-job.org)
app.post('/api/cron/scrape', async (req, res) => {
  // Simple auth check for cron execution
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    // 1. Fetch all currently tracked products
    const { data: products, error } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('is_tracking', true);

    if (error) throw error;

    if (!products || products.length === 0) {
      return res.json({ message: 'No products to scrape' });
    }

    const results = [];

    // 2. Scrape each product sequentially (or use Promise.all with concurrency limits)
    for (const product of products) {
      console.log(`Starting scrape for product: ${product.name} (ID: ${product.product_id})`);
      
      const startTime = Date.now();
      let scrapeResult = null;
      let status = 'FAILED';
      let errorMessage = null;

      try {
        // Run Playwright scraper
        const targetUrl = `https://demo.inelabteamdev.com/product/${product.product_id}`;
        scrapeResult = await runScraper(targetUrl, false);
        status = 'SUCCESS';
      } catch (err) {
        console.error(`Scrape failed for ${product.name}:`, err.message);
        errorMessage = err.message;
        
        // In a real app we might retry here, but the scraper module itself handles retries
        // If it still throws, it's a hard failure
      }

      const durationMs = Date.now() - startTime;

      // 3. Log the scrape attempt
      await supabase.from('scrape_logs').insert({
        tracked_product_id: product.id,
        status: status,
        duration_ms: durationMs,
        error_message: errorMessage,
        scraped_price_raw: scrapeResult ? scrapeResult.priceRaw : null,
        scraped_stock_status: scrapeResult ? scrapeResult.stockStatus : null
      });

      // 4. If successful, update the price history and the latest product info
      if (status === 'SUCCESS' && scrapeResult) {
        // Parse the numeric price from raw string (e.g., "₹ 42,900" -> 42900)
        let numericPrice = null;
        if (scrapeResult.priceRaw) {
           const cleanPrice = scrapeResult.priceRaw.replace(/[^\d.]/g, '');
           if (cleanPrice) {
             numericPrice = parseFloat(cleanPrice);
           }
        }

        // Insert into price history
        await supabase.from('price_history').insert({
          tracked_product_id: product.id,
          price: numericPrice,
          price_raw: scrapeResult.priceRaw,
          stock_status: scrapeResult.stockStatus
        });

        // Update the tracked product's latest data
        await supabase.from('tracked_products').update({
          last_scraped_at: new Date().toISOString(),
          latest_price: numericPrice,
          latest_stock_status: scrapeResult.stockStatus
        }).eq('id', product.id);
      }

      results.push({ productId: product.product_id, status });
    }

    res.json({ message: 'Scrape job completed', results });
  } catch (error) {
    console.error('Cron scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint for frontend to search available products in the mock store catalog
// We could proxy the mock store's API here or fetch it directly on frontend.
// Let's proxy it to avoid CORS issues from the frontend directly accessing the mock store if any.
app.get('/api/catalog', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const pageSize = req.query.pageSize || 20;
    const q = req.query.q ? req.query.q.toLowerCase() : '';
    
    const response = await fetch(`https://demo.inelabteamdev.com/api/catalog?page=${page}&pageSize=1000`);
    if (!response.ok) throw new Error('Failed to fetch from mock store');
    
    const data = await response.json();
    let items = data.items || [];
    
    if (q) {
      items = items.filter(item => item.name.toLowerCase().includes(q) || item.brand.toLowerCase().includes(q));
    }
    
    // Paginate manually since we fetched all to filter
    const startIndex = (page - 1) * pageSize;
    const paginatedItems = items.slice(startIndex, startIndex + parseInt(pageSize));
    
    res.json({
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      total: items.length,
      items: paginatedItems
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
