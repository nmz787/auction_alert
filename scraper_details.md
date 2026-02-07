# Scraper Implementation Details

Technical reference for reimplementing the auction-scraper training and replay system in another language, framework, or GUI.

## Overview

The system has two distinct modes:

1. **Training mode** -- A human user visually identifies page elements (search box, submit button, listing title, price, etc.) by clicking them in a real browser. The system records a CSS selector for each element.
2. **Replay mode** -- Given a saved set of selectors and a search query, the system automates a headless browser to perform a search and extract structured listing data.

## Critical Design Decision: CDP-Native Training

**Do not inject JavaScript into the page for the training overlay.** This was attempted first and failed on real-world sites (eBay, etc.) because:

- Sites enforce Content Security Policy (CSP) that blocks `eval()`, inline scripts, and dynamically added `<script>` elements
- Single-page apps (SPAs) may rebuild the DOM after initial load, destroying injected elements
- `page.evaluate(string)` acts like `eval()` and is blocked by CSP
- `page.addScriptTag({ content })` creates a `<script>` element which CSP can block
- `page.evaluateOnNewDocument()` runs before CSP is enforced but the DOM doesn't exist yet, so creating UI elements fails
- Even `Runtime.evaluate` with `allowUnsafeEvalBlockedByCSP: true` may succeed at the JS level but the DOM elements can be destroyed by SPA re-renders

### What actually works: `Overlay.setInspectMode`

The working approach uses Chrome DevTools Protocol's built-in element inspection overlay:

```
CDP command: Overlay.setInspectMode
  mode: "searchForNode"
  highlightConfig: { contentColor, borderColor, paddingColor, marginColor, showInfo }
```

This activates the same blue/green/red element highlight that Chrome DevTools uses when you click the "inspect element" button. It is:

- Rendered by the browser engine itself, not by page JavaScript
- Completely immune to CSP, page navigation, DOM rebuilds, Shadow DOM, iframes
- Already familiar to developers (looks like DevTools inspect)

When the user clicks an element, CDP fires:

```
Event: Overlay.inspectNodeRequested
  backendNodeId: <number>
```

When the user presses Escape (to skip optional fields), CDP fires:

```
Event: Overlay.inspectModeCanceled
```

## Training Flow (Step by Step)

### Phase 1: Text Input (Terminal)

All questions that require keyboard input are gathered BEFORE the browser opens. This is necessary because the browser window steals keyboard focus, making terminal readline unreliable.

Questions asked:
1. Sample search query (used to load a results page for field selection)
2. Does the site submit search by pressing Enter? (Y/n)
3. Seconds to wait after search for results to load (default: 3)
4. Max pages to scrape per search (default: 3)

After this, `readline` is closed and never used again.

### Phase 2: Browser Interaction

**Setup:**
```
1. Launch Chromium (non-headless, maximized)
2. Get a CDP session: page.target().createCDPSession()
3. Enable CDP domains: DOM.enable, Overlay.enable, Runtime.enable
4. Navigate to the target URL
```

**Element picking loop** (repeated for each field):

```
For each field (searchBox, searchSubmit, image?, title, price, location?, link, nextPage?):

  1. Show instruction banner in the page via CDP Runtime.evaluate
     (a small fixed-position div -- if it fails due to CSP, it's non-critical)

  2. Call Overlay.setInspectMode with mode: "searchForNode"
     - This activates the element highlight overlay
     - highlightConfig controls colors (we use red tones)

  3. Wait for one of:
     a. Overlay.inspectNodeRequested -- user clicked an element
     b. Overlay.inspectModeCanceled -- user pressed Escape (skip, if field is optional)
     c. Timeout (2 minutes)

  4. On click (inspectNodeRequested):
     a. Call Overlay.setInspectMode with mode: "none" to deactivate
     b. Call DOM.resolveNode({ backendNodeId }) to get a Runtime object reference
     c. Call Runtime.callFunctionOn({ objectId, functionDeclaration }) where the
        function runs ON the clicked DOM node (this = the element)
     d. The function computes and returns:
        - selector (specific CSS selector for this exact element)
        - generalizedSelector (for listing fields: a selector matching ALL listings)
        - tagName, text, href, src, bounding rect

  5. Store the selector in the profile
```

