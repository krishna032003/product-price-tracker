# Product Price Tracker

A full-stack web application for tracking product prices from the INE mock store.

## Tech Stack
* **Frontend**: React (Vite)
* **Backend**: Node.js, Express, Playwright
* **Database**: Supabase (PostgreSQL)

## Setup Instructions

### 1. Database Setup (Supabase)
1. Create a new Supabase project.
2. Go to the SQL Editor and run the SQL provided in `supabase/schema.sql`.

### 2. Backend Setup
1. Navigate to the `backend` folder: `cd backend`
2. Install dependencies: `npm install`
3. Install Playwright browsers: `npx playwright install chromium`
4. Copy `.env.example` to `.env` and fill in your Supabase credentials:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   CRON_SECRET=my-super-secret-cron-key
   ```
5. Start the server: `npm run dev`

### 3. Frontend Setup
1. Navigate to the `frontend` folder: `cd frontend`
2. Install dependencies: `npm install`
3. Create a `.env` file with your backend API URL and Supabase Anon key (if querying directly):
   ```
   VITE_API_URL=http://localhost:3001
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```
4. Start the dev server: `npm run dev`

## Scheduled Scraping (Cron)
The scraping mechanism is exposed via a POST endpoint on the backend: `/api/cron/scrape`.
Because free-tier hosting services sleep, you must use an external cron service (like cron-job.org) to trigger this endpoint every 2 hours.
* **URL**: `https://your-backend.render.com/api/cron/scrape`
* **Method**: POST
* **Headers**: `Authorization: Bearer <your-CRON_SECRET>`

## Headed Mode Scraping
To run the scraper in headed mode and watch its behavior:
```bash
cd backend
npm run scrape:headed
```
This will open Chromium in a visible window with a delay (slowMo) applied, so you can observe the mouse hover over the price to unlock it, the wait for the button to enable, and the extraction of price and stock data.
