/**
 * Interactive training engine. v4 -- CDP-native, no readline during browser phase.
 *
 * All text input is gathered BEFORE the browser opens.
 * During the browser phase, only CDP inspect-mode clicks are used.
 * Optional fields: user presses Escape in the browser to skip.
 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const chalk = require("chalk");
const ora = require("ora");
const { urlToSiteKey, saveProfile } = require("./profile-store");
const { findBrowser } = require("./browser-finder");

const SELECTOR_HELPERS = fs.readFileSync(
  path.join(__dirname, "selector-helpers.js"),
  "utf-8"
);

// ── Readline helpers ─────────────────────────────────────────────────
function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(chalk.cyan("? ") + question + " ", (answer) => {
      resolve(answer.trim());
    });
  });
}

// ── CDP-based element picker ─────────────────────────────────────────
// Returns clicked element data, or null if user pressed Escape to skip.
async function pickElement(cdp, page, mode, skippable) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out waiting for element click (2 minutes)"));
    }, 120000);

    function cleanup() {
      cdp.removeAllListeners("Overlay.inspectNodeRequested");
      cdp.removeAllListeners("Overlay.inspectModeCanceled");
      cdp.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      }).catch(() => {});
    }

    // If user presses Escape in the browser, inspect mode fires this event
    cdp.on("Overlay.inspectModeCanceled", () => {
      if (settled) return;
      if (skippable) {
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve(null); // null means skipped
      }
      // If not skippable, re-enable inspect mode
      else {
        cdp.send("Overlay.setInspectMode", {
          mode: "searchForNode",
          highlightConfig: {
            showInfo: true,
            contentColor: { r: 255, g: 65, b: 54, a: 0.3 },
            paddingColor: { r: 255, g: 65, b: 54, a: 0.15 },
            borderColor: { r: 255, g: 65, b: 54, a: 0.8 },
            marginColor: { r: 255, g: 200, b: 50, a: 0.1 },
          },
        }).catch(() => {});
      }
    });

    cdp.on("Overlay.inspectNodeRequested", async (params) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();

      try {
        const { object } = await cdp.send("DOM.resolveNode", {
          backendNodeId: params.backendNodeId,
        });

        const result = await cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function() {
            ${SELECTOR_HELPERS}
            var el = this;
            var specificSelector = getSelector(el);
            var generalizedSelector = null;
            if ("${mode}" === "listing_field") {
              generalizedSelector = generalizeSelector(specificSelector, el);
            }
            var href = null;
            try {
              href = el.href || null;
              if (!href && el.closest) {
                var a = el.closest("a");
                if (a) href = a.href;
              }
            } catch(e) {}
            var rect = el.getBoundingClientRect();
            return {
              selector: specificSelector,
              generalizedSelector: generalizedSelector,
              tagName: el.tagName || "",
              text: (el.textContent || "").replace(/\\s+/g, " ").trim().substring(0, 200),
              href: href,
              src: el.src || null,
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              timestamp: Date.now()
            };
          }`,
          returnByValue: true,
        });

        await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
        resolve(result.result.value);
      } catch (e) {
        reject(new Error("Failed to extract selector: " + e.message));
      }
    });

    cdp.send("Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig: {
        showInfo: true,
        showStyles: false,
        showRulers: false,
        showAccessibilityInfo: false,
        contentColor: { r: 255, g: 65, b: 54, a: 0.3 },
        paddingColor: { r: 255, g: 65, b: 54, a: 0.15 },
        borderColor: { r: 255, g: 65, b: 54, a: 0.8 },
        marginColor: { r: 255, g: 200, b: 50, a: 0.1 },
      },
    }).catch((e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Failed to enable inspect mode: " + e.message));
      }
    });
  });
}

// ── Show/hide message banner via CDP ─────────────────────────────────
async function showMessage(cdp, message) {
  try {
    await cdp.send("Runtime.evaluate", {
      expression: `
        (function() {
          var el = document.getElementById("__as_msg__");
          if (!el) {
            el = document.createElement("div");
            el.id = "__as_msg__";
            el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a2e;color:#e0e0e0;font-family:system-ui;font-size:14px;padding:10px 20px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.5);";
            document.documentElement.appendChild(el);
          }
          el.innerHTML = ${JSON.stringify(message)};
          el.style.display = "block";
        })()
      `,
      allowUnsafeEvalBlockedByCSP: true,
    });
  } catch (e) {}
}

async function hideMessage(cdp) {
  try {
    await cdp.send("Runtime.evaluate", {
      expression: `(function(){ var el = document.getElementById("__as_msg__"); if (el) el.style.display = "none"; })()`,
      allowUnsafeEvalBlockedByCSP: true,
    });
  } catch (e) {}
}

// ── Main training flow ───────────────────────────────────────────────
async function train(url) {
  console.log(chalk.bold("\n=== Auction Scraper Trainer v4 ===\n"));

  // ── Phase 1: Gather all text input BEFORE opening the browser ──────
  const rl = createRL();
  const siteKey = urlToSiteKey(url);

  const sampleQuery = await ask(rl, "Enter a sample search query to load results:");
  const submitViaEnter = (await ask(rl, "Does this site search by pressing Enter? (Y/n):")).toLowerCase() !== "n";
  const waitAfterSearch = parseInt(await ask(rl, "Seconds to wait after search for results? (default: 3):"), 10) || 3;
  const maxPages = parseInt(await ask(rl, "Max pages to scrape per search? (default: 3):"), 10) || 3;

  console.log(chalk.gray("\n  All questions answered. Opening browser now."));
  console.log(chalk.gray("  In the browser, elements will highlight as you hover."));
  console.log(chalk.gray("  Click an element to select it."));
  console.log(chalk.gray("  Press Escape in the browser to skip optional fields.\n"));

  rl.close();

  const profile = {
    siteKey,
    name: siteKey,
    url,
    selectors: {},
    submitViaEnter,
    waitAfterSearch,
    maxPages,
    trainedAt: new Date().toISOString(),
  };

  // ── Phase 2: Browser interaction (no readline needed) ──────────────
  const spinner = ora("Launching browser...").start();
  const executablePath = findBrowser();
  if (!executablePath) {
    spinner.fail("No Chrome/Chromium browser found!");
    console.log(chalk.red("Please install Google Chrome or Chromium."));
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());

  const cdp = await page.target().createCDPSession();
  await cdp.send("DOM.enable");
  await cdp.send("Overlay.enable");
  await cdp.send("Runtime.enable");

  // Navigate and load the site
  spinner.text = `Loading ${url}...`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));
  spinner.succeed("Page loaded");

  // ────────────────────────────────────────────────────────────────────
  // STEP 1: Search text box
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Step 1/7: Click the SEARCH TEXT BOX ---"));
  await showMessage(cdp, '<b style="color:#ff4136">STEP 1/7:</b> Click the <b>search text box</b>');

  const searchBoxClick = await pickElement(cdp, page, "single", false);
  profile.selectors.searchBox = searchBoxClick.selector;
  console.log(chalk.green("  Captured: ") + chalk.gray(searchBoxClick.selector));

  // ────────────────────────────────────────────────────────────────────
  // STEP 2: Search submit button
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Step 2/7: Click the SEARCH BUTTON ---"));
  await showMessage(cdp, '<b style="color:#ff4136">STEP 2/7:</b> Click the <b>search / submit button</b>');

  const submitClick = await pickElement(cdp, page, "single", false);
  profile.selectors.searchSubmit = submitClick.selector;
  console.log(chalk.green("  Captured: ") + chalk.gray(submitClick.selector));

  // ────────────────────────────────────────────────────────────────────
  // STEP 3: Perform sample search automatically
  // ────────────────────────────────────────────────────────────────────
  const spinner2 = ora(`Searching for "${sampleQuery}"...`).start();
  await hideMessage(cdp);

  await page.click(profile.selectors.searchBox);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.type(profile.selectors.searchBox, sampleQuery, { delay: 30 });

  if (profile.submitViaEnter) {
    await page.keyboard.press("Enter");
  } else {
    await page.click(profile.selectors.searchSubmit);
  }

  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 });
  } catch {
    await new Promise((r) => setTimeout(r, 3000));
  }
  await new Promise((r) => setTimeout(r, waitAfterSearch * 1000));
  spinner2.succeed("Results loaded");

  // Small extra wait for lazy-loaded content
  await new Promise((r) => setTimeout(r, 2000));

  // ────────────────────────────────────────────────────────────────────
  // STEP 4: Image thumbnail (optional -- Escape to skip)
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Step 3/7: Click a listing IMAGE (Escape to skip) ---"));
  await showMessage(cdp, '<b style="color:#ff4136">STEP 3/7:</b> Click a listing <b>image</b> &mdash; or press <b>Escape</b> to skip');

  const imgClick = await pickElement(cdp, page, "listing_field", true);
  if (imgClick) {
    profile.selectors.image = imgClick.generalizedSelector || imgClick.selector;
    profile.selectors._imageSpecific = imgClick.selector;
    console.log(chalk.green("  Captured: ") + chalk.gray(profile.selectors.image));
  } else {
    profile.selectors.image = null;
    console.log(chalk.gray("  Skipped"));
  }

  // ────────────────────────────────────────────────────────────────────
  // STEP 5: Title
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Step 4/7: Click a listing TITLE ---"));
  await showMessage(cdp, '<b style="color:#ff4136">STEP 4/7:</b> Click a listing <b>title</b>');

  const titleClick = await pickElement(cdp, page, "listing_field", false);
  profile.selectors.title = titleClick.generalizedSelector || titleClick.selector;
  profile.selectors._titleSpecific = titleClick.selector;
  console.log(chalk.green("  Captured: ") + chalk.gray(profile.selectors.title));
  console.log(chalk.gray(`  "${titleClick.text.substring(0, 80)}"`));

  // ────────────────────────────────────────────────────────────────────
  // STEP 6: Price
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Step 5/7: Click a listing PRICE ---"));
  await showMessage(cdp, '<b style="color:#ff4136">STEP 5/7:</b> Click a listing <b>price</b>');

  const priceClick = await pickElement(cdp, page, "listing_field", false);
  profile.selectors.price = priceClick.generalizedSelector || priceClick.selector;
  profile.selectors._priceSpecific = priceClick.selector;
  console.log(chalk.green("  Captured: ") + chalk.gray(profile.selectors.price));
  console.log(chalk.gray(`  "${priceClick.text.substring(0, 50)}"`));

  // ────────────────────────────────────────────────────────────────────
  // STEP 7: Location (optional -- Escape to skip)
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Step 6/7: Click a listing LOCATION (Escape to skip) ---"));
  await showMessage(cdp, '<b style="color:#ff4136">STEP 6/7:</b> Click a listing <b>location</b> &mdash; or press <b>Escape</b> to skip');

  const locClick = await pickElement(cdp, page, "listing_field", true);
  if (locClick) {
    profile.selectors.location = locClick.generalizedSelector || locClick.selector;
    profile.selectors._locationSpecific = locClick.selector;
    console.log(chalk.green("  Captured: ") + chalk.gray(profile.selectors.location));
    console.log(chalk.gray(`  "${locClick.text.substring(0, 50)}"`));
  } else {
    profile.selectors.location = null;
    console.log(chalk.gray("  Skipped"));
  }

  // ────────────────────────────────────────────────────────────────────
  // STEP 8: Listing link
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Step 7/7: Click the LISTING LINK ---"));
  console.log(chalk.gray("(The <a> element that goes to the full listing page)"));
  await showMessage(cdp, '<b style="color:#ff4136">STEP 7/7:</b> Click the <b>listing link</b> (the &lt;a&gt; to the detail page)');

  const linkClick = await pickElement(cdp, page, "listing_field", false);
  profile.selectors.link = linkClick.generalizedSelector || linkClick.selector;
  profile.selectors._linkSpecific = linkClick.selector;
  console.log(chalk.green("  Captured: ") + chalk.gray(profile.selectors.link));
  if (linkClick.href) {
    console.log(chalk.gray(`  ${linkClick.href.substring(0, 100)}`));
  }

  // ────────────────────────────────────────────────────────────────────
  // Verification
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Verification ---"));
  const spinner3 = ora("Counting selector matches...").start();

  const counts = await page.evaluate((selectors) => {
    var result = {};
    var keys = Object.keys(selectors);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.indexOf("_") === 0 || !selectors[key]) continue;
      try {
        result[key] = document.querySelectorAll(selectors[key]).length;
      } catch (e) {
        result[key] = -1;
      }
    }
    return result;
  }, profile.selectors);

  spinner3.succeed("Done");
  console.log(chalk.bold("\n  Selector match counts:"));
  for (const [key, count] of Object.entries(counts)) {
    if (key === "searchBox" || key === "searchSubmit") continue;
    const color = count > 1 ? chalk.green : count === 1 ? chalk.yellow : chalk.red;
    console.log(`    ${key}: ${color(count + " matches")}`);
  }

  // ────────────────────────────────────────────────────────────────────
  // Pagination (optional -- Escape to skip)
  // ────────────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n--- Bonus: Click NEXT PAGE button (Escape to skip) ---"));
  await showMessage(cdp, '<b style="color:#ff4136">BONUS:</b> Click <b>Next Page</b> &mdash; or press <b>Escape</b> to skip');

  const paginationClick = await pickElement(cdp, page, "single", true);
  if (paginationClick) {
    profile.selectors.nextPage = paginationClick.selector;
    console.log(chalk.green("  Captured: ") + chalk.gray(paginationClick.selector));
  } else {
    profile.selectors.nextPage = null;
    console.log(chalk.gray("  Skipped"));
  }

  // ────────────────────────────────────────────────────────────────────
  // Save
  // ────────────────────────────────────────────────────────────────────
  await hideMessage(cdp);
  const savedPath = saveProfile(profile);

  console.log(chalk.bold.green("\n  Profile saved!"));
  console.log(chalk.gray(`  File: ${savedPath}`));
  console.log(chalk.gray(`  Search: ${chalk.white(`node src/cli.js search "${siteKey}" "your query"`)}\n`));

  await new Promise((r) => setTimeout(r, 1000));
  await browser.close();

  return profile;
}

module.exports = { train };
