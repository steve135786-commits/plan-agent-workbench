import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lastErrorLine, resolveCli, runCli } from "../cliRunner";

/** Repo root: out/test/*.test.js -> ../../.. = plan-agent-workbench. */
const REPO_ROOT = join(__dirname, "..", "..", "..");

test("resolveCli throws a one-line build hint when the CLI is missing", () => {
  assert.throws(
    () => resolveCli("/nonexistent-root", ""),
    /PlanAgent CLI not found.*npm install && npm run build/,
  );
});

test("resolveCli accepts an explicit cliPath", () => {
  const resolved = resolveCli(REPO_ROOT, join(REPO_ROOT, "dist", "cli.js"));
  assert.equal(resolved.cliPath, join(REPO_ROOT, "dist", "cli.js"));
  assert.equal(resolved.nodeCmd, "node");
});

test("runCli runs the real CLI: demo exits 0", async () => {
  const cli = resolveCli(REPO_ROOT, "");
  const result = await runCli(cli, ["demo"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /w1\s+Regulation screening/);
  assert.match(result.stdout, /w2\s+CAD/);
  assert.match(result.stdout, /w3\s+Standard map/);
});

test("runCli reports agent status without spawning an agent", async () => {
  const cli = resolveCli(REPO_ROOT, "");
  const result = await runCli(cli, ["agent", "--status"], { env: { PLAN_AGENT_COMMAND: "" } });
  // No agent is configured in this environment.
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no ACP agent configured/);
});

test("lastErrorLine returns the last non-empty stderr line", () => {
  assert.equal(lastErrorLine({ code: 1, stdout: "", stderr: "first\nERROR: boom\n" }), "ERROR: boom");
  assert.equal(lastErrorLine({ code: 1, stdout: "only stdout\n", stderr: "" }), "only stdout");
});

/**
 * Scripted end-to-end harness: the extension's own runner drives a real
 * W1 run (exit 3, paused) and the --approve round-trip (exit 0) against
 * the real CLI and sidecar. No agent is configured, so w1-3 is skipped,
 * exactly as in v0.1.0. out/ is gitignored, so the run leaves no trace
 * in the repo history.
 */
test("harness: W1 pause -> approve round-trip through the extension runner", async () => {
  const cli = resolveCli(REPO_ROOT, "");
  const env = { PLAN_AGENT_COMMAND: "", PLAN_AGENT_FAKE: "0" };
  // A previous approved run may have left checklist.md behind; --approve
  // refuses to overwrite it, so start from a clean out/w1 state.
  const checklist = join(REPO_ROOT, "out", "w1", "checklist.md");
  if (existsSync(checklist)) rmSync(checklist);
  const run = await runCli(cli, ["run", "workflows/w1-regulation-screening.yaml"], { env });
  assert.equal(run.code, 3, `expected pause (exit 3), got ${run.code}: ${run.stderr}`);
  assert.match(run.stdout, /PAUSED for human review/);
  const approve = await runCli(cli, ["run", "workflows/w1-regulation-screening.yaml", "--approve"], { env });
  assert.equal(approve.code, 0, `expected approve (exit 0), got ${approve.code}: ${approve.stderr}`);
  assert.match(approve.stdout, /APPROVED/);
});
