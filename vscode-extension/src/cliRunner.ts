/**
 * How the extension finds and runs the CLI: it shells out to the local
 * `plan-agent` build (node <cliPath> <args>, cwd = workspace root) and
 * streams the output. No VS Code API here, so this module is
 * unit-testable with plain node — the scripted end-to-end harness runs
 * real workflows through it.
 */

import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

export interface CliResolved {
  /** Absolute path to dist/cli.js (or the configured cliPath). */
  cliPath: string;
  /** Node executable used to run it. */
  nodeCmd: string;
  workspaceRoot: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Resolve the CLI entry point. No hardcoded machine paths: cliPath comes
 * from the `planAgent.cliPath` setting, defaulting to
 * <workspaceRoot>/dist/cli.js. Throws a one-line error telling the user
 * to build the CLI when it is missing.
 */
export function resolveCli(workspaceRoot: string, cliPathSetting: string): CliResolved {
  const cliPath = cliPathSetting.trim() !== "" ? cliPathSetting.trim() : join(workspaceRoot, "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(
      `PlanAgent CLI not found at ${cliPath} — build it first: ` +
        `npm install && npm run build (in ${workspaceRoot})`,
    );
  }
  return { cliPath, nodeCmd: "node", workspaceRoot };
}

export interface RunOptions {
  /** Extra environment variables (e.g. PLAN_AGENT_FAKE=1 for tests). */
  env?: Record<string, string>;
  /** Called with each stdout/stderr chunk as it arrives. */
  onData?: (chunk: string, stream: "stdout" | "stderr") => void;
}

/** Run the CLI once and collect its output. Never throws on a non-zero exit. */
export function runCli(resolved: CliResolved, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(resolved.nodeCmd, [resolved.cliPath, ...args], {
        cwd: resolved.workspaceRoot,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: `ERROR: could not start node: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf-8");
      stdout += s;
      opts.onData?.(s, "stdout");
    });
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf-8");
      stderr += s;
      opts.onData?.(s, "stderr");
    });
    proc.on("error", (err) => {
      resolve({
        code: 1,
        stdout,
        stderr: stderr + `ERROR: could not run the CLI (${resolved.nodeCmd} ${resolved.cliPath}): ${err.message}\n`,
      });
    });
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Last non-empty line of stderr (or stdout) — the one-line error to show. */
export function lastErrorLine(result: RunResult): string {
  const text = result.stderr.trim() !== "" ? result.stderr : result.stdout;
  const lines = text.trim().split("\n").filter((l) => l.trim() !== "");
  return lines[lines.length - 1]?.trim() ?? "unknown error";
}
