#!/usr/bin/env node
/**
 * plan-agent CLI — v0.0.1 skeleton (Phase 0).
 *
 * Commands:
 *   plan-agent demo            list the three MVP workflows
 *   plan-agent run <workflow>  (Phase 1: validate + execute the YAML)
 *   plan-agent --help
 *
 * The ACP client and the W1–W3 engines land in Phase 1. This file only
 * proves the CLI shape: argument parsing, help text, workflow discovery.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");

interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
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
  console.log(`plan-agent ${"0.0.1"} — ACP planning workbench (Phase 0 skeleton)

Usage:
  plan-agent demo              list the MVP workflows
  plan-agent run <workflow>    run a workflow YAML (Phase 1 — not implemented yet)
  plan-agent --help            show this help

Workflows live in workflows/ — see docs/workflows.md for the YAML format.`);
}

function cmdDemo(): void {
  const workflows = listWorkflows();
  if (workflows.length === 0) {
    console.log("No workflows found in workflows/.");
    return;
  }
  console.log("MVP workflows (Phase 0 — definitions only, engines land in Phase 1):\n");
  for (const w of workflows) {
    console.log(`  ${w.id}  ${w.name}`);
    if (w.description) console.log(`      ${w.description}`);
  }
  console.log("\nRun one (Phase 1): plan-agent run workflows/w2-cad-gis-metrics.yaml");
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
    console.error(`Workflow execution is not implemented yet (Phase 1): ${target}`);
    console.error("Workflow definitions are in workflows/ — see docs/workflows.md.");
    return 1;
  }
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  return 2;
}

process.exit(main(process.argv.slice(2)));
