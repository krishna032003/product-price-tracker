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

// Concurrency mutex lock (Single-process instance limitation)
const activeScrapes = new Set();

// Cache for mock store catalog
let catalogCache = [];
let lastCatalogFetch = 0;

/**
 * Hardened catalog fetch with timeouts, validation, and cache preservation.
 */
async function getFullCatalog() {
  const now = Date.now();
  // Return cached catalog if fresh (< 1 hour)
  if (catalogCache.length > 0 && (now - lastCatalogFetch < 3600000)) {
    return { items: catalogCache, isStale: false };
  }

  const allItems = [];
  try {
    const firstRes = await fetch('https://demo.inelabteamdev.com/api/catalog?page=1&pageSize=60', {
      signal: AbortSignal.timeout(10000)
    });
    if (!firstRes.ok) throw new Error(`Catalog API returned HTTP ${firstRes.status}`);

    const firstData = await firstRes.json();
    if (!firstData || !Array.isArray(firstData.items)) {
      throw new Error('Invalid catalog API payload structure');
    }
    allItems.push(...firstData.items);

    const totalItems = typeof firstData.total === 'number' ? firstData.total : 1000;
    const pageSize = typeof firstData.pageSize === 'number' ? firstData.pageSize : 60;
    const totalPages = Math.ceil(totalItems / pageSize);

    for (let p = 2; p <= totalPages; p++) {
      const pageRes = await fetch(`https://demo.inelabteamdev.com/api/catalog?page=${p}&pageSize=60`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!pageRes.ok) throw new Error(`Catalog page ${p} returned HTTP ${pageRes.status}`);
      const pageData = await pageRes.json();
      if (!pageData || !Array.isArray(pageData.items)) {
        throw new Error(`Invalid payload structure on page ${p}`);
      }
      allItems.push(...pageData.items);
    }

    if (allItems.length >= totalItems) {
      catalogCache = allItems;
      lastCatalogFetch = now;
      console.log(`[Catalog] Successfully cached complete catalog: ${catalogCache.length} products.`);
      return { items: catalogCache, isStale: false };
    } else {
      throw new Error(`Incomplete catalog fetch: expected ${totalItems}, got ${allItems.length}`);
    }
  } catch (err) {
    console.error('[Catalog Refresh Failure]:', err.message);
    if (catalogCache.length > 0) {
      console.warn('[Catalog] Preserving previous complete cache on refresh failure.');
      return { items: catalogCache, isStale: true, error: err.message };
    }
    throw err;
  }
}

/**
 * Shared persistence helper with explicit error distinction and partial persistence detection.
 */
async function persistScrapeResult(product, scrapeResult) {
  const numericPrice = scrapeResult.numericPrice;
  if (!numericPrice || !Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new Error(`Invalid extracted price: "${scrapeResult.priceRaw}"`);
  }

  // 1. Insert into price history
  const { error: histErr } = await supabase.from('price_history').insert({
    tracked_product_id: product.id,
    price: numericPrice,
    price_raw: scrapeResult.priceRaw,
    stock_status: scrapeResult.stockStatus
  });
  if (histErr) {
    throw new Error(`Persistence failure (price_history): ${histErr.message}`);
  }

  // 2. Update tracked product header
  const { error: prodErr } = await supabase.from('tracked_products').update({
    last_scraped_at: new Date().toISOString(),
    latest_price: numericPrice,
    latest_stock_status: scrapeResult.stockStatus
  }).eq('id', product.id);
  if (prodErr) {
    // History saved, but product header failed
    throw new Error(`Partial persistence: price history saved, but product record update failed: ${prodErr.message}`);
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', supabase: !!supabase });
});

// Scheduled Scrape Route
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
      // Concurrency lock check
      if (activeScrapes.has(product.id)) {
        console.log(`[Cron Scrape] Skipping ${product.name}, scrape already in progress.`);
        results.push({ productId: product.product_id, status: 'SKIPPED', reason: 'Already in progress' });
        continue;
      }

      activeScrapes.add(product.id);
      console.log(`[Cron Scrape] Starting for: ${product.name} (ID: ${product.product_id})`);

      // Telemetry log callback (isolated so log errors don't restart or mask scraper)
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
          if (logErr) console.error('[Cron Telemetry Log Error]:', logErr.message);
        } catch (logErr) {
          console.error('[Cron Telemetry Write Exception]:', logErr.message);
        }
      };

      try {
        const targetUrl = `https://demo.inelabteamdev.com/product/${product.product_id}`;
        const scrapeResult = await runScraper(targetUrl, product.product_id, false, onAttempt);
        await persistScrapeResult(product, scrapeResult);
        results.push({ productId: product.product_id, status: 'SUCCESS', price: scrapeResult.numericPrice });
      } catch (err) {
        console.error(`[Cron Scrape] Failed for ${product.name}:`, err.message);
        results.push({ productId: product.product_id, status: 'FAILED', error: err.message });
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

// Manual On-Demand Scrape Route
app.post('/api/products/:id/scrape', async (req, res) => {
  const { id } = req.params;
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  let product = null;
  try {
    const { data, error } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(`Database error: ${error.message}`);
    product = data;

    if (!product) {
      const q = await supabase
        .from('tracked_products')
        .select('*')
        .eq('product_id', id)
        .maybeSingle();
      if (q.error) throw new Error(`Database error: ${q.error.message}`);
      product = q.data;
    }
  } catch (findErr) {
    return res.status(500).json({ error: findErr.message });
  }

  if (!product) {
    return res.status(404).json({ error: 'Tracked product not found' });
  }

  // Concurrency lock check
  if (activeScrapes.has(product.id)) {
    return res.status(409).json({ error: `Scrape already in progress for ${product.name}` });
  }

  activeScrapes.add(product.id);
  console.log(`[Manual Scrape] Starting for ${product.name} (ID: ${product.product_id})`);

  // Isolated telemetry logger
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
      if (logErr) console.error('[Manual Telemetry Log Error]:', logErr.message);
    } catch (logErr) {
      console.error('[Manual Telemetry Write Exception]:', logErr.message);
    }
  };

  let scrapeResult = null;
  let scrapeError = null;

  try {
    const targetUrl = `https://demo.inelabteamdev.com/product/${product.product_id}`;
    scrapeResult = await runScraper(targetUrl, product.product_id, false, onAttempt);
    await persistScrapeResult(product, scrapeResult);

    return res.json({
      success: true,
      message: 'Product scraped and persisted successfully',
      data: {
        ...product,
        latest_price: scrapeResult.numericPrice,
        latest_stock_status: scrapeResult.stockStatus,
        last_scraped_at: new Date().toISOString()
      },
      scrapeResult
    });
  } catch (err) {
    scrapeError = err.message;
    console.error('[Manual Scrape Route Error]:', scrapeError);
    return res.status(500).json({ success: false, error: scrapeError });
  } finally {
    activeScrapes.delete(product.id);
  }
});

// Catalog Search Route
app.get('/api/catalog', async (req, res) => {
  try {
    const { items, isStale, error } = await getFullCatalog();
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
      isStale: isStale || false,
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
