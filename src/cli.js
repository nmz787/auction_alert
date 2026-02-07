#!/usr/bin/env node

/**
 * Auction Scraper CLI
 *
 * Commands:
 *   train <url>                   Train a new scraper for an auction site
 *   search <site> <query>         Search a trained site and return results
 *   list                          List all trained scrapers
 *   delete <site>                 Delete a trained scraper profile
 *   show <site>                   Show details of a trained profile
 */

const { Command } = require("commander");
const chalk = require("chalk");

// Catch unhandled rejections so the process doesn't silently die
process.on("unhandledRejection", (err) => {
  console.error(chalk.red("\nUnhandled error: ") + (err.stack || err.message || err));
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(chalk.red("\nUncaught exception: ") + (err.stack || err.message || err));
  process.exit(1);
});
const { train } = require("./trainer");
const { search } = require("./scraper");
const {
  listProfiles,
  loadProfile,
  deleteProfile,
  urlToSiteKey,
} = require("./profile-store");

const program = new Command();

program
  .name("auction-scraper")
  .description(
    "Train and run web scrapers for auction websites via interactive click recording"
  )
  .version("1.0.0");

// ── train ────────────────────────────────────────────────────────────
program
  .command("train <url>")
  .description("Train a new scraper by interactively clicking elements on the site")
  .action(async (url) => {
    try {
      // Ensure URL has protocol
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url;
      }
      await train(url);
    } catch (err) {
      console.error(chalk.red("\nError: ") + (err.stack || err.message));
      process.exit(1);
    }
  });

// ── search ───────────────────────────────────────────────────────────
program
  .command("search <site> <query>")
  .description("Search a trained auction site and return structured results")
  .option("-p, --pages <n>", "Max pages to scrape", parseInt)
  .option("--no-headless", "Show the browser while scraping")
  .option("-f, --format <fmt>", "Output format: json (default), csv, table", "json")
  .option("-o, --output <file>", "Write output to file instead of stdout")
  .option("-q, --quiet", "Suppress progress output (only print results)")
  .action(async (site, query, opts) => {
    try {
      const results = await search(site, query, {
        maxPages: opts.pages,
        headless: opts.headless,
        quiet: opts.quiet,
      });

      let output;
      switch (opts.format) {
        case "csv":
          output = formatCSV(results);
          break;
        case "table":
          output = formatTable(results);
          break;
        case "json":
        default:
          output = JSON.stringify(results, null, 2);
          break;
      }

      if (opts.output) {
        const fs = require("fs");
        fs.writeFileSync(opts.output, output, "utf-8");
        console.log(chalk.green(`Results written to ${opts.output}`));
      } else {
        console.log(output);
      }
    } catch (err) {
      console.error(chalk.red("\nError: ") + err.message);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    }
  });

// ── list ─────────────────────────────────────────────────────────────
program
  .command("list")
  .description("List all trained scraper profiles")
  .action(() => {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log(chalk.yellow("No trained scrapers found."));
      console.log(
        chalk.gray("Run: auction-scraper train <url> to create one.")
      );
      return;
    }
    console.log(chalk.bold("\nTrained Scrapers:\n"));
    for (const p of profiles) {
      console.log(
        `  ${chalk.cyan(p.siteKey)}` +
          (p.name !== p.siteKey ? ` (${p.name})` : "") +
          `  ${chalk.gray(p.url)}`
      );
      console.log(chalk.gray(`    Trained: ${p.trainedAt}\n`));
    }
  });

// ── show ─────────────────────────────────────────────────────────────
program
  .command("show <site>")
  .description("Show details of a trained scraper profile")
  .action((site) => {
    const profile = loadProfile(site);
    if (!profile) {
      console.error(chalk.red(`No profile found for "${site}"`));
      process.exit(1);
    }
    console.log(chalk.bold(`\nProfile: ${profile.name}\n`));
    console.log(`  Site key:  ${chalk.cyan(profile.siteKey)}`);
    console.log(`  URL:       ${profile.url}`);
    console.log(`  Trained:   ${profile.trainedAt}`);
    console.log(`  Wait time: ${profile.waitAfterSearch}s`);
    console.log(`  Max pages: ${profile.maxPages}`);
    console.log(`  Submit:    ${profile.submitViaEnter ? "Enter key" : "Click button"}`);
    console.log(chalk.bold("\n  Selectors:"));
    for (const [key, val] of Object.entries(profile.selectors)) {
      if (key.startsWith("_")) continue;
      const status = val ? chalk.green(val) : chalk.gray("(not set)");
      console.log(`    ${key.padEnd(14)} ${status}`);
    }
    console.log();
  });

// ── delete ───────────────────────────────────────────────────────────
program
  .command("delete <site>")
  .description("Delete a trained scraper profile")
  .action((site) => {
    const profile = loadProfile(site);
    if (!profile) {
      console.error(chalk.red(`No profile found for "${site}"`));
      process.exit(1);
    }
    if (deleteProfile(profile.siteKey)) {
      console.log(chalk.green(`Deleted profile: ${profile.siteKey}`));
    } else {
      console.error(chalk.red("Failed to delete profile"));
      process.exit(1);
    }
  });

// ── Output formatters ────────────────────────────────────────────────
function formatCSV(results) {
  const headers = ["title", "price", "location", "url", "imageUrl"];
  const lines = [headers.join(",")];
  for (const listing of results.listings) {
    const row = headers.map((h) => {
      const val = listing[h] || "";
      // Escape CSV values
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    });
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

function formatTable(results) {
  const lines = [];
  lines.push(
    chalk.bold(
      `\nResults for "${results.query}" on ${results.site} ` +
        `(${results.totalResults} listings, ${results.pages} pages)\n`
    )
  );
  lines.push(
    chalk.gray("─".repeat(100))
  );

  for (let i = 0; i < results.listings.length; i++) {
    const l = results.listings[i];
    lines.push(
      `${chalk.gray(String(i + 1).padStart(3) + ".")} ${chalk.bold(l.title || "(no title)")}`
    );
    const details = [];
    if (l.price) details.push(chalk.green(l.price));
    if (l.location) details.push(chalk.yellow(l.location));
    if (details.length) lines.push(`     ${details.join("  |  ")}`);
    if (l.url) lines.push(`     ${chalk.blue.underline(l.url)}`);
    lines.push(chalk.gray("─".repeat(100)));
  }
  return lines.join("\n");
}

// ── Parse and run ────────────────────────────────────────────────────
program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
