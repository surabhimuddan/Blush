// KoiPilot background service worker: the only place that talks to the backend.
// Routes panel ↔ content messages (contract §7), keeps per-tab task state in
// chrome.storage.session (the worker can be suspended at any time), and guards every
// async continuation against stale runs/requests.
import { API_BASE, DEBUG } from "./config.js";

const TIMEOUT_MS = 25000;
const MAX_STEPS = 20;
const MAX_CONTROLS = 150;
const COMPLETE_RETRIES = 2;
const GREETING = "Hi, I'm Blush! Tell me what you want to do, or paste instructions.";
const DEMO_SHOP = "127.0.0.1:8787";
const GENERIC_CHECKS = ["page_changed", "text_visible", "element_visible", "menu_open", "field_filled"];
const ALLOWED_CHECKS = {
  find_returns: ["policy_visible"],
  github_create_repo: ["menu_open", "name_field_visible", "name_available", "repo_created"],
  custom: GENERIC_CHECKS,
  tutorial: GENERIC_CHECKS
};
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const CONTENT_TYPES = new Set(["CONTENT_READY", "PAGE_SCAN", "STEP_COMPLETED", "STEP_NOT_FOUND", "STEP_OFF_ROUTE", "TASK_COMPLETED", "TASK_STATUS", "TASK_ERROR"]);
const PANEL_TYPES = new Set(["PANEL_START", "PANEL_STOP", "PANEL_REPEAT", "PANEL_SET_MUTE", "PANEL_GET_STATE", "PANEL_MIC_SETUP", "PANEL_PLAY_AUDIO", "PANEL_ASK", "PANEL_TUTORIAL", "PANEL_OPENED"]);

const log = (...a) => { if (DEBUG) console.log("KoiPilot bg:", ...a); };

// ---------- small helpers ----------

const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();

function goalKeyOf(goal) {
  return goal.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

function cleanTarget(t) {
  if (!isObj(t)) return null;
  const role = str(t.role, 40), label = str(t.label, 80);
  if (!role || !label) return null;
  return { role, label, nearbyHeading: str(t.nearbyHeading, 60), context: str(t.context, 60) };
}

function cleanControls(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, MAX_CONTROLS)) {
    const t = cleanTarget(c);
    const id = str(c && c.id, 10);
    if (t && /^c\d+$/.test(id)) out.push({ id, ...t });
  }
  return out;
}

function cleanStart(s) {
  if (!isObj(s)) return { state: "", urlPattern: "", pageTitle: "", heading: "" };
  return { state: str(s.state, 200), urlPattern: str(s.urlPattern, 200), pageTitle: str(s.pageTitle, 80), heading: str(s.heading, 80) };
}

function cleanArgs(a) {
  if (!isObj(a)) return {};
  try { return JSON.stringify(a).length <= 300 ? JSON.parse(JSON.stringify(a)) : {}; } catch { return {}; }
}

function cleanStep(s, allowed, order) {
  const target = cleanTarget(s && s.target);
  if (!target || !allowed.includes(s.check)) return null;
  const step = { order, target, hint: str(s.hint, 160), check: s.check, checkArgs: cleanArgs(s.checkArgs) };
  if (typeof s.isFinal === "boolean") step.isFinal = s.isFinal;
  return step;
}

function cleanRoute(route, task) {
  if (!isObj(route) || !Array.isArray(route.steps)) return null;
  const allowed = ALLOWED_CHECKS[task] || [];
  const steps = [];
  for (const s of route.steps.slice(0, MAX_STEPS)) {
    const c = cleanStep(s, allowed, steps.length + 1);
    if (!c) return null; // a route with a bad step is not replayed
    steps.push(c);
  }
  return steps.length ? { version: route.version, site: route.site, task: route.task, start: route.start, steps, verifiedRuns: route.verifiedRuns } : null;
}

// ---------- state (chrome.storage.session, serialized per key) ----------

const S = chrome.storage.session;
const locks = new Map();

