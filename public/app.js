const accessDialog = document.querySelector("#access-dialog");
const accessForm = document.querySelector("#access-form");
const accessCodeInput = document.querySelector("#access-code");
const accessError = document.querySelector("#access-error");
const resolveForm = document.querySelector("#resolve-form");
const runResult = document.querySelector("#run-result");
const runStatus = document.querySelector("#run-status");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const messages = document.querySelector("#messages");
const chatStatus = document.querySelector("#chat-status");
const interactionRegion = document.querySelector("#interaction");
let accessCode = localStorage.getItem("jobnovaAccessCode") || "";
let sessionId;
let chatBusy = false;

if (!accessCode) accessDialog.showModal();

document.querySelector("#change-code").addEventListener("click", () => {
  accessCodeInput.value = accessCode;
  accessDialog.showModal();
  accessCodeInput.focus();
});

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const proposed = accessCodeInput.value;
  const response = await fetch("/api/eval", { headers: { "x-access-code": proposed } });
  if (!response.ok) {
    accessError.textContent = "That invite code was not accepted.";
    return;
  }
  accessCode = proposed;
  localStorage.setItem("jobnovaAccessCode", accessCode);
  accessError.textContent = "";
  accessDialog.close();
  loadEvaluation();
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-access-code": accessCode,
      ...options.headers,
    },
  });
  if (response.status === 401) {
    accessDialog.showModal();
    throw new Error("Enter a valid invite code to continue.");
  }
  return response;
}

resolveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = resolveForm.querySelector("button");
  button.disabled = true;
  runStatus.textContent = "Starting";
  runResult.innerHTML = '<p class="empty-copy">Creating a persistent server-side run…</p>';
  try {
    const response = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ url: resolveForm.elements.url.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not start the resolver.");
    history.replaceState(null, "", `#run=${body.runId}`);
    await pollRun(body.runId);
  } catch (error) {
    showRunError(error.message);
  } finally {
    button.disabled = false;
  }
});

async function pollRun(runId) {
  while (true) {
    const response = await api(`/api/runs/${runId}`);
    const run = await response.json();
    if (!response.ok) throw new Error(run.error || "Could not load this run.");
    runStatus.textContent = run.status === "running" ? "Resolving" : run.status;
    if (run.status === "queued" || run.status === "running") {
      runResult.innerHTML = `<p class="empty-copy">The resolver is working in the browser. Run ID: ${escapeHtml(runId)}</p>`;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    await renderRun(run);
    return;
  }
}

async function renderRun(run) {
  const result = run.result;
  if (!result?.success) {
    showRunError(result?.error || "The resolver could not verify a destination.", run.runtimeMs, run.trace);
    return;
  }
  runResult.innerHTML = `
    <p class="result-title">${escapeHtml(result.jobTitle)}</p>
    <p>${escapeHtml(result.company)}</p>
    <a class="result-link" href="${escapeAttribute(result.externalJobUrl)}" target="_blank" rel="noreferrer">Open verified job source</a>
    <p class="result-meta">${formatDuration(run.runtimeMs)} · ${run.trace.length} trace events</p>
    <div class="screenshots"></div>
  `;
  const screenshotRegion = runResult.querySelector(".screenshots");
  for (const url of run.screenshotUrls || []) {
    const response = await api(url, { headers: { "content-type": undefined } });
    if (!response.ok) continue;
    const image = document.createElement("img");
    image.src = URL.createObjectURL(await response.blob());
    image.alt = "Resolver browser evidence";
    screenshotRegion.append(image);
  }
}

function showRunError(message, runtimeMs = 0, trace = []) {
  runStatus.textContent = "Blocked";
  runResult.innerHTML = `
    <div class="blocker">
      <p class="result-title">Resolver blocked</p>
      <p class="empty-copy">${escapeHtml(message)}</p>
      ${runtimeMs ? `<p class="result-meta">${formatDuration(runtimeMs)} · ${trace.length} trace events</p>` : ""}
    </div>`;
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (chatBusy) return;
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  addMessage("user", text);
  await streamChat("message", { text });
});

async function streamChat(action, body) {
  setChatBusy(true);
  interactionRegion.replaceChildren();
  try {
    if (!sessionId) {
      const created = await api("/api/chat", { method: "POST", body: "{}" });
      const value = await created.json();
      if (!created.ok) throw new Error(value.error || "Could not start a chat.");
      sessionId = value.sessionId;
    }
    const response = await api(`/api/chat/${sessionId}/${action}`, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) {
      const value = await response.json();
      throw new Error(value.error || "The career agent could not continue.");
    }
    await readEventStream(response);
  } catch (error) {
    addMessage("agent", `Blocked: ${error.message}`);
    chatStatus.textContent = "Blocked";
  } finally {
    setChatBusy(false);
  }
}

