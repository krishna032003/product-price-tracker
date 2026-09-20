-- Supabase PostgreSQL Schema for Product Price Tracker

-- Table for tracking products
CREATE TABLE IF NOT EXISTS public.tracked_products (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    product_id text NOT NULL,       -- E.g., '237'
    slug text NOT NULL,             -- E.g., 'copperpot-sneaker-air'
    name text NOT NULL,             -- Product name
    brand text,                     -- Brand name
    is_tracking boolean DEFAULT true,
    added_at timestamp with time zone DEFAULT now(),
    last_scraped_at timestamp with time zone,
    latest_price numeric,
    latest_stock_status text,
    UNIQUE(product_id)
);

-- Table for price history
CREATE TABLE IF NOT EXISTS public.price_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    tracked_product_id uuid REFERENCES public.tracked_products(id) ON DELETE CASCADE,
    price numeric,
    price_raw text,                 -- Keep original string just in case, e.g., '₹ 42,900'
    stock_status text,
    scraped_at timestamp with time zone DEFAULT now()
);

-- Table for scrape logs
CREATE TABLE IF NOT EXISTS public.scrape_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    tracked_product_id uuid REFERENCES public.tracked_products(id) ON DELETE CASCADE,
    attempted_at timestamp with time zone DEFAULT now(),
    status text NOT NULL,           -- 'SUCCESS', 'RETRIED', 'FAILED'
    duration_ms integer,
    error_message text,
    scraped_price_raw text,
    scraped_stock_status text
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_price_history_product_id ON public.price_history(tracked_product_id);
CREATE INDEX IF NOT EXISTS idx_scrape_logs_product_id ON public.scrape_logs(tracked_product_id);

-- Enable Row Level Security (RLS)
ALTER TABLE public.tracked_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_logs ENABLE ROW LEVEL SECURITY;

-- Allow public read & write access for anon / frontend & backend service
CREATE POLICY "Allow all access to tracked_products" ON public.tracked_products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to price_history" ON public.price_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to scrape_logs" ON public.scrape_logs FOR ALL USING (true) WITH CHECK (true);

