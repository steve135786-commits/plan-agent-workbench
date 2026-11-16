#!/usr/bin/env node
/**
 * plan-agent CLI — v0.1.0 (Phase 1: W1 and W2 run end-to-end).
 *
 * Commands:
 *   plan-agent demo            list the MVP workflows
 *   plan-agent run <workflow>  validate the YAML and execute its steps
 *   plan-agent --help
 *
 * `run` executes deterministic steps by spawning the Python sidecar and
 * skips agent steps with an explicit audit-log entry — it never fakes
 * agent output. The ACP client itself is still pending. See
 * docs/workflows.md for the YAML format and the validation rules.
 */
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, "workflows");
const VERSION = "0.1.0";

interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
}

interface WorkflowInput {
  name: string;
  path: string;
  kind: string;
  required: boolean;
  note?: string;
}

interface WorkflowParameter {
  name: string;
  value: string | number;
  unit: string;
  source: string;
}

interface WorkflowStep {
  id: string;
  kind: string;
  name: string;
  runs?: string;
  uses?: string;
  outputs?: string[];
}

interface WorkflowOutput {
  name: string;
  path: string;
  kind: string;
  note?: string;
}

interface WorkflowDoc {
  workflow: { version: string; id: string; name: string; description: string };
  inputs: WorkflowInput[];
  parameters: WorkflowParameter[];
  steps: WorkflowStep[];
  outputs: WorkflowOutput[];
  audit: { log: string; require: string[] };
}

function extractDescription(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*description:\s*>/.test(l));
  if (start < 0) return "";
  const parts: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!/^ {2,}\S/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(" ");
}

function listWorkflows(): WorkflowSummary[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const text = readFileSync(join(WORKFLOWS_DIR, f), "utf-8");
      const id = text.match(/^\s+id:\s*(\S+)/m)?.[1] ?? f;
      const name = text.match(/^\s+name:\s*(.+)$/m)?.[1]?.trim() ?? f;
      const description = extractDescription(text);
      return { id, name, description };
    })
    .sort((a: WorkflowSummary, b: WorkflowSummary) => a.id.localeCompare(b.id));
}

function printHelp(): void {
  console.log(`plan-agent ${VERSION} — ACP planning workbench (Phase 1: W1 and W2 run)

Usage:
  plan-agent demo              list the MVP workflows
  plan-agent run <workflow>    validate and run a workflow YAML (deterministic
                               steps execute; agent steps are skipped until
                               an ACP agent is connected; a human_review step
                               pauses the run — see --approve)
  plan-agent run <workflow> --approve
                               finalise a run paused at a human_review step:
                               verifies the draft is unchanged, records the
                               human decision and writes the final output
  plan-agent --help            show this help

Exit codes: 0 done, 1 error, 2 usage, 3 paused for human review.

Workflows live in workflows/ — see docs/workflows.md for the YAML format.`);
}

function cmdDemo(): void {
  const workflows = listWorkflows();
  if (workflows.length === 0) {
    console.log("No workflows found in workflows/.");
    return;
  }
  console.log("MVP workflows (W1 and W2 run end-to-end; W3 engine lands later):\n");
  for (const w of workflows) {
    console.log(`  ${w.id}  ${w.name}`);
    if (w.description) console.log(`      ${w.description}`);
  }
  console.log("\nRun one: plan-agent run workflows/w1-regulation-screening.yaml");
  console.log("         plan-agent run workflows/w2-cad-gis-metrics.yaml");
}

// ---------------------------------------------------------------------------
// `plan-agent run`
// ---------------------------------------------------------------------------

const INPUT_KINDS = new Set(["pdf", "markdown", "dxf", "shp", "geojson", "csv", "yaml"]);
const STEP_KINDS = new Set(["deterministic", "agent", "human_review"]);
const AGENT_SKIP_NOTES: Record<string, string> = {
  // Keyed by the agent step's declared output file, so the note says
  // exactly what was not produced. W2's wording is preserved verbatim.
  "conversion-review.md": "review not performed, no proposal generated",
  "explanations.md": "explanations not drafted",
};

