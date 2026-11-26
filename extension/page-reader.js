// KP.reader: reads the page's visible controls as semantic data.
// Pure reads. Never reads field values. Nothing here runs until called.
globalThis.KP = globalThis.KP || {};

(() => {
  const DEBUG = false;
  const MAX_CONTROLS = 150;
  const MAX_LABEL = 80;
  const MAX_HEADING = 60;
  const MAX_CONTEXT = 60;
  const HOST_ID = "koipilot-host";

  const CONTROL_SELECTOR = [
    "a[href]", "button", "[role=button]", "[role=link]", "[role=menuitem]",
    "summary", "input", "textarea", "select"
  ].join(",");
  const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "number"]);
  const LANDMARK_TAGS = new Set(["NAV", "MAIN", "HEADER", "FOOTER", "ASIDE", "FORM", "SEARCH", "DIALOG"]);
  const LANDMARK_ROLES = new Set([
    "navigation", "main", "banner", "contentinfo", "complementary",
    "form", "search", "region", "dialog", "alertdialog"
  ]);
  // Extra guard for payment fields that don't use autocomplete="cc-*".
  const PAYMENT_NAME = /(cc-?num|card.?num|cardnumber|cvv|cvc|csc|security.?code|expiry|exp-?date)/i;

  function clean(text, max) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function norm(text) {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  // Parent that also steps out of shadow roots to the host element.
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.parentNode;
    return root && root.host ? root.host : null;
  }

  function* ancestors(el) {
    for (let a = parentOf(el); a; a = parentOf(a)) yield a;
  }

  // Text of a node for naming purposes. Skips form-field contents (never values),
  // scripts and styles; uses alt text for images.
  function textOf(node) {
    let out = "";
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue + " "; return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const tag = n.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "SELECT" ||
          tag === "INPUT" || tag === "OPTION" || tag === "TEMPLATE" || tag === "NOSCRIPT") return;
      if (n.getAttribute("aria-hidden") === "true") return;
      if (tag === "IMG") { out += (n.getAttribute("alt") || "") + " "; return; }
      for (const c of n.childNodes) walk(c);
    };
    walk(node);
    return out;
  }

  function byIdText(el, ids) {
    const root = el.getRootNode();
    return ids.split(/\s+/).map((id) => {
      const ref = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      return ref ? textOf(ref) : "";
    }).join(" ");
  }

  function isTextField(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    return el.tagName === "INPUT" && TEXT_INPUT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
  }

  // Accessible-name approximation, in the order agreed in the brief.
  function labelOf(el) {
    const aria = clean(el.getAttribute("aria-label"), MAX_LABEL);
    if (aria) return aria;
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = clean(byIdText(el, lb), MAX_LABEL);
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map(textOf).join(" "), MAX_LABEL);
      if (t) return t;
    }
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      // Button inputs show their value as their visible label; text fields never.
      if (type === "submit" || type === "button") {
        const t = clean(el.value || (type === "submit" ? "Submit" : ""), MAX_LABEL);
        if (t) return t;
      }
    } else if (!isTextField(el)) {
      const t = clean(textOf(el), MAX_LABEL);
      if (t) return t;
    }
    const title = clean(el.getAttribute("title"), MAX_LABEL);
    if (title) return title;
    return clean(el.getAttribute("placeholder"), MAX_LABEL);
  }

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
    if (explicit) return explicit;
    switch (el.tagName) {
      case "A": return "link";
      case "BUTTON": return "button";
      case "SUMMARY": return "button";
      case "SELECT": return "combobox";
      case "TEXTAREA": return "textbox";
      case "INPUT": {
        const type = (el.getAttribute("type") || "").toLowerCase();
        return type === "submit" || type === "button" ? "button" : "textbox";
      }
      default: return "";
    }
  }

  // Returns true for controls we are allowed to describe at all.
  function isEligible(el) {
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type !== "submit" && type !== "button" && !TEXT_INPUT_TYPES.has(type)) return false;
    }
    if (isTextField(el) || el.tagName === "INPUT") {
      const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
      if (/(^|\s)cc-/.test(ac)) return false;
      const ident = (el.getAttribute("name") || "") + " " + (el.id || "");
      if (PAYMENT_NAME.test(ident)) return false;
    }
    return true;
  }

  function isDisabled(el) {
    if (el.matches(":disabled")) return true;
    return el.getAttribute("aria-disabled") === "true";
  }

  // Rendered, non-zero size, not hidden by CSS, aria-hidden or a closed <details>.
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    }
    if (el.getAttribute("aria-hidden") === "true" || el.inert) return false;
    let child = el;
    for (const a of ancestors(el)) {
      if (a.getAttribute("aria-hidden") === "true" || a.inert) return false;
      if (a.tagName === "DETAILS" && !a.open) {
        // Only the details' own <summary> (and what's inside it) stays visible.
        if (!(child.tagName === "SUMMARY" && child.parentElement === a)) return false;
      }
      child = a;
    }
    return true;
  }

  function insideOverlay(el) {
    if (el.id === HOST_ID) return true;
    for (const a of ancestors(el)) if (a.id === HOST_ID) return true;
    return false;
  }

  function isLandmark(el) {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (LANDMARK_ROLES.has(role)) return true;
    if (LANDMARK_TAGS.has(el.tagName)) return true;
    // A <section> counts as a region only when it has a name.
    return el.tagName === "SECTION" &&
      (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"));
  }

  function landmarkOf(el) {
    for (const a of ancestors(el)) if (isLandmark(a)) return a;
    return null;
  }

  // Heading scope: nearest landmark or any <section>/<article>.
  function sectionOf(el) {
    for (const a of ancestors(el)) {
      if (isLandmark(a) || a.tagName === "SECTION" || a.tagName === "ARTICLE") return a;
    }
    return null;
  }

  function contextOf(el) {
    const lm = landmarkOf(el);
    if (!lm) return "";
    const aria = clean(lm.getAttribute("aria-label"), MAX_CONTEXT);
    if (aria) return aria;
    const lb = lm.getAttribute("aria-labelledby");
    if (lb) {
      const t = clean(byIdText(lm, lb), MAX_CONTEXT);
      if (t) return t;
    }
    // Unnamed landmark: its explicit role (e.g. "search" on a <div>), else its tag.
    const role = (lm.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
    return role || lm.tagName.toLowerCase();
  }

  // Bring el up to the same tree as `scope` (through shadow hosts) for position checks.
  function inTreeOf(el, scope) {
    const root = scope.getRootNode();
    let n = el;
    while (n && n.getRootNode() !== root) n = n.getRootNode().host || null;
    return n;
  }

  function headingOf(el, headingCache) {
    const scope = sectionOf(el) || document.documentElement;
    let list = headingCache.get(scope);
    if (!list) {
      list = [...scope.querySelectorAll(HEADING_SELECTOR)];
      headingCache.set(scope, list);
    }
    const pos = inTreeOf(el, scope);
    if (!pos) return "";
    let best = null;
    for (const h of list) {
      const rel = h.compareDocumentPosition(pos);
      // Heading before the control, or containing it.
      if ((rel & Node.DOCUMENT_POSITION_FOLLOWING) || (rel & Node.DOCUMENT_POSITION_CONTAINED_BY)) best = h;
      else break;
    }
    return best ? clean(textOf(best), MAX_HEADING) : "";
  }

  // Document-order walk that also enters open shadow roots. Iframes are skipped.
  function collect(root, out) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (out.length >= MAX_CONTROLS * 20) return; // hard stop on huge pages
      if (el.id === HOST_ID) continue;
      if (el.matches(CONTROL_SELECTOR)) out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
  }

  function scan() {
    const candidates = [];
    collect(document.documentElement, candidates);
    const controls = [];
    const map = new Map();
    const headingCache = new Map();
    for (const el of candidates) {
      if (controls.length >= MAX_CONTROLS) break;
      try {
        if (!isEligible(el) || isDisabled(el) || insideOverlay(el) || !isVisible(el)) continue;
        const role = roleOf(el);
        if (!role) continue; // e.g. SVG <a>, which has no HTML role here
        const label = labelOf(el);
        if (!label) continue;
        const id = "c" + (controls.length + 1);
        controls.push({
          id,
          role,
          label,
          nearbyHeading: headingOf(el, headingCache),
          context: contextOf(el)
        });
        map.set(id, el);
      } catch (e) {
        if (DEBUG) console.warn("KoiPilot reader: skipped a control", e);
      }
    }
    return { state: state(), controls, map };
  }

  // ---- Start state (contract §3.1) ----

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const LONG_HEX = /^(?=.*\d)[0-9a-f]{8,}$/;

  // Lowercase path, no query/hash, variable segments → "*", no trailing slash.
  function pathShape(pathname = location.pathname) {
    const segs = String(pathname).toLowerCase().split("/").filter(Boolean).map((s) =>
      (/^\d+$/.test(s) || UUID.test(s) || LONG_HEX.test(s) || s.length > 24) ? "*" : s
    );
    return "/" + segs.join("/");
  }

  function isGithubHome() {
    const p = location.pathname.replace(/\/+$/, "") || "/";
    if (p === "/" || p === "/dashboard" || p === "/repositories") return true;
    // Profile repositories tab: /<user>?tab=repositories
    const one = /^\/[^/]+$/.test(p);
    return one && new URLSearchParams(location.search).get("tab") === "repositories";
  }

  function state() {
    const host = location.host;
    const path = location.pathname.replace(/\/+$/, "");
    if (host === "127.0.0.1:8787" && path === "/shop") {
      return location.hash === "#returns" ? "store_policy" : "store_home";
    }
    if (host === "github.com" && isGithubHome()) return "github_home";
    return "p:" + pathShape();
  }

  // ---- Semantic match (contract §4, §8) ----

  function match(semanticTarget, controls) {
    const t = semanticTarget || {};
    const role = norm(t.role);
    const label = norm(t.label);
    if (!role || !label) return { notFound: true };
    const list = Array.isArray(controls) ? controls : scan().controls;
    let set = list.filter((c) => norm(c.role) === role && norm(c.label) === label);
    if (set.length === 0) return { notFound: true };
    if (set.length === 1) return set[0].id;
    for (const key of ["nearbyHeading", "context"]) {
      const want = norm(t[key]);
      if (!want) continue;
      const narrowed = set.filter((c) => norm(c[key]) === want);
      if (narrowed.length === 1) return narrowed[0].id;
      if (narrowed.length > 1) set = narrowed;
    }
    return { ambiguous: true };
  }

  KP.reader = {
    scan,
    state,
    match,
    pathShape,
    // Shared helpers for verifiers.js (read-only).
    util: { clean, norm, textOf, labelOf, roleOf, isVisible, isDisabled, isTextField, landmarkOf, ancestors }
  };
})();
