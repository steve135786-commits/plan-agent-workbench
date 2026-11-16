import assert from "node:assert/strict";
import { test } from "node:test";
import { outcomeForExitCode, outcomeLabel, statusBarText } from "../exitCodes";

test("exit codes map to outcomes", () => {
  assert.equal(outcomeForExitCode(0), "done");
  assert.equal(outcomeForExitCode(3), "paused");
  assert.equal(outcomeForExitCode(2), "usage");
  assert.equal(outcomeForExitCode(1), "error");
  assert.equal(outcomeForExitCode(99), "error");
});

test("outcome labels are plain language", () => {
  assert.equal(outcomeLabel("done"), "done");
  assert.equal(outcomeLabel("paused"), "paused for human review");
  assert.equal(outcomeLabel("error"), "failed");
  assert.equal(outcomeLabel("usage"), "usage error");
});

test("status bar text carries workflow, outcome and time", () => {
  const at = new Date(2026, 10, 16, 18, 2, 0);
  const text = statusBarText("w3", "paused", at);
  assert.match(text, /PlanAgent: w3 paused · 18:02/);
  const done = statusBarText("w2", "done", at);
  assert.match(done, /PlanAgent: w2 done · 18:02/);
});
