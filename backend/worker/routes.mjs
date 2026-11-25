const SITE = "127.0.0.1:8787";
const TASK = "find_returns";
const STATE = "store_home";

const ROUTE_LOOKUP = `
  SELECT route_json FROM routes
  WHERE site = ? AND task = ? AND start_state = ?
`;

const COUNT_COMPLETIONS = `
  SELECT COUNT(*) AS total FROM completed_runs
  WHERE site = ? AND task = ? AND start_state = ?
`;

export function validRunId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export async function countPlannerCall(db, runId) {
  const row = await db.prepare(`
    INSERT INTO planner_runs (run_id, planning_calls) VALUES (?, 1)
    ON CONFLICT (run_id) DO UPDATE SET planning_calls = planning_calls + 1
    RETURNING planning_calls
  `).bind(runId).first();

  return row.planning_calls;
}

export async function handleRoutes(pathname, db, body) {
  if (body?.site !== SITE || body.task !== TASK || body.start?.state !== STATE) {
    return Response.json({ error: "Invalid shop route request" }, { status: 400 });
  }

  const key = [SITE, TASK, STATE];

  if (pathname === "/path") {
    const [saved, count] = await db.batch([
      db.prepare(ROUTE_LOOKUP).bind(...key),
      db.prepare(COUNT_COMPLETIONS).bind(...key),
    ]);

    const verifiedRuns = count.results[0].total;
    const row = saved.results[0];

    return Response.json({
      route: row ? { ...JSON.parse(row.route_json), verifiedRuns } : null,
      verifiedRuns,
      planningCalls: 0,
    });
  }

  const step = body.steps?.[0];
  const target = step?.target;

  if (
    !validRunId(body.runId) ||
    !Array.isArray(body.steps) ||
    body.steps.length !== 1 ||
    step?.order !== 1 ||
    step.check !== "policy_visible" ||
    target?.role !== "link" ||
    typeof target.label !== "string" ||
    !/^returns$/i.test(target.label.trim())
  ) {
    return Response.json({ error: "Invalid demo completion" }, { status: 400 });
  }

  const routeJson = JSON.stringify({
    version: 1,
    site: SITE,
    task: TASK,
    start: {
      state: STATE,
      urlPattern: "/shop",
      pageTitle: "Demo shop",
      heading: "Demo shop",
    },
    steps: [{
      order: 1,
      target: { role: "link", label: "Returns" },
      hint: "Open the store's return policy.",
      check: "policy_visible",
    }],
  });

  const [, , outcome] = await db.batch([
    db.prepare(`
      INSERT INTO routes (site, task, start_state, route_json)
      SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM completed_runs WHERE run_id = ?)
      ON CONFLICT (site, task, start_state) DO NOTHING
    `).bind(...key, routeJson, body.runId),

    db.prepare(`
      INSERT INTO completed_runs (run_id, site, task, start_state)
      SELECT ?, site, task, start_state FROM routes
      WHERE site = ? AND task = ? AND start_state = ? AND route_json = ?
      ON CONFLICT (run_id) DO NOTHING
    `).bind(body.runId, ...key, routeJson),

    db.prepare(`
      SELECT
        (${COUNT_COMPLETIONS}) AS verified_runs,
        COALESCE((
          SELECT planning_calls FROM planner_runs WHERE run_id = ?
        ), 0) AS planning_calls
      FROM completed_runs AS completed
      JOIN routes USING (site, task, start_state)
      WHERE completed.run_id = ? AND completed.site = ?
        AND completed.task = ? AND completed.start_state = ?
        AND routes.route_json = ?
    `).bind(...key, body.runId, body.runId, ...key, routeJson),
  ]);

  const result = outcome.results[0];

  if (!result) {
    return Response.json({ error: "Route or run ID conflict" }, { status: 409 });
  }

  return Response.json({
    recorded: true,
    verifiedRuns: result.verified_runs,
    planningCalls: result.planning_calls,
  });
}