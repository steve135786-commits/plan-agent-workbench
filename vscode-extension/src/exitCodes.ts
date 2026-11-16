/**
 * Exit-code interpretation for `plan-agent run`.
 * Mirrors the CLI contract (see the root README and docs/workflows.md):
 *   0 done, 1 error, 2 usage, 3 paused for human review.
 * Kept in a vscode-free module so it is unit-testable without VS Code.
 */

export type RunOutcome = "done" | "paused" | "error" | "usage";

export function outcomeForExitCode(code: number): RunOutcome {
  if (code === 0) return "done";
  if (code === 3) return "paused";
  if (code === 2) return "usage";
  return "error";
}

export function outcomeLabel(outcome: RunOutcome): string {
  switch (outcome) {
    case "done":
      return "done";
    case "paused":
      return "paused for human review";
    case "usage":
      return "usage error";
    case "error":
      return "failed";
  }
}

/** One-line summary for the status bar, e.g. "W3 paused · 18:02". */
export function statusBarText(workflowId: string, outcome: RunOutcome, at: Date): string {
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  const short = outcome === "paused" ? "paused" : outcome;
  return `$(play) PlanAgent: ${workflowId} ${short} · ${hh}:${mm}`;
}
