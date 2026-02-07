/**
 * This script is injected into the page during training mode.
 * It creates a visual overlay and intercepts clicks to extract CSS selectors.
 *
 * Communication with Node.js happens via:
 *   - window.__auctionScraperOnClick(data) -- exposed by Puppeteer (primary)
 *   - window.__AUCTION_SCRAPER__.lastClick  -- polling fallback
 *
 * Written in ES5 to avoid CSP / compat issues on any site.
 */
(function () {
  "use strict";

  if (window.__AUCTION_SCRAPER_INITIALIZED__) return;
  window.__AUCTION_SCRAPER_INITIALIZED__ = true;

  window.__AUCTION_SCRAPER__ = {
    lastClick: null,
    active: false,
    mode: null
  };

  // ── CSS.escape polyfill ──────────────────────────────────────────────
  function cssEscape(str) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(str);
    }
    return String(str).replace(/([^\w-])/g, "\\$1");
  }

  // ── UI element creation with retries ─────────────────────────────────
  function ensureUI() {
    if (document.getElementById("__as_highlight__")) return;
    if (!document.documentElement) return;

    var highlight = document.createElement("div");
    highlight.id = "__as_highlight__";
    highlight.style.cssText =
      "position:fixed;pointer-events:none;border:3px solid #ff4136;" +
      "border-radius:3px;background:rgba(255,65,54,0.15);" +
      "z-index:2147483646;display:none;transition:all 0.05s ease;";
    document.documentElement.appendChild(highlight);

    var banner = document.createElement("div");
    banner.id = "__as_banner__";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
      "background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);" +
      "color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;" +
      "font-size:14px;padding:12px 20px;text-align:center;" +
      "box-shadow:0 4px 20px rgba(0,0,0,0.5);display:none;line-height:1.5;";
    document.documentElement.appendChild(banner);
  }

  if (document.documentElement) {
    ensureUI();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureUI);
  }
  setTimeout(ensureUI, 300);
  setTimeout(ensureUI, 1000);
  setTimeout(ensureUI, 3000);

  // ── Helper: get stable classes from an element ───────────────────────
  function getStableClasses(el) {
    if (!el.classList) return [];
    var result = [];
    for (var i = 0; i < el.classList.length; i++) {
      var c = el.classList[i];
      if (
        !/^[a-z]{1,2}-[a-f0-9]+$/i.test(c) &&
        !/^_/.test(c) &&
        c.length < 40
      ) {
        result.push(c);
      }
    }
    return result;
  }

  // ── Selector generation ──────────────────────────────────────────────
  function getSelector(el) {
    if (!el || !el.tagName) return "";

    // id
    if (el.id) {
      try {
        var idSel = "#" + cssEscape(el.id);
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      } catch (e) { /* skip */ }
    }

    // data-* attributes
    try {
      var attrs = el.attributes;
      for (var i = 0; i < attrs.length; i++) {
        var attr = attrs[i];
        if (attr.name.indexOf("data-") === 0 && attr.value) {
          var dSel =
            el.tagName.toLowerCase() +
            "[" + attr.name + '="' + cssEscape(attr.value) + '"]';
          if (document.querySelectorAll(dSel).length === 1) return dSel;
        }
      }
    } catch (e) { /* skip */ }

    // name attribute
    if (el.name) {
      try {
        var nameSel =
          el.tagName.toLowerCase() + '[name="' + cssEscape(el.name) + '"]';
        if (document.querySelectorAll(nameSel).length === 1) return nameSel;
      } catch (e) { /* skip */ }
    }

    // input type
    if (el.tagName === "INPUT" && el.type) {
      try {
        var typeSel = 'input[type="' + el.type + '"]';
        if (document.querySelectorAll(typeSel).length === 1) return typeSel;
      } catch (e) { /* skip */ }
    }

    // aria-label
    var ariaLabel = el.getAttribute ? el.getAttribute("aria-label") : null;
    if (ariaLabel) {
      try {
        var ariaSel =
          el.tagName.toLowerCase() +
          '[aria-label="' + cssEscape(ariaLabel) + '"]';
        if (document.querySelectorAll(ariaSel).length === 1) return ariaSel;
      } catch (e) { /* skip */ }
    }

    // role
    var role = el.getAttribute ? el.getAttribute("role") : null;
    if (role) {
      try {
        var roleSel =
          el.tagName.toLowerCase() + '[role="' + cssEscape(role) + '"]';
        if (document.querySelectorAll(roleSel).length === 1) return roleSel;
      } catch (e) { /* skip */ }
    }

    return buildNthChildPath(el);
  }

  function buildNthChildPath(el) {
    var parts = [];
    var current = el;
    while (current && current !== document.documentElement) {
      var selector = current.tagName.toLowerCase();
      var stableClasses = getStableClasses(current);
      if (stableClasses.length > 0) {
        var escapedClasses = [];
        for (var j = 0; j < stableClasses.length; j++) {
          escapedClasses.push(cssEscape(stableClasses[j]));
        }
        selector += "." + escapedClasses.join(".");
      }
      var parent = current.parentElement;
      if (parent) {
        var siblings = [];
        for (var k = 0; k < parent.children.length; k++) {
          if (parent.children[k].tagName === current.tagName) {
            siblings.push(parent.children[k]);
          }
        }
        if (siblings.length > 1) {
          var index = -1;
          for (var m = 0; m < siblings.length; m++) {
            if (siblings[m] === current) { index = m; break; }
          }
          selector += ":nth-of-type(" + (index + 1) + ")";
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
      var candidate = parts.join(" > ");
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (e) { /* skip */ }
    }
    return parts.join(" > ");
  }

  // ── Generalize a selector for repeated listing items ─────────────────
  function buildRelativePath(ancestor, descendant) {
    var parts = [];
    var current = descendant;
    while (current && current !== ancestor) {
      var sel = current.tagName.toLowerCase();
      var stableClasses = getStableClasses(current);
      if (stableClasses.length > 0) {
        var escaped = [];
        for (var i = 0; i < stableClasses.length; i++) {
          escaped.push(cssEscape(stableClasses[i]));
        }
        sel += "." + escaped.join(".");
      }
      parts.unshift(sel);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function generalizeSelector(specificSelector, el) {
    var listItem = el;
    while (listItem) {
      var parent = listItem.parentElement;
      if (!parent) break;
      var sameSiblings = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === listItem.tagName) {
          sameSiblings.push(parent.children[i]);
        }
      }
      if (sameSiblings.length >= 3) {
        var pathFromListItem = buildRelativePath(listItem, el);
        var parentSel = getSelector(parent);

        // Strategy 1: parent > tag path
        var gen =
          parentSel +
          " > " +
          listItem.tagName.toLowerCase() +
          " " +
          pathFromListItem;
        try {
          if (document.querySelectorAll(gen).length >= 2) return gen;
        } catch (e) { /* skip */ }

        // Strategy 2: list item classes + path
        var liSel = listItem.tagName.toLowerCase();
        var liClasses = getStableClasses(listItem);
        if (liClasses.length > 0) {
          var escapedLi = [];
          for (var j = 0; j < liClasses.length; j++) {
            escapedLi.push(cssEscape(liClasses[j]));
          }
          liSel += "." + escapedLi.join(".");
        }
        var gen2 = liSel + " " + pathFromListItem;
        try {
          if (document.querySelectorAll(gen2).length >= 2) return gen2;
        } catch (e) { /* skip */ }
        break;
      }
      listItem = parent;
    }
    return specificSelector;
  }

  // ── Helper: safely get closest ancestor ──────────────────────────────
  function safeClosest(el, selector) {
    try {
      if (el.closest) return el.closest(selector);
    } catch (e) { /* skip */ }
    return null;
  }

  // ── Helper: check if target is our UI ────────────────────────────────
  function isOurUI(target) {
    if (!target) return true;
    if (target.id === "__as_highlight__" || target.id === "__as_banner__") return true;
    if (safeClosest(target, "#__as_banner__")) return true;
    if (safeClosest(target, "#__as_highlight__")) return true;
    return false;
  }

  // ── Event handlers ───────────────────────────────────────────────────
  function onMouseMove(e) {
    if (!window.__AUCTION_SCRAPER__ || !window.__AUCTION_SCRAPER__.active) return;
    var highlight = document.getElementById("__as_highlight__");
    if (!highlight) return;

    var target = e.target;
    if (!target || !target.getBoundingClientRect) return;
    if (isOurUI(target)) return;

    var rect = target.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.top = rect.top + "px";
    highlight.style.left = rect.left + "px";
    highlight.style.width = rect.width + "px";
    highlight.style.height = rect.height + "px";
  }

  function onClick(e) {
    if (!window.__AUCTION_SCRAPER__ || !window.__AUCTION_SCRAPER__.active) return;
    var target = e.target;
    if (isOurUI(target)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var specificSelector = getSelector(target);
    var generalizedSelector = null;
    if (window.__AUCTION_SCRAPER__.mode === "listing_field") {
      generalizedSelector = generalizeSelector(specificSelector, target);
    }

    var href = null;
    try {
      href = target.href || null;
      if (!href) {
        var closestA = safeClosest(target, "a");
        if (closestA) href = closestA.href;
      }
    } catch (e2) { /* skip */ }

    var rect = target.getBoundingClientRect();
    var clickData = {
      selector: specificSelector,
      generalizedSelector: generalizedSelector,
      tagName: target.tagName || "",
      text: (target.textContent || "").replace(/\s+/g, " ").trim().substring(0, 200),
      href: href,
      src: target.src || null,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      timestamp: Date.now()
    };

    // Store for polling fallback
    window.__AUCTION_SCRAPER__.lastClick = clickData;

    // Notify Node.js via exposed function (primary, more reliable)
    if (typeof window.__auctionScraperOnClick === "function") {
      try {
        window.__auctionScraperOnClick(JSON.stringify(clickData));
      } catch (e3) {
        // fallback to polling via lastClick
      }
    }
  }

  function onMouseDown(e) {
    if (!window.__AUCTION_SCRAPER__ || !window.__AUCTION_SCRAPER__.active) return;
    var target = e.target;
    if (isOurUI(target)) return;
    // Stop propagation on mousedown too, so the site's own handlers
    // don't interfere with our click capture
    e.stopPropagation();
  }

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", onMouseDown, true);

  // ── Public API (called from Puppeteer via page.evaluate) ─────────────
  window.__AUCTION_SCRAPER__.showBanner = function (html) {
    ensureUI();
    var banner = document.getElementById("__as_banner__");
    if (banner) {
      banner.innerHTML = html;
      banner.style.display = "block";
    }
  };

  window.__AUCTION_SCRAPER__.hideBanner = function () {
    var banner = document.getElementById("__as_banner__");
    if (banner) banner.style.display = "none";
  };

  window.__AUCTION_SCRAPER__.activate = function (mode) {
    window.__AUCTION_SCRAPER__.active = true;
    window.__AUCTION_SCRAPER__.mode = mode || "single";
    window.__AUCTION_SCRAPER__.lastClick = null;
  };

  window.__AUCTION_SCRAPER__.deactivate = function () {
    window.__AUCTION_SCRAPER__.active = false;
    var highlight = document.getElementById("__as_highlight__");
    if (highlight) highlight.style.display = "none";
  };

  console.log("[auction-scraper] Overlay injected successfully");
})();
