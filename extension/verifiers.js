// KP.verify: local, read-only checks that a step really worked (contract §11).
// Pure reads: no clicks, no typing, no network, no changes to the page.
// Never returns or logs field values or page text; `detail` is a short status word.
globalThis.KP = globalThis.KP || {};

(() => {
  const DEBUG = false;
  const MAX_ARGS_JSON = 300;
  const MAX_TEXT = 60, MAX_ROLE = 40, MAX_LABEL = 80;
  const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const SAFE_ROLE = /^[a-z]{1,40}$/;

  const R = () => KP.reader && KP.reader.util;           // helpers from page-reader.js
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const result = (passed, detail) => ({ passed: !!passed, detail });
  const log = (...a) => { if (DEBUG) console.log("KoiPilot verify:", ...a); };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const u = R();
    if (u) return u.isVisible(el);
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
  }

  // "Main content": <main> / [role=main] if the page has one, else the whole body.
  function mainRoot() {
    const mains = [...document.querySelectorAll("main,[role=main]")].filter(visible);
    return mains[0] || document.body;
  }

  // ---------- checkArgs validation ----------

  const isStr = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

  // Returns the cleaned args, or null if missing / wrong / too big.
  function validArgs(check, args) {
    if (args != null && (typeof args !== "object" || Array.isArray(args))) return null;
    let json;
    try { json = JSON.stringify(args || {}); } catch { return null; }
    if (json.length > MAX_ARGS_JSON) return null;
    const a = args || {};
    switch (check) {
      case "text_visible":
        return isStr(a.text, MAX_TEXT) ? { text: a.text } : null;
      case "element_visible":
      case "field_filled":
        return isStr(a.role, MAX_ROLE) && isStr(a.label, MAX_LABEL) && SAFE_ROLE.test(norm(a.role))
          ? { role: norm(a.role), label: a.label } : null;
      default:
        return {}; // checks without arguments ignore anything extra
    }
  }

  // ---------- shop ----------

  // A heading matching /return policy/i is rendered inside main content.
  function policyVisible() {
    const hit = [...mainRoot().querySelectorAll(HEADING_SELECTOR)]
      .some((h) => /return policy/i.test(h.textContent || "") && visible(h));
    return result(hit, hit ? "visible" : "not_visible");
  }

  // ---------- menus ----------

  const POPUP_ROLES = new Set(["menu", "listbox", "dialog", "tree", "grid"]);

  // An open <details> with visible content, a visible menu/listbox, or a visible expanded
  // popup button (aria-haspopup, or controlling a menu/listbox/dialog) whose popup is visible.
  // Plain expanded sections (e.g. an always-open sidebar) do not count.
  function menuOpen() {
    for (const d of document.querySelectorAll("details[open]")) {
      const body = [...d.children].find((c) => c.tagName !== "SUMMARY");
      if (visible(d) && body && visible(body)) return result(true, "details_open");
    }
    for (const m of document.querySelectorAll("[role=menu],[role=listbox]")) {
      if (visible(m)) return result(true, "menu_visible");
    }
    for (const b of document.querySelectorAll("[aria-expanded=true]")) {
      if (!visible(b)) continue;
      const popup = (b.getAttribute("aria-haspopup") || "false").toLowerCase();
      const ids = (b.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean);
      const open = ids.map((id) => document.getElementById(id)).filter(visible);
      if (open.length && (popup !== "false" || open.some((el) => POPUP_ROLES.has((el.getAttribute("role") || "").toLowerCase())))) {
        return result(true, "expanded");
      }
    }
    return result(false, "closed");
  }

  // ---------- GitHub (untested on live GitHub) ----------

  function repoNameField() {
    const fields = [...document.querySelectorAll("input")].filter((i) => {
      const t = (i.getAttribute("type") || "text").toLowerCase();
      if (t !== "text" && t !== "") return false;
      const ident = `${i.id} ${i.getAttribute("name") || ""}`.toLowerCase();
      const lbl = R() ? R().labelOf(i) : i.getAttribute("aria-label") || "";
      return /repository[_-]?name/.test(ident) || /repository name/i.test(lbl);
    });
    return fields.find(visible) || null;
  }

  function nameFieldVisible() {
    const f = repoNameField();
    return result(!!f, f ? "visible" : "not_visible");
  }

  // Visible text matching re inside root (text nodes only; nothing is returned).
  function visibleTextMatches(root, re) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (re.test(n.nodeValue || "") && visible(n.parentElement)) return true;
    }
    return false;
  }

  function nameAvailable() {
    const f = repoNameField();
    if (!f) return result(false, "no_field");
    if (!String(f.value || "").trim()) return result(false, "empty"); // value read locally only
    const scope = f.closest("form") || document.body;
    if (visibleTextMatches(scope, /already exists/i)) return result(false, "name_taken");
    return result(true, "available");
  }

  // context.expected = { owner, name } is supplied by content.js and never sent anywhere.
  function repoCreated(context) {
    const exp = context && context.expected;
    if (!exp || !isStr(exp.owner, 100) || !isStr(exp.name, 100)) return result(false, "no_expected");
    const want = `/${exp.owner}/${exp.name}`.toLowerCase();
    const path = location.pathname.replace(/\/+$/, "").toLowerCase();
    if (location.host !== "github.com" || path !== want) return result(false, "wrong_page");
    // Header shows the repo: a visible link to /owner/name, or the repo name element.
    const link = [...document.querySelectorAll("a[href]")].some((a) => {
      const href = (a.getAttribute("href") || "").replace(/\/+$/, "").toLowerCase();
      return (href === want || href === `https://github.com${want}`) && visible(a);
    });
    const nameEl = [...document.querySelectorAll("[itemprop=name], strong a, h1 a")]
      .some((e) => norm(e.textContent) === norm(exp.name) && visible(e));
    return result(link || nameEl, link || nameEl ? "created" : "header_missing");
  }

  // ---------- generic checks (any website, used by custom) ----------

  // URL path or hash differs from when the step was shown, or the page reloaded.
  function pageChanged(context) {
    if (context && context.reloaded) return result(true, "reloaded");
    const start = context && context.startUrl;
    if (typeof start !== "string" || !start) return result(false, "no_start_url");
    let s;
    try { s = new URL(start, location.href); } catch { return result(false, "no_start_url"); }
    const changed = s.pathname !== location.pathname || s.hash !== location.hash || s.host !== location.host;
    return result(changed, changed ? "changed" : "same_page");
  }

  // That text (case-insensitive) is rendered and visible in the main content.
  // innerText only contains rendered text (no display:none, no closed <details>).
  function textVisible(args) {
    const want = norm(args.text);
    const hay = norm(mainRoot().innerText || "");
    return result(hay.includes(want), hay.includes(want) ? "visible" : "not_visible");
  }

  const IMPLICIT = { dialog: "dialog", heading: "h1,h2,h3,h4,h5,h6", navigation: "nav", main: "main" };

  // A visible element with that role and label (controls via KP.reader, plus non-control
  // roles such as dialog / tabpanel / heading).
  function elementVisible(args) {
    const label = norm(args.label);
    if (KP.reader) {
      const hit = KP.reader.scan().controls.some((c) => norm(c.role) === args.role && norm(c.label) === label);
      if (hit) return result(true, "visible");
    }
    const sel = [`[role=${args.role}]`, IMPLICIT[args.role]].filter(Boolean).join(",");
    const u = R();
    const hit = [...document.querySelectorAll(sel)].some((el) => {
      if (!visible(el)) return false;
      const name = u ? u.labelOf(el) : el.getAttribute("aria-label") || "";
      return norm(name) === label || (args.role === "heading" && norm(el.textContent) === label);
    });
    return result(hit, hit ? "visible" : "not_visible");
  }

  // That field has a non-empty value. The value is only checked here, never returned or sent.
  function fieldFilled(args) {
    if (!KP.reader) return result(false, "no_reader");
    const scan = KP.reader.scan();
    const id = KP.reader.match({ role: args.role, label: args.label }, scan.controls);
    if (typeof id !== "string") return result(false, id && id.ambiguous ? "ambiguous" : "not_found");
    const el = scan.map.get(id);
    const value = el.isContentEditable ? el.textContent : el.value;
    const filled = String(value || "").trim().length > 0;
    return result(filled, filled ? "filled" : "empty");
  }

  // ---------- entry point ----------

  const CHECKS = {
    policy_visible: () => policyVisible(),
    menu_open: () => menuOpen(),
    name_field_visible: () => nameFieldVisible(),
    name_available: () => nameAvailable(),
    repo_created: (ctx) => repoCreated(ctx),
    page_changed: (ctx) => pageChanged(ctx),
    text_visible: (ctx, a) => textVisible(a),
    element_visible: (ctx, a) => elementVisible(a),
    field_filled: (ctx, a) => fieldFilled(a)
  };

  // run(check, context, checkArgs) → { passed, detail }
  function run(check, context, checkArgs) {
    if (typeof check !== "string" || !Object.prototype.hasOwnProperty.call(CHECKS, check)) {
      return result(false, "unsupported_check");
    }
    const args = validArgs(check, checkArgs);
    if (!args) return result(false, "bad_args");
    try {
      return CHECKS[check](context || {}, args);
    } catch (e) {
      log("check failed", check, e);
      return result(false, "error");
    }
  }

  KP.verify = { run, supported: Object.keys(CHECKS) };
})();