**Search execution** (between step 2 and step 3 of the field picks):
```
1. page.click(searchBox selector)
2. Ctrl+A to select all existing text
3. page.type(searchBox selector, query)
4. Submit via Enter or click(searchSubmit selector)
5. Wait for navigation (with fallback timeout for SPA-style sites)
6. Wait the configured delay for results to load
```

**Profile saved** to `~/.auction-scraper/profiles/<domain>.json`.

## Selector Generation Algorithm

The selector functions are defined in `selector-helpers.js`. They are written in ES5 because they execute inside `Runtime.callFunctionOn` in the page's JavaScript context.

### `getSelector(element)` -- Specific Selector

Tries strategies in priority order. Returns the first selector that uniquely matches the element (i.e., `document.querySelectorAll(selector).length === 1`):

| Priority | Strategy | Example |
|----------|----------|---------|
| 1 | `#id` | `#gh-ac` |
| 2 | `tag[data-*="value"]` | `input[data-testid="search-input"]` |
| 3 | `tag[name="value"]` | `input[name="_nkw"]` |
| 4 | `input[type="value"]` | `input[type="search"]` |
| 5 | `tag[aria-label="value"]` | `input[aria-label="Search"]` |
| 6 | `tag[role="value"]` | `div[role="searchbox"]` |
| 7 | `buildNthChildPath()` | Structural path (see below) |

### `buildNthChildPath(element)` -- Structural Selector

Walks up the DOM tree from the element, building a `>` (direct child) selector chain. At each level:

1. Start with the tag name (lowercase)
2. Append stable class names (filtered: excludes classes matching `^[a-z]{1,2}-[a-f0-9]+$` which look auto-generated, excludes classes starting with `_`, excludes classes longer than 40 chars)
3. If the element has same-tag siblings under its parent, append `:nth-of-type(N)`
4. Prepend this segment to the path
5. Test if the path so far is unique (`querySelectorAll(path).length === 1`)
6. If unique, return early. Otherwise, continue walking up.

Example output: `div.srp-results > ul > li.s-item:nth-of-type(3) > div.s-item__info > a.s-item__link > h3.s-item__title`

### `generalizeSelector(specificSelector, element)` -- Listing Selector

Given a selector that matches ONE specific listing field (e.g., the title of the 3rd listing), produces a selector matching the SAME field across ALL listings.

