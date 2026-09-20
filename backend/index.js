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
 * Persists scrape result with rollback compensation on partial failure.
 * If tracked_products update fails after price_history insert, the history entry is deleted
 * to prevent orphaned duplicate rows when scraping is retried.
 */
async function persistScrapeResult(product, scrapeResult) {
  const numericPrice = scrapeResult.numericPrice;
  if (!numericPrice || !Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new Error(`Invalid extracted price: "${scrapeResult.priceRaw}"`);
  }

  // 1. Insert into price history and capture the new record ID
  const { data: histData, error: histErr } = await supabase
    .from('price_history')
    .insert({
      tracked_product_id: product.id,
      price: numericPrice,
      price_raw: scrapeResult.priceRaw,
      stock_status: scrapeResult.stockStatus
    })
    .select('id')
    .single();

  if (histErr) {
    throw new Error(`Persistence failure (price_history insert failed): ${histErr.message}`);
  }

  // 2. Update tracked product header
  const { error: prodErr } = await supabase
    .from('tracked_products')
    .update({
      last_scraped_at: new Date().toISOString(),
      latest_price: numericPrice,
      latest_stock_status: scrapeResult.stockStatus
    })
    .eq('id', product.id);

  if (prodErr) {
    // Roll back history insert to prevent orphaned duplicate history on subsequent retry
    if (histData && histData.id) {
      console.warn(`[Compensating Rollback] Deleting price_history row ${histData.id} due to product update failure`);
      await supabase.from('price_history').delete().eq('id', histData.id).catch(() => {});
    }
    throw new Error(`Persistence failure (product header update failed; history insert was rolled back): ${prodErr.message}`);
  }

  return { historyId: histData?.id, status: 'COMMITTED' };
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
      if (activeScrapes.has(product.id)) {
        console.log(`[Cron Scrape] Skipping ${product.name}, scrape already in progress.`);
        results.push({ productId: product.product_id, status: 'SKIPPED', reason: 'Already in progress' });
        continue;
      }

      activeScrapes.add(product.id);
      console.log(`[Cron Scrape] Starting for: ${product.name} (ID: ${product.product_id})`);

      let logErrorWarning = null;
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
          if (logErr) {
            logErrorWarning = logErr.message;
            console.error('[Cron Log Insert Error]:', logErr.message);
          }
        } catch (logErr) {
          logErrorWarning = logErr.message;
          console.error('[Cron Telemetry Write Exception]:', logErr.message);
        }
      };

      try {
        const targetUrl = `https://demo.inelabteamdev.com/product/${product.product_id}`;
        const scrapeResult = await runScraper(targetUrl, product.product_id, false, onAttempt);
        await persistScrapeResult(product, scrapeResult);

        results.push({
          productId: product.product_id,
          status: 'SUCCESS',
          price: scrapeResult.numericPrice,
          auditLogging: logErrorWarning ? `DEGRADED: ${logErrorWarning}` : 'COMPLETE'
        });
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

  if (activeScrapes.has(product.id)) {
    return res.status(409).json({ error: `Scrape already in progress for ${product.name}` });
  }

  activeScrapes.add(product.id);
  console.log(`[Manual Scrape] Starting for ${product.name} (ID: ${product.product_id})`);

  let logErrorWarning = null;
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
      if (logErr) {
        logErrorWarning = logErr.message;
        console.error('[Manual Log Insert Error]:', logErr.message);
      }
    } catch (logErr) {
      logErrorWarning = logErr.message;
      console.error('[Manual Telemetry Write Exception]:', logErr.message);
    }
  };

  let scrapeResult = null;
  try {
    const targetUrl = `https://demo.inelabteamdev.com/product/${product.product_id}`;
    scrapeResult = await runScraper(targetUrl, product.product_id, false, onAttempt);
    await persistScrapeResult(product, scrapeResult);

    return res.json({
      success: true,
      extraction: 'SUCCESS',
      persistence: 'COMMITTED',
      auditLogging: logErrorWarning ? `DEGRADED: ${logErrorWarning}` : 'COMPLETE',
      data: {
        ...product,
        latest_price: scrapeResult.numericPrice,
        latest_stock_status: scrapeResult.stockStatus,
        last_scraped_at: new Date().toISOString()
      },
      scrapeResult
    });
  } catch (err) {
    console.error('[Manual Scrape Route Error]:', err.message);
    return res.status(500).json({
      success: false,
      extraction: scrapeResult ? 'SUCCESS' : 'FAILED',
      persistence: 'FAILED',
      error: err.message
    });
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


// Health check alias
app.get('/health', (req, res) => res.json({ ok: true, status: 'ok', supabase: !!supabase }));

// Codex Catalog search endpoint
app.get('/api/catalog/search', async (req, res) => {
  try {
    const { items } = await getFullCatalog();
    const q = req.query.q ? req.query.q.toLowerCase().trim() : '';
    const filtered = items.filter(item => 
      (item.name && item.name.toLowerCase().includes(q)) || 
      (item.brand && item.brand.toLowerCase().includes(q)) ||
      (item.slug && item.slug.toLowerCase().includes(q)) ||
      (item.id && String(item.id) === q)
    );
    res.json(filtered.slice(0, 50));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Products list endpoint
app.get('/api/products', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  try {
    const { data: products, error } = await supabase
      .from('tracked_products')
      .select('*, price_history(price, stock_status, scraped_at)')
      .eq('is_tracking', true)
      .order('added_at', { ascending: false });
    if (error) throw error;

    const formatted = products.map(p => {
      const history = (p.price_history || []).filter(h => Number(h.price) > 50);
      const latestHist = history.sort((a, b) => new Date(b.scraped_at) - new Date(a.scraped_at))[0];
      const stockNum = latestHist?.stock_status ? parseInt(latestHist.stock_status.match(/\d+/)?.[0] || '0') : 0;
      return {
        id: p.id,
        catalog_id: Number(p.product_id) || p.product_id,
        name: p.name,
        brand: p.brand,
        category: 'General',
        sku: `SKU-${p.product_id}`,
        active: p.is_tracking,
        created_at: p.added_at,
        latest: latestHist ? {
          price: latestHist.price,
          stock: stockNum,
          scraped_at: latestHist.scraped_at
        } : (p.latest_price && p.latest_price > 50 ? {
          price: p.latest_price,
          stock: p.latest_stock_status ? parseInt(p.latest_stock_status.match(/\d+/)?.[0] || '0') : 0,
          scraped_at: p.last_scraped_at
        } : null)
      };
    });
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Product track endpoint
app.post('/api/products', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  try {
    const catalogId = req.body.catalogId || req.body.product_id;
    if (!catalogId) return res.status(400).json({ error: 'catalogId is required' });

    const { items } = await getFullCatalog();
    const item = items.find(i => String(i.id) === String(catalogId));
    if (!item) return res.status(404).json({ error: 'Product not found in catalog' });

    const row = {
      product_id: String(item.id),
      slug: item.slug || `product-${item.id}`,
      name: item.name,
      brand: item.brand || null,
      is_tracking: true
    };

    const { data, error } = await supabase
      .from('tracked_products')
      .upsert(row, { onConflict: 'product_id' })
      .select()
      .single();

    if (error) throw error;

    // Auto-scrape in the background immediately
    const targetUrl = `https://demo.inelabteamdev.com/product/${item.id}`;
    runScraper(targetUrl, item.id, false, () => {}).then(res => persistScrapeResult(data, res)).catch(e => console.error("Initial scrape error:", e.message));

    res.status(201).json({
      id: data.id,
      catalog_id: Number(data.product_id) || data.product_id,
      name: data.name,
      brand: data.brand,
      category: 'General',
      sku: `SKU-${data.product_id}`,
      active: true,
      created_at: data.added_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Product detail endpoint
app.get('/api/products/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  try {
    const { id } = req.params;
    let { data: product } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!product) {
      const q = await supabase.from('tracked_products').select('*').eq('product_id', id).maybeSingle();
      product = q.data;
    }
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const [{ data: history }, { data: logs }] = await Promise.all([
      supabase.from('price_history').select('*').eq('tracked_product_id', product.id).order('scraped_at', { ascending: true }),
      supabase.from('scrape_logs').select('*').eq('tracked_product_id', product.id).order('attempted_at', { ascending: false }).limit(50)
    ]);

    const formattedHistory = (history || []).map(h => ({
      id: h.id,
      product_id: product.id,
      price: h.price,
      stock: h.stock_status ? parseInt(h.stock_status.match(/\d+/)?.[0] || '0') : 0,
      scraped_at: h.scraped_at
    }));

    const formattedLogs = (logs || []).map(l => ({
      id: l.id,
      product_id: product.id,
      status: (l.status || '').toLowerCase(),
      created_at: l.attempted_at,
      message: l.error_message || `Captured ${l.scraped_price_raw || ''}; ${l.scraped_stock_status || ''}`
    }));

    res.json({
      product: {
        id: product.id,
        catalog_id: Number(product.product_id) || product.product_id,
        name: product.name,
        brand: product.brand,
        category: 'General',
        sku: `SKU-${product.product_id}`
      },
      history: formattedHistory,
      logs: formattedLogs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
