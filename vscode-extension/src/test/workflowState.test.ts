import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflowStatus, listOutputFiles, listWorkflows } from "../workflowState";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-agent-ext-test-"));
  mkdirSync(join(root, "workflows"), { recursive: true });
  const yaml = (id: string, name: string) =>
    `workflow:\n  version: "0.0.1"\n  id: ${id}\n  name: ${name}\n  description: >\n    Synthetic ${name} workflow for tests.\ninputs: []\nparameters: []\nsteps: []\noutputs:\n  - name: checklist\n    path: out/${id}/checklist.md\n    kind: markdown\n  - name: checklist_csv\n    path: out/${id}/checklist.csv\n    kind: csv\naudit:\n  log: out/${id}/audit.log\n  require: []\n`;
  writeFileSync(join(root, "workflows", "w1.yaml"), yaml("w1", "Regulation screening"));
  writeFileSync(join(root, "workflows", "w2.yaml"), yaml("w2", "CAD to GIS metrics"));
  writeFileSync(join(root, "workflows", "w9.yaml"), yaml("w9", "Never run"));
  // w1: paused
  mkdirSync(join(root, "out", "w1"), { recursive: true });
  writeFileSync(
    join(root, "out", "w1", "review-state.json"),
    JSON.stringify({ status: "paused", step: "w1-4", paused_at: "2026-11-16T10:00:00Z" }),
  );
  writeFileSync(join(root, "out", "w1", "checklist.md"), "# checklist\n");
  writeFileSync(join(root, "out", "w1", "audit.log"), "# w1 audit log\n");
  // w2: done via audit log, no review-state.json
  mkdirSync(join(root, "out", "w2"), { recursive: true });
  writeFileSync(join(root, "out", "w2", "audit.log"), "## Result\n- exit 0: all steps completed\n");
  writeFileSync(join(root, "out", "w2", "checklist.md"), "# w2\n");
  // w3: out dir exists but nothing conclusive (yaml missing on purpose)
  mkdirSync(join(root, "out", "w3"), { recursive: true });
  return root;
}

test("listWorkflows reads id, name and description from YAML", () => {
  const root = fixture();
  const ws = listWorkflows(root);
  assert.deepEqual(
    ws.map((w) => w.id),
    ["w1", "w2", "w9"],
  );
  assert.equal(ws[0]?.name, "Regulation screening");
  assert.match(ws[0]?.description ?? "", /Synthetic Regulation screening/);
  assert.ok(existsSync(ws[0]?.yamlPath ?? ""));
});

test("getWorkflowStatus: paused / done / not-run / unknown", () => {
  const root = fixture();
  const w1 = getWorkflowStatus(root, "w1");
  assert.equal(w1.status, "paused");
  assert.match(w1.detail, /paused at 2026-11-16T10:00:00Z/);
  assert.equal(getWorkflowStatus(root, "w2").status, "done");
  assert.equal(getWorkflowStatus(root, "w9").status, "not-run");
  assert.equal(getWorkflowStatus(root, "w3").status, "unknown");
});

test("getWorkflowStatus: failed audit log and corrupt state are not invented", () => {
  const root = fixture();
  mkdirSync(join(root, "out", "w4"), { recursive: true });
  writeFileSync(join(root, "out", "w4", "audit.log"), "## Result — FAILED\n- FAILED: boom\n");
  assert.equal(getWorkflowStatus(root, "w4").status, "failed");
  mkdirSync(join(root, "out", "w5"), { recursive: true });
  writeFileSync(join(root, "out", "w5", "review-state.json"), "{not json");
  assert.equal(getWorkflowStatus(root, "w5").status, "unknown");
});

test("listOutputFiles returns only existing files, audit log last", () => {
  const root = fixture();
  const files = listOutputFiles(root, "w1");
  // checklist.csv was declared but never created in the fixture.
  assert.deepEqual(
    files.map((f) => f.label),
    ["checklist.md", "audit.log"],
  );
  assert.ok(files.every((f) => existsSync(f.path)));
  assert.deepEqual(listOutputFiles(root, "w9"), []);
});
