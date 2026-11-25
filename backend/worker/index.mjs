import { planReturnsStep } from "./planner.mjs";
import { countPlannerCall, handleRoutes, validRunId } from "./routes.mjs";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

      if (request.method !== "POST" || !["/next", "/path", "/complete"].includes(pathname)) {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST" || pathname !== "/next") {
      return Response.json({ error: "Unknown endpoint" }, { status: 404 });
    }

    if (!env.DEMO_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.DEMO_TOKEN}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
        if (pathname !== "/next") {
      try {
        return await handleRoutes(pathname, env.DB, body);
      } catch {
        return Response.json({ error: "Route storage failed" }, { status: 500 });
      }
    }

    if (
      body?.site !== "127.0.0.1:8787" ||
      body.task !== "find_returns" ||
      !validRunId(body.runId) ||
      !Array.isArray(body.allowedChecks) ||
      !body.allowedChecks.includes("policy_visible") ||
      !Array.isArray(body.controls) ||
      body.controls.length === 0 ||
      body.controls.length > 30
    ) {
      return Response.json({ error: "Invalid shop planner request" }, { status: 400 });
    }

    const controls = [];

    for (const control of body.controls) {
      if (
        typeof control?.id !== "string" ||
        typeof control.role !== "string" ||
        typeof control.label !== "string" ||
        control.id.length > 40 ||
        control.role.length > 40 ||
        control.label.length > 120
      ) {
        return Response.json({ error: "Invalid control" }, { status: 400 });
      }

      controls.push({ id: control.id, role: control.role, label: control.label });
    }

    if (!env.GROQ_API_KEY) {
      return Response.json({ error: "Planner is unavailable" }, { status: 503 });
    }

      try {
      const planningCalls = await countPlannerCall(env.DB, body.runId);
      const step = await planReturnsStep(env.GROQ_API_KEY, controls);
      return Response.json({ ...step, source: "planner", planningCalls });
    } catch (error) {
      console.error("Planner failed:", error.message);
      return Response.json({ error: "Planner request failed" }, { status: 502 });
    }
  },
};