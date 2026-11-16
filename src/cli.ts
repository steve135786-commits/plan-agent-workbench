#!/usr/bin/env node
/**
 * plan-agent CLI — v0.0.1 (Phase 1: W2 runs end-to-end).
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
  statSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, "workflows");
const VERSION = "0.0.1";

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
  console.log(`plan-agent ${VERSION} — ACP planning workbench (Phase 1: W2 runs end-to-end)

Usage:
  plan-agent demo              list the MVP workflows
  plan-agent run <workflow>    validate and run a workflow YAML (deterministic
                               steps execute; agent steps are skipped until
                               an ACP agent is connected)
  plan-agent --help            show this help

Workflows live in workflows/ — see docs/workflows.md for the YAML format.`);
}

function cmdDemo(): void {
  const workflows = listWorkflows();
  if (workflows.length === 0) {
    console.log("No workflows found in workflows/.");
    return;
  }
  console.log("MVP workflows (W2 runs end-to-end; W1/W3 engines land later):\n");
  for (const w of workflows) {
    console.log(`  ${w.id}  ${w.name}`);
    if (w.description) console.log(`      ${w.description}`);
  }
  console.log("\nRun one: plan-agent run workflows/w2-cad-gis-metrics.yaml");
}

// ---------------------------------------------------------------------------
// `plan-agent run`
// ---------------------------------------------------------------------------

const INPUT_KINDS = new Set(["pdf", "markdown", "dxf", "shp", "geojson", "csv", "yaml"]);
const STEP_KINDS = new Set(["deterministic", "agent", "human_review"]);
const AGENT_SKIP_NOTE =
  "SKIPPED: no ACP agent connected yet — review not performed, no proposal generated";

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

function runSidecar(script: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("python3", [join(ROOT, "sidecar", script), ...args], {
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
    const crs = String(params.get("crs")?.value ?? "");
    auditLines.push(`CRS: ${crs} (workflow default for the demo; local planar metre`);
    auditLines.push("coordinates from the DXF are NOT lon/lat — EPSG:4326 does not apply");
    auditLines.push("to them; real runs must set the project CRS first)");
    auditLines.push(`units: ${units}`);
    auditLines.push("");
    auditLines.push("## Steps");

    for (const step of doc.steps) {
      if (step.kind === "agent") {
        // Never fake agent output: skip and say so in the audit log.
        auditLines.push(`- ${step.id} ${step.name}: ${AGENT_SKIP_NOTE}`);
        continue;
      }
      if (step.kind === "human_review") {
        throw new Error(`step ${step.id} is a human_review checkpoint — run paused here`);
      }
      if (step.kind !== "deterministic" || !step.runs) {
        throw new Error(`step ${step.id}: unsupported kind '${step.kind}'`);
      }

      if (step.runs === "sidecar.dxf_to_geojson") {
        const dxf = inputPaths.get("plan_dxf");
        if (!dxf) throw new Error("missing required input 'plan_dxf'");
        const r = runSidecar("dxf_to_geojson.py", ["--dxf", dxf, "--out", outDir, "--units", units]);
        if (r.code !== 0) {
          const last = (r.stderr.trim().split("\n").pop() ?? "").replace(/^ERROR: /, "");
          throw new Error(`step ${step.id} (${step.runs}) failed: ${last || "exit " + r.code}`);
        }
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
        if (r.code !== 0) {
          const last = (r.stderr.trim().split("\n").pop() ?? "").replace(/^ERROR: /, "");
          throw new Error(`step ${step.id} (${step.runs}) failed: ${last || "exit " + r.code}`);
        }
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
      } else {
        throw new Error(`step ${step.id}: unsupported deterministic runner '${step.runs}'`);
      }
    }

    // Formulas per indicator, read back from the produced CSV.
    const csvPath = join(outDir, "indicators.csv");
    if (existsSync(csvPath)) {
      auditLines.push("", "## Indicator formulas (from indicators.csv)");
      for (const row of readCsvFormulas(csvPath)) {
        auditLines.push(`- ${row.name}: ${row.value} — ${row.formula}`);
      }
    }

    // Conversion warnings and how each was handled.
    const convLog = join(outDir, "conversion-log.md");
    auditLines.push("", "## Conversion warnings and handling");
    if (existsSync(convLog)) {
      const conv = readFileSync(convLog, "utf-8");
      const m = conv.match(/## Warnings\n([\s\S]*?)\n## /);
      const warnText = m ? (m[1] as string).trim() : "";
      auditLines.push(warnText || "- none");
      auditLines.push("- handling: warnings are recorded here and in conversion-log.md; no feature was silently dropped (unsupported types are skipped with a warning, out-of-range coordinates are kept and flagged)");
    } else {
      auditLines.push("- no conversion log found (w2-1 did not run)");
    }

    auditLines.push("", "## Outputs");
    for (const o of doc.outputs) {
      const full = resolveUnderRoot(o.path);
      auditLines.push(`- ${o.name}: ${o.path} — ${existsSync(full) ? `${statSync(full).size} bytes` : "MISSING"}`);
    }
    const shpExtra = ["plan.shp", "plan_polygons.shp", "plan_points.shp"];
    for (const f of shpExtra) {
      const full = join(outDir, f);
      if (existsSync(full)) auditLines.push(`- shapefile: out/w2/${f} — ${statSync(full).size} bytes`);
    }

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
    const target = rest[0];
    if (!target) {
      console.error("Usage: plan-agent run <workflow.yaml>");
      return 2;
    }
    return cmdRun(target);
  }
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  return 2;
}

process.exit(main(process.argv.slice(2)));
