/**
 * The page half of browser annotations (plan 20260929-browser-annotations): plain JavaScript the
 * main process injects over CDP into a named **isolated world** of a page guest
 * (`Page.addScriptToEvaluateOnNewDocument` with `worldName`, and into the current document when it
 * is first needed). Page scripts never see it: it shares the DOM, not the JavaScript globals. It
 * talks to main only through a `Runtime.addBinding` binding scoped to that world, and main calls
 * `__cofluxAnnotatorApi` in the same world.
 *
 * It does only what must happen inside the page — hover highlight, hit-testing, locating elements
 * again, rectangles and the numbered pins (drawn in a closed shadow root) — and acts in the
 * top-level frame only. The comment card, attachments and panel are renderer UI.
 *
 * Written by hand for coflux (no third-party code). Kept free of template-literal syntax so it can
 * live in this raw string.
 */

export const ANNOTATOR_WORLD = "coflux-annotator";
export const ANNOTATOR_BINDING = "__cofluxAnnotatorEmit";

export const ANNOTATOR_PAGE_SCRIPT = String.raw`(function () {
  "use strict";
  if (window.top !== window) return;
  if (globalThis.__cofluxAnnotatorApi) return;

  var BINDING = "__cofluxAnnotatorEmit";
  var ATTRIBUTES = ["role", "aria-label", "name", "type", "href", "alt", "placeholder", "title", "for", "data-testid", "data-test", "data-cy"];
  var STYLES = ["color", "background-color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
    "padding", "margin", "border", "border-radius", "box-shadow", "display", "gap", "width", "height", "opacity"];
  var TEST_ATTRIBUTES = ["data-testid", "data-test", "data-cy", "data-qa"];

  var state = { mode: false, pins: [], anchor: null };
  var host = null, root = null, hoverBox = null, hoverLabel = null, anchorBox = null, pinLayer = null, cursorStyle = null;
  var picked = new Map();
  var nextToken = 1;
  var hidden = false;
  var located = new Map();
  var pinNodes = new Map();
  var lastAnchor = "";
  var lastMissing = "";
  var frame = 0;
  var observer = null;
  var relocateTimer = 0;
  // An annotation to scroll into view once its element is found (it may render after the page loads).
  var pendingScroll = null;

  function emit(message) {
    try {
      var send = globalThis[BINDING];
      if (typeof send === "function") send(JSON.stringify(message));
    } catch (error) {}
  }

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function rectOf(element) {
    var box = element.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  }

  function clip(value, max) {
    value = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return value.length > max ? value.slice(0, max) : value;
  }

  function escapeCss(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function count(selector) {
    try { return document.querySelectorAll(selector).length; } catch (error) { return 0; }
  }

  function stableClass(name) {
    return name.length > 0 && name.length <= 40 && !/\d{3,}/.test(name) && !/^(css|sc|jsx|emotion|svelte)-/.test(name) && !/__[A-Za-z0-9]{5}$/.test(name);
  }

  function stableId(id) {
    return id && id.length <= 64 && !/\d{4,}/.test(id) && !/^[:0-9]/.test(id);
  }

  function nthOfType(element) {
    var index = 1, total = 0, sibling;
    var parent = element.parentElement;
    if (!parent) return "";
    for (sibling = parent.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.tagName !== element.tagName) continue;
      total += 1;
      if (sibling === element) index = total;
    }
    return total > 1 ? ":nth-of-type(" + index + ")" : "";
  }

  function domPath(element) {
    var parts = [];
    for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
      parts.unshift(node.tagName.toLowerCase() + nthOfType(node));
      if (node === document.documentElement) break;
    }
    return parts.join(" > ");
  }

  function uniqueSelector(element) {
    var tag = element.tagName.toLowerCase();
    if (stableId(element.id)) {
      var byId = "#" + escapeCss(element.id);
      if (count(byId) === 1) return byId;
    }
    for (var i = 0; i < TEST_ATTRIBUTES.length; i++) {
      var value = element.getAttribute(TEST_ATTRIBUTES[i]);
      if (!value) continue;
      var byTest = tag + "[" + TEST_ATTRIBUTES[i] + "=\"" + value.replace(/["\\]/g, "\\$&") + "\"]";
      if (count(byTest) === 1) return byTest;
    }
    var parts = [];
    var node = element;
    for (var depth = 0; node && node.nodeType === 1 && depth < 12; depth++, node = node.parentElement) {
      if (node !== element && stableId(node.id)) {
        var anchored = "#" + escapeCss(node.id) + " > " + parts.join(" > ");
        if (count(anchored) === 1) return anchored;
      }
      var step = node.tagName.toLowerCase();
      var classes = Array.prototype.filter.call(node.classList, stableClass).slice(0, 2);
      if (classes.length) step += "." + classes.map(escapeCss).join(".");
      step += nthOfType(node);
      parts.unshift(step);
      var candidate = parts.join(" > ");
      if (count(candidate) === 1) return candidate;
      if (node === document.body) break;
    }
    return domPath(element);
  }

  function describe(element) {
    var attributes = {};
    for (var i = 0; i < ATTRIBUTES.length; i++) {
      var value = element.getAttribute(ATTRIBUTES[i]);
      if (value) attributes[ATTRIBUTES[i]] = clip(value, 300);
    }
    var styles = {};
    var computed = window.getComputedStyle(element);
    for (var j = 0; j < STYLES.length; j++) {
      var style = computed.getPropertyValue(STYLES[j]);
      if (style) styles[STYLES[j]] = clip(style, 200);
    }
    var box = element.getBoundingClientRect();
    return {
      selector: uniqueSelector(element),
      domPath: domPath(element),
      tag: element.tagName.toLowerCase(),
      text: clip(element.innerText || element.textContent || "", 300),
      elementId: element.id || "",
      classes: Array.prototype.slice.call(element.classList, 0, 16),
      attributes: attributes,
      styles: styles,
      width: Math.round(box.width),
      height: Math.round(box.height)
    };
  }

  // Finding an annotated element again: every candidate the stored selector, DOM path, id or text
  // can produce is scored; the best one above the threshold wins.
  function score(locator, element, selectorMatches, pathMatches) {
    var total = 0;
    if (selectorMatches) total += selectorMatches === 1 ? 5 : 2;
    if (pathMatches) total += 3;
    if (locator.elementId && element.id === locator.elementId) total += 4;
    if (locator.tag && element.tagName.toLowerCase() === locator.tag) total += 1;
    if (locator.text) {
      var current = clip(element.innerText || element.textContent || "", 300);
      if (current === locator.text) total += 3;
      else if (current && locator.text.indexOf(current.slice(0, 40)) === 0) total += 1;
    }
    if (locator.classes && locator.classes.length) {
      var shared = 0;
      for (var i = 0; i < locator.classes.length; i++) if (element.classList.contains(locator.classes[i])) shared++;
      total += 2 * shared / locator.classes.length;
    }
    return total;
  }

  function locate(locator) {
    var candidates = [];
    var bySelector = [], byPath = [];
    function add(list, into) {
      for (var i = 0; i < list.length && i < 50; i++) {
        if (into) into.push(list[i]);
        if (candidates.indexOf(list[i]) < 0) candidates.push(list[i]);
      }
    }
    try { if (locator.selector) add(document.querySelectorAll(locator.selector), bySelector); } catch (error) {}
    try { if (locator.domPath) add(document.querySelectorAll(locator.domPath), byPath); } catch (error) {}
    if (locator.elementId) {
      var byId = document.getElementById(locator.elementId);
      if (byId) add([byId]);
    }
    var best = null, bestScore = 0;
    function consider(element) {
      if (host && (element === host || host.contains(element))) return;
      var value = score(locator, element, bySelector.indexOf(element) >= 0 ? bySelector.length : 0, byPath.indexOf(element) >= 0);
      if (value > bestScore) { best = element; bestScore = value; }
    }
    candidates.forEach(consider);
    if (bestScore < 4 && locator.tag && locator.text) {
      var same = document.getElementsByTagName(locator.tag);
      for (var i = 0; i < same.length && i < 3000; i++) consider(same[i]);
    }
    return bestScore >= 4 ? best : null;
  }

  function ensureUi() {
    if (host && host.isConnected) return true;
    var parent = document.documentElement;
    if (!parent) return false;
    if (!host) {
      host = document.createElement("coflux-annotator");
      host.setAttribute("style", "all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: 2147483647 !important; display: block !important;");
      root = host.attachShadow({ mode: "closed" });
      var style = document.createElement("style");
      style.textContent = [
        ".hover{position:fixed;display:none;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.10);border-radius:3px;pointer-events:none}",
        ".label{position:fixed;display:none;font:500 11px/16px -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;background:#3b82f6;padding:0 5px;border-radius:3px;pointer-events:none;white-space:nowrap}",
        ".anchor{position:fixed;display:none;box-sizing:border-box;border:2px solid #f59e0b;border-radius:3px;pointer-events:none;box-shadow:0 0 0 4px rgba(245,158,11,.18)}",
        ".pin{position:fixed;display:flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:10px;",
        "font:600 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;background:#f59e0b;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:pointer;pointer-events:auto;transform:translate(-50%,-50%)}",
        ".pin.resolved{background:#16a34a}",
        ".pin:hover{filter:brightness(1.08)}"
      ].join("");
      root.appendChild(style);
      hoverBox = document.createElement("div"); hoverBox.className = "hover"; root.appendChild(hoverBox);
      hoverLabel = document.createElement("div"); hoverLabel.className = "label"; root.appendChild(hoverLabel);
      anchorBox = document.createElement("div"); anchorBox.className = "anchor"; root.appendChild(anchorBox);
      pinLayer = document.createElement("div"); root.appendChild(pinLayer);
    }
    parent.appendChild(host);
    return true;
  }

  function place(node, rect) {
    node.style.left = rect.x + "px";
    node.style.top = rect.y + "px";
    node.style.width = rect.width + "px";
    node.style.height = rect.height + "px";
    node.style.display = "block";
  }

  function isOurs(element) {
    return !element || element === host || element === document.documentElement || (host && host.contains(element));
  }

  function targetAt(x, y) {
    var element = document.elementFromPoint(x, y);
    return isOurs(element) ? null : element;
  }

  function onPointerMove(event) {
    if (!state.mode || hidden || !ensureUi()) return;
    var target = targetAt(event.clientX, event.clientY);
    if (!target) { hoverBox.style.display = "none"; hoverLabel.style.display = "none"; return; }
    var rect = rectOf(target);
    place(hoverBox, rect);
    hoverLabel.textContent = target.tagName.toLowerCase() + (target.id ? "#" + target.id : "");
    hoverLabel.style.left = rect.x + "px";
    hoverLabel.style.top = Math.max(0, rect.y - 18) + "px";
    hoverLabel.style.width = "auto";
    hoverLabel.style.height = "auto";
    hoverLabel.style.display = "block";
  }

  function swallow(event) {
    if (!state.mode) return;
    var path = event.composedPath ? event.composedPath() : [];
    if (host && path.indexOf(host) >= 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    if (!state.mode) return;
    var path = event.composedPath ? event.composedPath() : [];
    if (host && path.indexOf(host) >= 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var target = targetAt(event.clientX, event.clientY);
    if (target) pick(target);
  }

  function onKeyDown(event) {
    if (!state.mode || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    emit({ type: "exit" });
  }

  function pick(element) {
    var token = "p" + nextToken++;
    picked.clear();
    picked.set(token, element);
    state.anchor = { kind: "pick", token: token };
    // Hide the overlays for the frame the element's screenshot is taken from; main shows them again.
    setHidden(true);
    // Main shows them again once it has the screenshot; never leave them hidden if it does not.
    setTimeout(function () { if (hidden) { setHidden(false); schedule(); } }, 4000);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!element.isConnected) { setHidden(false); return; }
        emit({ type: "pick", token: token, url: location.href, title: document.title, rect: rectOf(element), viewport: viewport(), element: describe(element) });
      });
    });
  }

  function setHidden(value) {
    hidden = value;
    if (host) host.style.setProperty("visibility", value ? "hidden" : "visible", "important");
    if (value && hoverBox) { hoverBox.style.display = "none"; hoverLabel.style.display = "none"; }
  }

  function anchorElement() {
    var anchor = state.anchor;
    if (!anchor) return null;
    if (anchor.kind === "pick") return picked.get(anchor.token) || null;
    return located.get(anchor.id) || null;
  }

  function relocate() {
    var missing = [];
    var alive = new Set();
    for (var i = 0; i < state.pins.length; i++) {
      var pin = state.pins[i];
      alive.add(pin.id);
      var current = located.get(pin.id);
      if (!current || !current.isConnected) {
        current = locate(pin);
        if (current) located.set(pin.id, current); else located.delete(pin.id);
      }
      if (!current) missing.push(pin.id);
    }
    if (pendingScroll) {
      var target = located.get(pendingScroll);
      if (target) {
        pendingScroll = null;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    located.forEach(function (_, id) { if (!alive.has(id)) located.delete(id); });
    var key = location.href + "|" + missing.join(",");
    if (key !== lastMissing) {
      lastMissing = key;
      emit({ type: "pins", url: location.href, missing: missing });
    }
  }

  function renderPins() {
    if (!pinLayer) return;
    var wanted = new Set();
    for (var i = 0; i < state.pins.length; i++) {
      var pin = state.pins[i];
      var element = located.get(pin.id);
      var node = pinNodes.get(pin.id);
      if (!element || !element.isConnected) { if (node) node.style.display = "none"; continue; }
      wanted.add(pin.id);
      if (!node) {
        node = document.createElement("div");
        node.className = "pin";
        (function (id) {
          node.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); emit({ type: "pin-click", id: id }); });
          node.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
          node.addEventListener("mousedown", function (event) { event.stopPropagation(); });
        })(pin.id);
        pinNodes.set(pin.id, node);
        pinLayer.appendChild(node);
      }
      node.className = pin.resolved ? "pin resolved" : "pin";
      node.textContent = pin.resolved ? "\u2713" : String(pin.number);
      var rect = rectOf(element);
      node.style.left = rect.x + "px";
      node.style.top = rect.y + "px";
      var visible = rect.width + rect.height > 0 && rect.y + rect.height >= 0 && rect.y <= window.innerHeight;
      node.style.display = visible ? "flex" : "none";
    }
    pinNodes.forEach(function (node, id) {
      var keep = false;
      for (var i = 0; i < state.pins.length; i++) if (state.pins[i].id === id) keep = true;
      if (!keep) { node.remove(); pinNodes.delete(id); }
      else if (!wanted.has(id)) node.style.display = "none";
    });
  }

  function renderAnchor() {
    var element = anchorElement();
    var rect = element && element.isConnected ? rectOf(element) : null;
    if (anchorBox) {
      if (rect && !hidden) place(anchorBox, rect); else anchorBox.style.display = "none";
    }
    var view = viewport();
    var key = rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height), view.width, view.height].join(",") : "none," + view.width + "," + view.height;
    if (key !== lastAnchor && state.anchor) {
      lastAnchor = key;
      emit({ type: "anchor", rect: rect, viewport: view });
    }
    if (!state.anchor) lastAnchor = "";
  }

  function render() {
    frame = 0;
    if (!needed()) { if (host && host.isConnected) host.remove(); return; }
    if (!ensureUi()) return;
    renderPins();
    renderAnchor();
    if (hidden) return;
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(render);
  }

  function scheduleRelocate() {
    if (relocateTimer) return;
    relocateTimer = setTimeout(function () {
      relocateTimer = 0;
      if (!state.pins.length) return;
      relocate();
      schedule();
    }, 400);
  }

  function needed() {
    return state.mode || state.pins.length > 0 || state.anchor !== null;
  }

  function watchDom() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var target = records[i].target;
        if (host && (target === host || host.contains(target))) continue;
        scheduleRelocate();
        return;
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  var api = {
    apply: function (next) {
      var previous = state.anchor;
      state = { mode: !!next.mode, pins: Array.isArray(next.pins) ? next.pins : [], anchor: next.anchor || null };
      if (state.anchor && state.anchor.kind === "pick" && !picked.has(state.anchor.token)) state.anchor = null;
      if (!state.anchor || state.anchor.kind !== "pick") picked.clear();
      if (cursorStyle) cursorStyle.disabled = !state.mode;
      else if (state.mode && document.head) {
        cursorStyle = document.createElement("style");
        cursorStyle.textContent = "html, html * { cursor: crosshair !important; }";
        document.head.appendChild(cursorStyle);
      }
      if (!state.mode && hoverBox) { hoverBox.style.display = "none"; hoverLabel.style.display = "none"; }
      var anchor = state.anchor;
      if (anchor && anchor.kind === "pin" && anchor.scroll && (!previous || previous.kind !== "pin" || previous.id !== anchor.id)) {
        pendingScroll = anchor.id;
      } else if (!anchor || anchor.kind !== "pin") {
        pendingScroll = null;
      }
      if (state.pins.length) { watchDom(); relocate(); }
      else if (lastMissing) { lastMissing = ""; }
      lastAnchor = "";
      schedule();
      return true;
    },
    show: function () {
      setHidden(false);
      schedule();
      return true;
    },
    pickedElement: function (token) {
      return picked.get(token) || null;
    }
  };
  Object.defineProperty(globalThis, "__cofluxAnnotatorApi", { value: api, configurable: false, enumerable: false, writable: false });

  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  window.addEventListener("pointerdown", swallow, true);
  window.addEventListener("mousedown", swallow, true);
  window.addEventListener("pointerup", swallow, true);
  window.addEventListener("mouseup", swallow, true);
  window.addEventListener("dblclick", swallow, true);
  window.addEventListener("contextmenu", swallow, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  setInterval(function () { if (needed()) schedule(); }, 500);

  function announce() { emit({ type: "ready", url: location.href }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce, { once: true });
  else announce();
})();`;