async function readEventStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let agentMessage;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const records = buffer.split("\n\n");
    buffer = records.pop() || "";
    for (const record of records) {
      const dataLine = record.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(5).trim());
      if (event.type === "text_delta") {
        if (!agentMessage) agentMessage = addMessage("agent", "");
        agentMessage.textContent += event.delta;
        scrollMessages();
      } else if (event.type === "tool") {
        agentMessage = undefined;
        const detail = event.phase === "failed" && event.error ? `: ${event.error}` : "";
        addActivity(`${toolLabel(event.name)} ${event.phase}${detail}`, event.phase === "failed");
      } else if (event.type === "interaction") {
        agentMessage = undefined;
        renderInteraction(event.interaction);
      } else if (event.type === "status") {
        chatStatus.textContent = event.status === "thinking" ? "Working" : "Continuing";
      } else if (event.type === "error") {
        agentMessage = undefined;
        addMessage("agent", `Blocked: ${event.error}`);
        chatStatus.textContent = "Blocked";
      } else if (event.type === "done") {
        chatStatus.textContent = "Ready";
      }
    }
    if (done) break;
  }
}

function renderInteraction(interaction) {
  const card = document.createElement("form");
  card.className = "interaction-card";
  let controls = "";
  if (interaction.kind === "user_input") {
    if (interaction.options?.length) {
      controls = `<select name="value" required>${interaction.options.map((option) => `<option>${escapeHtml(option)}</option>`).join("")}</select>`;
    } else if (interaction.inputType === "boolean") {
      controls = '<select name="value" required><option value="yes">Yes</option><option value="no">No</option></select>';
    } else {
      controls = `<input name="value" type="${escapeAttribute(interaction.inputType || "text")}" required placeholder="${escapeAttribute(interaction.formatHint || "")}">`;
    }
  } else if (interaction.kind === "answer_approval") {
    controls = `<p><strong>Draft:</strong> ${escapeHtml(interaction.draft)}</p><div class="button-row"><button name="value" value="yes">Approve answer</button><button name="value" value="no">Reject answer</button></div>`;
  } else {
    controls = '<div class="button-row"><button name="value" value="yes">Confirm one submission</button><button name="value" value="no">Do not submit</button></div>';
  }
  card.innerHTML = `<h3>${escapeHtml(interaction.label || interaction.prompt || "Action required")}</h3>
    ${interaction.description ? `<p>${escapeHtml(interaction.description)}</p>` : ""}
    ${controls}
    ${interaction.kind === "user_input" ? '<button type="submit">Continue privately</button>' : ""}`;
  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    const value = submitter?.value || new FormData(card).get("value");
    card.remove();
    await streamChat("respond", { value: String(value) });
  });
  interactionRegion.replaceChildren(card);
}

function setChatBusy(busy) {
  chatBusy = busy;
  chatInput.disabled = busy;
  chatForm.querySelector("button").disabled = busy;
  if (busy) chatStatus.textContent = "Working";
}

function addMessage(kind, text) {
  const element = document.createElement("div");
  element.className = `message ${kind}`;
  element.textContent = text;
  messages.append(element);
  scrollMessages();
  return element;
}

function addActivity(text, failed = false) {
  const element = addMessage("activity", text);
  if (failed) element.classList.add("failed");
}

function scrollMessages() {
  messages.scrollTop = messages.scrollHeight;
}

async function loadEvaluation() {
  if (!accessCode) return;
  try {
    const response = await api("/api/eval");
    const evaluation = await response.json();
    if (!response.ok || !evaluation.cases?.length) return;
    document.querySelector("#eval-summary").textContent = evaluation.summary
      ? `${evaluation.summary.correct}/${evaluation.summary.total} correct`
      : `${evaluation.cases.length} cases`;
    document.querySelector("#eval-body").innerHTML = evaluation.cases.map((item) => `
      <tr>
        <td>${escapeHtml(String(item.case))}</td>
        <td>${escapeHtml(item.company || "Unknown")}<br>${escapeHtml(item.jobTitle || "")}</td>
        <td>${item.correct ? "Correct" : "Failed"}</td>
        <td>${formatDuration(item.runtimeMs || 0)}</td>
        <td>${escapeHtml(item.failureReason || "")}</td>
      </tr>`).join("");
  } catch {}
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function toolLabel(name) {
  return String(name).replace(/^(browser_|stagehand_)/, "").replaceAll("_", " ");
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

const runFromHash = location.hash.match(/^#run=([a-f0-9-]+)$/)?.[1];
if (accessCode) {
  loadEvaluation();
  if (runFromHash) pollRun(runFromHash).catch((error) => showRunError(error.message));
}