function locked(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

const tabKey = (id) => `tab:${id}`;

// fn(box): box.st is the tab's state (or null). Set box.st = null to delete it.
function withTab(tabId, fn) {
  return locked(tabKey(tabId), async () => {
    const box = { st: (await S.get(tabKey(tabId)))[tabKey(tabId)] || null };
    const out = await fn(box);
    if (box.st) await S.set({ [tabKey(tabId)]: box.st });
    else await S.remove(tabKey(tabId));
    return out;
  });
}

async function readTab(tabId) {
  return (await S.get(tabKey(tabId)))[tabKey(tabId)] || null;
}

const META_DEFAULT = { ready: {}, activeTabId: null, greeted: false, muted: false };

function withMeta(fn) {
  return locked("meta", async () => {
    const box = { meta: { ...META_DEFAULT, ...((await S.get("meta")).meta || {}) } };
    const out = await fn(box.meta);
    await S.set({ meta: box.meta });
    return out;
  });
}

async function readMeta() {
  return { ...META_DEFAULT, ...((await S.get("meta")).meta || {}) };
}

// ---------- talking to the panel and tabs ----------

function toPanel(type, payload) {
  try { chrome.runtime.sendMessage({ type, payload }).catch(() => {}); } catch { /* panel closed */ }
}

async function toTab(tabId, type, payload = {}) {
  try { return await chrome.tabs.sendMessage(tabId, { type, payload }); } catch { return null; }
}

function panelPayload(st, muted) {
  return {
    status: st ? st.status : "idle",
    goal: st ? st.goal : "",
    task: st ? st.task : "",
    currentStep: st ? Math.min(st.stepIndex + 1, st.totalSteps || MAX_STEPS) : 0,
    totalSteps: st && st.totalSteps ? st.totalSteps : null,
    muted: !!muted,
    verifiedRuns: st ? st.verifiedRuns : 0,
    planningCalls: st ? st.planningCalls : 0,
    tutorialSteps: st && st.tutorial ? st.tutorial.steps : null
  };
}

async function pushState(tabId) {
  const [st, meta] = await Promise.all([tabId == null ? null : readTab(tabId), readMeta()]);
  const payload = panelPayload(st, meta.muted);
  toPanel("PANEL_STATE", payload);
  toPanel("PANEL_COUNTERS", { verifiedRuns: payload.verifiedRuns, planningCalls: payload.planningCalls });
  return payload;
}

function panelStatus(status, message) {
  toPanel("PANEL_STATUS", { status, message: message || "" });
}

// ---------- backend ----------

async function api(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json" };
    const { demoToken } = await S.get("demoToken");
    if (typeof demoToken === "string" && demoToken) headers.Authorization = `Bearer ${demoToken}`;
    const res = await fetch(API_BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const e = new Error(data && typeof data.error === "string" ? data.error.slice(0, 120) : `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return isObj(data) ? data : {};
  } catch (e) {
    if (e.name === "AbortError") { const t = new Error("The backend took too long (25 s)."); t.network = true; throw t; }
    if (!e.status) e.network = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function errorText(e) {
  if (e && e.network) return "Can't reach the KoiPilot backend. Press Repeat to try again.";
  return `Backend error: ${str(e && e.message, 120)}. Press Repeat to try again.`;
}

// ---------- which tab ----------

const isExtensionPage = (url) => typeof url === "string" && url.startsWith(chrome.runtime.getURL(""));

// The panel's tab: the active page in the panel's window if it has our content script.
// If the panel is itself a tab (dev panel), the most recent page that sent CONTENT_READY.
async function resolveTab(sender) {
  const meta = await readMeta();
  let windowId = sender.tab ? sender.tab.windowId : null;
  if (windowId == null) {
    try { windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id; } catch { windowId = null; }
  }
  const [active] = await chrome.tabs.query(windowId != null ? { active: true, windowId } : { active: true, lastFocusedWindow: true });
  if (active && !(sender.tab && sender.tab.id === active.id)) {
    return meta.ready[active.id] ? active.id : null; // e.g. chrome:// or Web Store → unsupported
  }
  const candidates = Object.entries(meta.ready)
    .filter(([, r]) => windowId == null || r.windowId === windowId)
    .sort((a, b) => b[1].at - a[1].at);
  return candidates.length ? Number(candidates[0][0]) : null;
}

// Prefer the tab with a running task (Stop, Repeat, Ask…), else resolve as above.
async function runTab(sender) {
  const meta = await readMeta();
  if (meta.activeTabId != null) {
    const st = await readTab(meta.activeTabId);
    if (st && st.active) return meta.activeTabId;
  }
  return resolveTab(sender);
}

async function forgetReady(tabId) {
  await withMeta((m) => { delete m.ready[tabId]; });
}

// ---------- starting a run ----------

function mapGoal(goal, host) {
  if (host === DEMO_SHOP && /return|refund/i.test(goal)) return { task: "find_returns" };
  if (host === "github.com" && /\brepo(sitory)?\b|repositories/i.test(goal)) return { task: "github_create_repo" };
  return { task: "custom", goal, goalKey: goalKeyOf(goal) };
}

async function stopTab(tabId, notify = true) {
  await toTab(tabId, "TASK_STOP");
  await withTab(tabId, (box) => { box.st = null; }); // drops every late response for this run
  await withMeta((m) => { if (m.activeTabId === tabId) m.activeTabId = null; });
  if (notify) { panelStatus("stopped", ""); await pushState(null); }
}

async function startRun(tabId, info, runId = crypto.randomUUID()) {
  const meta = await readMeta();
  if (meta.activeTabId != null && meta.activeTabId !== tabId) await stopTab(meta.activeTabId, false);

  const st = {
    active: true, runId, tabId,
    goal: info.goal || "", goalKey: info.goalKey || "", task: info.task, site: info.site,
    start: null, stepIndex: 0, pendingCheck: null, route: null, completedSteps: [],
    planningCalls: 0, verifiedRuns: 0, muted: meta.muted, status: "starting", requestId: 1,
    currentHint: "", tutorial: info.tutorial || null,
    totalSteps: info.tutorial ? info.tutorial.steps.length : null,
    planned: null, retry: null
  };
  await withTab(tabId, (box) => { box.st = st; });
  await withMeta((m) => { m.activeTabId = tabId; });
  await pushState(tabId);

  // This ends passive mode in the tab; the reply carries its start state and control scan.
  const reply = await toTab(tabId, "TASK_START", { runId, goal: st.goal, goalKey: st.goalKey, task: st.task, site: st.site });
  if (!reply || !reply.ok) {
    await withTab(tabId, (box) => { box.st = null; });
    panelStatus("unsupported_page", "KoiPilot can't run on this page.");
    return { ok: false, error: "unsupported_page" };
  }
  const start = cleanStart(reply.start);
  const controls = cleanControls(reply.controls);
  const ids = await withTab(tabId, (box) => {
    if (!box.st || box.st.runId !== runId) return null;
    box.st.start = start;
    return { runId, requestId: box.st.requestId };
  });
  if (!ids) return { ok: false, error: "stale" };

  // Already on the return policy: nothing to guide, and never look up a route from here.
  if (st.task === "find_returns" && start.state === "store_policy") {
    await toTab(tabId, "TASK_STOP");
    await withTab(tabId, (box) => { if (box.st) { box.st.active = false; box.st.status = "completed"; } });
    await toTab(tabId, "BLUSH_SAY", { text: "The return policy is already open on this page!", mode: "info" });
    panelStatus("completed", "The return policy is already open on this page.");
    await pushState(tabId);
    return { ok: true };
  }
  return lookUpRoute(tabId, ids, controls, reply.url);
}

function pathBody(st) {
  const body = { site: st.site, task: st.task, start: st.start };
  if (st.task === "custom") { body.goal = st.goal; body.goalKey = st.goalKey; }
  if (st.task === "tutorial" && st.tutorial) body.tutorialKey = st.tutorial.tutorialKey;
  return body;
}

// POST /path: a saved route → replay with no planning; none → plan the first step.
async function lookUpRoute(tabId, ids, controls, url) {
  const st0 = await readTab(tabId);
  if (!st0 || st0.runId !== ids.runId) return { ok: false, error: "stale" };
  let res;
  try {
    res = await api("/path", pathBody(st0));
  } catch (e) {
    await withTab(tabId, (box) => {
      if (box.st && box.st.runId === ids.runId) { box.st.status = "error"; box.st.retry = { kind: "path", controls, url }; }
    });
    panelStatus("error", errorText(e));
    await pushState(tabId);
    return { ok: false, error: "path_failed" };
  }
  const go = await withTab(tabId, (box) => {
    const st = box.st;
    if (!st || st.runId !== ids.runId || st.requestId !== ids.requestId) return null;
    st.retry = null;
    if (typeof res.verifiedRuns === "number") st.verifiedRuns = res.verifiedRuns;
    const route = cleanRoute(res.route, st.task);
    if (route) {
      st.route = route;
      st.totalSteps = st.tutorial ? st.totalSteps : route.steps.length;
      st.status = "guiding";
      return { route };
    }
    return { plan: true };
  });
  if (!go) return { ok: false, error: "stale" };
  await pushState(tabId);
  if (go.route) {
    if (res.repaired || res.routeVersion > 1) panelStatus("info", "Using the updated route for this page.");
    await toTab(tabId, "ROUTE_REPLAY", { route: go.route });
    return { ok: true, route: true };
  }
  return planStep(tabId, { controls, state: (await readTab(tabId)).start.state, url, reason: "new_route" });
}

// ---------- planning ----------

function currentInstruction(st) {
  if (!st.tutorial) return null;
  const s = st.tutorial.steps[st.tutorial.index];
  return s ? s.instruction : null;
}

function nextGuidable(tutorial, from) {
  for (let i = from; i < tutorial.steps.length; i++) if (!tutorial.steps[i].blocked) return i;
  return -1;
}

// POST /next with the page's controls → STEP_RESULT to the tab.
async function planStep(tabId, req) {
  const controls = cleanControls(req.controls);
  const prep = await withTab(tabId, (box) => {
    const st = box.st;
    if (!st || !st.active) return null;
    if (st.stepIndex >= MAX_STEPS) return { tooMany: true };
    st.requestId++;
    st.status = "planning";
    st.retry = { kind: "next", controls, state: req.state, url: req.url, reason: req.reason || null };
    const body = {
      runId: st.runId, site: st.site, task: st.task, state: str(req.state, 200), controls,
      allowedChecks: ALLOWED_CHECKS[st.task] || [], previousSteps: st.completedSteps.filter(Boolean)
    };
    if (req.reason) body.reason = req.reason;
    if (st.task === "custom") { body.goal = st.goal; body.goalKey = st.goalKey; }
    if (st.task === "tutorial") body.instruction = str(currentInstruction(st), 300);
    return { body, runId: st.runId, requestId: st.requestId };
  });
  if (!prep) return { ok: false, error: "no_active_task" };
  if (prep.tooMany) {
    panelStatus("error", "That took more than 20 steps, so I stopped.");
    return { ok: false, error: "too_many_steps" };
  }
  if (req.reason === "no_saved_target_match" || req.reason === "ambiguous_saved_target") {
    panelStatus("repairing", "This page changed. Finding the new way…");
  }
  await pushState(tabId);

  let res;
  try {
    res = await api("/next", prep.body);
  } catch (e) {
    await withTab(tabId, (box) => {
      if (box.st && box.st.runId === prep.runId && box.st.requestId === prep.requestId) box.st.status = "error";
    });
    panelStatus("error", errorText(e)); // the current step stays visible; Repeat retries
    await pushState(tabId);
    return { ok: false, error: "next_failed" };
  }

  const out = await withTab(tabId, (box) => {
    const st = box.st;
    if (!st || st.runId !== prep.runId || st.requestId !== prep.requestId) return null; // stale
    if (typeof res.planningCalls === "number") st.planningCalls = res.planningCalls; // backend is the truth
    const hint = str(res.hint, 160) || "I couldn't find that here.";
    if (res.targetId == null) {
      st.planned = null;
      st.pendingCheck = null;
      st.currentHint = hint;
      st.status = "waiting_for_user";
      st.retry = null;
      return { msg: { targetId: null, hint, check: null, checkArgs: {}, isFinal: false, source: str(res.source, 20) || "planner" } };
    }
    const c = controls.find((x) => x.id === res.targetId);
    if (!c || !prep.body.allowedChecks.includes(res.check)) { st.status = "error"; return { invalid: true }; }

    // Tutorial: only the last guidable instruction's final step ends the run.
    let isFinal = !!res.isFinal, instructionDone = false;
    if (st.task === "tutorial" && st.tutorial) {
      instructionDone = isFinal;
      isFinal = isFinal && nextGuidable(st.tutorial, st.tutorial.index + 1) === -1;
    }
    const step = {
      stepIndex: st.stepIndex,
      target: { role: c.role, label: c.label, nearbyHeading: c.nearbyHeading, context: c.context },
      hint, check: res.check, checkArgs: cleanArgs(res.checkArgs), isFinal,
      source: str(res.source, 20) || "planner"
    };
    st.planned = { ...step, instructionDone };
    st.pendingCheck = { ...step, startUrl: str(req.url, 2000) };
    st.currentHint = hint;
    st.status = "guiding";
    st.retry = null;
    return { msg: { targetId: c.id, hint, check: step.check, checkArgs: step.checkArgs, isFinal, source: step.source } };
  });
  if (!out) return { ok: false, error: "stale" };
  if (out.invalid) {
    panelStatus("error", "The planner returned an unusable step. Press Repeat to try again.");
    await pushState(tabId);
    return { ok: false, error: "bad_step" };
  }
  await toTab(tabId, "STEP_RESULT", out.msg);
  await pushState(tabId);
  return { ok: true };
}

function reasonForMissing(semanticTarget, controls) {
  const t = cleanTarget(semanticTarget);
  if (!t) return "no_saved_target_match";
  const n = controls.filter((c) => norm(c.role) === norm(t.role) && norm(c.label) === norm(t.label)).length;
  return n > 1 ? "ambiguous_saved_target" : "no_saved_target_match";
}

// ---------- completing ----------

async function completeRun(tabId, runId) {
  const prep = await withTab(tabId, (box) => {
    const st = box.st;
    if (!st || st.runId !== runId) return null;
    st.active = false;
    st.status = "completing";
    const steps = st.completedSteps.filter(Boolean).map((s, i) => ({ ...s, order: i + 1 }));
    const body = { runId: st.runId, site: st.site, task: st.task, start: st.start, steps };
    if (st.task === "custom") { body.goal = st.goal; body.goalKey = st.goalKey; }
    if (st.task === "tutorial" && st.tutorial) body.tutorialKey = st.tutorial.tutorialKey;
    return { body };
  });
  if (!prep) return { ok: false, error: "stale" };
  await withMeta((m) => { if (m.activeTabId === tabId) m.activeTabId = null; });
  await pushState(tabId);

  let res = null, lastErr = null;
  for (let attempt = 0; attempt <= COMPLETE_RETRIES && !res; attempt++) {
    try { res = await api("/complete", prep.body); } // same runId on every retry
    catch (e) { lastErr = e; if (!e.network) break; }
  }
  await withTab(tabId, (box) => {
    const st = box.st;
    if (!st || st.runId !== runId) return;
    if (res) {
      if (typeof res.verifiedRuns === "number") st.verifiedRuns = res.verifiedRuns;
      st.status = "completed";
      st.retry = null;
    } else {
      st.status = "error";
      st.retry = { kind: "complete" };
    }
  });
  if (res) {
    panelStatus("completed", res.repaired ? "Route updated for the new page layout." : "Route saved.");
  } else {
    panelStatus("error", `Couldn't save the route. ${errorText(lastErr)}`);
  }
  await pushState(tabId);
  return { ok: !!res };
}

// ---------- retry (Repeat after a failure) ----------

async function retry(tabId, st) {
  const r = st.retry;
  if (r.kind === "path") return lookUpRoute(tabId, { runId: st.runId, requestId: st.requestId }, r.controls, r.url);
  if (r.kind === "next") return planStep(tabId, { controls: r.controls, state: r.state, url: r.url, reason: r.reason });
  if (r.kind === "complete") {
    await withTab(tabId, (box) => { if (box.st) box.st.retry = null; });
    return completeRun(tabId, st.runId);
  }
  return { ok: false };
}

// ---------- content → background ----------

async function onContent(type, p, sender) {
  const tabId = sender.tab.id;
  const url = sender.url || "";

  if (type === "CONTENT_READY") {
    let host = "";
    try { host = new URL(url).host; } catch { /* ignore */ }
    await withMeta((m) => { m.ready[tabId] = { windowId: sender.tab.windowId, at: Date.now(), host }; });
    return withTab(tabId, (box) => {
      const st = box.st;
      if (!st || !st.active) return { ok: true };
      st.requestId++; // a new page: anything planned for the old page is stale
      return {
        ok: true,
        type: "TASK_RESUME",
        payload: {
          runId: st.runId, task: st.task, site: st.site, start: st.start, stepIndex: st.stepIndex,
          pendingCheck: st.pendingCheck, route: st.route, completedSteps: st.completedSteps
        }
      };
    });
  }

  if (type === "PAGE_SCAN") {
    return planStep(tabId, { controls: p.controls, state: p.state, url });
  }

  if (type === "STEP_NOT_FOUND") {
    const controls = cleanControls(p.controls);
    return planStep(tabId, { controls, state: p.state, url, reason: reasonForMissing(p.semanticTarget, controls) });
  }

  if (type === "STEP_OFF_ROUTE") {
    return planStep(tabId, { controls: p.controls, state: p.state, url, reason: "off_route" });
  }

  if (type === "STEP_COMPLETED") {
    const said = [];
    const out = await withTab(tabId, (box) => {
      const st = box.st;
      if (!st || !st.active || p.stepIndex !== st.stepIndex) return null;
      const allowed = ALLOWED_CHECKS[st.task] || [];
      const fallback = st.pendingCheck && st.pendingCheck.stepIndex === st.stepIndex ? st.pendingCheck : null;
      const step = cleanStep({ target: p.target || (fallback && fallback.target), hint: p.hint, check: p.check, checkArgs: p.checkArgs, isFinal: !!p.isFinal }, allowed, st.stepIndex + 1);
      if (!step) return null;
      step.isFinal = !!p.isFinal;
      st.completedSteps[st.stepIndex] = step;
      // Tutorial: this instruction is done → move to the next guidable one.
      if (st.tutorial && st.planned && st.planned.stepIndex === st.stepIndex && st.planned.instructionDone) {
        const next = nextGuidable(st.tutorial, st.tutorial.index + 1);
        for (let i = st.tutorial.index + 1; i < (next === -1 ? st.tutorial.steps.length : next); i++) {
          said.push(`I'll skip step ${i + 1} ("${st.tutorial.steps[i].instruction}"): I can't guide passwords, payments or deleting things.`);
        }
        if (next !== -1) st.tutorial.index = next;
      }
      st.stepIndex++;
      st.pendingCheck = null;
      st.planned = null;
      st.status = "step_done";
      return { tutorial: st.tutorial };
    });
    if (!out) return { ok: false, error: "stale" };
    for (const text of said) await toTab(tabId, "BLUSH_SAY", { text, mode: "info" });
    if (out.tutorial) toPanel("PANEL_TUTORIAL_STEPS", { steps: out.tutorial.steps, currentStep: out.tutorial.index + 1 });
    await pushState(tabId);
    return { ok: true };
  }

  if (type === "TASK_COMPLETED") {
    if (typeof p.runId !== "string") return { ok: false };
    return completeRun(tabId, p.runId);
  }

  if (type === "TASK_STATUS") {
    const allowed = new Set(["guiding", "waiting_for_user", "step_done", "completed"]);
    if (!allowed.has(p.status)) return { ok: false };
    await withTab(tabId, (box) => {
      const st = box.st;
      if (!st || !st.active) return;
      if (p.status !== "completed") st.status = p.status;
      if (typeof p.hint === "string" && p.hint) st.currentHint = str(p.hint, 160);
      // Remember what's on screen so a page load can verify it (TASK_RESUME.pendingCheck).
      if (p.status === "guiding" && p.stepIndex === st.stepIndex) {
        const planned = st.planned && st.planned.stepIndex === st.stepIndex ? st.planned : null;
        const saved = !planned && st.route ? st.route.steps[st.stepIndex] : null;
        const base = planned || (saved && {
          stepIndex: st.stepIndex, target: saved.target, hint: saved.hint, check: saved.check, checkArgs: saved.checkArgs || {},
          isFinal: typeof saved.isFinal === "boolean" ? saved.isFinal : st.stepIndex === st.route.steps.length - 1, source: "route"
        });
        if (base) {
          const { instructionDone, ...step } = base;
          st.pendingCheck = { ...step, startUrl: str(url, 2000) };
        }
      }
    });
    await pushState(tabId);
    return { ok: true };
  }

  if (type === "TASK_ERROR") {
    panelStatus("error", str(p.message, 160) || "Something went wrong.");
    if (p.recoverable === false) await stopTab(tabId, false);
    await pushState(tabId);
    return { ok: true };
  }
  return { ok: false };
}

// ---------- panel → background ----------

async function pingTab(tabId) {
  if (tabId == null) return null;
  const reply = await toTab(tabId, "TASK_STATE_REQUEST");
  if (!reply || !reply.ok) { await forgetReady(tabId); return null; }
  return reply;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

async function onPanel(type, p, sender) {
  if (type === "PANEL_START") {
    const goal = typeof p.goal === "string" ? p.goal.trim() : "";
    if (!goal || goal.length > 200) {
      panelStatus("invalid_goal", "Type a goal of up to 200 characters.");
      return { ok: false, error: "invalid_goal" };
    }
    const tabId = await resolveTab(sender);
    const ping = await pingTab(tabId);
    if (!ping) { panelStatus("unsupported_page", "KoiPilot can't run on this page."); return { ok: false, error: "unsupported_page" }; }
    const site = hostOf(ping.url);
    return startRun(tabId, { ...mapGoal(goal, site), goal: goal.slice(0, 200), site });
  }

  if (type === "PANEL_STOP") {
    const tabId = await runTab(sender);
    if (tabId == null) return { ok: true };
    await stopTab(tabId);
    return { ok: true };
  }

  if (type === "PANEL_REPEAT") {
    const tabId = await runTab(sender);
    if (tabId == null) return { ok: false, error: "no_tab" };
    const st = await readTab(tabId);
    if (st && st.retry) return retry(tabId, st);
    await toTab(tabId, "STEP_REPEAT");
    return { ok: true };
  }

  if (type === "PANEL_SET_MUTE") {
    if (typeof p.muted !== "boolean") return { ok: false, error: "bad_payload" };
    await withMeta((m) => { m.muted = p.muted; });
    const tabId = (await readMeta()).activeTabId;
    if (tabId != null) await withTab(tabId, (box) => { if (box.st) box.st.muted = p.muted; });
    await pushState(tabId);
    return { ok: true };
  }

  if (type === "PANEL_GET_STATE") {
    const tabId = await runTab(sender);
    const payload = await pushState(tabId);
    return { ok: true, type: "PANEL_STATE", payload };
  }

  if (type === "PANEL_MIC_SETUP") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("mic-setup.html") });
    return { ok: true };
  }

  if (type === "PANEL_PLAY_AUDIO") {
    const hint = str(p.hint, 200);
    if (!hint) return { ok: false, error: "bad_payload" };
    if ((await readMeta()).muted) return { ok: true, skipped: "muted" }; // mute skips /voice
    try {
      const res = await api("/voice", { hint });
      if (typeof res.audioBase64 !== "string" || !/^audio\//.test(String(res.mime))) throw new Error("bad audio");
      toPanel("PANEL_AUDIO", { audioBase64: res.audioBase64, mime: res.mime });
      return { ok: true };
    } catch (e) {
      panelStatus("voice_unavailable", "Voice isn't available right now.");
      return { ok: false, error: "voice_failed" };
    }
  }

  if (type === "PANEL_ASK") {
    const question = typeof p.question === "string" ? p.question.trim() : "";
    if (!question || question.length > 300) {
      panelStatus("invalid_question", "Ask a question of up to 300 characters.");
      return { ok: false, error: "invalid_question" };
    }
    const tabId = await runTab(sender);
    const st = tabId != null ? await readTab(tabId) : null;
    const page = await pingTab(tabId); // controls only if a task is running there (passive otherwise)
    const running = !!(st && st.active && page && page.active);
    let res;
    try {
      res = await api("/ask", {
        runId: running ? st.runId : crypto.randomUUID(),
        question,
        goal: running ? st.goal : "",
        site: page ? hostOf(page.url) : "",
        state: page ? str(page.state, 200) : "",
        currentHint: running ? st.currentHint : "",
        controls: running ? cleanControls(page.controls) : []
      });
    } catch (e) {
      panelStatus("error", errorText(e));
      return { ok: false, error: "ask_failed" };
    }
    const answer = str(res.answer, 240) || "Hmm, I'm not sure.";
    if (page) await toTab(tabId, "BLUSH_SAY", { text: answer, mode: "answer" });
    toPanel("PANEL_ANSWER", { question, answer });
    return { ok: true };
  }

  if (type === "PANEL_TUTORIAL") {
    const text = typeof p.text === "string" ? p.text.trim() : "";
    const images = Array.isArray(p.images) ? p.images : [];
    const badImage = images.some((d) => typeof d !== "string" || !IMAGE_DATA_URL.test(d) || Math.floor((d.length - d.indexOf(",") - 1) * 3 / 4) > MAX_IMAGE_BYTES);
    if ((!text && !images.length) || text.length > 4000 || images.length > 5 || badImage) {
      panelStatus("invalid_tutorial", "Paste up to 4,000 characters of text and/or up to 5 PNG/JPEG/WebP screenshots (4 MB each).");
      return { ok: false, error: "invalid_tutorial" };
    }
    const tabId = await resolveTab(sender);
    const ping = await pingTab(tabId);
    if (!ping) { panelStatus("unsupported_page", "KoiPilot can't run on this page."); return { ok: false, error: "unsupported_page" }; }
    const site = hostOf(ping.url);
    const runId = crypto.randomUUID();
    const body = { runId, site };
    if (text) body.text = text;
    if (images.length) body.images = images;
    panelStatus("reading_tutorial", "Reading your instructions…");
    let res;
    try { res = await api("/tutorial", body); } catch (e) { panelStatus("error", errorText(e)); return { ok: false, error: "tutorial_failed" }; }

    const steps = (Array.isArray(res.steps) ? res.steps : []).slice(0, MAX_STEPS)
      .map((s, i) => ({ order: i + 1, instruction: str(s && s.instruction, 300), blocked: !!(s && s.blocked) }))
      .filter((s) => s.instruction);
    const tutorialKey = str(res.tutorialKey, 64);
    if (!steps.length || !/^[0-9a-f]{8,64}$/i.test(tutorialKey)) { panelStatus("error", "I couldn't read any steps from that."); return { ok: false, error: "no_steps" }; }
    const warnings = Array.isArray(res.warnings) ? res.warnings.map((w) => str(w, 160)).filter(Boolean) : [];
    if (warnings.length) panelStatus("info", warnings.join(" "));

    const tutorial = { steps, tutorialKey, index: nextGuidable({ steps }, 0) };
    toPanel("PANEL_TUTORIAL_STEPS", { steps, currentStep: tutorial.index + 1 });
    if (tutorial.index === -1) {
      await toTab(tabId, "BLUSH_SAY", { text: "Every step there needs passwords, payments or deleting things, so I can't guide it.", mode: "info" });
      return { ok: false, error: "all_blocked" };
    }
    for (let i = 0; i < tutorial.index; i++) {
      await toTab(tabId, "BLUSH_SAY", { text: `I'll skip step ${i + 1} ("${steps[i].instruction}"): I can't guide passwords, payments or deleting things.`, mode: "info" });
    }
    return startRun(tabId, { task: "tutorial", goal: "Follow the tutorial", goalKey: "", site, tutorial }, runId);
  }

  if (type === "PANEL_OPENED") {
    const tabId = await runTab(sender);
    const meta = await readMeta();
    if (!meta.greeted) {
      const page = await pingTab(tabId);
      if (page) {
        await withMeta((m) => { m.greeted = true; });
        await toTab(tabId, "BLUSH_SAY", { text: GREETING, mode: "greeting" });
      }
    }
    const payload = await pushState(tabId);
    return { ok: true, type: "PANEL_STATE", payload };
  }
  return { ok: false };
}

// ---------- wiring ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || sender.id !== chrome.runtime.id) return;
  const p = isObj(msg.payload) ? msg.payload : {};
  let job;
  if (CONTENT_TYPES.has(msg.type)) {
    if (!sender.tab || sender.tab.id == null || isExtensionPage(sender.url)) return; // only content scripts
    job = onContent(msg.type, p, sender);
  } else if (PANEL_TYPES.has(msg.type)) {
    if (sender.tab && !isExtensionPage(sender.url)) return; // never from a web page's content script
    job = onPanel(msg.type, p, sender);
  } else {
    return; // unknown types are ignored
  }
  job.then((r) => sendResponse(r || { ok: true }), (e) => {
    log("handler failed", msg.type, e);
    sendResponse({ ok: false, error: "internal_error" });
  });
  return true; // async reply
});

function setupPanel() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => log("setPanelBehavior failed", e));
}
chrome.runtime.onInstalled.addListener(setupPanel);
chrome.runtime.onStartup.addListener(setupPanel);

chrome.tabs.onActivated.addListener(({ tabId }) => {
  withMeta((m) => { if (m.ready[tabId]) m.ready[tabId].at = Date.now(); });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withMeta((m) => { delete m.ready[tabId]; if (m.activeTabId === tabId) m.activeTabId = null; });
  withTab(tabId, (box) => { box.st = null; });
});
