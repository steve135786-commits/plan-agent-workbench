/**
 * ACP client — the thin, auditable bridge to an agent.
 *
 * One job: spawn the configured agent over the Agent Client Protocol
 * (ACP v1, JSON-RPC 2.0 over stdio), send it one prompt, collect the
 * text answer, and log everything. It never calls an LLM itself, never
 * writes files on the agent's behalf, and never fakes an agent answer.
 *
 * No agent is bundled and none is assumed installed. The agent command
 * comes from configuration (see docs/acp-client.md): env var
 * PLAN_AGENT_COMMAND, or plan-agent.config.json. Nothing configured
 * means "no agent" — the caller decides what that means (the workflow
 * runner skips agent steps; the `agent` command errors out).
 *
 * Deny by default: the client advertises no client-side capabilities,
 * so the agent cannot read/write files or run terminal commands
 * through the client, and permission requests are always answered
 * "cancelled" (and counted in the result).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_AGENT_REL = "tests/fake-acp-agent.mjs";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface AgentConfig {
  /** Short label for logs (best effort, derived from the command). */
  name: string;
  /** argv: command[0] is the executable. */
  command: string[];
  /** Where this config came from (env var / config file path / --fake). */
  source: string;
  /** True only for the test fake agent — never a real model. */
  fake: boolean;
}

export interface AgentCallResult {
  agent: string;
  command: string;
  /** Agent name/version as reported in initialize, or "not reported by agent". */
  model: string;
  text: string;
  stopReason: string;
  sessionId: string;
  permissionRequestsDenied: number;
  fake: boolean;
}

export function fakeAgentPath(): string {
  return join(ROOT, FAKE_AGENT_REL);
}

export function fakeAgentConfig(): AgentConfig {
  return {
    name: "plan-agent-fake",
    command: ["node", fakeAgentPath()],
    source: "test fake (--fake)",
    fake: true,
  };
}

/** Split a command line on whitespace, respecting single/double quotes. */
function splitCommandLine(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && i + 1 < s.length) {
        cur += s[++i] as string;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i] as string;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error(`PLAN_AGENT_COMMAND has an unterminated quote: ${s}`);
  if (cur) out.push(cur);
  return out;
}

function nameFromCommand(argv: string[]): string {
  const base = (p: string): string =>
    basename(p)
      .replace(/\.cmd|\.exe$/i, "")
      .replace(/\.(mjs|js)$/, "");
  const first = base(argv[0] ?? "agent");
  if (first === "npx" || first === "node" || first === "npm") {
    const pkg = argv.slice(1).find((a) => !a.startsWith("-"));
    if (pkg) return base(pkg).replace(/^@[^/]+\//, "").replace(/-acp$/, "");
  }
  return first || "agent";
}

/** True when any argv element resolves to the test fake agent script. */
function isFakeCommand(argv: string[]): boolean {
  const fake = resolve(fakeAgentPath());
  for (const a of argv) {
    if (!a.includes("/") && !a.includes("\\") && !a.endsWith(".mjs") && !a.endsWith(".js")) continue;
    for (const base of [ROOT, process.cwd()]) {
      if (resolve(base, a) === fake) return true;
    }
  }
  return false;
}

/**
 * Resolve the agent configuration, or null when no agent is configured.
 * Throws a one-line error on malformed configuration, and on any attempt
 * to use the test fake agent without the explicit PLAN_AGENT_FAKE=1
 * opt-in — the fake is never used silently.
 */
export function resolveAgentConfig(): AgentConfig | null {
  const fakeAllowed = process.env.PLAN_AGENT_FAKE === "1";
  const checkFake = (cfg: AgentConfig): AgentConfig => {
    if (cfg.fake) return cfg; // built by fakeAgentConfig() — already explicit
    if (isFakeCommand(cfg.command) && !fakeAllowed) {
      throw new Error(
        `refusing to use the test fake agent (${FAKE_AGENT_REL}) without PLAN_AGENT_FAKE=1 — ` +
          `set PLAN_AGENT_FAKE=1, or use 'plan-agent agent --prompt "..." --fake'`,
      );
    }
    if (isFakeCommand(cfg.command)) cfg.fake = true;
    return cfg;
  };

  const envCmd = (process.env.PLAN_AGENT_COMMAND ?? "").trim();
  if (envCmd) {
    const argv = splitCommandLine(envCmd);
    if (argv.length === 0) throw new Error("PLAN_AGENT_COMMAND is empty");
    return checkFake({
      name: nameFromCommand(argv),
      command: argv,
      source: "env PLAN_AGENT_COMMAND",
      fake: false,
    });
  }

  const candidates = [
    join(process.cwd(), "plan-agent.config.json"),
    join(ROOT, "plan-agent.config.json"),
    join(homedir(), ".config", "plan-agent", "config.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      throw new Error(`agent config file is not valid JSON: ${path}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`agent config file must be a JSON object: ${path}`);
    }
    const agent = (parsed as Record<string, unknown>)["agent"];
    if (typeof agent !== "object" || agent === null || Array.isArray(agent)) {
      throw new Error(`agent config file must have an "agent" object: ${path}`);
    }
    const cmd = (agent as Record<string, unknown>)["command"];
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== "string" || c === "")) {
      throw new Error(`agent config file "agent.command" must be a non-empty array of strings: ${path}`);
    }
    const name = (agent as Record<string, unknown>)["name"];
    const argv = cmd as string[];
    return checkFake({
      name: typeof name === "string" && name ? name : nameFromCommand(argv),
      command: argv,
      source: `config file ${path}`,
      fake: false,
    });
  }

  return null;
}

