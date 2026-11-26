// KP.overlay: Blush the pixel fish, her dashed ring and her speech bubble.
// Everything lives in one closed Shadow DOM host with pointer-events:none,
// so the page stays fully clickable. One requestAnimationFrame loop drives it all.
globalThis.KP = globalThis.KP || {};

(() => {
  const DEBUG = false;

  // Sizes and timings
  const FISH_W = 84, FISH_H = 36, HW = FISH_W / 2, HH = FISH_H / 2;
  // Orbit: a flattened ellipse (wide, short) so she circles like a fish, not a wheel.
  // Orbit: a plain circle around the target, always clockwise; her nose follows the tangent
  // through a full 360° each lap (a backflip loop, no mirroring).
  const ORBIT_PAD = 22;                    // circle radius = half the target's diagonal + this
  // Rotation easing: lag (ms) and max turn rate (deg per ms).
  const SWIM_LAG = 90, SWIM_RATE = 0.3;    // pointing where she swims
  const ORBIT_LAG = 35, ORBIT_RATE = 0.5;  // following the circle (the loop itself turns 225°/s)
  const LEVEL_LAG = 160;                   // rolling back to level
  const SHADOW_W = 64, SHADOW_H = 12, SHADOW_DY = 20;               // soft shadow under her
  const RING_PAD_X = 10, RING_PAD_Y = 5;      // dashed ring hugs the target
  const SWIM_MS = 900, SHORT_SWIM_MS = 450, MAX_SWIM_MS = 1400, LOOP_MS = 1600, GUIDE_LOOPS = 2;
  const TO_REST_MS = 600, SCROLL_SETTLE_MAX = 800;
  const TYPE_MS = 28, VISIT_WAIT_MS = 6000;
  const HOP_MS = 480, HOP_PX = 22, BOB_PX = 4, BOB_MS = 1600;
  const GAP = 18;        // space between target and resting Blush (clears the ring)
  const EDGE = 8;        // viewport margin
  const TAIL_GAP = 12;   // space between Blush and the bubble (the tail sticks out 10 px)
  const AVOID_PAD = 10;  // bubble keeps this far from the target
  const REST_PAD = 4;    // extra margin around Blush (bob) when checking what she'd cover
  const TRAIL_DOTS = 8, TRAIL_BACK = 34, TRAIL_R = 2.25;
  const RECHOOSE_MS = 500;
  // Anything the user might click; Blush must not rest on top of these.
  const INTERACTIVE = "a[href],button,input,select,textarea,summary,label[for],[role=button],[role=link]," +
    "[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[contenteditable=true]";
  const PLUM = "#4A2A4F";
  const HOST_ID = "koipilot-host";
  const SVG_NS = "http://www.w3.org/2000/svg";

  // State
  let ui = null, raf = 0, gen = 0, stopped = true;
  let target = null, curRect = null, hint = "";
  // She always first appears at the right edge swimming left, so start facing left.
  // facing: +1 art as drawn (nose right) / −1 mirrored (nose left). Only changes instantly
  // before a swim, or invisibly while her nose points straight up/down.
  // rot: rotation of her body in degrees (any value; compared via wrap180, so no ±180° jumps).
  let pos = null, facing = -1, rot = 0, orbitA = null;
  let heading = { x: -1, y: 0 };  // where her nose points on screen (for the trail)
  let vel = { x: 0, y: 0 };       // smoothed velocity, px/ms
  let phase = "none";          // settle | tween | orbit | rest | free | none
  let tween = null, orbit = null, settle = null;
  let ringAlpha = 0, ringGoal = 0, dashOffset = 0;
  let trail = [], trailAlpha = 0;
  let hopStart = -1, lastNow = 0, restChoice = null, restChosenAt = 0, placement = null;
  let bubbleOn = false, typeTimer = 0, typeId = 0, visitTimer = 0;
  const sparkleTimers = new Set();

  const log = (...a) => { if (DEBUG) console.log("KoiPilot overlay:", ...a); };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const viewW = () => document.documentElement.clientWidth || innerWidth;
  const viewH = () => document.documentElement.clientHeight || innerHeight;
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180; // any angle → [−180, 180)
  const DEG = Math.PI / 180;

  // ---------- Fish renderer (canvas) ----------
  // blush.png is 264×176 = a 66×44 pixel-art grid at 4× (each art pixel is itself 2×2 in
  // that grid). We reshape it into a sleek 84×36 koi with nearest-neighbour copies only:
  //   longer:  mid-body columns 18–53 are repeated ×1.5 (every 2-column art pixel → 3),
  //            head (54–65) and forked tail (0–17) are untouched;
  //   slimmer: body rows 14–31 are merged 18 → 14 (one row of some 2-row pairs dropped,
  //            so no feature disappears); empty margin rows are trimmed.
  // Lower fins and side fin are cut from the original art at their original size and
  // pinned at their mapped spots, so they keep their look. Then we draw:
  //   body in vertical strips, each offset by y = a(x)·sin(k·x − ω·t) (head ≈ still, tail most),
  //   dorsal fin swaying with the body, and three small fins paddling about their roots.
  // The image comes from the extension, so the canvas is cross-origin: we never read pixels,
  // pieces are cut with drawImage + clearRect/compositing only.

  const SRC_W = 66, SRC_H = 44;            // original art grid
  const ART_W = 84, ART_H = 36;            // reshaped art grid (= her size in CSS px)
  const CANVAS_SIZE = 104;                 // square canvas centred on her: room to rotate fully, wave, fins
  const STRIPS = 10;
  // Depth shading baked per art row (stays pixel-crisp): highlight along the back, darker belly.
  const BACK_ROWS = [[12, 0.22], [13, 0.16], [14, 0.10], [15, 0.05]];
  const BELLY_ROWS = [[22, 0.05], [23, 0.09], [24, 0.13], [25, 0.17]];
  const BACK_LIGHT = "#FFFFFF", BELLY_SHADE = "#4A2A4F";
  const BODY_FILL = "#FFF0F6";             // body colour behind the side fin
  // Reshape map, original art px → reshaped art px.
  const WIDE_X0 = 18, WIDE_X1 = 54, WIDE_K = 1.5;          // columns repeated ×1.5
  const SLIM_Y0 = 14, SLIM_Y1 = 32, SLIM_ROWS = 14, TOP_TRIM = 2; // rows merged 18 → 14
  const mapX = (x) => x < WIDE_X0 ? x : x < WIDE_X1 ? WIDE_X0 + (x - WIDE_X0) * WIDE_K : x + (WIDE_X1 - WIDE_X0) * (WIDE_K - 1);
  const mapY = (y) => y < SLIM_Y0 ? y - TOP_TRIM
    : y < SLIM_Y1 ? SLIM_Y0 - TOP_TRIM + (y - SLIM_Y0) * SLIM_ROWS / (SLIM_Y1 - SLIM_Y0)
    : y - TOP_TRIM - (SLIM_Y1 - SLIM_Y0 - SLIM_ROWS);
  // Piece rects in ORIGINAL art px; (px, py) is where the piece attaches to the body.
  const DORSAL = { x: 30, y: 6, w: 24, h: 8, px: 42, py: 14 };                 // stretches with the back
  const FIN_REAR = { x: 26, y: 30, w: 9, h: 7, px: 30, py: 31, cutY: 32 };      // lower fin nearer the tail
  const FIN_FRONT = { x: 39, y: 31, w: 10, h: 7, px: 43.5, py: 32, cutY: 32 }; // lower fin nearer the head
  const SIDE_FIN = { x: 44, y: 24, w: 8, h: 6, px: 47, py: 24.5, cells: [[0, 0, 8, 2], [0, 2, 4, 2], [0, 4, 2, 2]] };

  function makeFishRenderer(canvas) {
    const ctx = canvas.getContext("2d");
    let pieces = null;
    let phase = 0, finPhase = 0, speedS = 0;

    const img = new Image();
    img.addEventListener("load", () => { pieces = cutPieces(img); });
    img.addEventListener("error", () => log("blush.png failed to load"));
    img.src = chrome.runtime.getURL("assets/blush.png");

    function cnv(w, h) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      x.imageSmoothingEnabled = false;
      return [c, x];
    }

    // 66×44 original-grid canvas → 84×36 reshaped canvas (nearest-neighbour copies only).
    function reshape(src) {
      const [v, vx] = cnv(SRC_W, ART_H);   // pass 1: rows (trim + merge body rows)
      const slimTo = SLIM_Y0 - TOP_TRIM;
      vx.drawImage(src, 0, TOP_TRIM, SRC_W, SLIM_Y0 - TOP_TRIM, 0, 0, SRC_W, slimTo);
      vx.drawImage(src, 0, SLIM_Y0, SRC_W, SLIM_Y1 - SLIM_Y0, 0, slimTo, SRC_W, SLIM_ROWS);
      vx.drawImage(src, 0, SLIM_Y1, SRC_W, ART_H - slimTo - SLIM_ROWS, 0, slimTo + SLIM_ROWS, SRC_W, ART_H - slimTo - SLIM_ROWS);
      const [o, ox] = cnv(ART_W, ART_H);   // pass 2: columns (repeat mid-body)
      const wideW = (WIDE_X1 - WIDE_X0) * WIDE_K;
      ox.drawImage(v, 0, 0, WIDE_X0, ART_H, 0, 0, WIDE_X0, ART_H);
      ox.drawImage(v, WIDE_X0, 0, WIDE_X1 - WIDE_X0, ART_H, WIDE_X0, 0, wideW, ART_H);
      ox.drawImage(v, WIDE_X1, 0, SRC_W - WIDE_X1, ART_H, WIDE_X0 + wideW, 0, SRC_W - WIDE_X1, ART_H);
      return o;
    }

    // A piece is drawn by translating to its pivot (reshaped px) and drawing at (ox, oy).
    function smallPiece(art, r, maskCells) {
      const [c, x] = cnv(r.w, r.h);
      x.drawImage(art, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      if (maskCells) {
        x.globalCompositeOperation = "destination-in";
        for (const [cx, cy, cw, ch] of maskCells) x.fillRect(cx, cy, cw, ch);
        x.globalCompositeOperation = "source-over";
      }
      return { c, px: mapX(r.px), py: mapY(r.py), ox: r.x - r.px, oy: r.y - r.py };
    }

    // Reshaped-space rect covering an original-space rect, rounded outwards to whole px.
    function mapRect(x, y, w, h) {
      const x0 = Math.floor(mapX(x)), y0 = Math.floor(mapY(y));
      return [x0, y0, Math.ceil(mapX(x + w)) - x0, Math.ceil(mapY(y + h)) - y0];
    }

    function cutPieces(image) {
      const [art, ax] = cnv(SRC_W, SRC_H);
      ax.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, SRC_W, SRC_H);
      const shaped = reshape(art);

      // Small fins: original size and look.
      const finRear = smallPiece(art, FIN_REAR);
      const finFront = smallPiece(art, FIN_FRONT);
      const side = smallPiece(art, SIDE_FIN, SIDE_FIN.cells);

      // Dorsal: the reshaped back fin (it runs along her lengthened back).
      const [dm, dmx] = cnv(SRC_W, SRC_H);
      dmx.fillRect(DORSAL.x, DORSAL.y, DORSAL.w, DORSAL.h);
      const dMask = reshape(dm);
      const [d, dx] = cnv(ART_W, ART_H);
      dx.drawImage(shaped, 0, 0);
      dx.globalCompositeOperation = "destination-in";
      dx.drawImage(dMask, 0, 0);
      const dorsal = { c: d, px: mapX(DORSAL.px), py: mapY(DORSAL.py), ox: -mapX(DORSAL.px), oy: -mapY(DORSAL.py) };

      // Body = everything else. Lower fins keep their root rows on the body.
      const [body, bx] = cnv(ART_W, ART_H);
      bx.drawImage(shaped, 0, 0);
      bx.globalCompositeOperation = "destination-out";
      bx.drawImage(dMask, 0, 0);
      bx.globalCompositeOperation = "source-over";
      for (const f of [FIN_REAR, FIN_FRONT]) bx.clearRect(...mapRect(f.x, f.cutY, f.w, f.y + f.h - f.cutY));
      bx.fillStyle = BODY_FILL;
      for (const [cx, cy, cw, ch] of SIDE_FIN.cells) bx.fillRect(...mapRect(SIDE_FIN.x + cx, SIDE_FIN.y + cy, cw, ch));

      // Depth shading: whole art rows tinted only where she has pixels (source-atop),
      // so the edges stay crisp and the shading rides along with the body wave.
      bx.globalCompositeOperation = "source-atop";
      for (const [rows, color] of [[BACK_ROWS, BACK_LIGHT], [BELLY_ROWS, BELLY_SHADE]]) {
        bx.fillStyle = color;
        for (const [y, a] of rows) { bx.globalAlpha = a; bx.fillRect(0, y, ART_W, 1); }
      }
      bx.globalAlpha = 1;
      bx.globalCompositeOperation = "source-over";
      return { body, dorsal, finRear, finFront, side };
    }

    function piece(p, dy, angleDeg) {
      ctx.save();
      ctx.translate(p.px, p.py + dy);
      ctx.rotate(angleDeg * DEG);
      ctx.drawImage(p.c, p.ox, p.oy);
      ctx.restore();
    }

    // speed: px/ms of her body on screen. facing: 1 as drawn (nose right), -1 mirrored.
    // rotDeg: body rotation in degrees (applied before the mirror; any value, e.g. a full loop).
    function draw(now, dt, speed, facing, rotDeg, still) {
      if (!pieces) return;

      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(CANVAS_SIZE * dpr), ch = cw;
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }

      // Speed 0..1: resting ≈ 0, orbit ≈ 0.4, fast swim ≈ 1. Smoothed so changes blend in.
      speedS += (clamp(speed / 0.6, 0, 1) - speedS) * (1 - Math.exp(-dt / 150));
      if (!still) {
        phase += lerp(1.1, 3.6, speedS) * 2 * Math.PI * dt / 1000;     // body wave: 1.1 Hz → 3.6 Hz
        finPhase += lerp(1.8, 3.2, speedS) * 2 * Math.PI * dt / 1000;  // fin paddle
      }

      const amp = still ? 0 : lerp(0.7, 2.4, speedS);          // art px at the tail
      const finAmp = still ? 0 : lerp(24, 7, speedS);          // degrees of paddle
      const fold = still ? 0 : lerp(0, 28, speedS);            // fins tuck back when fast
      const snap = (v) => Math.round(v * dpr) / dpr;
      // Vertical offset of the body at art x (head is on the right).
      const yOff = (x) => {
        const d = 1 - x / ART_W;                           // 0 at the head, 1 at the tail
        return amp * (0.06 + 0.94 * d * d) * Math.sin(2 * Math.PI * 0.85 * d - phase);
      };

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(CANVAS_SIZE / 2, CANVAS_SIZE / 2);
      // Applied to her in reverse order: rotate first, then mirror.
      ctx.scale(facing, 1);
      if (!still && rotDeg) ctx.rotate(rotDeg * DEG);
      ctx.translate(-ART_W / 2, -ART_H / 2);

      // Dorsal fin sways a little with the body.
      const P = pieces;
      const dD = 1 - P.dorsal.px / ART_W;
      piece(P.dorsal, snap(yOff(P.dorsal.px)), still ? 0 : amp * 2 * Math.sin(2 * Math.PI * 0.85 * dD - phase - 0.8));

      // Body strips, tail → head.
      for (let i = 0; i < STRIPS; i++) {
        const x0 = Math.round((i * ART_W) / STRIPS), x1 = Math.round(((i + 1) * ART_W) / STRIPS);
        ctx.drawImage(P.body, x0, 0, x1 - x0, ART_H, x0, snap(yOff((x0 + x1) / 2)), x1 - x0, ART_H);
      }

      // Fins paddle in alternation; bigger strokes when slow, folded back when fast.
      piece(P.side, snap(yOff(P.side.px)), fold * 0.6 + finAmp * 0.7 * Math.sin(finPhase + Math.PI / 2));
      piece(P.finRear, snap(yOff(P.finRear.px)), fold + finAmp * Math.sin(finPhase));
      piece(P.finFront, snap(yOff(P.finFront.px)), fold + finAmp * Math.sin(finPhase + Math.PI));
    }

    return { draw, ready: () => !!pieces };
  }

  // ---------- DOM ----------

  function div(cls) {
    const d = document.createElement("div");
    d.className = cls;
    return d;
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // Pixel tail pointing down, 5×3 cells of 5 px (same as the border width).
  function makeTail() {
    const svg = svgEl("svg", { class: "kp-tail", viewBox: "0 0 5 3", "shape-rendering": "crispEdges" });
    const px = [[0, 0, 1, PLUM], [1, 0, 3, "#FFFFFF"], [4, 0, 1, PLUM],
                [1, 1, 1, PLUM], [2, 1, 1, "#FFFFFF"], [3, 1, 1, PLUM],
                [2, 2, 1, PLUM]];
    for (const [x, y, w, fill] of px) svg.appendChild(svgEl("rect", { x, y, width: w, height: 1, fill }));
    return svg;
  }

  function ensureUI() {
    if (ui) {
      if (!ui.host.isConnected) document.documentElement.appendChild(ui.host);
      return;
    }
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all: initial !important; display: block !important; position: fixed !important;" +
      "inset: 0 !important; pointer-events: none !important; z-index: 2147483647 !important;";
    const root = host.attachShadow({ mode: "closed" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("overlay.css");

    const layer = div("kp-layer");
    layer.hidden = true; // shown once overlay.css has loaded (no unstyled flash)
    link.addEventListener("load", () => { layer.hidden = false; });
    link.addEventListener("error", () => { layer.hidden = false; log("overlay.css failed to load"); });

    const fx = svgEl("svg", { class: "kp-fx" });
    const trailG = svgEl("g", { class: "kp-trail" });
    const dots = [];
    for (let i = 0; i < TRAIL_DOTS; i++) {
      const c = svgEl("circle", { r: 0, cx: -99, cy: -99 });
      dots.push(c);
      trailG.appendChild(c);
    }
    const ring = svgEl("ellipse", { class: "kp-ring", cx: -999, cy: -999, rx: 1, ry: 1 });
    fx.append(trailG, ring);

    const shadow = div("kp-shadow");
    shadow.style.visibility = "hidden";
    const fish = div("kp-fish");
    const tiltEl = div("kp-tilt");
    const canvas = document.createElement("canvas");
    canvas.className = "kp-canvas";
    const fishR = makeFishRenderer(canvas);
    tiltEl.appendChild(canvas);
    fish.appendChild(tiltEl);
    fish.style.visibility = "hidden";

    const bubble = div("kp-bubble");
    const typed = document.createElement("span");
    const rest = document.createElement("span");
    rest.className = "kp-rest";
    const tail = makeTail();
    bubble.append(typed, rest, tail);

    const sparkles = div("kp-sparkles");

    layer.append(fx, shadow, fish, bubble, sparkles);
    root.append(link, layer);
    document.documentElement.appendChild(host);
    ui = { host, layer, ring, dots, shadow, fish, tiltEl, fishR, bubble, typed, rest, tail, sparkles };
  }

  function startLoop() {
    if (!raf && ui && !stopped) raf = requestAnimationFrame(frame);
  }

  // Removes everything and resets state. Used by stop() and after a visit.
  function teardown() {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(typeTimer);
    clearTimeout(visitTimer);
    for (const t of sparkleTimers) clearTimeout(t);
    sparkleTimers.clear();
    typeId++;
    if (ui) ui.host.remove();
    ui = null;
    target = null; curRect = null; pos = null;
    phase = "none"; tween = null; orbit = null; settle = null;
    ringAlpha = 0; ringGoal = 0; trail = []; trailAlpha = 0;
    hopStart = -1; lastNow = 0; restChoice = null; restChosenAt = 0; placement = null;
    bubbleOn = false; rot = 0; orbitA = null; facing = -1; heading = { x: -1, y: 0 }; vel = { x: 0, y: 0 };
  }

  // ---------- Geometry ----------

  function center(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function orbitRadii(r) {
    const radius = Math.hypot(r.width / 2, r.height / 2) + ORBIT_PAD; // circle clears the corners
    return { rx: radius, ry: radius };
  }

  function ellipsePoint(r, a) {
    const c = center(r), { rx, ry } = orbitRadii(r);
    return { x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) };
  }

  function angleOn(r, p) {
    const c = center(r), { rx, ry } = orbitRadii(r);
    return Math.atan2((p.y - c.y) / ry, (p.x - c.x) / rx);
  }

  function clampFish(p) {
    return {
      x: clamp(p.x, HW + EDGE, Math.max(HW + EDGE, viewW() - HW - EDGE)),
      y: clamp(p.y, HH + EDGE, Math.max(HH + EDGE, viewH() - HH - EDGE))
    };
  }

  // ---------- Resting spot ----------
  // A choice is a side of the target plus a small vertical shift ({ side, dy }).

  function freeSpace(r) {
    const vw = viewW(), vh = viewH();
    return { right: vw - r.right, left: r.left, bottom: vh - r.bottom, top: r.top };
  }

  function sideFits(r, side) {
    const need = side === "left" || side === "right" ? FISH_W + GAP + EDGE : FISH_H + GAP + EDGE;
    return freeSpace(r)[side] >= need;
  }

  function spotFor(r, c) {
    const m = center(r);
    if (c.side === "right") return { x: r.right + GAP + HW, y: m.y + c.dy };
    if (c.side === "left") return { x: r.left - GAP - HW, y: m.y + c.dy };
    if (c.side === "bottom") return { x: m.x, y: r.bottom + GAP + HH };
    return { x: m.x, y: r.top - GAP - HH };
  }

  // How many clickable things (other than the target) would Blush cover in this box?
  // Samples a 3×3 grid with elementsFromPoint; our host has pointer-events:none so it's skipped.
  function controlsUnder(b) {
    const seen = new Set();
    for (const fx of [0.1, 0.5, 0.9]) {
      for (const fy of [0.1, 0.5, 0.9]) {
        const x = b.left + b.width * fx, y = b.top + b.height * fy;
        if (x < 0 || y < 0 || x >= viewW() || y >= viewH()) continue;
        for (const el of document.elementsFromPoint(x, y)) {
          const ctl = el.closest ? el.closest(INTERACTIVE) : null;
          if (!ctl || seen.has(ctl)) continue;
          if (target && (ctl === target || ctl.contains(target) || target.contains(ctl))) continue;
          seen.add(ctl);
        }
      }
    }
    return seen.size;
  }

  // Left or right first (whichever has more free space), each centred or shifted up/down;
  // above/below only as a fallback. Never a spot that overlaps the target; prefer one
  // that covers no other link/button, else the one covering the fewest.
  function chooseRest(r) {
    const space = freeSpace(r);
    const horiz = ["right", "left"].sort((a, b) => space[b] - space[a]);
    const vert = ["bottom", "top"].sort((a, b) => space[b] - space[a]);
    // Shifted spots sit diagonally beside the target, fully clear of its row
    // (so neighbours like "Size guide | Returns | Contact" stay uncovered).
    const shift = r.height / 2 + HH + REST_PAD + 2;
    const cands = [];
    for (const side of horiz) for (const dy of [0, -shift, shift]) cands.push({ side, dy });
    for (const side of vert) cands.push({ side, dy: 0 });
    const tgt = box(r.left, r.top, r.width, r.height);
    let best = null;
    for (const c of cands) {
      if (!sideFits(r, c.side)) continue;
      const p = clampFish(spotFor(r, c));
      const b = box(p.x - HW - REST_PAD, p.y - HH - REST_PAD, FISH_W + REST_PAD * 2, FISH_H + REST_PAD * 2);
      if (overlap(b, tgt) > 0) continue;
      const hits = controlsUnder(b);
      if (hits === 0) return c;
      if (!best || hits < best.hits) best = { c, hits };
    }
    if (best) return best.c;
    // Nothing fits (tiny viewport or target off-screen): the side with the most space.
    return { side: [...horiz, ...vert].sort((a, b) => space[b] - space[a])[0], dy: 0 };
  }

  // Keeps the chosen spot while it still fits, so Blush doesn't jump sides on scroll.
  function restSpot(r) {
    const now = performance.now();
    if (!restChoice || (!sideFits(r, restChoice.side) && now - restChosenAt > RECHOOSE_MS)) {
      restChoice = chooseRest(r);
      restChosenAt = now;
    }
    return clampFish(spotFor(r, restChoice));
  }

  function overlap(a, b) {
    if (!a || !b) return 0;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function box(left, top, w, h) {
    return { left, top, right: left + w, bottom: top + h, width: w, height: h };
  }

  // ---------- Speech bubble ----------

  function placeBubble() {
    if (!ui || !pos || !bubbleOn) return;
    const b = ui.bubble;
    const bw = b.offsetWidth, bh = b.offsetHeight;
    if (!bw || !bh) return;
    const vw = viewW(), vh = viewH();
    const fx = pos.x, fy = pos.y;
    const fishBox = box(fx - HW, fy - HH, FISH_W, FISH_H);
    const avoid = curRect && target
      ? box(curRect.left - AVOID_PAD, curRect.top - AVOID_PAD, curRect.width + AVOID_PAD * 2, curRect.height + AVOID_PAD * 2)
      : null;
    const tc = curRect ? center(curRect) : null;
    const away = tc && tc.x < fx ? "right" : "left";
    const cand = {
      above: [fx - bw / 2, fishBox.top - TAIL_GAP - bh],
      below: [fx - bw / 2, fishBox.bottom + TAIL_GAP],
      right: [fishBox.right + TAIL_GAP, fy - bh / 2],
      left: [fishBox.left - TAIL_GAP - bw, fy - bh / 2]
    };
    const order = ["above", "below", away, away === "right" ? "left" : "right"];
    if (placement && order.includes(placement)) order.unshift(placement); // stay put if still fine

    let best = null;
    for (const name of order) {
      const [l, t] = cand[name];
      const bx = box(clamp(l, EDGE, Math.max(EDGE, vw - bw - EDGE)), clamp(t, EDGE, Math.max(EDGE, vh - bh - EDGE)), bw, bh);
      const score = overlap(bx, avoid) * 10 + overlap(bx, fishBox);
      if (!best || score < best.score) best = { name, bx, score };
      if (score === 0) break;
    }
    placement = best.name;
    const { bx } = best;
    b.style.left = Math.round(bx.left) + "px";
    b.style.top = Math.round(bx.top) + "px";

    // Pixel tail points at Blush. Coordinates are relative to the padding box (inside the 5px border).
    const tx = clamp(fx - bx.left, 22, bw - 22);
    const ty = clamp(fy - bx.top, 22, bh - 22);
    let cx, cy, rot;
    if (placement === "above") { cx = tx; cy = bh + 2.5; rot = 0; }
    else if (placement === "below") { cx = tx; cy = -2.5; rot = 180; }
    else if (placement === "right") { cx = -2.5; cy = ty; rot = 90; }
    else { cx = bw + 2.5; cy = ty; rot = -90; }
    ui.tail.style.left = (cx - 5 - 12.5) + "px";
    ui.tail.style.top = (cy - 5 - 7.5) + "px";
    ui.tail.style.transform = `rotate(${rot}deg)`;
    b.style.setProperty("--kp-origin", `${Math.round(cx)}px ${Math.round(cy)}px`);
  }

  // Types text letter by letter with textContent. A new call cancels the old typing.
  function showBubble(text, onTyped) {
    if (!ui) return;
    clearTimeout(typeTimer);
    const my = ++typeId;
    const chars = Array.from(String(text || ""));
    bubbleOn = true;
    placement = null;
    ui.bubble.classList.add("show");
    if (reduced()) {
      ui.typed.textContent = chars.join("");
      ui.rest.textContent = "";
      placeBubble();
      if (onTyped) onTyped();
      return;
    }
    ui.typed.textContent = "";
    ui.rest.textContent = chars.join("");
    placeBubble();
    let i = 0;
    const tick = () => {
      if (my !== typeId || !ui) return;
      i++;
      ui.typed.textContent = chars.slice(0, i).join("");
      ui.rest.textContent = chars.slice(i).join("");
      if (i < chars.length) typeTimer = setTimeout(tick, TYPE_MS);
      else if (onTyped) onTyped();
    };
    if (chars.length) typeTimer = setTimeout(tick, TYPE_MS);
    else if (onTyped) onTyped();
  }

  function hideBubble() {
    clearTimeout(typeTimer);
    typeId++;
    bubbleOn = false;
    if (ui) ui.bubble.classList.remove("show");
  }

  // ---------- Motion phases ----------

  // kind: "swim" = she points where she's going; "rest" = she rolls level and faces the target.
  function startTween(now, to, dur, wave, onDone, kind = "swim") {
    phase = "tween";
    tween = { from: { x: pos.x, y: pos.y }, to, dur, wave, start: now, last: null, onDone, kind };
  }

  // Mirror her once, before she starts moving, if where she's going is on her other side.
  // So while travelling the destination is always on her nose side: never upside down.
  function faceToward(x) {
    if (!pos) return;
    if (x < pos.x - 1) facing = -1;
    else if (x > pos.x + 1) facing = 1;
  }

  function liveRect() {
    return target && target.isConnected ? curRect : null;
  }

  // Swim onto the orbit ellipse, then orbit. Only her very first appearance starts at
  // the right screen edge; every later guide() starts from wherever she is now.
  function beginGuideSwim(now) {
    const r = curRect;
    if (!pos) pos = { x: viewW() + HW + 10, y: clamp(center(r).y, HH + EDGE, viewH() - HH - EDGE) };
    const a0 = angleOn(r, pos);
    const dest = ellipsePoint(r, a0);
    const dist = Math.hypot(dest.x - pos.x, dest.y - pos.y);
    // ~0.9 s for a normal trip; short hops are quicker, long trips across the page a bit slower.
    const dur = dist < 120 ? SHORT_SWIM_MS : clamp(SWIM_MS * (dist / 500), SWIM_MS, MAX_SWIM_MS);
    faceToward(dest.x);
    startTween(now, () => { const lr = liveRect(); return lr ? ellipsePoint(lr, a0) : null; }, dur, true,
      (t) => startOrbit(t, a0, GUIDE_LOOPS));
  }

  function startOrbit(now, a0, loops) {
    if (!liveRect()) { phase = "free"; return; }
    phase = "orbit";
    orbit = { a0, loops, start: now };
    orbitA = a0;
    ringGoal = 1;
  }

  function goRest(now) {
    startTween(now, () => { const lr = liveRect(); return lr ? restSpot(lr) : null; }, TO_REST_MS, false, () => {
      phase = liveRect() ? "rest" : "free";
      showBubble(hint);
    }, "rest");
  }

  function onTargetLost() {
    target = null;
    curRect = null;
    ringGoal = 0;
    if (phase === "settle" || phase === "orbit" || phase === "rest" || (phase === "tween" && tween && tween.guide !== false)) {
      phase = "free";
      tween = null;
    }
    log("target left the DOM");
  }

  function stepSettle(now) {
    if (!curRect) return;
    if (settle.top === curRect.top && settle.left === curRect.left) settle.stable++;
    else settle.stable = 0;
    settle.top = curRect.top;
    settle.left = curRect.left;
    const waited = now - settle.start;
    if ((settle.stable >= 3 && waited >= settle.minMs) || waited >= SCROLL_SETTLE_MAX) beginGuideSwim(now);
  }

  function stepTween(now) {
    const tw = tween;
    const t = Math.min(1, (now - tw.start) / tw.dur);
    const dest = tw.to() || tw.last || tw.from;
    tw.last = dest;
    const e = ease(t);
    let x = tw.from.x + (dest.x - tw.from.x) * e;
    let y = tw.from.y + (dest.y - tw.from.y) * e;
    if (tw.wave) {
      const dx = dest.x - tw.from.x, dy = dest.y - tw.from.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = Math.min(14, len * 0.08) * Math.sin(Math.PI * 2 * t);
      x += (-dy / len) * off;
      y += (dx / len) * off;
    }
    pos = { x, y };
    if (t >= 1) {
      tween = null;
      if (tw.onDone) tw.onDone(now);
    }
  }

  function stepOrbit(now) {
    const r = liveRect();
    if (!r) { phase = "free"; return; }
    const t = Math.min(1, (now - orbit.start) / (orbit.loops * LOOP_MS));
    orbitA = orbit.a0 + Math.PI * 2 * orbit.loops * t; // unwrapped: keeps growing, clockwise
    pos = ellipsePoint(r, orbitA);
    ringGoal = 1;
    if (t >= 1) goRest(now);
  }

  function stepRest(dt) {
    const r = liveRect();
    if (!r) { phase = "free"; return; }
    const d = restSpot(r);
    const k = 1 - Math.exp(-dt / 60); // smooth follow on scroll/resize
    pos = { x: pos.x + (d.x - pos.x) * k, y: pos.y + (d.y - pos.y) * k };
  }

  // ---------- Frame ----------

  function frame(now) {
    raf = 0;
    if (!ui || stopped) return;
    const dt = lastNow ? Math.min(50, Math.max(1, now - lastNow)) : 16;
    lastNow = now;
    if (!ui.host.isConnected) document.documentElement.appendChild(ui.host);

    curRect = null;
    if (target) {
      if (target.isConnected) curRect = target.getBoundingClientRect();
      else onTargetLost();
    }

    const prev = pos ? { x: pos.x, y: pos.y } : null;
    const moving = phase === "tween" || phase === "orbit";
    if (phase === "settle") stepSettle(now);
    else if (phase === "tween") stepTween(now);
    else if (phase === "orbit") stepOrbit(now);
    else if (phase === "rest") stepRest(dt);
    if (!ui || stopped) return; // a phase may have torn down (end of a visit)

    render(now, dt, prev, moving);
    raf = requestAnimationFrame(frame);
  }

  function render(now, dt, prev, moving) {
    const rm = reduced();

    // Fish: direction, bob, hop.
    // The renderer draws mirror(facing) ∘ rotate(rot), so her nose points at screen angle
    //   noseOf(facing, rot) = facing > 0 ? rot : 180 − rot.
    // Every goal is first moved to the equivalent angle nearest the current one (wrap180),
    // so the rotation is continuous: no jumps at ±180°, full 360° loops on orbits.
    if (pos) {
      const noseOf = (f, r) => (f > 0 ? r : 180 - r);
      const rotFor = (f, ang) => (f > 0 ? ang : 180 - ang);   // rotation that puts her nose at ang
      const toward = (g) => rot + wrap180(g - rot);
      let goal = null, lag = SWIM_LAG, rate = SWIM_RATE;

      if (moving && prev) {
        const k = 1 - Math.exp(-dt / 90); // smoothed velocity (ignores the wavy path's little wiggles)
        vel = { x: vel.x + ((pos.x - prev.x) / dt - vel.x) * k, y: vel.y + ((pos.y - prev.y) / dt - vel.y) * k };
      } else {
        vel = { x: 0, y: 0 };
      }

      if (phase === "orbit" && orbitA !== null) {
        // Backflip loop: nose along the clockwise tangent (circle angle + 90°), no mirroring.
        goal = toward(rotFor(facing, orbitA / DEG + 90));
        lag = ORBIT_LAG; rate = ORBIT_RATE;
      } else if (phase === "tween" && tween && tween.kind === "swim") {
        // Travelling: point where she's going (the destination is on her nose side).
        if (Math.hypot(vel.x, vel.y) > 0.02) goal = toward(rotFor(facing, Math.atan2(vel.y, vel.x) / DEG));
      } else if ((phase === "tween" && tween && tween.kind === "rest") || phase === "rest") {
        // After the orbit: roll back to level, facing the target.
        const want = curRect ? (center(curRect).x >= pos.x ? 1 : -1) : facing;
        if (want !== facing && !rm) {
          // Swap the mirror only while her nose points straight up/down, where it doesn't show.
          const nose = noseOf(facing, rot);
          const v = Math.abs(wrap180(nose - 90)) <= Math.abs(wrap180(nose + 90)) ? 90 : -90;
          if (Math.abs(wrap180(nose - v)) < 6) { facing = want; rot = rotFor(want, nose); goal = toward(0); lag = LEVEL_LAG; }
          else { goal = toward(rotFor(facing, v)); lag = 60; rate = ORBIT_RATE; }
        } else {
          facing = want;
          goal = toward(0);
          lag = LEVEL_LAG;
        }
      } else if (phase === "free") {
        goal = toward(0); // level out (celebrate, visit)
        lag = LEVEL_LAG;
      }

      if (rm) rot = 0;
      else if (goal !== null) {
        // Ease toward the goal with a capped turn rate: smooth, never snapping.
        const step = (goal - rot) * (1 - Math.exp(-dt / lag));
        rot += clamp(step, -rate * dt, rate * dt);
      }
      rot = wrap180(rot); // keep the number small; drawing and comparisons don't care
      const nose = noseOf(facing, rot) * DEG;
      heading = { x: Math.cos(nose), y: Math.sin(nose) }; // nose direction on screen (trail)

      const speed = prev ? Math.hypot(pos.x - prev.x, pos.y - prev.y) / dt : 0; // px/ms
      const idle = !moving && (phase === "rest" || phase === "free");
      let offY = idle && !rm ? Math.sin((now / BOB_MS) * Math.PI * 2) * BOB_PX : 0;
      if (hopStart >= 0) {
        const t = (now - hopStart) / HOP_MS;
        if (t < 1) offY -= HOP_PX * Math.sin(Math.PI * t);
        else hopStart = -1;
      }
      ui.fish.style.visibility = "visible";
      ui.fish.style.transform = `translate(${(pos.x - HW).toFixed(1)}px, ${(pos.y - HH + offY).toFixed(1)}px)`;
      // Body wave, fins and rotation; reduced motion draws her still and level.
      ui.fishR.draw(now, dt, speed, facing, rot, rm);

      // Soft shadow on the page below her: follows her, smaller and fainter when she's
      // higher (bob/hop), narrower when her body points up or down.
      const lift = clamp(-offY / HOP_PX, -0.2, 1);            // 0 = normal height, 1 = top of a hop
      const sw = SHADOW_W * (0.5 + 0.5 * Math.abs(Math.cos(rot * DEG))) * (1 - 0.35 * lift);
      ui.shadow.style.visibility = "visible";
      ui.shadow.style.width = sw.toFixed(1) + "px";
      ui.shadow.style.transform = `translate(${(pos.x - sw / 2).toFixed(1)}px, ${(pos.y + SHADOW_DY - SHADOW_H / 2).toFixed(1)}px)`;
      ui.shadow.style.opacity = (0.9 - 0.45 * lift).toFixed(2);
    } else {
      ui.fish.style.visibility = "hidden";
      ui.shadow.style.visibility = "hidden";
    }

    // Dashed ring around the target
    if (curRect) {
      const c = center(curRect);
      ui.ring.setAttribute("cx", c.x.toFixed(1));
      ui.ring.setAttribute("cy", c.y.toFixed(1));
      ui.ring.setAttribute("rx", (curRect.width / 2 + RING_PAD_X).toFixed(1));
      ui.ring.setAttribute("ry", (curRect.height / 2 + RING_PAD_Y).toFixed(1));
    }
    const goal = curRect ? ringGoal : 0;
    ringAlpha = clamp(ringAlpha + Math.sign(goal - ringAlpha) * (dt / 350), Math.min(ringAlpha, goal), Math.max(ringAlpha, goal));
    if (rm) ringAlpha = goal;
    ui.ring.style.opacity = ringAlpha.toFixed(3);
    if (!rm) {
      dashOffset = (dashOffset - dt * 0.02) % 24;
      ui.ring.setAttribute("stroke-dashoffset", dashOffset.toFixed(2));
    }

    // Short fading dot trail behind her tail
    if (moving && pos && !rm) {
      trail.push({ x: pos.x - heading.x * TRAIL_BACK, y: pos.y - heading.y * TRAIL_BACK }); // behind her tail
      if (trail.length > TRAIL_DOTS * 3 + 1) trail.shift();
      trailAlpha = 1;
    } else {
      trailAlpha *= Math.exp(-dt / 200);
      if (trailAlpha < 0.03) { trail = []; trailAlpha = 0; }
    }
    for (let i = 0; i < TRAIL_DOTS; i++) {
      const dot = ui.dots[i];
      const p = trail[trail.length - 1 - (i + 1) * 3];
      if (!p) { dot.setAttribute("r", "0"); continue; }
      dot.setAttribute("cx", p.x.toFixed(1));
      dot.setAttribute("cy", p.y.toFixed(1));
      dot.setAttribute("r", (TRAIL_R * (1 - i * 0.1)).toFixed(2));
      dot.style.opacity = (trailAlpha * (0.7 - i * 0.08)).toFixed(3);
    }

    placeBubble();
  }

  function spawnSparkles() {
    if (!ui || !pos || reduced()) return;
    const n = 6;
    for (let i = 0; i < n; i++) {
      const s = div(i % 2 ? "kp-sparkle pink" : "kp-sparkle");
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const dist = 62 + (i % 3) * 10;
      s.style.left = (pos.x - 3) + "px";
      s.style.top = (pos.y - 3) + "px";
      s.style.setProperty("--dx", Math.round(Math.cos(a) * dist) + "px");
      s.style.setProperty("--dy", Math.round(Math.sin(a) * dist * 0.8) + "px");
      ui.sparkles.appendChild(s);
      const t = setTimeout(() => { sparkleTimers.delete(t); s.remove(); }, 1000);
      sparkleTimers.add(t);
    }
  }

  // ---------- Public API ----------

  // Swim to the element, orbit it twice, rest beside it and show the hint.
  function guide(element, text) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    gen++;
    stopped = false;
    clearTimeout(visitTimer);
    ensureUI();
    if (element !== target) ringAlpha = 0;
    target = element;
    hint = String(text || "");
    restChoice = null;
    placement = null;
    ringGoal = 0;
    hideBubble();
    tween = null;
    orbit = null;

    const r = element.getBoundingClientRect();
    const offscreen = r.top < 0 || r.left < 0 || r.bottom > viewH() || r.right > viewW();
    const rm = reduced();
    if (offscreen) element.scrollIntoView({ behavior: rm ? "auto" : "smooth", block: "center", inline: "nearest" });

    if (rm) {
      // No swim or orbit: appear at the rest spot with ring and bubble.
      curRect = element.getBoundingClientRect();
      pos = restSpot(curRect);
      phase = "rest";
      ringGoal = 1;
      ringAlpha = 1;
      showBubble(hint);
    } else {
      phase = "settle";
      // After a smooth scroll request, give the scroll time to start before trusting "stable".
      settle = { start: performance.now(), top: null, left: null, stable: 0, minMs: offscreen ? 150 : 0 };
    }
    startLoop();
    return true;
  }

  // Change the bubble text only.
  function say(text) {
    hint = String(text || "");
    if (!ui || stopped) return;
    if (phase === "rest" || phase === "free") showBubble(hint);
    // While moving, the new text appears when she arrives.
  }

  // Finish line: small hop, sparkles, bubble, then idle.
  function celebrate(text) {
    if (!ui || stopped) return;
    target = null;
    curRect = null;
    ringGoal = 0;
    tween = null;
    orbit = null;
    if (!pos) pos = clampFish({ x: viewW() - HW - 40, y: viewH() - HH - 60 });
    phase = "free";
    if (!reduced()) hopStart = performance.now();
    spawnSparkles();
    showBubble(String(text || ""));
    startLoop();
  }

  // No task running: swim in bottom-right, speak, wait 6 s, swim out, remove the host.
  function visit(text) {
    if (ui && !stopped && target) { say(text); return; }
    gen++;
    const my = gen;
    stopped = false;
    clearTimeout(visitTimer);
    ensureUI();
    target = null;
    curRect = null;
    ringGoal = 0;
    ringAlpha = 0;
    hideBubble();
    const spot = clampFish({ x: viewW() - HW - 40, y: viewH() - HH - 60 });
    const afterTyped = () => {
      visitTimer = setTimeout(() => { if (my === gen) leave(); }, VISIT_WAIT_MS);
    };
    const now = performance.now();
    if (reduced()) {
      pos = spot;
      phase = "free";
      showBubble(text, afterTyped);
    } else {
      if (!pos) pos = { x: viewW() + HW + 10, y: spot.y };
      faceToward(spot.x);
      startTween(now, () => spot, SWIM_MS, true, () => {
        phase = "free";
        showBubble(text, afterTyped);
      });
      tween.guide = false;
    }
    startLoop();
  }

  function leave() {
    if (!ui || stopped) return;
    hideBubble();
    if (reduced() || !pos) { teardown(); return; }
    const exit = { x: viewW() + HW + 20, y: pos.y };
    faceToward(exit.x);
    startTween(performance.now(), () => exit, SWIM_MS, true, () => teardown());
    tween.guide = false;
    startLoop();
  }

  // One extra orbit around the current target, then the bubble text.
  function nudge(text) {
    if (!ui || stopped) return;
    if (text) hint = String(text);
    const r = target && target.isConnected ? target.getBoundingClientRect() : null;
    if (!r || reduced() || !pos || phase !== "rest") { say(hint); return; }
    curRect = r;
    hideBubble();
    const a0 = angleOn(r, pos);
    faceToward(ellipsePoint(r, a0).x);
    startTween(performance.now(), () => { const lr = liveRect(); return lr ? ellipsePoint(lr, a0) : null; }, SHORT_SWIM_MS, false,
      (t) => startOrbit(t, a0, 1));
    startLoop();
  }

  // Instant: cancel everything, remove the host; late callbacks draw nothing.
  function stop() {
    gen++;
    teardown();
  }

  KP.overlay = {
    guide,
    say,
    celebrate,
    visit,
    nudge,
    stop,
    isActive: () => !!ui && !stopped,
    hasTarget: () => !!target && target.isConnected
  };
})();
