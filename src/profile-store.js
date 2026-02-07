/**
 * Manages scraper profile persistence.
 * Profiles are stored as JSON files in ~/.auction-scraper/profiles/
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROFILES_DIR = path.join(os.homedir(), ".auction-scraper", "profiles");

function ensureDir() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

/**
 * Normalize a URL to a stable site key.
 * "https://www.example.com/foo" -> "example.com"
 */
function urlToSiteKey(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname.replace(/^www\./, "");
  } catch {
    // If it's not a URL, treat it as a plain key
    return urlStr.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  }
}

function profilePath(siteKey) {
  return path.join(PROFILES_DIR, siteKey + ".json");
}

function saveProfile(profile) {
  ensureDir();
  const filePath = profilePath(profile.siteKey);
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf-8");
  return filePath;
}

function loadProfile(siteKeyOrUrl) {
  ensureDir();
  // Try exact match first
  let key = siteKeyOrUrl;
  let fp = profilePath(key);
  if (fs.existsSync(fp)) {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  }
  // Try as URL
  key = urlToSiteKey(siteKeyOrUrl);
  fp = profilePath(key);
  if (fs.existsSync(fp)) {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  }
  // Try partial match
  const files = fs.readdirSync(PROFILES_DIR);
  const match = files.find(
    (f) =>
      f.replace(".json", "").includes(key) ||
      key.includes(f.replace(".json", ""))
  );
  if (match) {
    return JSON.parse(
      fs.readFileSync(path.join(PROFILES_DIR, match), "utf-8")
    );
  }
  return null;
}

function listProfiles() {
  ensureDir();
  const files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const data = JSON.parse(
      fs.readFileSync(path.join(PROFILES_DIR, f), "utf-8")
    );
    return {
      siteKey: data.siteKey,
      name: data.name,
      url: data.url,
      trainedAt: data.trainedAt,
    };
  });
}

function deleteProfile(siteKey) {
  const fp = profilePath(siteKey);
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
    return true;
  }
  return false;
}

module.exports = {
  urlToSiteKey,
  saveProfile,
  loadProfile,
  listProfiles,
  deleteProfile,
  PROFILES_DIR,
};
