/**
 * Finds a Chrome/Chromium executable on the system.
 * Falls back to bundled Puppeteer chromium if available.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CANDIDATES = {
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/usr/bin/brave-browser",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  ],
};

function findBrowser() {
  const platform = process.platform;
  const candidates = CANDIDATES[platform] || CANDIDATES.linux;

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  // Try `which` on unix
  if (platform !== "win32") {
    for (const cmd of ["google-chrome", "chromium-browser", "chromium", "brave-browser"]) {
      try {
        const result = execSync(`which ${cmd} 2>/dev/null`, {
          encoding: "utf-8",
        }).trim();
        if (result && fs.existsSync(result)) return result;
      } catch {
        // not found
      }
    }
  }

  // Try puppeteer's bundled chromium
  try {
    const puppeteer = require("puppeteer");
    const execPath = puppeteer.executablePath();
    if (execPath && fs.existsSync(execPath)) return execPath;
  } catch {
    // not available
  }

  return null;
}

module.exports = { findBrowser };
