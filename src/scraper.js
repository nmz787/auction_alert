/**
 * Scraper replay engine.
 * Takes a saved profile + search query and returns structured results.
 */
const puppeteer = require("puppeteer-core");
const chalk = require("chalk");
const ora = require("ora");
const { loadProfile } = require("./profile-store");
const { findBrowser } = require("./browser-finder");

/**
 * Extract text content from an element, cleaning up whitespace.
 */
function cleanText(text) {
  if (!text) return null;
  return text.replace(/\s+/g, " ").trim() || null;
}

/**
 * Run a search using a trained scraper profile.
 *
 * @param {string} siteKeyOrUrl - site key or URL to look up the profile
 * @param {string} query - search query
 * @param {object} options - { maxPages, headless, format }
 * @returns {Promise<object>} structured results
 */
async function search(siteKeyOrUrl, query, options = {}) {
  const profile = loadProfile(siteKeyOrUrl);
  if (!profile) {
    throw new Error(
      `No trained scraper found for "${siteKeyOrUrl}". ` +
        `Run: auction-scraper train <url> first.`
    );
  }

  const maxPages = options.maxPages || profile.maxPages || 3;
  const headless = options.headless !== false;

  const spinner = options.quiet ? null : ora("Launching browser...").start();

  const executablePath = findBrowser();
  if (!executablePath) {
    throw new Error(
      "No Chrome/Chromium browser found. Please install Google Chrome or Chromium."
    );
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: headless ? "new" : false,
    defaultViewport: { width: 1280, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = (await browser.pages())[0] || (await browser.newPage());

    // Set a reasonable user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    if (spinner) spinner.text = `Loading ${profile.url}...`;
    await page.goto(profile.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Type the search query
    if (spinner) spinner.text = "Entering search query...";
    await page.waitForSelector(profile.selectors.searchBox, { timeout: 10000 });
    await page.click(profile.selectors.searchBox);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.type(profile.selectors.searchBox, query, { delay: 20 });

    // Submit
    if (spinner) spinner.text = "Submitting search...";
    if (profile.submitViaEnter) {
      await page.keyboard.press("Enter");
    } else {
      await page.click(profile.selectors.searchSubmit);
    }

    // Wait for results
    try {
      await page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    } catch {
      // Dynamic loading — no navigation event
    }

    // Extra wait time configured during training
    const waitMs = (profile.waitAfterSearch || 3) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));

    if (spinner) spinner.text = "Scraping results...";

    // ── Scrape pages ────────────────────────────────────────────────
    const allListings = [];
    let currentPage = 1;

    while (currentPage <= maxPages) {
      if (spinner) spinner.text = `Scraping page ${currentPage}...`;

      const pageListings = await extractListings(page, profile);
      allListings.push(...pageListings);

      // Try pagination
      if (
        currentPage < maxPages &&
        profile.selectors.nextPage
      ) {
        const hasNext = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el && !el.disabled && el.offsetParent !== null;
        }, profile.selectors.nextPage);

        if (!hasNext) break;

        await page.click(profile.selectors.nextPage);
        try {
          await page.waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
        await new Promise((r) => setTimeout(r, waitMs));
        currentPage++;
      } else {
        break;
      }
    }

    if (spinner) spinner.succeed(`Found ${allListings.length} listings`);

    return {
      query,
      site: profile.siteKey,
      scrapedAt: new Date().toISOString(),
      totalResults: allListings.length,
      pages: currentPage,
      listings: allListings,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Extract listing data from the current page using the profile's selectors.
 */
async function extractListings(page, profile) {
  const sel = profile.selectors;

  return page.evaluate(
    ({ titleSel, priceSel, imageSel, locationSel, linkSel }) => {
      function cleanText(text) {
        if (!text) return null;
        return text.replace(/\s+/g, " ").trim() || null;
      }

      // Find all title elements (these define the number of listings)
      const titleEls = titleSel
        ? Array.from(document.querySelectorAll(titleSel))
        : [];
      const priceEls = priceSel
        ? Array.from(document.querySelectorAll(priceSel))
        : [];
      const imageEls = imageSel
        ? Array.from(document.querySelectorAll(imageSel))
        : [];
      const locationEls = locationSel
        ? Array.from(document.querySelectorAll(locationSel))
        : [];
      const linkEls = linkSel
        ? Array.from(document.querySelectorAll(linkSel))
        : [];

      const count = titleEls.length;
      const listings = [];

      for (let i = 0; i < count; i++) {
        const title = titleEls[i] ? cleanText(titleEls[i].textContent) : null;
        const price = priceEls[i] ? cleanText(priceEls[i].textContent) : null;

        // Image: check for src on the element or an img child
        let imageUrl = null;
        if (imageEls[i]) {
          imageUrl =
            imageEls[i].src ||
            imageEls[i].querySelector("img")?.src ||
            imageEls[i].style?.backgroundImage?.match(/url\(["']?(.+?)["']?\)/)?.[1] ||
            null;
        }

        const location = locationEls[i]
          ? cleanText(locationEls[i].textContent)
          : null;

        // Link: check href on the element or closest <a>
        let url = null;
        if (linkEls[i]) {
          url =
            linkEls[i].href ||
            linkEls[i].closest("a")?.href ||
            linkEls[i].querySelector("a")?.href ||
            null;
        }

        if (title || price) {
          listings.push({
            title,
            price,
            imageUrl,
            location,
            url,
          });
        }
      }

      return listings;
    },
    {
      titleSel: sel.title,
      priceSel: sel.price,
      imageSel: sel.image,
      locationSel: sel.location,
      linkSel: sel.link,
    }
  );
}

module.exports = { search };
