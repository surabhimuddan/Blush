const form = document.querySelector("#goal-form");
const goalInput = document.querySelector("#goal");
const startButton = document.querySelector("#start");
const askButton = document.querySelector("#ask");
const repeatButton = document.querySelector("#repeat");
const stopButton = document.querySelector("#stop");
const hint = document.querySelector("#hint");
const planningCalls = document.querySelector("#planning-calls");
const verifiedRuns = document.querySelector("#verified-runs");

const runtime = globalThis.chrome?.runtime;

function showUpdate(message) {
  const { type, payload } = message ?? {};
  if (!payload || typeof payload !== "object") return;

  if (type === "PANEL_STATUS" && typeof payload.message === "string") {
    hint.textContent = payload.message;
  }

  if (type === "PANEL_ANSWER" && typeof payload.answer === "string") {
    hint.textContent = payload.answer;
  }

  if (type === "PANEL_STATE" || type === "PANEL_COUNTERS") {
    if (Number.isInteger(payload.planningCalls) && payload.planningCalls >= 0) {
      planningCalls.value = String(payload.planningCalls);
    }

    if (Number.isInteger(payload.verifiedRuns) && payload.verifiedRuns >= 0) {
      verifiedRuns.value = String(payload.verifiedRuns);
    }
  }
}

async function send(type, payload = {}) {
  try {
    const reply = await runtime.sendMessage({ type, payload });
    showUpdate(reply);

    if (reply?.ok === false) {
      if (type !== "PANEL_ASK") {
        hint.textContent = "KoiPilot couldn't complete that action. Try again.";
      }
      return false;
    }

    return true;
  } catch {
    hint.textContent = "The extension connection is unavailable.";
    return false;
  }
}

async function askQuestion() {
  if (askButton.disabled) return;

  const question = goalInput.value.trim();

  if (!question || question.length > 300) {
    hint.textContent = "Enter a question up to 300 characters.";
    goalInput.focus();
    return;
  }

  askButton.disabled = true;
  const waitingMessage = "Thinking…";
  hint.textContent = waitingMessage;

  try {
    await send("PANEL_ASK", { question });

    if (hint.textContent === waitingMessage) {
      hint.textContent = "KoiPilot couldn't answer. Try again.";
    }
  } finally {
    askButton.disabled = false;
  }
}

if (runtime?.id) {
  runtime.onMessage.addListener(showUpdate);
  startButton.disabled = false;
  askButton.disabled = false;
  void send("PANEL_GET_STATE");

  askButton.addEventListener("click", (event) => {
    event.preventDefault();
    void askQuestion();
  });

  goalInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;

    event.preventDefault();
    if (!event.repeat) void askQuestion();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter !== startButton || startButton.disabled) return;

    const goal = goalInput.value.trim();
    if (!goal) return;

    startButton.disabled = true;
    const started = await send("PANEL_START", { goal });
    startButton.disabled = started;
    repeatButton.disabled = !started;
    stopButton.disabled = !started;
  });

  repeatButton.addEventListener("click", () => {
    void send("PANEL_REPEAT");
  });

  stopButton.addEventListener("click", async () => {
    if (await send("PANEL_STOP")) {
      startButton.disabled = false;
      repeatButton.disabled = true;
      stopButton.disabled = true;
    }
  });
} else {
  hint.textContent = "Layout preview. Open KoiPilot from the Chrome extension to start.";
}