Algorithm:
1. Walk up from the element to find a **repeating container** -- an ancestor whose parent has >= 3 children with the same tag name (indicating a list of items)
2. **Strategy 1:** Build `parentSelector > listItemTag relativePath` where `relativePath` is the path from the list item to the target element. Test if it matches >= 2 elements.
3. **Strategy 2:** Build `listItemTag.classes relativePath` (without the parent selector, using the list item's tag + stable classes). Test if it matches >= 2 elements.
4. If neither works, fall back to the specific selector.

Example: If the user clicks a title in the 3rd search result, the specific selector might be `li.s-item:nth-of-type(3) > ... > h3.s-item__title`. The generalized selector strips the `:nth-of-type(3)` and produces `li.s-item h3.s-item__title` which matches all listing titles.

### `cssEscape(string)`

Wraps the native `CSS.escape()` with a fallback that backslash-escapes non-word/non-hyphen characters. Required because some attribute values contain special CSS characters.

### `getStableClasses(element)`

Filters an element's class list to exclude likely-generated class names:
- Matches `^[a-z]{1,2}-[a-f0-9]+$` (e.g., `x-a1b2c3`) -- common in CSS-in-JS
- Starts with `_` (e.g., `_1a2b3c`) -- common in CSS modules
- Longer than 40 characters -- likely hashes

## Replay Engine (scraper.js)

### Search Flow

```
1. Load profile from ~/.auction-scraper/profiles/<domain>.json
2. Launch headless Chromium via puppeteer-core
3. Set user agent to a standard Chrome UA string
4. Navigate to profile.url
5. Wait for searchBox selector to appear (10s timeout)
6. Click searchBox, Ctrl+A, type query (20ms delay between keys)
7. Submit via Enter key or click searchSubmit (based on profile.submitViaEnter)
8. Wait for navigation (15s timeout, with fallback for SPAs)
9. Wait profile.waitAfterSearch seconds
10. Extract listings from current page
11. If pagination enabled and more pages needed:
    a. Check if nextPage element exists and is visible
    b. Click it, wait for navigation, wait delay
    c. Extract listings
    d. Repeat up to maxPages
12. Close browser, return structured results
```

### Extraction Logic (`extractListings`)

Runs inside `page.evaluate()` (in the page's JS context):

```javascript
// For each selector type, querySelectorAll to get all matches
titleEls  = document.querySelectorAll(profile.selectors.title)
priceEls  = document.querySelectorAll(profile.selectors.price)
imageEls  = document.querySelectorAll(profile.selectors.image)   // may be null
locationEls = document.querySelectorAll(profile.selectors.location) // may be null
linkEls   = document.querySelectorAll(profile.selectors.link)

// The number of listings = titleEls.length
// For each index i:
listings[i] = {
  title:    titleEls[i].textContent (cleaned)
  price:    priceEls[i].textContent (cleaned)
  imageUrl: imageEls[i].src || imageEls[i].querySelector("img").src || background-image URL
  location: locationEls[i].textContent (cleaned)
  url:      linkEls[i].href || linkEls[i].closest("a").href || linkEls[i].querySelector("a").href
}
```

**Assumption:** All generalized selectors return elements in the same order -- i.e., `titleEls[3]` and `priceEls[3]` belong to the same listing. This works because the selectors are generalized from the same DOM structure, so querySelectorAll returns them in document order.

**Edge case:** If a field has fewer matches than titles (e.g., some listings lack a price), the extra indices will be `undefined`, and the field will be `null` in the output.

## Profile Storage

Profiles are JSON files stored at `~/.auction-scraper/profiles/<siteKey>.json`.

`siteKey` is derived from the URL: `new URL(url).hostname.replace(/^www\./, "")` -- e.g., `https://www.ebay.com/foo` becomes `ebay.com`.

### Profile Schema

```json
{
  "siteKey": "string -- hostname-based key, used as filename",
  "name": "string -- display name (same as siteKey in current version)",
  "url": "string -- full URL to navigate to for searches",
  "selectors": {
    "searchBox": "string -- CSS selector for the search input",
    "searchSubmit": "string -- CSS selector for the search button",
    "image": "string|null -- generalized CSS selector for listing images",
    "title": "string -- generalized CSS selector for listing titles",
    "price": "string -- generalized CSS selector for listing prices",
    "location": "string|null -- generalized CSS selector for listing locations",
    "link": "string -- generalized CSS selector for listing detail links",
    "nextPage": "string|null -- CSS selector for the next-page button",
    "_imageSpecific": "string -- the specific (single-element) selector captured during training",
    "_titleSpecific": "string",
    "_priceSpecific": "string",
    "_locationSpecific": "string",
    "_linkSpecific": "string"
  },
  "submitViaEnter": "boolean -- true if search submits by pressing Enter",
  "waitAfterSearch": "number -- seconds to wait after search submission",
  "maxPages": "number -- default max pages to scrape",
  "trainedAt": "string -- ISO 8601 timestamp"
}
```

The `_*Specific` selectors are stored for debugging/retraining reference but not used during replay.

### Profile Lookup

`loadProfile(key)` tries three strategies:
1. Exact file match: `profiles/<key>.json`
2. URL-to-siteKey conversion: `profiles/<urlToSiteKey(key)>.json`
3. Partial string match against all profile filenames

## Browser Detection

`browser-finder.js` searches for Chrome/Chromium in platform-specific locations:

- **Linux:** `/usr/bin/google-chrome`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`, etc.
- **macOS:** `/Applications/Google Chrome.app/...`, Chromium.app, Brave Browser.app
- **Windows:** `Program Files\Google\Chrome\...`, `%LOCALAPPDATA%\Google\Chrome\...`
- **Fallback:** `which google-chrome`, `which chromium-browser`, etc.
- **Last resort:** Puppeteer's bundled Chromium (`require("puppeteer").executablePath()`)

## Output Format

### JSON (default)

```json
{
  "query": "search terms",
  "site": "ebay.com",
  "scrapedAt": "2026-02-07T12:00:00.000Z",
  "totalResults": 48,
  "pages": 3,
  "listings": [
    {
      "title": "string or null",
      "price": "string or null (raw text, e.g. '$1,250.00')",
      "imageUrl": "string or null (absolute URL)",
      "location": "string or null",
      "url": "string or null (absolute URL to listing detail page)"
    }
  ]
}
```

### CSV

Header row: `title,price,location,url,imageUrl`  
Values are escaped with double-quotes if they contain commas, quotes, or newlines.

### Table

Human-readable colored terminal output with listing number, title, price, location, and URL.

## Reimplementation Notes

### If building a GUI-based trainer

Replace the CLI terminal prompts with a web-based or desktop UI. The core training mechanism remains the same:

1. **You must use CDP `Overlay.setInspectMode`** for the element picker. Do not try to inject JavaScript overlays into arbitrary websites -- CSP will break it on most real-world sites.

2. The CDP session can be obtained from any Chromium automation library:
   - Python: `playwright` (via `cdp_session = page.context.new_cdp_session(page)`) or `pyppeteer`
   - Rust: `chromiumoxide` or `headless_chrome`
   - Go: `chromedp` (has native CDP support)
   - C#: `PuppeteerSharp`

3. The sequence is always:
   ```
   Enable: DOM.enable, Overlay.enable, Runtime.enable
   Activate: Overlay.setInspectMode({ mode: "searchForNode", highlightConfig: {...} })
   Wait for: Overlay.inspectNodeRequested event -> backendNodeId
   Resolve: DOM.resolveNode({ backendNodeId }) -> objectId
   Extract: Runtime.callFunctionOn({ objectId, functionDeclaration: "..." }) -> selector data
   Deactivate: Overlay.setInspectMode({ mode: "none" })
   ```

4. For Escape-to-skip on optional fields, listen for `Overlay.inspectModeCanceled`.

5. The selector generation logic (`selector-helpers.js`) is pure DOM JavaScript with no dependencies. It can run via `Runtime.callFunctionOn` in any CDP client, or be ported to any language that can traverse a DOM tree.

### If porting the replay engine

The replay engine is simpler -- it only needs:
1. A headless browser automation library (Puppeteer, Playwright, Selenium, etc.)
2. Ability to navigate, click elements, type text, and run `querySelectorAll` in the page
3. No CDP needed for replay -- standard automation APIs suffice

The key correctness requirement: the generalized selectors must return elements **in document order**, and all field selectors must return the **same number of elements** (or fewer, with null-fill for missing fields). This is guaranteed by `querySelectorAll` which always returns elements in document order.

### Price parsing

The scraper returns raw price text (e.g., `"$1,250.00"`, `"EUR 99,00"`, `"C $50.00 to C $75.00"`). Price parsing/normalization is intentionally not included in the scraper layer -- it should be handled by the consuming application (AuctionAlert) because:
- Currency formats vary by locale
- Some sites show price ranges
- Some show "bidding" vs "buy now" prices
- The text may include labels like "Free shipping"

## Upcoming: AuctionAlert Integration

This scraper module is designed to be consumed by the AuctionAlert web application:

- `search(siteKey, query, options)` is the primary programmatic API
- Profiles in `~/.auction-scraper/profiles/` are shared across all users
- AuctionAlert will call `search()` on a schedule, compare results to previous runs, and email users when new listings match their subscriptions
- Site availability (which scrapers are trained and working) will be exposed to AuctionAlert users as a site selection list
- Region-specific sites (e.g., Australian auction sites) will be tagged in the profile metadata (future field: `region`)
