/**
 * Selector extraction helpers.
 * This code is inlined into Runtime.callFunctionOn() calls.
 * It must be pure ES5 -- no imports, no module syntax.
 * It defines functions in the local scope of the caller.
 */

function cssEscape(str) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(str);
  }
  return String(str).replace(/([^\w-])/g, "\\$1");
}

function getStableClasses(el) {
  if (!el.classList) return [];
  var result = [];
  for (var i = 0; i < el.classList.length; i++) {
    var c = el.classList[i];
    if (!/^[a-z]{1,2}-[a-f0-9]+$/i.test(c) && !/^_/.test(c) && c.length < 40) {
      result.push(c);
    }
  }
  return result;
}

function getSelector(el) {
  if (!el || !el.tagName) return "";

  if (el.id) {
    try {
      var idSel = "#" + cssEscape(el.id);
      if (document.querySelectorAll(idSel).length === 1) return idSel;
    } catch (e) {}
  }

  try {
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs[i];
      if (attr.name.indexOf("data-") === 0 && attr.value) {
        var dSel = el.tagName.toLowerCase() + "[" + attr.name + '="' + cssEscape(attr.value) + '"]';
        if (document.querySelectorAll(dSel).length === 1) return dSel;
      }
    }
  } catch (e) {}

  if (el.name) {
    try {
      var nameSel = el.tagName.toLowerCase() + '[name="' + cssEscape(el.name) + '"]';
      if (document.querySelectorAll(nameSel).length === 1) return nameSel;
    } catch (e) {}
  }

  if (el.tagName === "INPUT" && el.type) {
    try {
      var typeSel = 'input[type="' + el.type + '"]';
      if (document.querySelectorAll(typeSel).length === 1) return typeSel;
    } catch (e) {}
  }

  var ariaLabel = el.getAttribute ? el.getAttribute("aria-label") : null;
  if (ariaLabel) {
    try {
      var ariaSel = el.tagName.toLowerCase() + '[aria-label="' + cssEscape(ariaLabel) + '"]';
      if (document.querySelectorAll(ariaSel).length === 1) return ariaSel;
    } catch (e) {}
  }

  var role = el.getAttribute ? el.getAttribute("role") : null;
  if (role) {
    try {
      var roleSel = el.tagName.toLowerCase() + '[role="' + cssEscape(role) + '"]';
      if (document.querySelectorAll(roleSel).length === 1) return roleSel;
    } catch (e) {}
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
      var escaped = [];
      for (var j = 0; j < stableClasses.length; j++) {
        escaped.push(cssEscape(stableClasses[j]));
      }
      selector += "." + escaped.join(".");
    }
    var parent = current.parentElement;
    if (parent) {
      var siblings = [];
      for (var k = 0; k < parent.children.length; k++) {
        if (parent.children[k].tagName === current.tagName) siblings.push(parent.children[k]);
      }
      if (siblings.length > 1) {
        var idx = -1;
        for (var m = 0; m < siblings.length; m++) {
          if (siblings[m] === current) { idx = m; break; }
        }
        selector += ":nth-of-type(" + (idx + 1) + ")";
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
    var candidate = parts.join(" > ");
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    } catch (e) {}
  }
  return parts.join(" > ");
}

function buildRelativePath(ancestor, descendant) {
  var parts = [];
  var current = descendant;
  while (current && current !== ancestor) {
    var sel = current.tagName.toLowerCase();
    var sc = getStableClasses(current);
    if (sc.length > 0) {
      var esc = [];
      for (var i = 0; i < sc.length; i++) esc.push(cssEscape(sc[i]));
      sel += "." + esc.join(".");
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
      if (parent.children[i].tagName === listItem.tagName) sameSiblings.push(parent.children[i]);
    }
    if (sameSiblings.length >= 3) {
      var pathFromListItem = buildRelativePath(listItem, el);
      var parentSel = getSelector(parent);
      var gen = parentSel + " > " + listItem.tagName.toLowerCase() + " " + pathFromListItem;
      try { if (document.querySelectorAll(gen).length >= 2) return gen; } catch (e) {}

      var liSel = listItem.tagName.toLowerCase();
      var liClasses = getStableClasses(listItem);
      if (liClasses.length > 0) {
        var escapedLi = [];
        for (var j = 0; j < liClasses.length; j++) escapedLi.push(cssEscape(liClasses[j]));
        liSel += "." + escapedLi.join(".");
      }
      var gen2 = liSel + " " + pathFromListItem;
      try { if (document.querySelectorAll(gen2).length >= 2) return gen2; } catch (e) {}
      break;
    }
    listItem = parent;
  }
  return specificSelector;
}
