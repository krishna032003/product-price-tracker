require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { runScraper } = require('./scraper');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;

// Lock to prevent overlapping manual and scheduled scrapes on the same product
const activeScrapes = new Set();

// Cache for mock store catalog (1000 items) to enable instant full & partial search
let catalogCache = [];
let lastCatalogFetch = 0;

async function getFullCatalog() {
  const now = Date.now();
  if (catalogCache.length > 0 && (now - lastCatalogFetch < 3600000)) {
    return catalogCache;
  }

  const allItems = [];
  try {
    const firstRes = await fetch('https://demo.inelabteamdev.com/api/catalog?page=1&pageSize=60');
    const firstData = await firstRes.json();
    allItems.push(...(firstData.items || []));
    
    const totalPages = Math.ceil((firstData.total || 1000) / (firstData.pageSize || 60));
    const fetchPromises = [];
    for (let p = 2; p <= totalPages; p++) {
      fetchPromises.push(
        fetch(`https://demo.inelabteamdev.com/api/catalog?page=${p}&pageSize=60`)
          .then(r => r.json())
          .then(d => d.items || [])
          .catch(() => [])
      );
    }
    const otherPages = await Promise.all(fetchPromises);
    otherPages.forEach(pageItems => allItems.push(...pageItems));

    if (allItems.length > 0) {
      catalogCache = allItems;
      lastCatalogFetch = now;
      console.log(`[Catalog] Cached ${catalogCache.length} products from mock store.`);
    }
  } catch (e) {
    console.error('[Catalog Fetch Error]:', e.message);
  }
  return catalogCache.length > 0 ? catalogCache : [];
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', supabase: !!supabase });
});

// Endpoint triggered by external cron job (e.g., cron-job.org)
app.post('/api/cron/scrape', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const { data: products, error } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('is_tracking', true);

    if (error) throw new Error(`Database query failed: ${error.message}`);

    if (!products || products.length === 0) {
      return res.json({ message: 'No products to scrape' });
    }

    const results = [];

    for (const product of products) {
      // Avoid overlapping if an on-demand scrape is currently running for this product
      if (activeScrapes.has(product.id)) {
        console.log(`[Cron Scrape] Skipping ${product.name}, scrape already in progress.`);
        results.push({ productId: product.product_id, status: 'SKIPPED', reason: 'Already in progress' });
        continue;
      }

      activeScrapes.add(product.id);
      console.log(`[Cron Scrape] Starting for: ${product.name} (ID: ${product.product_id})`);

      const onAttempt = async (attemptData) => {
        try {
          const { error: logErr } = await supabase.from('scrape_logs').insert({
            tracked_product_id: product.id,
            status: attemptData.status,
            duration_ms: attemptData.durationMs,
            error_message: attemptData.errorMessage || null,
            scraped_price_raw: attemptData.priceRaw || null,
            scraped_stock_status: attemptData.stockStatus || null
          });
          if (logErr) console.error('[Cron Log Insert Error]:', logErr.message);
        } catch (logErr) {
          console.error('[Cron Scrape Log Error]:', logErr.message);
        }
      };

      try {
        const targetUrl = `https://demo.inelabteamdev.com/product/${product.product_id}`;
        const scrapeResult = await runScraper(targetUrl, false, onAttempt);

        let numericPrice = null;
        if (scrapeResult && scrapeResult.priceRaw) {
          const clean = scrapeResult.priceRaw.replace(/[^\d.]/g, '');
          if (clean) numericPrice = parseFloat(clean);
        }

        if (numericPrice && !isNaN(numericPrice) && numericPrice > 0) {
          const { error: histErr } = await supabase.from('price_history').insert({
            tracked_product_id: product.id,
            price: numericPrice,
            price_raw: scrapeResult.priceRaw,
            stock_status: scrapeResult.stockStatus
          });
          if (histErr) throw new Error(`Failed to save price history: ${histErr.message}`);

          const { error: prodErr } = await supabase.from('tracked_products').update({
            last_scraped_at: new Date().toISOString(),
            latest_price: numericPrice,
            latest_stock_status: scrapeResult.stockStatus
          }).eq('id', product.id);
          if (prodErr) throw new Error(`Failed to update tracked product: ${prodErr.message}`);

          results.push({ productId: product.product_id, status: 'SUCCESS', price: numericPrice });
        } else {
          const errText = `Invalid price parsed: "${scrapeResult ? scrapeResult.priceRaw : 'null'}"`;
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
      } finally {
        activeScrapes.delete(product.id);
      }
    }

    res.json({ message: 'Scrape job completed', results });
  } catch (error) {
    console.error('Cron fatal error:', error);
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
    let { data: product, error: findErr } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (findErr) throw new Error(`Database error: ${findErr.message}`);

    if (!product) {
      const q = await supabase
        .from('tracked_products')
        .select('*')
        .eq('product_id', id)
        .maybeSingle();
      if (q.error) throw new Error(`Database error: ${q.error.message}`);
      product = q.data;
    }

    if (!product) {
      return res.status(404).json({ error: 'Tracked product not found' });
    }

    // Check mutex lock
    if (activeScrapes.has(product.id)) {
      return res.status(409).json({ error: `Scrape already in progress for ${product.name}` });
    }

    activeScrapes.add(product.id);
    console.log(`[Manual Scrape] Starting for ${product.name} (ID: ${product.product_id})`);

    const onAttempt = async (attemptData) => {
      try {
        const { error: logErr } = await supabase.from('scrape_logs').insert({
          tracked_product_id: product.id,
          status: attemptData.status,
          duration_ms: attemptData.durationMs,
          error_message: attemptData.errorMessage || null,
          scraped_price_raw: attemptData.priceRaw || null,
          scraped_stock_status: attemptData.stockStatus || null
        });
        if (logErr) console.error('[Manual Scrape Log Insert Error]:', logErr.message);
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
    } finally {
      activeScrapes.delete(product.id);
    }

    if (!scrapeResult) {
      return res.status(502).json({
        success: false,
        error: scrapeError || 'Scraping failed after all retries'
      });
    }

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

    // Await all Supabase persistence writes and throw if errors occur
    const { error: histErr } = await supabase.from('price_history').insert({
      tracked_product_id: product.id,
      price: numericPrice,
      price_raw: scrapeResult.priceRaw,
      stock_status: scrapeResult.stockStatus
    });
    if (histErr) throw new Error(`Failed to save price history: ${histErr.message}`);

    const { error: prodErr } = await supabase.from('tracked_products').update({
      last_scraped_at: new Date().toISOString(),
      latest_price: numericPrice,
      latest_stock_status: scrapeResult.stockStatus
    }).eq('id', product.id);
    if (prodErr) throw new Error(`Failed to update tracked product: ${prodErr.message}`);

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
    activeScrapes.delete(id);
    console.error('Manual scrape route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint for frontend to search available products in mock store catalog
app.get('/api/catalog', async (req, res) => {
  try {
    const items = await getFullCatalog();
    const q = req.query.q ? req.query.q.toLowerCase().trim() : '';

    let filtered = items;
    if (q) {
      filtered = items.filter(item => 
        (item.name && item.name.toLowerCase().includes(q)) || 
        (item.brand && item.brand.toLowerCase().includes(q)) ||
        (item.slug && item.slug.toLowerCase().includes(q)) ||
        (item.id && String(item.id) === q)
      );
    }

    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const startIndex = (page - 1) * pageSize;
    const paginatedItems = filtered.slice(startIndex, startIndex + pageSize);

    res.json({
      page,
      pageSize,
      total: filtered.length,
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
