import { planReturnsStep } from "./planner.mjs";
import { countPlannerCall, handleRoutes, validRunId } from "./routes.mjs";

const POST_ENDPOINTS = new Set(["/ask", "/next", "/path", "/complete"]);

async function answerQuestion(body, apiKey) {
  const question = typeof body?.question === "string" ? body.question.trim() : "";

  if (!question || question.length > 300) {
    return Response.json(
      { error: "Enter a question up to 300 characters." },
      { status: 400 },
    );
  }

  if (!apiKey) {
    return Response.json(
      { error: "Question answering is unavailable." },
      { status: 503 },
    );
  }

  const site = typeof body.site === "string" ? body.site.slice(0, 253) : "";

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content:
              "Answer the user's question directly in simple language. " +
              "Use the site name as optional context. " +
              "If the answer depends on details of the current page, " +
              "say what information you need and avoid guessing what the page shows.",
          },
          {
            role: "user",
            content: JSON.stringify({ question, site }),
          },
        ],
      }),
    });

    if (response.status === 429) {
      return Response.json(
        { error: "Groq is busy. Try again shortly." },
        { status: 429 },
      );
    }

    if (!response.ok) {
      throw new Error("Groq request failed");
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content;

    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("Groq returned an empty answer");
    }

    return Response.json({ answer: answer.trim() });
  } catch {
    return Response.json(
      { error: "Could not answer the question. Try again." },
      { status: 502 },
    );
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST" || !POST_ENDPOINTS.has(pathname)) {
      return Response.json({ error: "Unknown endpoint" }, { status: 404 });
    }

    if (
      !env.DEMO_TOKEN ||
      request.headers.get("Authorization") !== `Bearer ${env.DEMO_TOKEN}`
    ) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);

    if (pathname === "/ask") {
      return answerQuestion(body, env.GROQ_API_KEY);
    }

    if (pathname === "/path" || pathname === "/complete") {
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