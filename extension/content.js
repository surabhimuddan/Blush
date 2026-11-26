// KP runtime: drives one task in this tab (contract §7, §8, §8.2).
// Passive by default: until TASK_START / TASK_RESUME it only sends CONTENT_READY.
// Never clicks, types or submits; never sends field values; no network (background does that).
globalThis.KP = globalThis.KP || {};

(() => {
  const DEBUG = false;
  const POLL_MS = 400;                 // check + URL poll while waiting
  const MUTATION_THROTTLE_MS = 150;
  const NUDGE_FIRST_MS = 20000, NUDGE_EVERY_MS = 30000, MAX_NUDGES = 3;
  const WAITING_STATUS_MS = 4500;      // after guiding, report waiting_for_user
  const SETTLE_MS = 450;               // let a new page/section settle before scanning
  const CELEBRATE_MS = 5000;
  const REFIND_MS = 2000;
  const MAX_STEPS = 20;
  const MAX_TEXT = 300;
  const OFF_ROUTE_TEXT = "Oops, that's not it. Let me find the way from here";
  const NEXT_TEXT = "Nice! Let me find the next step…";
  const NAME_TAKEN_TEXT = "That name is already taken. Try a different one!";
  const DETAIL_HOSTS = new Set(["127.0.0.1:8787", "github.com"]); // only here do we share title/heading
  const ACTIVITY_EVENTS = ["scroll", "wheel", "keydown", "pointerdown", "touchstart"];

  const log = (...a) => { if (DEBUG) console.log("KoiPilot:", ...a); };
  const clean = (t, max) => String(t || "").replace(/\s+/g, " ").trim().slice(0, max);

  if (window.top !== window) return; // top frame only

  let run = null;        // active task; null = passive
  let lastScan = null;   // the scan whose temporary ids the background planned with
  let watch = null;      // watchers for the step on screen
  let celebrateTimer = 0;

  // ---------- messaging ----------

  function send(type, payload) {
    try {
      return chrome.runtime.sendMessage({ type, payload }).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension reloaded: this old script just goes quiet
    }
  }

  const semantic = (c) => ({ role: c.role, label: c.label, nearbyHeading: c.nearbyHeading || "", context: c.context || "" });

  function scanForPlan() {
    lastScan = KP.reader.scan();
    return lastScan;
  }

  // Start-page description (contract §5). Title/heading only on the demo hosts (privacy).
  function startInfo() {
    const detailed = DETAIL_HOSTS.has(location.host);
    const h1 = detailed ? document.querySelector("h1") : null;
    return {
      state: KP.reader.state(),
      urlPattern: KP.reader.pathShape(),
      pageTitle: detailed ? clean(document.title, 80) : "",
      heading: h1 ? clean(h1.textContent, 80) : ""
    };
  }

  function status(statusName, stepIndex, hint) {
    send("TASK_STATUS", { status: statusName, stepIndex, hint: hint || "" });
  }

  // Ask the background for a step: PAGE_SCAN / STEP_NOT_FOUND / STEP_OFF_ROUTE.
  function requestPlan(type, extra) {
    if (!run) return;
    const sc = scanForPlan();
    run.awaiting = true;
    send(type, { ...(extra || {}), state: sc.state, controls: sc.controls });
  }

  // Blush speaks: in her bubble if she's on screen, otherwise a short visit.
  function blushSay(text) {
    if (KP.overlay.isActive()) KP.overlay.say(text);
    else KP.overlay.visit(text);
  }

  // ---------- GitHub: expected repo for repo_created (kept on this page only) ----------

  function rememberRepoName() {
    const f = document.querySelector("input#repository_name, input[name='repository[name]'], input#repository-name-input");
    const owner = document.querySelector("meta[name=user-login]");
    if (f && run) run.repo = { owner: owner ? owner.content : "", name: String(f.value || "").trim() };
  }

  function expectedRepo() {
    if (run && run.repo && run.repo.owner && run.repo.name) return run.repo;
    // After a full page load the typed name is gone: use the signed-in user + this path.
    const owner = document.querySelector("meta[name=user-login]");
    const parts = location.pathname.split("/").filter(Boolean);
    if (owner && parts.length === 2 && parts[0].toLowerCase() === owner.content.toLowerCase()) {
      return { owner: owner.content, name: parts[1] };
    }
    return null;
  }

  // ---------- watching for the user's action ----------

  function clearWatch() {
    if (!watch) return;
    clearInterval(watch.poll);
    clearTimeout(watch.nudgeTimer);
    clearTimeout(watch.waitingTimer);
    clearTimeout(watch.mutationTimer);
    if (watch.mo) watch.mo.disconnect();
    window.removeEventListener("hashchange", watch.onNav);
    window.removeEventListener("popstate", watch.onNav);
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, watch.onActivity, true);
    watch = null;
  }

  // mode "step": verify the guided step. mode "hint": no target; replan when the URL changes.
  function startWatch(mode) {
    clearWatch();
    const w = { mode, nudges: 0, lastMutationEval: 0, mutationTimer: 0, nudgeTimer: 0, waitingTimer: 0, poll: 0, mo: null };
    watch = w;
    const evaluate = () => { if (watch === w && run) (mode === "step" ? checkStep() : checkHintWait()); };
    w.poll = setInterval(evaluate, POLL_MS);
    w.onNav = () => evaluate();
    window.addEventListener("hashchange", w.onNav);
    window.addEventListener("popstate", w.onNav);
    if (mode !== "step") return;

    // DOM changes (menus opening, sections appearing), throttled.
    w.mo = new MutationObserver(() => {
      const wait = MUTATION_THROTTLE_MS - (performance.now() - w.lastMutationEval);
      if (w.mutationTimer) return;
      w.mutationTimer = setTimeout(() => {
        w.mutationTimer = 0;
        w.lastMutationEval = performance.now();
        evaluate();
      }, Math.max(0, wait));
    });
    w.mo.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["open", "aria-expanded", "hidden", "class", "style"]
    });

    // Nudges: 20 s of no activity, then every 30 s, at most 3. Activity resets the timer.
    const scheduleNudge = (ms) => {
      clearTimeout(w.nudgeTimer);
      if (w.nudges >= MAX_NUDGES) return;
      w.nudgeTimer = setTimeout(() => {
        if (watch !== w || !run || !run.step) return;
        w.nudges++;
        const hint = clean(run.step.hint, 120).replace(/[.!?]+$/, "");
        KP.overlay.nudge(`Still here! ${hint} when you're ready 🐟`);
        scheduleNudge(NUDGE_EVERY_MS);
      }, ms);
    };
    w.onActivity = () => scheduleNudge(NUDGE_FIRST_MS);
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, w.onActivity, { capture: true, passive: true });
    scheduleNudge(NUDGE_FIRST_MS);
  }

  function targetStillHere(s) {
    if (s.el && s.el.isConnected && KP.reader.util.isVisible(s.el)) return true;
    return typeof KP.reader.match(s.target, KP.reader.scan().controls) === "string";
  }

  function checkStep() {
    const s = run.step;
    if (!s) return;
    const r = KP.verify.run(s.check, { startUrl: s.startUrl, reloaded: false, expected: expectedRepo() }, s.checkArgs);
    if (r.passed) { stepPassed(); return; }

    // An error on the page (e.g. name taken): stay on the same control, explain.
    if (r.detail === "name_taken" && s.errorShown !== r.detail) { s.errorShown = r.detail; KP.overlay.say(NAME_TAKEN_TEXT); }
    else if (r.detail !== "name_taken" && s.errorShown) { s.errorShown = null; KP.overlay.say(s.hint); }

    // Wrong turn: the URL changed, the check fails and the step's target is gone.
    if (location.href !== s.lastUrl) {
      s.lastUrl = location.href;
      if (!targetStillHere(s)) { offRoute(); return; }
    }

    // The target was re-rendered (SPA): find the same control again by meaning, never another one.
    if (!s.el || !s.el.isConnected) {
      const now = performance.now();
      if (now - (s.lastRefind || 0) < REFIND_MS) return;
      s.lastRefind = now;
      const sc = KP.reader.scan();
      const id = KP.reader.match(s.target, sc.controls);
      if (typeof id === "string") {
        s.el = sc.map.get(id);
        KP.overlay.guide(s.el, s.hint);
      }
    }
  }

  // Waiting after a "no target" hint: when the page changes, ask for a plan again.
  function checkHintWait() {
    if (location.href === run.hintUrl) return;
    clearWatch();
    const myRun = run;
    setTimeout(() => { if (run === myRun) requestPlan("PAGE_SCAN"); }, SETTLE_MS);
  }

  function offRoute() {
    const s = run.step;
    clearWatch();
    run.step = null;
    blushSay(OFF_ROUTE_TEXT);
    requestPlan("STEP_OFF_ROUTE", { stepIndex: s.stepIndex });
  }

  // ---------- steps ----------

  function guide(step, el) {
    clearWatch();
    clearTimeout(celebrateTimer);
    run.awaiting = false;
    run.step = { ...step, el, startUrl: location.href, lastUrl: location.href, errorShown: null, lastRefind: 0 };
    KP.overlay.guide(el, step.hint);
    status("guiding", step.stepIndex, step.hint);
    startWatch("step");
    const myStep = run.step;
    watch.waitingTimer = setTimeout(() => {
      if (run && run.step === myStep) status("waiting_for_user", step.stepIndex, step.hint);
    }, WAITING_STATUS_MS);
  }

  function stepPassed() {
    const s = run.step;
    clearWatch();
    run.step = null;
    const done = {
      order: s.stepIndex + 1,
      target: s.target,
      hint: s.hint,
      check: s.check,
      checkArgs: s.checkArgs || {},
      isFinal: !!s.isFinal
    };
    run.completed[s.stepIndex] = done;
    if (s.check === "name_available") rememberRepoName();
    send("STEP_COMPLETED", { stepIndex: s.stepIndex, check: done.check, checkArgs: done.checkArgs, isFinal: done.isFinal, target: done.target, hint: done.hint });
    status("step_done", s.stepIndex, s.hint);
    if (done.isFinal) { finish(); return; }

    run.stepIndex = s.stepIndex + 1;
    if (run.stepIndex >= MAX_STEPS) {
      send("TASK_ERROR", { code: "too_many_steps", message: "That took more than 20 steps, so I stopped.", recoverable: false });
      stopRun();
      return;
    }
    if (KP.overlay.isActive()) KP.overlay.say(NEXT_TEXT);
    const myRun = run;
    setTimeout(() => { if (run === myRun && !run.step && !run.awaiting) nextStep(); }, SETTLE_MS);
  }

  // Next saved step if the route has one, otherwise ask for a planned step.
  function nextStep() {
    if (run.route && run.route.steps[run.stepIndex]) replayStep();
    else requestPlan("PAGE_SCAN");
  }

  // Replay a saved semantic step: exactly one match → guide it (no backend call).
  function replayStep() {
    const saved = run.route.steps[run.stepIndex];
    const sc = scanForPlan();
    const m = KP.reader.match(saved.target, sc.controls);
    if (typeof m === "string") {
      const last = run.stepIndex === run.route.steps.length - 1;
      guide({
        stepIndex: run.stepIndex,
        target: saved.target,
        hint: saved.hint,
        check: saved.check,
        checkArgs: saved.checkArgs || {},
        isFinal: typeof saved.isFinal === "boolean" ? saved.isFinal : last,
        source: "route"
      }, sc.map.get(m));
      return;
    }
    run.awaiting = true;
    send("STEP_NOT_FOUND", { stepIndex: run.stepIndex, semanticTarget: saved.target, state: sc.state, controls: sc.controls });
  }

  function finish() {
    const steps = run.completed.filter(Boolean);
    const { runId, site, task, goal, goalKey, start, stepIndex } = run;
    const onScreen = KP.overlay.isActive();
    if (onScreen) KP.overlay.celebrate("Done! Route saved.");
    else KP.overlay.visit("Done! Route saved.");
    send("TASK_COMPLETED", { runId, site, task, goal, goalKey, start, steps });
    status("completed", stepIndex, "");
    run = null; // passive again
    if (onScreen) celebrateTimer = setTimeout(() => { if (!run) KP.overlay.stop(); }, CELEBRATE_MS);
  }

  function stopRun() {
    clearWatch();
    clearTimeout(celebrateTimer);
    run = null;
    KP.overlay.stop();
  }

  // ---------- message handlers ----------

  function onTaskStart(p) {
    if (typeof p.runId !== "string" || typeof p.task !== "string") return { ok: false, error: "bad_payload" };
    stopRun();
    run = {
      runId: p.runId, task: p.task, site: p.site || location.host,
      goal: typeof p.goal === "string" ? p.goal : "", goalKey: typeof p.goalKey === "string" ? p.goalKey : "",
      start: startInfo(), route: null, stepIndex: 0, completed: [], step: null, awaiting: true, repo: null
    };
    const sc = scanForPlan();
    return { ok: true, url: location.href, start: run.start, state: sc.state, controls: sc.controls };
  }

  function onStepResult(p) {
    if (!run || !run.awaiting) return; // stale or unexpected
    run.awaiting = false;
    if (p.targetId == null) {
      // Safety or nothing found: show the hint, guide nothing, replan when the page changes.
      blushSay(clean(p.hint, MAX_TEXT) || "I couldn't find that here.");
      status("waiting_for_user", run.stepIndex, p.hint);
      run.hintUrl = location.href;
      startWatch("hint");
      return;
    }
    const c = lastScan && lastScan.controls.find((x) => x.id === p.targetId);
    const el = lastScan && lastScan.map.get(p.targetId);
    if (!c || !el || !el.isConnected || !KP.reader.util.isVisible(el)) {
      // The control went away: rescan and ask again. Never point at a different control.
      requestPlan("STEP_NOT_FOUND", { stepIndex: run.stepIndex, semanticTarget: c ? semantic(c) : null });
      return;
    }
    if (typeof p.check !== "string" || !p.check) {
      send("TASK_ERROR", { code: "bad_step", message: "The planner sent a step without a check.", recoverable: true });
      return;
    }
    guide({
      stepIndex: run.stepIndex,
      target: semantic(c),             // recorded right away, before the page can change
      hint: clean(p.hint, MAX_TEXT),
      check: p.check,
      checkArgs: p.checkArgs && typeof p.checkArgs === "object" ? p.checkArgs : {},
      isFinal: !!p.isFinal,
      source: p.source || "planner"
    }, el);
  }

  function onRouteReplay(p) {
    if (!run) return;
    const steps = p.route && Array.isArray(p.route.steps) ? p.route.steps.filter((s) => s && s.target && s.check) : [];
    if (!steps.length) { requestPlan("PAGE_SCAN"); return; }
    run.route = { ...p.route, steps };
    run.awaiting = false;
    replayStep();
  }

  // After a page load in the middle of a task: run the pending check first, then continue.
  function onResume(p) {
    if (!p || typeof p.runId !== "string") return;
    if (run && run.runId === p.runId) return; // already running here
    stopRun();
    run = {
      runId: p.runId, task: p.task, site: p.site, goal: "", goalKey: "",
      start: p.start || startInfo(),
      route: p.route && Array.isArray(p.route.steps) ? p.route : null,
      stepIndex: Number.isInteger(p.stepIndex) ? p.stepIndex : 0,
      completed: Array.isArray(p.completedSteps) ? p.completedSteps.slice() : [],
      step: null, awaiting: false, repo: null
    };
    const myRun = run;
    setTimeout(() => { if (run === myRun) resumeFlow(p.pendingCheck); }, SETTLE_MS);
  }

  function resumeFlow(pc) {
    if (pc && typeof pc.check === "string" && pc.target) {
      const step = {
        stepIndex: Number.isInteger(pc.stepIndex) ? pc.stepIndex : run.stepIndex,
        target: pc.target, hint: clean(pc.hint, MAX_TEXT), check: pc.check,
        checkArgs: pc.checkArgs || {}, isFinal: !!pc.isFinal, source: pc.source || "planner"
      };
      run.stepIndex = step.stepIndex;
      const r = KP.verify.run(step.check, { startUrl: pc.startUrl, reloaded: true, expected: expectedRepo() }, step.checkArgs);
      if (r.passed) {
        run.step = { ...step, el: null };
        stepPassed();
        return;
      }
      const sc = scanForPlan();
      const m = KP.reader.match(step.target, sc.controls);
      if (typeof m === "string") { guide(step, sc.map.get(m)); return; } // same page again (e.g. refresh)
      blushSay(OFF_ROUTE_TEXT);
      run.awaiting = true;
      send("STEP_OFF_ROUTE", { stepIndex: step.stepIndex, state: sc.state, controls: sc.controls });
      return;
    }
    nextStep();
  }

  function onRepeat() {
    if (!run || !run.step) return;
    const s = run.step;
    if (s.el && s.el.isConnected) { KP.overlay.guide(s.el, s.hint); return; }
    const sc = KP.reader.scan();
    const id = KP.reader.match(s.target, sc.controls);
    if (typeof id === "string") { s.el = sc.map.get(id); KP.overlay.guide(s.el, s.hint); }
    else KP.overlay.say(s.hint);
  }

  // State for the background. A separate scan, so the planner's ids (lastScan) stay valid.
  function stateReply() {
    return {
      ok: true,
      active: !!run,
      runId: run ? run.runId : null,
      url: location.href,
      state: KP.reader.state(),
      stepIndex: run ? run.stepIndex : 0,
      hint: run && run.step ? run.step.hint : "",
      controls: run ? KP.reader.scan().controls : []
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return;
    const p = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : {};
    switch (msg.type) {
      case "TASK_START": sendResponse(onTaskStart(p)); return;
      case "TASK_STOP": stopRun(); sendResponse({ ok: true }); return;
      case "STEP_REPEAT": onRepeat(); sendResponse({ ok: true }); return;
      case "TASK_STATE_REQUEST": sendResponse(stateReply()); return;
      case "STEP_RESULT": onStepResult(p); sendResponse({ ok: true }); return;
      case "ROUTE_REPLAY": onRouteReplay(p); sendResponse({ ok: true }); return;
      case "TASK_RESUME": onResume(p); sendResponse({ ok: true }); return;
      case "BLUSH_SAY": {
        const text = clean(p.text, MAX_TEXT);
        if (text) blushSay(text); // the user asked from the panel, so this is allowed when passive
        sendResponse({ ok: !!text });
        return;
      }
      default: return; // unknown types are ignored
    }
  });

  // The one thing a passive page does: say it's here (and pick up a running task).
  send("CONTENT_READY", { url: location.href, state: KP.reader.state() }).then((res) => {
    if (res && res.ok && res.type === "TASK_RESUME") onResume(res.payload);
  });
  log("ready");
})();