function agentSkipNote(step: WorkflowStep): string {
  const outputs = step.outputs ?? [];
  for (const o of outputs) {
    const note = AGENT_SKIP_NOTES[o];
    if (note) return `SKIPPED: no ACP agent connected yet — ${note}`;
  }
  return "SKIPPED: no ACP agent connected yet — no output produced";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveWorkflowPath(target: string): string {
  if (existsSync(target)) return resolve(target);
  const underRoot = join(ROOT, target);
  if (existsSync(underRoot)) return underRoot;
  throw new Error(`workflow file not found: ${target}`);
}

function resolveUnderRoot(p: string): string {
  return resolve(ROOT, p);
}

/** Validate the parsed YAML against docs/workflows.md. Throws one-line errors. */
function validateWorkflow(doc: unknown): WorkflowDoc {
  if (!isRecord(doc)) throw new Error("workflow YAML must be a mapping");
  const w = doc["workflow"];
  if (!isRecord(w)) throw new Error("missing top-level 'workflow' mapping");
  for (const f of ["version", "id", "name", "description"]) {
    if (typeof w[f] !== "string" || (w[f] as string).trim() === "") {
      throw new Error(`workflow.${f} is required (docs/workflows.md)`);
    }
  }
  const wid = w["id"] as string;
  for (const f of ["inputs", "parameters", "steps", "outputs"]) {
    if (!Array.isArray(doc[f]) || (doc[f] as unknown[]).length === 0) {
      throw new Error(`top-level '${f}' must be a non-empty list (docs/workflows.md)`);
    }
  }
  for (const inp of doc["inputs"] as unknown[]) {
    if (!isRecord(inp)) throw new Error("each input must be a mapping");
    for (const f of ["name", "path", "kind"]) {
      if (typeof inp[f] !== "string" || (inp[f] as string).trim() === "") {
        throw new Error(`input is missing required field '${f}'`);
      }
    }
    if (!INPUT_KINDS.has(inp["kind"] as string)) {
      throw new Error(`input '${inp["name"]}': unknown kind '${inp["kind"]}'`);
    }
    if (typeof inp["required"] !== "boolean") {
      throw new Error(`input '${inp["name"]}': 'required' must be true/false`);
    }
  }
  for (const p of doc["parameters"] as unknown[]) {
    if (!isRecord(p)) throw new Error("each parameter must be a mapping");
    for (const f of ["name", "value", "unit", "source"]) {
      if (p[f] === undefined || p[f] === "") {
        throw new Error(`parameter is missing required field '${f}'`);
      }
    }
  }
  for (const s of doc["steps"] as unknown[]) {
    if (!isRecord(s)) throw new Error("each step must be a mapping");
    for (const f of ["id", "kind", "name"]) {
      if (typeof s[f] !== "string" || (s[f] as string).trim() === "") {
        throw new Error(`step is missing required field '${f}'`);
      }
    }
    if (!STEP_KINDS.has(s["kind"] as string)) {
      throw new Error(`step '${s["id"]}': unknown kind '${s["kind"]}'`);
    }
    if (!new RegExp(`^${wid}-\\d+$`).test(s["id"] as string)) {
      throw new Error(`step id '${s["id"]}' must match <workflow>-<n> (docs/workflows.md)`);
    }
    if (s["kind"] === "deterministic" && typeof s["runs"] !== "string") {
      throw new Error(`deterministic step '${s["id"]}' must declare 'runs'`);
    }
    if (s["kind"] === "agent" && typeof s["uses"] !== "string") {
      throw new Error(`agent step '${s["id"]}' must declare 'uses'`);
    }
  }
  for (const o of doc["outputs"] as unknown[]) {
    if (!isRecord(o)) throw new Error("each output must be a mapping");
    for (const f of ["name", "path", "kind"]) {
      if (typeof o[f] !== "string" || (o[f] as string).trim() === "") {
        throw new Error(`output is missing required field '${f}'`);
      }
    }
  }
  const audit = doc["audit"];
  if (!isRecord(audit) || typeof audit["log"] !== "string" || !Array.isArray(audit["require"])) {
    throw new Error("missing top-level 'audit' mapping with 'log' and 'require'");
  }
  return doc as unknown as WorkflowDoc;
}

/**
 * The sidecar runs on the repo-local venv when it exists, so the Python
 * packages survive a VM replacement (system-wide pip installs do not);
 * otherwise it falls back to the system `python3`.
 */
function sidecarPython(): string {
  const venvBin = join(ROOT, ".venv", "bin", "python");
  if (existsSync(venvBin)) return venvBin;
  const venvWin = join(ROOT, ".venv", "Scripts", "python.exe");
  if (existsSync(venvWin)) return venvWin;
  return "python3";
}

function runSidecar(script: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(sidecarPython(), [join(ROOT, "sidecar", script), ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 10 * 60 * 1000,
  });
  if (res.error) {
    return { code: 1, stdout: res.stdout ?? "", stderr: String(res.error) };
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function readCsvFormulas(csvPath: string): Array<{ name: string; value: string; formula: string }> {
  const text = readFileSync(csvPath, "utf-8").trim().split("\n");
  const rows: Array<{ name: string; value: string; formula: string }> = [];
  for (const line of text.slice(1)) {
    const parts = line.split(",");
    if (parts.length >= 3) {
      rows.push({ name: parts[0] as string, value: parts[1] as string, formula: parts.slice(2, -1).join(",") });
    }
  }
  return rows;
}

/** Minimal CSV line parser: handles double-quoted fields containing commas. */
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

interface ChecklistRow {
  item: string;
  indicator_value: string;
  limit: string;
  unit: string;
  status: string;
  clause: string;
  page: string;
  notes: string;
}

function readChecklistRows(csvPath: string): ChecklistRow[] {
  const lines = readFileSync(csvPath, "utf-8").trim().split(/\r?\n/);
  const rows: ChecklistRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const p = parseCsvLine(line);
    rows.push({
      item: p[0] ?? "",
      indicator_value: p[1] ?? "",
      limit: p[2] ?? "",
      unit: p[3] ?? "",
      status: p[4] ?? "",
      clause: p[5] ?? "",
      page: p[6] ?? "",
      notes: p[7] ?? "",
    });
  }
  return rows;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeUsername(): string {
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Evidence sections for the audit log. Each section is conditional on its
 * source file existing, so a W2 run produces exactly the sections it
 * produced before, and a W1 run produces the regulation + checklist
 * sections instead. Called by both the normal path and the pause path.
 */
function appendEvidenceSections(auditLines: string[], outDir: string): void {
  const csvPath = join(outDir, "indicators.csv");
  if (existsSync(csvPath)) {
    auditLines.push("", "## Indicator formulas (from indicators.csv)");
    for (const row of readCsvFormulas(csvPath)) {
      auditLines.push(`- ${row.name}: ${row.value} — ${row.formula}`);
    }
  }
  const limitsPath = join(outDir, "limits.json");
  if (existsSync(limitsPath)) {
    const limits = JSON.parse(readFileSync(limitsPath, "utf-8")) as {
      regulation: { file: string; version: string };
      limits: Array<{ name: string; value: number; unit: string; clause: string; page: number; direction: string }>;
    };
    auditLines.push("", "## Regulation limits (from limits.json)");
    auditLines.push(`- regulation: ${limits.regulation.file} (Version: ${limits.regulation.version})`);
    for (const l of limits.limits) {
      auditLines.push(`- ${l.name}: ${l.value} ${l.unit} — clause ${l.clause}, page ${l.page}, ${l.direction}`);
    }
  }
  const draftPath = join(outDir, "checklist-draft.csv");
  if (existsSync(draftPath)) {
    auditLines.push("", "## Checklist (from checklist-draft.csv)");
    for (const row of readChecklistRows(draftPath)) {
      auditLines.push(
        `- ${row.item}: ${row.indicator_value || "(no value)"} vs ${row.limit} ${row.unit} — ` +
          `${row.status} (clause ${row.clause}, page ${row.page})`,
      );
    }
  }
  const convLog = join(outDir, "conversion-log.md");
  if (existsSync(convLog)) {
    const conv = readFileSync(convLog, "utf-8");
    const m = conv.match(/## Warnings\n([\s\S]*?)\n## /);
    const warnText = m ? (m[1] as string).trim() : "";
    auditLines.push("", "## Conversion warnings and handling");
    auditLines.push(warnText || "- none");
    auditLines.push("- handling: warnings are recorded here and in conversion-log.md; no feature was silently dropped (unsupported types are skipped with a warning, out-of-range coordinates are kept and flagged)");
  }
}

function appendOutputsSection(auditLines: string[], doc: WorkflowDoc, outDir: string): void {
  auditLines.push("", "## Outputs");
  for (const o of doc.outputs) {
    const full = resolveUnderRoot(o.path);
    auditLines.push(`- ${o.name}: ${o.path} — ${existsSync(full) ? `${statSync(full).size} bytes` : "MISSING"}`);
  }
  const shpExtra = ["plan.shp", "plan_polygons.shp", "plan_points.shp"];
  for (const f of shpExtra) {
    const full = join(outDir, f);
    if (existsSync(full)) {
      auditLines.push(`- shapefile: ${relative(ROOT, full)} — ${statSync(full).size} bytes`);
    }
  }
}

interface StepContext {
  doc: WorkflowDoc;
  inputPaths: Map<string, string>;
  outDir: string;
  units: string;
  auditLines: string[];
}

function sidecarFailed(step: WorkflowStep, runs: string, r: { code: number; stderr: string }): Error {
  const last = (r.stderr.trim().split("\n").pop() ?? "").replace(/^ERROR: /, "");
  return new Error(`step ${step.id} (${runs}) failed: ${last || "exit " + r.code}`);
}

/**
 * Execute one deterministic step, dispatched on its `runs` field — never
 * on a hardcoded step id, so new workflows only add a branch here.
 * Appends the step's audit line; throws a one-line error on failure.
 */
function runDeterministicStep(step: WorkflowStep, ctx: StepContext): void {
  const { doc, inputPaths, outDir, units, auditLines } = ctx;
  if (!step.runs) throw new Error(`step ${step.id}: deterministic step must declare 'runs'`);

  if (step.runs === "sidecar.dxf_to_geojson") {
    const dxf = inputPaths.get("plan_dxf");
    if (!dxf) throw new Error("missing required input 'plan_dxf'");
    const r = runSidecar("dxf_to_geojson.py", ["--dxf", dxf, "--out", outDir, "--units", units]);
    if (r.code !== 0) throw sidecarFailed(step, step.runs, r);
    const geojson = join(outDir, "plan.geojson");
    const shp = join(outDir, "plan.shp");
    auditLines.push(
      `- ${step.id} ${step.name}: OK (exit 0) — plan.geojson ${existsSync(geojson) ? "written" : "MISSING"}, ` +
        `plan.shp ${existsSync(shp) ? "written" : "not written (see conversion-log.md)"}`,
    );
  } else if (step.runs === "sidecar.compute_indicators") {
    const parcel = resolveUnderRoot("data/parcels/synthetic-parcel-a.csv");
    const buildings = resolveUnderRoot("data/parcels/synthetic-buildings.csv");
    for (const f of [parcel, buildings]) {
      if (!existsSync(f)) throw new Error(`missing input for step ${step.id}: ${f}`);
    }
    const r = runSidecar("compute_indicators.py", [
      "--parcel", parcel,
      "--buildings", buildings,
      "--out", outDir,
    ]);
    if (r.code !== 0) throw sidecarFailed(step, step.runs, r);
    auditLines.push(`- ${step.id} ${step.name}: OK (exit 0) — 8 indicators written`);
  } else if (step.runs === "sidecar.write_outputs") {
    // w2-4: compute_indicators already wrote indicators.csv + run-log.md,
    // so this step verifies those outputs exist and are non-empty, then
    // appends the w2-1 conversion warnings to the run log (the run log
    // is the single human-readable record of the run).
    const csv = join(outDir, "indicators.csv");
    const log = join(outDir, "run-log.md");
    for (const f of [csv, log]) {
      if (!existsSync(f) || statSync(f).size === 0) {
        throw new Error(`step ${step.id}: expected output missing or empty: ${f}`);
      }
    }
    const convLog = join(outDir, "conversion-log.md");
    const header = "## Conversion warnings (w2-1, appended by the runner at w2-4)";
    let warningsText = "- none";
    if (existsSync(convLog)) {
      const conv = readFileSync(convLog, "utf-8");
      const m = conv.match(/## Warnings\n([\s\S]*?)\n## /);
      if (m) warningsText = (m[1] as string).trim();
    }
    const existing = readFileSync(log, "utf-8");
    const stripped = existing.replace(new RegExp(`\n${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*$`), "\n");
    writeFileSync(log, stripped.replace(/\n$/, "") + `\n\n${header}\n${warningsText}\n`, "utf-8");
    auditLines.push(
      `- ${step.id} ${step.name}: OK — indicators.csv (${statSync(csv).size} bytes) and ` +
        `run-log.md (${statSync(log).size} bytes) verified; conversion warnings appended to run-log.md`,
    );
  } else if (step.runs === "sidecar.parse_regulation") {
    const regulation = inputPaths.get("regulation");
    if (!regulation) throw new Error("missing required input 'regulation'");
    const expects = doc.parameters.flatMap((p) => ["--expect", `${p.name}=${p.value}`]);
    const r = runSidecar("parse_regulation.py", ["--regulation", regulation, "--out", outDir, ...expects]);
    if (r.code !== 0) throw sidecarFailed(step, step.runs, r);
    const limits = JSON.parse(readFileSync(join(outDir, "limits.json"), "utf-8")) as { limits: unknown[] };
    auditLines.push(`- ${step.id} ${step.name}: OK (exit 0) — ${limits.limits.length} limits written (limits.json)`);
  } else if (step.runs === "sidecar.compare_indicators") {
    const parcel = inputPaths.get("parcel");
    if (!parcel) throw new Error("missing required input 'parcel'");
    const limits = join(outDir, "limits.json");
    if (!existsSync(limits)) throw new Error(`step ${step.id}: limits.json missing — run w1-1 first`);
    const r = runSidecar("compare_indicators.py", ["--parcel", parcel, "--limits", limits, "--out", outDir]);
    if (r.code !== 0) throw sidecarFailed(step, step.runs, r);
    const rows = readChecklistRows(join(outDir, "checklist-draft.csv"));
    auditLines.push(`- ${step.id} ${step.name}: OK (exit 0) — ${rows.length} checklist rows written (checklist-draft.csv)`);
  } else {
    throw new Error(`step ${step.id}: unsupported deterministic runner '${step.runs}'`);
  }
}

interface ReviewState {
  workflow: string;
  workflow_path: string;
  workflow_sha256: string;
  step: string;
  status: "paused" | "approved";
  paused_at: string;
  approver: string | null;
  approved_at: string | null;
  files: Record<string, string>;
}

/**
 * Pause a run at a human_review step. Writes the draft outputs (the
 * machine-readable checklist.csv copy of the draft, plus review-state.json
 * with sha256 hashes of everything in the output dir so --approve can
 * refuse a changed draft), finishes the audit log and returns exit 3.
 * The final output (checklist.md) is deliberately NOT written here.
 *
 * The integrity check is W1-specific: the draft is checklist-draft.csv +
 * limits.json. A workflow whose human_review step has no such draft fails
 * loudly instead of pausing — its draft contract is not defined yet.
 */
function pauseForHumanReview(
  step: WorkflowStep,
  doc: WorkflowDoc,
  wfPath: string,
  outDir: string,
  target: string,
  auditLines: string[],
  auditPath: string,
): number {
  const draft = join(outDir, "checklist-draft.csv");
  const limits = join(outDir, "limits.json");
  for (const f of [draft, limits]) {
    if (!existsSync(f)) {
      throw new Error(`step ${step.id}: draft output missing — cannot pause for review: ${f}`);
    }
  }
  const csvOut = doc.outputs.find((o) => o.name === "checklist_csv");
  const csvPath = csvOut ? resolveUnderRoot(csvOut.path) : join(outDir, "checklist.csv");
  copyFileSync(draft, csvPath);

  const files: Record<string, string> = {};
  for (const name of readdirSync(outDir).sort()) {
    if (name === "audit.log" || name === "review-state.json") continue;
    const full = join(outDir, name);
    if (statSync(full).isFile()) files[name] = sha256File(full);
  }
  const state: ReviewState = {
    workflow: doc.workflow.id,
    workflow_path: wfPath,
    workflow_sha256: sha256File(wfPath),
    step: step.id,
    status: "paused",
    paused_at: new Date().toISOString(),
    approver: null,
    approved_at: null,
    files,
  };
  writeFileSync(join(outDir, "review-state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8");

  appendEvidenceSections(auditLines, outDir);
  appendOutputsSection(auditLines, doc, outDir);
  auditLines.push("", "## Human review gate");
  auditLines.push(`- paused at step ${step.id} ${step.name} — no final output written`);
  auditLines.push("- draft: checklist-draft.csv + checklist.csv + limits.json (see review-state.json)");
  auditLines.push(`- finalise with: plan-agent run ${target} --approve`);
  auditLines.push("", "## Result — PAUSED for human review (exit 3)");
  auditLines.push("- checklist.md is written only after a human approves the draft");
  try {
    writeFileSync(auditPath, auditLines.join("\n") + "\n", "utf-8");
  } catch {
    console.error("ERROR: could not write audit log");
    return 1;
  }
  console.log(
    `PAUSED for human review at step ${step.id}: draft written — ` +
      `run 'plan-agent run ${target} --approve' to finalise.`,
  );
  return 3;
}

function renderChecklist(
  doc: WorkflowDoc,
  regulation: { file: string; version: string },
  rows: ChecklistRow[],
  approver: string,
  approvedAt: string,
  pausedAt: string,
): string {
  const esc = (s: string): string => s.replace(/\|/g, "\\|");
  const reviewStep = doc.steps.find((s) => s.kind === "human_review");
  const parcel = doc.inputs.find((i) => i.name === "parcel");
  const lines: string[] = [
    `# Regulation screening checklist — ${doc.workflow.id} (SYNTHETIC)`,
    "",
    `Regulation: ${regulation.file} (Version: ${regulation.version})`,
    `Parcel: ${parcel ? parcel.path : "(unknown)"} (SYNTHETIC)`,
    `Approved by ${approver} at ${approvedAt} — human review, step ${reviewStep ? reviewStep.id : "human_review"} (paused at ${pausedAt}).`,
    "",
    "| item | indicator value | limit | unit | status | clause | page | notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${esc(r.item)} | ${esc(r.indicator_value || "(no value)")} | ${esc(r.limit)} | ` +
        `${esc(r.unit)} | ${esc(r.status)} | ${esc(r.clause)} | ${esc(r.page)} | ${esc(r.notes)} |`,
    );
  }
  lines.push(
    "",
    "- explanations.md was not drafted — the agent step was skipped: no ACP agent connected.",
    "- Statuses are screening results only (pass / review / fail), never an absolute claim of compliance.",
    "- All values are SYNTHETIC examples, not a real regulation or a real parcel.",
  );
  return lines.join("\n") + "\n";
}

/**
 * `plan-agent run <workflow> --approve`: finalise a run paused at a
 * human_review step. Verifies the draft is byte-identical to the pause
 * (workflow YAML hash + every file hash in review-state.json), records
 * the human decision in the audit log, and only then writes the final
 * output. Never auto-approves, never fakes a human decision.
 */
function cmdApprove(target: string): number {
  try {
    const wfPath = resolveWorkflowPath(target);
    const doc = validateWorkflow(parseYaml(readFileSync(wfPath, "utf-8")));
    const reviewStep = doc.steps.find((s) => s.kind === "human_review");
    if (!reviewStep) {
      console.error(`ERROR: workflow ${doc.workflow.id} has no human_review step — nothing to approve`);
      return 1;
    }
    const outDir = resolveUnderRoot(dirname(doc.audit.log));
    const auditPath = resolveUnderRoot(doc.audit.log);
    const statePath = join(outDir, "review-state.json");
    if (!existsSync(statePath)) {
      console.error(`ERROR: no paused run to approve for workflow ${doc.workflow.id} — run 'plan-agent run ${target}' first`);
      return 1;
    }
    if (!existsSync(auditPath)) {
      console.error(`ERROR: audit log missing (${doc.audit.log}) — refusing to approve; re-run the workflow`);
      return 1;
    }
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as ReviewState;
    if (state.workflow !== doc.workflow.id || state.workflow_path !== wfPath) {
      console.error("ERROR: review state belongs to a different workflow — refusing to approve");
      return 1;
    }
    if (state.step !== reviewStep.id) {
      console.error(`ERROR: review state is for step ${state.step}, not ${reviewStep.id} — refusing to approve`);
      return 1;
    }
    if (state.status === "approved") {
      console.error(
        `ERROR: already approved by ${state.approver ?? "unknown"} at ${state.approved_at ?? "unknown"} — ` +
          "re-run the workflow to start a new review",
      );
      return 1;
    }
    if (state.status !== "paused") {
      console.error(`ERROR: review state has unexpected status ${JSON.stringify(state.status)} — refusing to approve`);
      return 1;
    }
    if (sha256File(wfPath) !== state.workflow_sha256) {
      console.error("ERROR: workflow YAML changed since the pause — refusing to approve; re-run the workflow to start a new review");
      return 1;
    }
    for (const [name, want] of Object.entries(state.files)) {
      const full = join(outDir, name);
      if (!existsSync(full)) {
        console.error(`ERROR: ${name} changed since the pause (missing) — refusing to approve; re-run the workflow to start a new review`);
        return 1;
      }
      if (sha256File(full) !== want) {
        console.error(`ERROR: ${name} changed since the pause — refusing to approve; re-run the workflow to start a new review`);
        return 1;
      }
    }
    const draftPath = join(outDir, "checklist-draft.csv");
    const limitsPath = join(outDir, "limits.json");
    const checklistOut = doc.outputs.find((o) => o.name === "checklist");
    if (!checklistOut) {
      console.error("ERROR: workflow declares no 'checklist' output — refusing to approve");
      return 1;
    }
    const checklistPath = resolveUnderRoot(checklistOut.path);
    if (existsSync(checklistPath)) {
      console.error(`ERROR: ${checklistOut.path} already exists — refusing to overwrite; delete it or re-run the workflow`);
      return 1;
    }
    const rows = readChecklistRows(draftPath);
    const limits = JSON.parse(readFileSync(limitsPath, "utf-8")) as {
      regulation: { file: string; version: string };
    };
    const approver = safeUsername();
    const approvedAt = new Date().toISOString();
    const md = renderChecklist(doc, limits.regulation, rows, approver, approvedAt, state.paused_at);
    writeFileSync(checklistPath, md, "utf-8");
    state.status = "approved";
    state.approver = approver;
    state.approved_at = approvedAt;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    appendFileSync(
      auditPath,
      `\n## Human review decision\n` +
        `- approved by ${approver} at ${approvedAt} (step ${reviewStep.id})\n` +
        `- draft verified unchanged since the pause at ${state.paused_at} (workflow YAML + every output file, sha256)\n` +
        `- checklist.md written (${statSync(checklistPath).size} bytes)\n`,
      "utf-8",
    );
    console.log(`APPROVED by ${approver}: ${checklistOut.path} written.`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${msg}`);
    return 1;
  }
}

function cmdRun(target: string): number {
  const auditLines: string[] = [];
  const auditPath = { value: "" };
  const startedAt = new Date().toISOString();
  let doc: WorkflowDoc | null = null;

  const finish = (ok: boolean, error?: string): number => {
    auditLines.push("", ok ? "## Result" : "## Result — FAILED");
    auditLines.push(ok ? "- exit 0: all steps completed" : `- FAILED: ${error ?? "unknown error"}`);
    if (auditPath.value) {
      try {
        writeFileSync(auditPath.value, auditLines.join("\n") + "\n", "utf-8");
      } catch {
        console.error("ERROR: could not write audit log");
        return 1;
      }
    }
    if (!ok) console.error(`ERROR: ${error ?? "run failed"}`);
    return ok ? 0 : 1;
  };

  try {
    const wfPath = resolveWorkflowPath(target);
    const raw = readFileSync(wfPath, "utf-8");
    doc = validateWorkflow(parseYaml(raw));
    const outDir = resolveUnderRoot(dirname(doc.audit.log));
    auditPath.value = resolveUnderRoot(doc.audit.log);
    mkdirSync(outDir, { recursive: true });

    auditLines.push(`# ${doc.workflow.id} audit log — plan-agent run (SYNTHETIC)`);
    auditLines.push("");
    auditLines.push(`run at: ${startedAt}`);
    auditLines.push(`workflow: ${doc.workflow.id} — ${doc.workflow.name} (${target})`);
    auditLines.push("");

    const params = new Map(doc.parameters.map((p) => [p.name, p]));
    auditLines.push("## Parameters");
    for (const p of doc.parameters) {
      auditLines.push(`- ${p.name}: ${p.value} (${p.unit}) — ${p.source}`);
    }
    auditLines.push("");

    // Required inputs must exist; optional ones are noted and skipped.
    const inputPaths = new Map<string, string>();
    const inputNotes: string[] = [];
    for (const inp of doc.inputs) {
      const full = resolveUnderRoot(inp.path);
      if (!existsSync(full)) {
        if (inp.required) {
          throw new Error(`missing required input '${inp.name}': ${inp.path}`);
        }
        inputNotes.push(`- optional input '${inp.name}' not present (${inp.path}) — skipped`);
      } else {
        inputPaths.set(inp.name, full);
        inputNotes.push(`- ${inp.name}: ${inp.path} — present`);
      }
    }
    auditLines.push("## Inputs");
    auditLines.push(...inputNotes);
    auditLines.push("");

    const units = String(params.get("units")?.value ?? "mm");
    const crsParam = params.get("crs");
    const crsLines: string[] = [];
    if (crsParam) {
      crsLines.push(`CRS: ${crsParam.value} (workflow default for the demo; local planar metre`);
      crsLines.push("coordinates from the DXF are NOT lon/lat — EPSG:4326 does not apply");
      crsLines.push("to them; real runs must set the project CRS first)");
    }
    if (params.has("units")) {
      crsLines.push(`units: ${units}`);
    }
    if (crsLines.length > 0) {
      auditLines.push(...crsLines, "");
    }
    auditLines.push("## Steps");

    for (const step of doc.steps) {
      if (step.kind === "agent") {
        // Never fake agent output: skip and say so in the audit log.
        auditLines.push(`- ${step.id} ${step.name}: ${agentSkipNote(step)}`);
        continue;
      }
      if (step.kind === "human_review") {
        return pauseForHumanReview(step, doc, wfPath, outDir, target, auditLines, auditPath.value);
      }
      if (step.kind !== "deterministic" || !step.runs) {
        throw new Error(`step ${step.id}: unsupported kind '${step.kind}'`);
      }
      runDeterministicStep(step, { doc, inputPaths, outDir, units, auditLines });
    }

    appendEvidenceSections(auditLines, outDir);
    appendOutputsSection(auditLines, doc, outDir);

    return finish(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return finish(false, msg);
  }
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return 0;
  }
  if (cmd === "demo") {
    cmdDemo();
    return 0;
  }
  if (cmd === "run") {
    const approve = rest.includes("--approve");
    const args = rest.filter((a) => a !== "--approve");
    const target = args[0];
    if (!target || args.length > 1) {
      console.error("Usage: plan-agent run <workflow.yaml> [--approve]");
      return 2;
    }
    return approve ? cmdApprove(target) : cmdRun(target);
  }
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  return 2;
}

process.exit(main(process.argv.slice(2)));
