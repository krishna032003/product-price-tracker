require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { runScraper } = require('./scraper');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client (Service Role for backend updates)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', supabase: !!supabase });
});

// Endpoint triggered by external cron job (e.g., cron-job.org / GitHub Actions)
app.post('/api/cron/scrape', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    // 1. Fetch all currently active tracked products
    const { data: products, error } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('is_tracking', true);

    if (error) throw error;

    if (!products || products.length === 0) {
      return res.json({ message: 'No products to scrape' });
    }

    const results = [];

    // 2. Scrape each product sequentially (isolated: failure of one does not block others)
    for (const product of products) {
      console.log(`[Cron Scrape] Starting for: ${product.name} (ID: ${product.product_id})`);

      // Callback to log EVERY attempt (including intermediate retries)
      const onAttempt = async (attemptData) => {
        try {
          await supabase.from('scrape_logs').insert({
            tracked_product_id: product.id,
            status: attemptData.status,
            duration_ms: attemptData.durationMs,
            error_message: attemptData.errorMessage || null,
            scraped_price_raw: attemptData.priceRaw || null,
            scraped_stock_status: attemptData.stockStatus || null
          });
        } catch (logErr) {
          console.error('[Cron Scrape Log Error]:', logErr.message);
        }
      };

      try {
        const targetUrl = `https://demo.inelabteamdev.com/product/${product.product_id}`;
        const scrapeResult = await runScraper(targetUrl, false, onAttempt);

        // Parse and validate numeric price
        let numericPrice = null;
        if (scrapeResult && scrapeResult.priceRaw) {
          const clean = scrapeResult.priceRaw.replace(/[^\d.]/g, '');
          if (clean) numericPrice = parseFloat(clean);
        }

        // Strict validation: price must be a valid positive number
        if (numericPrice && !isNaN(numericPrice) && numericPrice > 0) {
          // Record price history
          await supabase.from('price_history').insert({
            tracked_product_id: product.id,
            price: numericPrice,
            price_raw: scrapeResult.priceRaw,
            stock_status: scrapeResult.stockStatus
          });

          // Update tracked product latest status
          await supabase.from('tracked_products').update({
            last_scraped_at: new Date().toISOString(),
            latest_price: numericPrice,
            latest_stock_status: scrapeResult.stockStatus
          }).eq('id', product.id);

          results.push({ productId: product.product_id, status: 'SUCCESS', price: numericPrice });
        } else {
          // Invalid price parsed: record failure and do NOT update latest_price
          const errText = `Invalid price parsed: "${scrapeResult ? scrapeResult.priceRaw : 'null'}"`;
          console.warn(`[Cron Scrape] ${product.name}: ${errText}`);
          await supabase.from('scrape_logs').insert({
            tracked_product_id: product.id,
            status: 'FAILED',
            duration_ms: 0,
            error_message: errText,
            scraped_price_raw: scrapeResult ? scrapeResult.priceRaw : null,
            scraped_stock_status: scrapeResult ? scrapeResult.stockStatus : null
          });
          results.push({ productId: product.product_id, status: 'FAILED', error: errText });
        }

      } catch (productErr) {
        console.error(`[Cron Scrape] Failed for ${product.name}:`, productErr.message);
        results.push({ productId: product.product_id, status: 'FAILED', error: productErr.message });
        // Continues cleanly to next product
      }
    }

    res.json({ message: 'Scrape job completed', results });
  } catch (error) {
    console.error('Cron scrape fatal error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual on-demand 'Scrape Now' endpoint for a single product
app.post('/api/products/:id/scrape', async (req, res) => {
  const { id } = req.params;
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    let { data: product } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!product) {
      const q = await supabase
        .from('tracked_products')
        .select('*')
        .eq('product_id', id)
        .maybeSingle();
      product = q.data;
    }

    if (!product) {
      return res.status(404).json({ error: 'Tracked product not found' });
    }

    console.log(`[Manual Scrape] Starting for ${product.name} (ID: ${product.product_id})`);

    // Callback to log EVERY attempt to Supabase
    const onAttempt = async (attemptData) => {
      try {
        await supabase.from('scrape_logs').insert({
          tracked_product_id: product.id,
          status: attemptData.status,
          duration_ms: attemptData.durationMs,
          error_message: attemptData.errorMessage || null,
          scraped_price_raw: attemptData.priceRaw || null,
          scraped_stock_status: attemptData.stockStatus || null
        });
      } catch (logErr) {
        console.error('[Manual Scrape Log Error]:', logErr.message);
      }
    };

    let scrapeResult = null;
    let scrapeError = null;

    try {
      const targetUrl = `https://demo.inelabteamdev.com/product/${product.product_id}`;
      scrapeResult = await runScraper(targetUrl, false, onAttempt);
    } catch (err) {
      scrapeError = err.message;
    }

    if (!scrapeResult) {
      return res.status(502).json({
        success: false,
        error: scrapeError || 'Scraping failed after all retries'
      });
    }

    // Validate numeric price
    let numericPrice = null;
    if (scrapeResult.priceRaw) {
      const clean = scrapeResult.priceRaw.replace(/[^\d.]/g, '');
      if (clean) numericPrice = parseFloat(clean);
    }

    if (!numericPrice || isNaN(numericPrice) || numericPrice <= 0) {
      const invalidMsg = `Invalid price parsed: "${scrapeResult.priceRaw}"`;
      await supabase.from('scrape_logs').insert({
        tracked_product_id: product.id,
        status: 'FAILED',
        duration_ms: 0,
        error_message: invalidMsg,
        scraped_price_raw: scrapeResult.priceRaw,
        scraped_stock_status: scrapeResult.stockStatus
      });
      return res.status(502).json({ success: false, error: invalidMsg });
    }

    // Insert into price history
    await supabase.from('price_history').insert({
      tracked_product_id: product.id,
      price: numericPrice,
      price_raw: scrapeResult.priceRaw,
      stock_status: scrapeResult.stockStatus
    });

    // Update tracked product latest status
    await supabase.from('tracked_products').update({
      last_scraped_at: new Date().toISOString(),
      latest_price: numericPrice,
      latest_stock_status: scrapeResult.stockStatus
    }).eq('id', product.id);

    return res.json({
      success: true,
      message: 'Product scraped successfully',
      data: {
        ...product,
        latest_price: numericPrice,
        latest_stock_status: scrapeResult.stockStatus,
        last_scraped_at: new Date().toISOString()
      },
      scrapeResult
    });

  } catch (err) {
    console.error('Manual scrape route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint for frontend to search available products in mock store catalog
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
      items = items.filter(item => 
        (item.name && item.name.toLowerCase().includes(q)) || 
        (item.brand && item.brand.toLowerCase().includes(q))
      );
    }
    
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
