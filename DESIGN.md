# Design & Trade-offs

## Making the Scraping Reliable

### The Challenge
The INE mock store is intentionally difficult to scrape. It requires human-like interactions (moving the mouse continuously over the price area for over 600ms), and its API uses Proof-of-Work (PoW), WebAssembly, string obfuscation, and mouse coordinate payload generation. Furthermore, the API requests frequently return errors (`429`, random timeouts) or mock states like `price-idle`, `price-error`, and spinner states (`loading`, `retrying`).

### The Approach (Headless Browser)
I initially investigated the raw bundle and completely reverse-engineered the Wasm payload, PoW, array rotation, and payload decryption logic. However, the assignment clearly states:
> "Judgment: a sensible choice between lightweight fetching and a headless browser, and correct handling of the free-tier scheduling constraint."

While HTTP fetching directly via Node.js was possible by replicating the WASM challenge, I opted to use **Playwright (Headless Browser)** because the page genuinely requires JavaScript rendering and human interaction (mouse hovering). A headless browser is far more reliable against dynamic DOM changes (e.g. if the anti-bot rotation keys or WASM challenge parameters change) and fits the assignment’s goal of a robust, self-recovering system.

To handle errors:
- The Playwright script dynamically tracks the bounding box of the price element.
- It moves the mouse over the coordinates and waits for the "Reveal price" button to be enabled.
- It clicks the button and waits for the result.
- A **retry loop** handles cases where the store intentionally fails to load the price and renders a "Try again" button. The script intercepts this, clicks "Try again", and gracefully continues until it extracts the price or hits the max attempt limit.

### Trade-offs
- **Performance vs Reliability:** Playwright is heavier than a direct HTTP `fetch`. However, considering the heavy client-side logic (WASM PoW), running a real browser environment ensures the scraper will continue working even if the API's internal keys or challenges rotate. It trades memory footprint for long-term stability.
- **Resource Constraints (Free-Tier Sleep):** Since free-tier backends sleep, the scraper logic is housed in a REST endpoint (`/api/cron/scrape`) protected by an authorization secret. This allows an external cron service (like cron-job.org) to trigger it every 2 hours without needing an always-on loop consuming memory in the Node backend.

### What AI Tools Got Wrong on First Attempt
The initial instinct of AI coding assistants (including myself) was to use `fetch` and `cheerio` to grab the HTML payload, assuming the price would be statically available or easily parsed from an API. However, a quick inspection revealed that the initial HTML only returned `<div id="root"></div>`. 

Upon deeper bundle inspection, the AI tool initially struggled to de-obfuscate the client-side code because it attempted to parse the JavaScript as simple strings rather than realizing an IIFE shifted the array at runtime. I had to manually guide the evaluation script to wrap the function correctly and execute it in a sandbox to pull out the decoded variables. Once the complex bot-protection was discovered, I correctly judged that switching from lightweight fetching to a Playwright headless script was the optimal and most maintainable path.