/** Truncate text for audit logs, keeping the total size visible. */
export function truncateForLog(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… [truncated: ${text.length} chars total]`;
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 2000).unref();
}

/**
 * Run one prompt against the configured agent: spawn, initialize, one
 * session, one prompt turn, collect the text, shut down. Throws a
 * one-line error on spawn failure, protocol mismatch, agent error, or
 * timeout (the agent process is killed in all failure paths).
 */
export async function runAgentPrompt(
  config: AgentConfig,
  promptText: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<AgentCallResult> {
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.PLAN_AGENT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid agent timeout: ${String(process.env.PLAN_AGENT_TIMEOUT_MS ?? timeoutMs)} ms`);
  }
  const [exe, ...args] = config.command;
  if (!exe) throw new Error("agent command is empty");

  let child: ChildProcess;
  try {
    child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to start agent '${config.command.join(" ")}': ${msg}`);
  }
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf-8");
    if (stderr.length > 200 * 1024) stderr = stderr.slice(-200 * 1024);
  });
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (err) => {
      reject(new Error(`failed to start agent '${config.command.join(" ")}': ${err.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        const tail = stderr.trim().split("\n").slice(-5).join(" | ");
        reject(
          new Error(
            `agent process exited early (code ${code}${signal ? `, signal ${signal}` : ""})` +
              (tail ? ` — agent stderr: ${tail}` : ""),
          ),
        );
      }
    });
  });

  let permissionRequestsDenied = 0;
  // Permission requests are always denied — the agent may only answer
  // from the prompt text; it never gets to touch anything.
  const PERMISSION_DENIED: acp.RequestPermissionResponse = {
    outcome: { outcome: "cancelled" },
  };

  const doCall = async (): Promise<AgentCallResult> => {
    if (!child.stdin || !child.stdout) {
      throw new Error("agent process has no stdio pipes — cannot speak ACP");
    }
    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    return acp
      .client({ name: "plan-agent" })
      .onRequest(acp.methods.client.session.requestPermission, () => {
        permissionRequestsDenied++;
        return PERMISSION_DENIED;
      })
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
          throw new Error(
            `agent negotiated unsupported protocol version ${init.protocolVersion} ` +
              `(plan-agent speaks ACP v${acp.PROTOCOL_VERSION})`,
          );
        }
        const info = init.agentInfo;
        const model =
          info && info.name
            ? `${info.name}${info.version ? ` ${info.version}` : ""}`
            : "not reported by agent";
        const { text, stopReason, sessionId } = await ctx
          .buildSession(opts.cwd)
          .withSession(async (session) => {
            const [resp, text] = await Promise.all([
              session.prompt(promptText),
              session.readText(),
            ]);
            return { text, stopReason: resp.stopReason, sessionId: session.sessionId };
          });
        // Best-effort session close; the process is killed right after
        // regardless, so a failure here is not fatal.
        try {
          await ctx.request(acp.methods.agent.session.close, { sessionId });
        } catch {
          // ignore — shutdown proceeds via process kill below
        }
        return {
          agent: config.name,
          command: config.command.join(" "),
          model,
          text,
          stopReason,
          sessionId,
          permissionRequestsDenied,
          fake: config.fake,
        };
      });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.race([doCall(), spawnError]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          killChild(child);
          reject(new Error(`agent call timed out after ${timeoutMs} ms — agent process killed`));
        }, timeoutMs);
      }),
    ]);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const tail = stderr.trim().split("\n").slice(-5).join(" | ");
    throw new Error(tail && !msg.includes("agent stderr:") ? `${msg} (agent stderr: ${tail})` : msg);
  } finally {
    if (timer) clearTimeout(timer);
    killChild(child);
  }
}
