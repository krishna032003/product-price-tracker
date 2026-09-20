# PricePulse - E-Commerce Price Tracker & Scraper

A production-ready full-stack web application designed for the **INE Software Engineer Intern Assignment**. It automates price tracking and stock monitoring from the mock e-commerce store with automated anti-bot bypass, real-time analytics, and headless cloud execution.

## 🚀 Live Deployments & Demo

* **Live Web App (Vercel)**: [https://frontend-seven-indol-j1fblp1x0q.vercel.app](https://frontend-seven-indol-j1fblp1x0q.vercel.app)
* **Live API & Headless Scraper (Render)**: [https://pulse-price-tracker-api.onrender.com](https://pulse-price-tracker-api.onrender.com)
* **GitHub Repository**: [https://github.com/krishna032003/product-price-tracker](https://github.com/krishna032003/product-price-tracker)
* **Headed Scraper Demo Video**: Located in [
ecordings/headed-scraper-demo.webm](./recordings/headed-scraper-demo.webm) in this repo.

---

## 🛠 Tech Stack

* **Frontend**: React 18, Vite, Lucide Icons, Recharts, Glassmorphism UI
* **Backend**: Node.js, Express, Playwright Chromium Engine
* **Database & Auth**: Supabase (PostgreSQL with real-time support)
* **Hosting**: Vercel (Frontend), Render (Backend & Headless Browser)

---

## ✨ Features & Assignment Requirements Met

1. **Robust Anti-Bot Bypass**:
   - Overcomes dynamic lock screens where the unlock button remains disabled until human-like mouse movement and cursor interaction are detected.
   - Handles multi-step DOM changes, delays, and dynamic DOM rendering.

2. **Accurate Price & Stock Extraction**:
   - Parses complex text formats (e.g., currency symbols, spaces, formatted numbers, stock statuses).
   - Inserts clean numeric pricing alongside raw scraped strings into Supabase.

3. **Real-time Price Trends & History**:
   - Visualizes price fluctuations using Recharts.
   - Comprehensive audit log of every scrape attempt with duration, status, and raw payload data.

4. **On-Demand & Automated Cron Scraping**:
   - **⚡ Scrape Now**: Triggers instant cloud scraping directly from the dashboard.
   - **Scheduled Cron**: Authenticated /api/cron/scrape endpoint ready for external triggers (cron-job.org / GitHub Actions).

5. **Headed Browser Demonstration**:
   - Includes full video proof (
ecordings/headed-scraper-demo.webm) demonstrating the scraper launching a visible Chromium browser, bypassing the anti-bot lock, and parsing the price in real time.

---

## 💻 Local Setup & Development

### 1. Prerequisites
- Node.js (v18+)
- Playwright Chromium (
px playwright install chromium)
- Supabase account & project

### 2. Backend Setup
`ash
cd backend
npm install
npx playwright install chromium
cp .env.example .env
# Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, PORT
npm run dev
`

### 3. Frontend Setup
`ash
cd frontend
npm install
# Configure VITE_API_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm run dev
`

### 4. Running the Headed Scraper Demo
To run the scraper in visible (headed) mode and generate a video recording:
`ash
cd backend
node record-demo.js
`
The resulting video will be saved to 
ecordings/headed-scraper-demo.webm.

---

## 📡 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| GET | /api/health | Backend status & Supabase connectivity check |
| GET | /api/catalog | Paginated product search from the mock store |
| POST | /api/products/:id/scrape | On-demand scrape for a specific tracked product |
| POST | /api/cron/scrape | Protected cron job triggering scraping for all active products |
