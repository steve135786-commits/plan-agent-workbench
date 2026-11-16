/**
 * Workflow discovery and run-state detection, read from the workbench
 * repo on disk — no VS Code API here, so this module is unit-testable
 * with plain node. Status is derived only from files the CLI wrote
 * (review-state.json, audit.log); when it cannot be determined the
 * status is "unknown", never invented.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  yamlPath: string;
}

export type WorkflowStatus = "not-run" | "paused" | "approved" | "done" | "failed" | "unknown";

export interface WorkflowStatusInfo {
  status: WorkflowStatus;
  /** Human-readable detail, e.g. "paused at 2026-11-16T10:02:42Z". */
  detail: string;
}

export interface OutputFile {
  /** Label shown in the quick-pick (the file name). */
  label: string;
  /** Absolute path. */
  path: string;
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

/** Workflows defined by workflows/*.yaml, sorted by id. */
export function listWorkflows(workspaceRoot: string): WorkflowInfo[] {
  const dir = join(workspaceRoot, "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const full = join(dir, f);
      const text = readFileSync(full, "utf-8");
      const id = text.match(/^\s+id:\s*(\S+)/m)?.[1] ?? f;
      const name = text.match(/^\s+name:\s*(.+)$/m)?.[1]?.trim() ?? f;
      return { id, name, description: extractDescription(text), yamlPath: full };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface ReviewState {
  status?: string;
  step?: string;
  paused_at?: string;
  approver?: string | null;
  approved_at?: string | null;
}

/** Derive a workflow's run status from out/<id>/ (never invented). */
export function getWorkflowStatus(workspaceRoot: string, workflowId: string): WorkflowStatusInfo {
  const outDir = join(workspaceRoot, "out", workflowId);
  if (!existsSync(outDir)) {
    return { status: "not-run", detail: "never run (no out directory)" };
  }
  const statePath = join(outDir, "review-state.json");
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as ReviewState;
      if (state.status === "paused") {
        return { status: "paused", detail: `paused at ${state.paused_at ?? "unknown time"}` };
      }
      if (state.status === "approved") {
        return {
          status: "approved",
          detail: `approved by ${state.approver ?? "unknown"} at ${state.approved_at ?? "unknown time"}`,
        };
      }
      return { status: "unknown", detail: "review-state.json has an unexpected status" };
    } catch {
      return { status: "unknown", detail: "review-state.json is unreadable" };
    }
  }
  const auditPath = join(outDir, "audit.log");
  if (existsSync(auditPath)) {
    try {
      const audit = readFileSync(auditPath, "utf-8");
      if (audit.includes("exit 0: all steps completed")) {
        return { status: "done", detail: "all steps completed (audit.log)" };
      }
      if (audit.includes("## Result — FAILED")) {
        return { status: "failed", detail: "last run failed (audit.log)" };
      }
      return { status: "unknown", detail: "audit.log exists but records no final result" };
    } catch {
      return { status: "unknown", detail: "audit.log is unreadable" };
    }
  }
  return { status: "unknown", detail: "out directory exists but has no audit log" };
}

/**
 * Output files for a workflow: the paths its YAML declares under
 * `outputs:` plus the audit log. Only files that actually exist are
 * returned, in YAML order (audit log last).
 */
export function listOutputFiles(workspaceRoot: string, workflowId: string): OutputFile[] {
  const yamlPath = join(workspaceRoot, "workflows", `${workflowId}.yaml`);
  const out: OutputFile[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    const full = join(workspaceRoot, rel);
    if (seen.has(full) || !existsSync(full) || !statSync(full).isFile()) return;
    seen.add(full);
    out.push({ label: rel.split("/").pop() as string, path: full });
  };
  if (existsSync(yamlPath)) {
    const text = readFileSync(yamlPath, "utf-8");
    // Declared outputs: `path: out/<w>/<file>` lines.
    for (const m of text.matchAll(/^\s*path:\s*(out\/\S+)\s*$/gm)) {
      add(m[1] as string);
    }
    // Audit log: `log: out/<w>/audit.log` in the audit section.
    const log = text.match(/^\s*log:\s*(out\/\S+)\s*$/m)?.[1];
    if (log) add(log);
  }
  // Fallback: if the YAML could not be read, at least offer the audit log.
  if (out.length === 0) {
    add(join("out", workflowId, "audit.log"));
  }
  return out;
}

/** Make sure an out dir exists (used by the scripted harness, not the UI). */
export function ensureOutDir(workspaceRoot: string, workflowId: string): string {
  const dir = join(workspaceRoot, "out", workflowId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
