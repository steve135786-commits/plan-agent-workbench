import {
  agentStatus,
  approveWorkflow,
  draftForReview,
  getSettings,
  listOutputs,
  listWorkflows,
  onRunLog,
  outcomeLabel,
  pickFolder,
  readOutput,
  runWorkflow,
  saveSettings,
  shortTime,
  workflowStatus,
  type AgentStatus,
  type Draft,
  type FileContent,
  type OutputFile,
  type Settings,
  type WorkflowInfo,
} from "./api";

// ---------------------------------------------------------------------------
// Small renderers (no framework, no dependencies)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal Markdown: headings, tables, bold, inline code, lists, rules. */
function mdToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  while (i < lines.length) {
    const line = lines[i] as string;
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = (h[1] as string).length;
      out.push(`<h${level}>${inline(h[2] as string)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }
    // Table: header row + | --- | separator row + body rows.
    if (
      line.trim().startsWith("|") &&
      lines[i + 1] !== undefined &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] as string)
    ) {
      const cells = (l: string): string[] =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(line);
      out.push("<table><thead><tr>");
      for (const c of head) out.push(`<th>${inline(c)}</th>`);
      out.push("</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && (lines[i] as string).trim().startsWith("|")) {
        out.push("<tr>");
        for (const c of cells(lines[i] as string)) out.push(`<td>${inline(c)}</td>`);
        out.push("</tr>");
        i++;
      }
      out.push("</tbody></table>");
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      out.push("<ul>");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] as string)) {
        out.push(`<li>${inline((lines[i] as string).replace(/^\s*[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push("</ul>");
      continue;
    }
    out.push(`<p>${inline(line.trim())}</p>`);
    i++;
  }
  return out.join("\n");
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvToHtml(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "<p>(empty file)</p>";
  const rows = lines.map(parseCsvLine);
  const head = rows[0] as string[];
  const body = rows.slice(1);
  let html = "<table><thead><tr>";
  for (const c of head) html += `<th>${esc(c)}</th>`;
  html += "</tr></thead><tbody>";
  for (const r of body) {
    html += "<tr>";
    for (const c of r) html += `<td>${esc(c)}</td>`;
    html += "</tr>";
  }
  return html + "</tbody></table>";
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let settings: Settings = { cli_path: "", workspace_root: "" };
let workflows: WorkflowInfo[] = [];
let statuses = new Map<string, { status: string; detail: string }>();
let selectedId: string | null = null;
let outputs: OutputFile[] = [];
let running = false;
let lastRun: { workflowId: string; outcome: string; at: Date } | null = null;
/** Count of streamed run-log events seen — a run falls back to the
 * command's return value only if no event arrived (best-effort stream). */
let logEventCount = 0;

const $ = <T extends HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

function setStatusLine(text: string): void {
  $("#status-line").textContent = text;
}

function appendLog(text: string, cls = ""): void {
  const log = $("#run-log") as HTMLPreElement;
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

async function refreshAgentStatus(): Promise<void> {
  const chip = $("#agent-chip");
  if (settings.workspace_root.trim() === "") {
    chip.textContent = "Agent: not configured — pick a workspace first";
    chip.className = "chip warn";
    return;
  }
  chip.textContent = "Agent: checking…";
  chip.className = "chip";
  try {
    const s: AgentStatus = await agentStatus(settings.cli_path, settings.workspace_root);
    if (s.configured) {
      chip.textContent = `Agent: ${s.agent ?? "configured"}${s.fake ? " [FAKE test agent]" : ""} — via ${s.source ?? "?"}`;
      chip.className = "chip ok";
      chip.title =
        "Credentials and login live with the agent itself, never in this app. " +
        "Agent steps run through the CLI's ACP client.";
    } else {
      chip.textContent = "Agent: not configured — agent steps will be skipped";
      chip.className = "chip warn";
      chip.title = s.error ?? "No ACP agent configured.";
    }
  } catch (e) {
    chip.textContent = `Agent: check failed — ${e instanceof Error ? e.message : String(e)}`;
    chip.className = "chip err";
  }
}

async function refreshStatuses(): Promise<void> {
  if (settings.workspace_root.trim() === "") return;
  for (const w of workflows) {
    try {
      statuses.set(w.id, await workflowStatus(settings.workspace_root, w.id));
    } catch {
      statuses.set(w.id, { status: "unknown", detail: "could not read status" });
    }
  }
  renderWorkflowList();
}

function renderWorkflowList(): void {
  const list = $("#workflow-list");
  list.innerHTML = "";
  for (const w of workflows) {
    const st = statuses.get(w.id) ?? { status: "unknown", detail: "" };
    const card = document.createElement("div");
    card.className = `wf-card${selectedId === w.id ? " selected" : ""}`;
    card.innerHTML = `
      <div class="wf-head">
        <strong>${esc(w.id)} — ${esc(w.name)}</strong>
        <span class="badge ${esc(st.status)}">${esc(st.status)}</span>
      </div>
      <p class="wf-desc">${esc(w.description)}</p>
      <p class="wf-detail">${esc(st.detail)}</p>
      <div class="wf-actions">
        <button data-run="${esc(w.id)}" ${running ? "disabled" : ""}>Run</button>
        <button data-open="${esc(w.id)}">Outputs</button>
      </div>`;
    card.querySelector("[data-run]")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void runSelected(w.id);
    });
    card.querySelector("[data-open]")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void selectWorkflow(w.id);
    });
    card.addEventListener("click", () => void selectWorkflow(w.id));
    list.appendChild(card);
  }
  if (workflows.length === 0) {
    list.innerHTML = `<p class="hint">No workflows found in ${esc(settings.workspace_root)}/workflows/ — check the workspace folder in Settings.</p>`;
  }
}

async function selectWorkflow(id: string): Promise<void> {
  selectedId = id;
  renderWorkflowList();
  const panel = $("#outputs-panel");
  panel.innerHTML = `<h2>Outputs — ${esc(id)}</h2><p class="hint">Loading…</p>`;
  try {
    outputs = await listOutputs(settings.workspace_root, id);
    if (outputs.length === 0) {
      panel.innerHTML = `<h2>Outputs — ${esc(id)}</h2><p class="hint">No outputs yet — run the workflow first.</p>`;
      return;
    }
    const list = outputs
      .map(
        (o, i) =>
          `<button class="out-btn" data-i="${i}">${esc(o.label)}</button>`,
      )
      .join(" ");
    panel.innerHTML = `<h2>Outputs — ${esc(id)}</h2><div class="out-list">${list}</div><div id="viewer" class="viewer"><p class="hint">Pick a file to preview it here.</p></div>`;
    panel.querySelectorAll("[data-i]").forEach((b) =>
      b.addEventListener("click", () => {
        const o = outputs[Number((b as HTMLElement).dataset.i)] as OutputFile;
        void viewOutput(o);
      }),
    );
  } catch (e) {
    panel.innerHTML = `<h2>Outputs — ${esc(id)}</h2><p class="err">Could not list outputs: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

async function viewOutput(o: OutputFile): Promise<void> {
  const viewer = $("#viewer");
  if (!viewer) return;
  viewer.innerHTML = `<p class="hint">Loading ${esc(o.label)}…</p>`;
  try {
    const c: FileContent = await readOutput(settings.workspace_root, o.path);
    if (c.kind === "image") {
      viewer.innerHTML = `<h3>${esc(o.label)} <span class="meta">${c.size} bytes</span></h3><img class="preview-img" src="data:${esc(c.mime)};base64,${c.base64 ?? ""}" alt="${esc(o.label)}" />`;
    } else if (c.kind === "pdf") {
      viewer.innerHTML = `<h3>${esc(o.label)} <span class="meta">${c.size} bytes</span></h3><p class="hint">PDF preview uses the webview's built-in viewer; if it stays blank, open the file from ${esc(o.path)}.</p><embed class="preview-pdf" type="application/pdf" src="data:application/pdf;base64,${c.base64 ?? ""}" />`;
    } else if (c.mime === "text/csv") {
      viewer.innerHTML = `<h3>${esc(o.label)}</h3>${csvToHtml(c.text ?? "")}`;
    } else if (c.mime === "text/markdown") {
      viewer.innerHTML = `<h3>${esc(o.label)}</h3><div class="md">${mdToHtml(c.text ?? "")}</div>`;
    } else {
      viewer.innerHTML = `<h3>${esc(o.label)}</h3><pre>${esc(c.text ?? "")}</pre>`;
    }
  } catch (e) {
    viewer.innerHTML = `<p class="err">Could not open ${esc(o.label)}: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

function draftToHtml(d: Draft): string {
  if (d.kind === "map" && d.image_base64) {
    return `<img class="preview-img" src="data:image/png;base64,${d.image_base64}" alt="Draft map" />`;
  }
  if (d.rows.length === 0) return `<p class="hint">${esc(d.note)}</p>`;
  let html = "<table><thead><tr>";
  for (const h of d.headers) html += `<th>${esc(h)}</th>`;
  html += "</tr></thead><tbody>";
  for (const r of d.rows) {
    html += "<tr>";
    for (const c of r.cells) html += `<td>${esc(c)}</td>`;
    html += "</tr>";
  }
  return html + "</tbody></table>";
}

async function showReviewDialog(workflowId: string): Promise<void> {
  const modal = $("#review-modal");
  const body = $("#review-body");
  $("#review-title").textContent = `Human review — ${workflowId}`;
  body.innerHTML = `<p class="hint">Loading draft…</p>`;
  modal.classList.remove("hidden");
  try {
    const d: Draft = await draftForReview(settings.workspace_root, workflowId);
    body.innerHTML = `<p class="hint">${esc(d.note)}</p>${draftToHtml(d)}`;
  } catch (e) {
    body.innerHTML = `<p class="err">Could not load the draft: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
  const approveBtn = $("#review-approve") as HTMLButtonElement;
  approveBtn.disabled = false;
  approveBtn.textContent = "Approve";
  approveBtn.onclick = async () => {
    approveBtn.disabled = true;
    approveBtn.textContent = "Approving…";
    appendLog(`\nApproving ${workflowId}…\n`);
    const logBefore = logEventCount;
    try {
      const r = await approveWorkflow(settings.cli_path, settings.workspace_root, workflowId);
      // Events are delivered asynchronously; give in-flight events a beat
      // to land before deciding the stream produced nothing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (logEventCount === logBefore) {
        appendLog(r.stdout + r.stderr);
      }
      if (r.code === 0) {
        setStatusLine(`PlanAgent: ${workflowId} approved · ${shortTime(new Date())}`);
        lastRun = { workflowId, outcome: "approved", at: new Date() };
        modal.classList.add("hidden");
        appendLog("Approved.\n", "ok");
      } else {
        setStatusLine(`PlanAgent: ${workflowId} approve failed · ${shortTime(new Date())}`);
        appendLog(`Approve failed (exit ${r.code}).\n`, "err");
        approveBtn.disabled = false;
        approveBtn.textContent = "Approve";
      }
    } catch (e) {
      appendLog(`Approve failed: ${e instanceof Error ? e.message : String(e)}\n`, "err");
      approveBtn.disabled = false;
      approveBtn.textContent = "Approve";
    }
    await refreshStatuses();
  };
  ($("#review-open") as HTMLButtonElement).onclick = () => {
    modal.classList.add("hidden");
    void selectWorkflow(workflowId);
  };
  ($("#review-close") as HTMLButtonElement).onclick = () => {
    modal.classList.add("hidden");
  };
}

async function runSelected(workflowId: string): Promise<void> {
  if (running) return;
  if (settings.workspace_root.trim() === "") {
    setStatusLine("Pick a workspace folder in Settings first.");
    return;
  }
  running = true;
  renderWorkflowList();
  selectedId = workflowId;
  const started = new Date();
  appendLog(`\n$ plan-agent run workflows/${workflowId}.yaml\n`);
  setStatusLine(`PlanAgent: ${workflowId} running…`);
  const logBefore = logEventCount;
  try {
    const r = await runWorkflow(settings.cli_path, settings.workspace_root, workflowId);
    // The streamed log already holds the output; fall back to the return
    // value only if no event arrived (the stream is best-effort). Events
    // are delivered asynchronously, so give in-flight events a beat to
    // land before deciding the stream produced nothing.
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (logEventCount === logBefore) {
      appendLog(r.stdout + r.stderr);
    }
    if (r.stdout.trim() === "" && r.stderr.trim() === "" && logEventCount === logBefore) {
      appendLog("(no output)\n");
    }
    lastRun = { workflowId, outcome: r.outcome, at: new Date() };
    setStatusLine(
      `PlanAgent: ${workflowId} ${outcomeLabel(r.outcome)} · ${shortTime(started)}`,
    );
    if (r.outcome === "paused") {
      appendLog(`Paused for human review (exit 3).\n`, "warn");
      await refreshStatuses();
      await showReviewDialog(workflowId);
    } else if (r.outcome === "done") {
      appendLog("Done.\n", "ok");
    } else {
      const last = (r.stderr.trim() || r.stdout.trim()).split("\n").pop() ?? "failed";
      appendLog(`Failed (exit ${r.code}): ${last}\n`, "err");
    }
  } catch (e) {
    lastRun = { workflowId, outcome: "error", at: new Date() };
    setStatusLine(`PlanAgent: ${workflowId} failed · ${shortTime(started)}`);
    appendLog(`Could not run the CLI: ${e instanceof Error ? e.message : String(e)}\n`, "err");
  }
  running = false;
  await refreshStatuses();
}

async function loadAll(): Promise<void> {
  if (settings.workspace_root.trim() === "") {
    workflows = [];
    renderWorkflowList();
    return;
  }
  try {
    workflows = await listWorkflows(settings.workspace_root);
  } catch (e) {
    workflows = [];
    setStatusLine(`Could not list workflows: ${e instanceof Error ? e.message : String(e)}`);
  }
  await refreshStatuses();
  await refreshAgentStatus();
}

async function init(): Promise<void> {
  // Layout.
  $("#app").innerHTML = `
    <header>
      <div>
        <h1>PlanAgent Workbench</h1>
        <p class="sub">ACP planning workbench — regulation screening · CAD→GIS metrics · standard maps</p>
      </div>
      <div class="header-right">
        <span id="agent-chip" class="chip">Agent: …</span>
        <button id="settings-toggle">Settings</button>
      </div>
    </header>
    <section id="settings-panel" class="panel hidden">
      <h2>Settings</h2>
      <p class="hint">The app shells out to the local <code>plan-agent</code> CLI — it never runs models itself. Credentials and login live with the agent, never here.</p>
      <label>Workspace root (workbench repo)
        <span class="row"><input id="in-workspace" type="text" placeholder="/path/to/plan-agent-workbench" /><button id="browse-workspace">Browse…</button></span>
      </label>
      <label>CLI path (empty = &lt;workspace&gt;/dist/cli.js, run with node)
        <span class="row"><input id="in-cli" type="text" placeholder="" /><button id="browse-cli">Browse…</button></span>
      </label>
      <div class="row">
        <button id="save-settings">Save settings</button>
        <span id="settings-msg" class="hint"></span>
      </div>
    </section>
    <main>
      <section class="col">
        <h2>Workflows</h2>
        <div id="workflow-list"></div>
        <h2>Run log</h2>
        <pre id="run-log" class="log"></pre>
      </section>
      <section class="col">
        <div id="outputs-panel">
          <h2>Outputs</h2>
          <p class="hint">Select a workflow to see its outputs.</p>
        </div>
      </section>
    </main>
    <footer><span id="status-line">PlanAgent: idle</span></footer>
    <div id="review-modal" class="modal hidden">
      <div class="modal-card">
        <h2 id="review-title">Human review</h2>
        <div id="review-body"></div>
        <div class="modal-actions">
          <button id="review-open">Review draft</button>
          <button id="review-approve" class="primary">Approve</button>
          <button id="review-close">Close</button>
        </div>
        <p class="hint">Approval runs <code>plan-agent run … --approve</code>: it verifies the draft is unchanged and records your decision in the audit log. The app never finalises anything itself.</p>
      </div>
    </div>`;

  settings = await getSettings();
  ($("#in-workspace") as HTMLInputElement).value = settings.workspace_root;
  ($("#in-cli") as HTMLInputElement).value = settings.cli_path;

  const settingsPanel = $("#settings-panel");
  const needsSetup = settings.workspace_root.trim() === "";
  if (needsSetup) {
    settingsPanel.classList.remove("hidden");
    setStatusLine("Pick the workbench repo folder in Settings to get started.");
  }
  $("#settings-toggle").addEventListener("click", () =>
    settingsPanel.classList.toggle("hidden"),
  );
  $("#browse-workspace").addEventListener("click", async () => {
    const picked = await pickFolder();
    if (picked) ($("#in-workspace") as HTMLInputElement).value = picked;
  });
  $("#browse-cli").addEventListener("click", async () => {
    const picked = await pickFolder();
    if (picked) ($("#in-cli") as HTMLInputElement).value = picked;
  });
  $("#save-settings").addEventListener("click", async () => {
    settings = {
      workspace_root: ($("#in-workspace") as HTMLInputElement).value.trim(),
      cli_path: ($("#in-cli") as HTMLInputElement).value.trim(),
    };
    try {
      await saveSettings(settings);
      $("#settings-msg").textContent = "Saved.";
      await loadAll();
    } catch (e) {
      $("#settings-msg").textContent = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  });

  // Load the workflow list first: registering the run-log listener must
  // never block the initial render (if listen ever failed or stalled,
  // the list and agent chip should still show up; the run commands fall
  // back to their return values when no stream events arrive).
  await loadAll();

  // Streamed run output (best-effort; the command return value is the
  // fallback — see logEventCount in runSelected / the approve handler).
  await onRunLog((ev) => {
    logEventCount++;
    appendLog(ev.text, ev.stream === "stderr" ? "dim" : "");
  });
}

void init();