/**
 * Runs in the page's **main** world with `this` = the picked element (`Runtime.callFunctionOn`):
 * reads framework source identity from the page's own development data. React: the fiber on the
 * element, component names up the `return` chain and `_debugSource` (React ≤ 18 development builds;
 * React 19 has names only). Vue 3: `__vueParentComponent` and `type.__file`; Vue 2: `__vue__`.
 * Pure reads with bounded loops; any failure yields what was found so far. Returned by value.
 */
export const SOURCE_IDENTITY_READER = String.raw`function () {
  var out = { framework: "", components: [], file: "", line: 0, column: 0 };
  function push(name) {
    if (typeof name !== "string" || !name || name.length > 200) return;
    if (out.components[out.components.length - 1] !== name) out.components.push(name);
  }
  function reactName(type, depth) {
    if (!type || depth > 4) return "";
    if (typeof type === "function") return type.displayName || type.name || "";
    if (typeof type === "object") {
      if (typeof type.displayName === "string") return type.displayName;
      if (type.render) return reactName(type.render, depth + 1);
      if (type.type) return reactName(type.type, depth + 1);
    }
    return "";
  }
  try {
    var element = this;
    for (var up = 0; element && up < 8 && !out.framework; up++, element = element.parentElement) {
      var keys = Object.keys(element);
      var fiber = null;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) { fiber = element[keys[i]]; break; }
      }
      if (fiber) {
        out.framework = "react";
        for (var node = fiber, steps = 0; node && steps < 300 && out.components.length < 12; node = node.return, steps++) {
          if (typeof node.type !== "string") push(reactName(node.type, 0));
          var source = node._debugSource;
          if (!out.file && source && typeof source.fileName === "string") {
            out.file = source.fileName;
            out.line = Number(source.lineNumber) || 0;
            out.column = Number(source.columnNumber) || 0;
          }
        }
        break;
      }
      var instance = element.__vueParentComponent;
      if (instance) {
        out.framework = "vue";
        for (var steps3 = 0; instance && steps3 < 50 && out.components.length < 12; instance = instance.parent, steps3++) {
          var type = instance.type || {};
          var file = typeof type.__file === "string" ? type.__file : "";
          push(type.name || type.__name || (file ? file.split("/").pop().replace(/\.vue$/, "") : ""));
          if (!out.file && file) out.file = file;
        }
        break;
      }
      var vm = element.__vue__;
      if (vm) {
        out.framework = "vue";
        for (var steps2 = 0; vm && steps2 < 50 && out.components.length < 12; vm = vm.$parent, steps2++) {
          var options = vm.$options || {};
          push(options.name || options._componentTag || "");
          if (!out.file && typeof options.__file === "string") out.file = options.__file;
        }
        break;
      }
    }
  } catch (error) {}
  return out;
}`;
