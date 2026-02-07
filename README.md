# auction-scraper

A CLI tool that lets non-technical users **train** web scrapers for auction/listing websites by visually clicking elements in a real browser, then **replay** those scrapers to extract structured search results on demand.

Trained scrapers are saved as JSON profiles and can be invoked programmatically or via the CLI. This module is the foundation layer for **AuctionAlert** (see [Roadmap](#roadmap)).

## Requirements

- **Node.js >= 18** (tested on 20.x)
- **Google Chrome or Chromium** installed on the machine (the tool auto-detects the browser path)
- A graphical desktop environment (training requires a visible browser window)

## Installation

```bash
git clone <repo-url>
cd auction-scraper
npm install
```

To make the `auction-scraper` command available globally:

```bash
npm link
```

## Quick Start

```bash
# 1. Train a scraper for an auction site
node src/cli.js train https://www.ebay.com

# 2. Search using the trained scraper
node src/cli.js search ebay.com "vintage watch"

# 3. List all trained scrapers
node src/cli.js list
```

## Architecture

```
auction-scraper/
  src/
    cli.js               # CLI entry point (commander.js). Commands: train, search, list, show, delete
    trainer.js            # Interactive training engine. Opens Chromium, uses CDP inspect mode
    scraper.js            # Replay engine. Loads a profile, runs a headless search, extracts listings
    selector-helpers.js   # Pure ES5 selector extraction functions (CSS selector generation, generalization)
    profile-store.js      # JSON file persistence for scraper profiles (~/.auction-scraper/profiles/)
    browser-finder.js     # Auto-detects Chrome/Chromium on Linux, macOS, Windows
    injected-overlay.js   # (Legacy) Page-injected overlay script. Kept for reference; not used in v4+
  package.json
```

### How Training Works

Training uses **Chrome DevTools Protocol (CDP)** directly rather than injecting JavaScript into pages. This is critical because modern sites (eBay, etc.) enforce strict Content Security Policies that block injected scripts.

The training flow:

1. **Phase 1 (terminal):** All text questions are asked before the browser opens -- search query, submit method, wait time, max pages. This avoids focus conflicts between the browser and terminal.

2. **Phase 2 (browser):** The browser opens and navigates to the target site. For each field the user needs to identify, the tool activates `Overlay.setInspectMode` (the same highlight system Chrome DevTools uses). The user hovers to see elements highlighted in red, and clicks to select.

3. **Selector extraction:** When the user clicks an element, CDP resolves the backend DOM node. `Runtime.callFunctionOn` runs the selector-generation code directly on that node (bypassing CSP entirely). The code tries, in priority order:
   - `#id` if unique
   - `tag[data-*="value"]` if unique
   - `tag[name="value"]` if unique
   - `input[type="value"]` if unique
   - `tag[aria-label="value"]` if unique
   - `tag[role="value"]` if unique
   - `nth-of-type` path (walking up the DOM until a unique path is found)

4. **Selector generalization:** For listing fields (title, price, image, etc.), the tool generalizes a specific selector (matching one listing) into a selector matching all listings. It walks up the DOM to find a repeating container (an ancestor whose parent has >= 3 same-tag siblings), then builds a relative path from that container to the target element.

5. **Profile saved** to `~/.auction-scraper/profiles/<domain>.json`.

### How Scraping Works

The replay engine (`scraper.js`):

1. Launches headless Chromium via `puppeteer-core`
2. Navigates to the site's URL from the profile
3. Types the search query into the recorded search box selector
4. Submits via Enter or button click (as configured)
5. Waits the configured delay for results to load
6. Uses `document.querySelectorAll()` with the generalized selectors to extract all listings
7. Optionally paginates by clicking the next-page selector
8. Returns structured JSON

### Profile Format

```json
{
  "siteKey": "ebay.com",
  "name": "ebay.com",
  "url": "https://www.ebay.com",
  "selectors": {
    "searchBox": "#gh-ac",
    "searchSubmit": "#gh-btn",
    "image": ".s-item .s-item__image img",
    "title": ".s-item .s-item__title",
    "price": ".s-item .s-item__price",
    "location": ".s-item .s-item__location",
    "link": ".s-item a.s-item__link",
    "nextPage": "a.pagination__next"
  },
  "submitViaEnter": true,
  "waitAfterSearch": 3,
  "maxPages": 3,
  "trainedAt": "2026-02-07T..."
}
```

## CLI Reference

### `train <url>`

Interactively train a scraper for a website.

```bash
node src/cli.js train https://www.ebay.com
```

The tool asks text questions first, then opens a browser. In the browser, elements highlight as you hover. Click to select. Press Escape to skip optional fields (image, location, pagination).

### `search <site> <query>`

Run a trained scraper and return results.

```bash
# JSON output (default)
node src/cli.js search ebay.com "vintage watch"

# Table format (human-readable)
node src/cli.js search ebay.com "vintage watch" -f table

# CSV format
node src/cli.js search ebay.com "vintage watch" -f csv

# Write to file
node src/cli.js search ebay.com "vintage watch" -f csv -o results.csv

# Limit to 5 pages
node src/cli.js search ebay.com "vintage watch" -p 5

# Show the browser while scraping (useful for debugging)
node src/cli.js search ebay.com "vintage watch" --no-headless

# Quiet mode (no spinner, just results)
node src/cli.js search ebay.com "vintage watch" -q
```

**Output structure (JSON):**

```json
{
  "query": "vintage watch",
  "site": "ebay.com",
  "scrapedAt": "2026-02-07T...",
  "totalResults": 48,
  "pages": 3,
  "listings": [
    {
      "title": "Vintage Omega Seamaster 1960s",
      "price": "$1,250.00",
      "imageUrl": "https://i.ebayimg.com/...",
      "location": "New York, NY",
      "url": "https://www.ebay.com/itm/..."
    }
  ]
}
```

### `list`

List all trained scraper profiles.

```bash
node src/cli.js list
```

### `show <site>`

Display details of a trained profile including all selectors.

```bash
node src/cli.js show ebay.com
```

### `delete <site>`

Delete a trained profile.

```bash
node src/cli.js delete ebay.com
```

## When to Retrain

Scrapers break when a website changes its HTML structure. Symptoms:

- `search` returns 0 results
- Titles, prices, or other fields come back as `null`
- The selector match counts during training verification show `0 matches`

**To retrain:**

```bash
# Delete the old profile
node src/cli.js delete ebay.com

# Train again
node src/cli.js train https://www.ebay.com
```

Tips for more durable selectors:

- During training, prefer clicking elements that have visible `id` or `data-*` attributes (the selector generator will pick these up automatically)
- If a site uses React/Vue/Angular with auto-generated class names (like `_a1b2c3`), the tool filters those out and falls back to structural selectors
- If selectors break frequently, increase the `waitAfterSearch` time -- some sites lazy-load results

## Assumptions and Limitations

- **One search box per site.** The tool assumes a single search input and submit mechanism per site.
- **List-style results.** The tool assumes search results are a repeating list of items with consistent HTML structure.
- **Same-page results.** Results must appear on the page after search submission (either via navigation or dynamic loading). The tool does not handle multi-step flows (e.g., selecting a category first).
- **CSS selectors only.** The tool generates CSS selectors, not XPath. This works for the vast majority of sites but may fail on sites that render content exclusively inside Shadow DOM or iframes.
- **Desktop Chrome required for training.** Training needs a visible browser window with mouse interaction. Scraping (replay) runs headless and can run on a server.
- **No CAPTCHA handling.** If a site presents a CAPTCHA during scraping, the tool will not be able to proceed. Running with `--no-headless` allows manual CAPTCHA solving.
- **No authentication.** The tool does not handle login flows. It scrapes publicly accessible search results.

## Programmatic Usage

The scraper can be used as a Node.js library:

```js
const { search } = require("./src/scraper");

const results = await search("ebay.com", "vintage watch", {
  maxPages: 2,
  headless: true,
  quiet: true,
});

console.log(results.listings); // Array of { title, price, imageUrl, location, url }
```

## Roadmap

### AuctionAlert (Next Phase)

A web application layered on top of this scraper module:

- **User accounts** with email notification preferences
- **Keyword subscriptions** -- users define search terms and select which trained sites to monitor
- **Scheduled scraping** -- background jobs run searches at configurable intervals
- **Email alerts** -- when new results match a subscription, users receive an email with listing details
- **Site selection** -- users choose from available trained scrapers (some may be region-specific)
- **Web-based training UI** -- eventually, a browser-based alternative to the CLI training flow

The scraper module (`search()` function) serves as the data extraction layer for AuctionAlert. Profiles are shared -- a site trained once can be used by all AuctionAlert subscribers.
