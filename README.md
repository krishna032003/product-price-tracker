# PricePulse - Product Price Tracker (Web Scraping)

A full-stack web application built for the **INE Software Engineer Intern Assignment**. It tracks product prices and stock availability from the INE mock store (`demo.inelabteamdev.com`) on an automated schedule with anti-bot handling, retry visibility, and historical trends.

---

## 🔗 Live Deployments & Code

- **Live Web App (Frontend)**: [https://frontend-seven-indol-j1fblp1x0q.vercel.app](https://frontend-seven-indol-j1fblp1x0q.vercel.app)
- **Live Backend API**: [https://pulse-price-tracker-api.onrender.com](https://pulse-price-tracker-api.onrender.com)
  - Health check: `https://pulse-price-tracker-api.onrender.com/api/health`
- **GitHub Repository**: [https://github.com/krishna032003/product-price-tracker](https://github.com/krishna032003/product-price-tracker)
- **Headed Scraper Demo Video**: Stored in [`recordings/headed-scraper-demo.webm`](./recordings/headed-scraper-demo.webm) (and viewable locally via `node backend/record-demo.js`).

---

## 🛠 Tech Stack

- **Frontend**: React (Vite), Lucide Icons, Recharts (deployed on Vercel)
- **Backend**: Node.js, Express, Playwright Chromium (deployed on Render)
- **Database**: Supabase (PostgreSQL with Row Level Security)
- **Scheduling**: 2-hour cron via GitHub Actions (`.github/workflows/scrape-cron.yml`) and compatible with `cron-job.org`

---

## ⚙️ Environment Variables

### Backend (`backend/.env`)
| Variable | Description | Example / Production Value |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Supabase project URL | `https://hpuunqsufpuecolqntbu.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role secret | (Found in Supabase Project Settings -> API) |
| `CRON_SECRET` | Secret token to authorize scheduled runs | `my-super-secret-cron-key` |
| `PORT` | Local or Render web port | `3001` (local) / `10000` (Render) |
| `PLAYWRIGHT_BROWSERS_PATH` | Browser binary location | `0` (installs into `node_modules` to persist on Render) |

### Frontend (`frontend/.env`)
| Variable | Description | Example / Production Value |
| :--- | :--- | :--- |
| `VITE_API_URL` | Backend API base URL | `https://pulse-price-tracker-api.onrender.com` |
| `VITE_SUPABASE_URL` | Supabase project URL | `https://hpuunqsufpuecolqntbu.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase public anonymous key | (Found in Supabase Project Settings -> API) |

---

## 💻 Local Setup & Execution

### 1. Database Setup
1. Create a Supabase project at [supabase.com](https://supabase.com).
2. Open the SQL Editor and run the queries in `supabase/schema.sql`.

### 2. Backend Setup
```bash
cd backend
npm install
npx playwright install chromium
# Configure backend/.env with your Supabase credentials
npm run dev
```

### 3. Frontend Setup
```bash
cd frontend
npm install
# Configure frontend/.env with VITE_API_URL and Supabase keys
npm run dev
```

### 4. Running the Observable (Headed) Scraper Demo
To run the scraper with a visible browser window and generate a recording:
```bash
cd backend
node record-demo.js
```
The recording will be saved to `recordings/headed-scraper-demo.webm`.

---

## ⏰ Two-Hour Scraping Schedule

Because free-tier cloud backends sleep after 15 minutes of inactivity, an internal timer (`setInterval` or `node-cron`) stops running when the instance goes idle. 

We address this with two external trigger options:

1. **GitHub Actions (Configured in Repo)**:
   - File: `.github/workflows/scrape-cron.yml`
   - Schedule: `cron: '0 */2 * * *'` (Runs every 2 hours)
   - It issues an authenticated `POST` request to `https://pulse-price-tracker-api.onrender.com/api/cron/scrape` with `Authorization: Bearer <CRON_SECRET>`.
   - When the request arrives, Render wakes up from sleep (takes ~30-45 seconds for a cold start), scrapes each tracked product sequentially, and records the logs into Supabase.

2. **Manual Configuration via cron-job.org**:
   - **URL**: `https://pulse-price-tracker-api.onrender.com/api/cron/scrape`
   - **Method**: `POST`
   - **Schedule**: Every 2 hours (`0 */2 * * *`)
   - **Request Headers**:
     - `Authorization`: `Bearer my-super-secret-cron-key`
     - `Content-Type`: `application/json`
   - **Timeout**: Set to **120 seconds** to accommodate cold start and Playwright browser launches.

### How to Verify a Scheduled Run After Render Has Gone Idle:
Open your Supabase dashboard or the web app's Scrape Logs table. Look for log entries spaced 2 hours apart with `attempted_at` timestamps occurring when no users were active on the site.

---

## 📝 Design Notes & Technical Decisions

### Why Playwright was necessary (Observed Storefront Behavior)
We tested lightweight HTTP fetching (`fetch` + HTML parsing) first, but it failed on `demo.inelabteamdev.com` for three reasons:
1. **Client-Side Rendering (CSR)**: The initial HTML returned by raw HTTP requests does not contain price or stock details. The page requires client-side JavaScript to fetch and render catalog data.
2. **Interactive Anti-Bot Lock**: Prices are hidden behind an interactive "Reveal price" button.
3. **Cursor Interaction Requirement**: The button remains disabled until actual mouse movement (`mousemove`) is registered across its bounding box. Merely dispatching an HTTP request or calling an un-hovered click does not unlock the price.
4. **Transient Error Handling**: The mock store occasionally renders a transient error block with a "Try again" button before resolving the final price.

Because of this, a real browser automation engine (Playwright Chromium) was required to calculate bounding boxes, simulate mouse paths, and wait for DOM mutations.

### Retries, Validation & Failure Handling
- **Attempt Tracking & Retry Visibility**: Every scrape attempt is recorded in the `scrape_logs` table. If attempt 1 fails and attempt 2 succeeds, attempt 1 is saved with `status: 'RETRIED'` and the error message, while attempt 2 is saved with `status: 'SUCCESS'`. Intermediate failures are never hidden.
- **Bounded Retries**: Scrapes are capped at 3 attempts with exponential backoff (1.5s, 3s) to prevent infinite loops.
- **Strict Price Validation**: Extracted price strings are stripped of non-numeric characters and parsed. If the resulting number is null, NaN, or `<= 0`, it is rejected. We log a `FAILED` attempt with the invalid string and never overwrite `latest_price` with corrupt data.
- **Stock Disambiguation**: Missing or unparseable stock text defaults to `"Unknown"`. It is only marked `"Out of stock"` if the text explicitly matches `/out of stock/i`.
- **Product Isolation**: In the scheduled cron loop, each product scrape is wrapped in an individual `try...catch`. If scraping fails for Product A, it logs the failure and continues to Product B without aborting the run.

### Limitations
- **Render Free Tier Cold Starts**: When the backend is asleep, an incoming request can take 30–45 seconds to boot the container before Playwright can launch.
- **Memory Consumption**: Headless Chromium requires ~200–300MB of RAM. On free-tier containers with 512MB RAM, products are scraped sequentially rather than in parallel to avoid Out-Of-Memory (OOM) crashes.

---

## 🤖 AI Mistakes & Corrections

During development, we used AI coding assistance for boilerplate and scaffolding. Here are four genuine mistakes made by the AI tools and how we diagnosed and corrected them:

1. **Render Playwright Browser Path**:
   - *AI Mistake*: The AI assumed running `npx playwright install chromium` during the Render build command would keep the browser ready for runtime. On Render, `/opt/render/.cache` is erased between build and runtime containers, leading to `Executable doesn't exist at ...` crashes.
   - *Correction*: We diagnosed the missing path from container logs and set `PLAYWRIGHT_BROWSERS_PATH=0`, forcing Chromium into `node_modules`, which persists into runtime.

2. **PowerShell UTF-8 BOM Corruption**:
   - *AI Mistake*: The AI generated PowerShell scripts using `Set-Content -Encoding utf8` to write JSON configs. Windows PowerShell adds a Byte Order Mark (`\xef\xbb\xbf`), causing the Vercel CLI and JSON parsers to fail with `Unexpected token` errors.
   - *Correction*: We replaced PowerShell file writers with Node.js and Python scripts that write clean UTF-8 without BOM.

3. **Vercel Mixed Content Security**:
   - *AI Mistake*: The AI initially configured the frontend to call `http://localhost:3001` or an unencrypted HTTP backend. In production on HTTPS Vercel, modern browsers block all unencrypted calls due to Mixed Content policies.
   - *Correction*: We deployed the backend to HTTPS on Render and wired the Vercel environment variable `VITE_API_URL` to the secure endpoint.

4. **Hidden Intermediate Retries**:
   - *AI Mistake*: The AI initially wrapped retries in an internal `for` loop inside `scraper.js` and only inserted a single log record at the very end. This hid transient failures when a retry succeeded, violating the assignment requirement for honest logging.
   - *Correction*: We refactored `scraper.js` to accept an `onAttempt` callback that immediately inserts every attempt (whether `RETRIED`, `FAILED`, or `SUCCESS`) into Supabase with individual timestamps and error messages.
