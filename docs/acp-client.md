# ACP client (docs/acp-client.md)

One module, one job: spawn a configured agent over the Agent Client
Protocol (ACP, JSON-RPC 2.0 over stdio), send it one prompt, collect the
text answer, and log everything. The client is a thin, auditable bridge —
it never calls an LLM itself, never writes files on the agent's behalf,
and never fakes an agent answer.

- Protocol: ACP v1 (stable), via the official TypeScript SDK
  `@agentclientprotocol/sdk` (exact version pinned in `package.json`).
- Flow per call: spawn agent process → `initialize` (protocol version
  negotiation) → `session/new` → `session/prompt` → collect
  `agent_message_chunk` text until the turn stops → close session, kill
  the agent process. One prompt = one spawned process = one session.
  Session resume is not implemented yet (see Limitations).
- Every call is logged: agent command, agent name/version as reported by
  the agent (or "not reported by agent"), the full prompt, the result
  (truncated in the log with its byte size), and the stop reason.

## Which agent, and how it is configured

No agent is bundled and none is assumed installed. The agent binary is
the user's own install; plan-agent only spawns the command it is told
to spawn. Credentials and login live with the agent, never with
plan-agent.

Default (recommended — matches this project's Codex goal): OpenAI Codex
through the official ACP adapter maintained by the ACP project:

```
npx -y @agentclientprotocol/codex-acp
```

Codex itself does not speak ACP natively; the adapter translates
ACP ⇄ Codex App Server. It uses your ChatGPT login (`codex login`,
cached in `~/.codex/auth.json`) or `CODEX_API_KEY` / `OPENAI_API_KEY`.

Alternatives (same pattern, any agent that speaks ACP v1 over stdio):

| Agent | Command |
|---|---|
| Claude Code (Anthropic) | `npx -y @agentclientprotocol/claude-agent-acp` |
| Gemini CLI (native ACP) | `gemini` (see its `--acp` mode in Gemini CLI docs) |
| OpenCode (native ACP) | `opencode acp` |
| Goose (native ACP) | `goose acp` |
| GitHub Copilot CLI (native ACP) | `copilot --acp --stdio` |

Configuration, in precedence order:

1. Env var `PLAN_AGENT_COMMAND` — the full command line, e.g.
   `PLAN_AGENT_COMMAND="npx -y @agentclientprotocol/codex-acp"`.
   Split on whitespace (single/double quotes respected).
2. Config file `plan-agent.config.json` — searched in the current
   directory, then the repo root, then `~/.config/plan-agent/`.
   ```json
   { "agent": { "name": "codex", "command": ["npx", "-y", "@agentclientprotocol/codex-acp"] } }
   ```
   Copy `plan-agent.config.example.json` to start. The real config file
   is gitignored (it holds local paths).
3. Nothing configured → agent steps are skipped with an explicit
   audit-log entry, exactly as in v0.1.0. Nothing is faked.

Optional: `PLAN_AGENT_TIMEOUT_MS` (default 600000 = 10 minutes per
agent call). A timed-out call kills the agent process and fails the run.

## Commands

```
plan-agent agent --prompt "Say hello in one sentence."
```

Sends one prompt to the configured agent, prints the agent's text
answer to stdout, and a call record (agent, model, stop reason, prompt
and result size) to stderr. Fails with a clear one-line error when no
agent is configured, when the agent binary cannot be started, or when
the call times out.

```
plan-agent agent --prompt "..." --fake
```

Same, but against the built-in test fake agent (see below). No
configuration needed; the `--fake` flag is the explicit opt-in.

## What the client refuses to do (deny by default)

The client advertises **no** client-side capabilities
(`clientCapabilities: {}`). Consequences, all deliberate:

- The agent cannot read or write files through the client: `fs/*`
  requests are rejected by the SDK (method not found). The agent only
  ever sees the prompt text we send it.
- The agent cannot run terminal commands through the client.
- Permission requests (`session/request_permission`) are always
  answered "cancelled" — and the denial is counted and logged.
- The agent's answer is a *proposal*: it never finalises anything. In
  W1, the human-review gate (w1-4) still decides whether the checklist
  is finalised, agent output or not.

## The test fake agent

`tests/fake-acp-agent.mjs` is a minimal ACP agent built on the same
official SDK, clearly labeled FAKE / test-only. It answers prompts
deterministically (no model, no network): for a W1 checklist it writes
one plain-language paragraph per checklist row; otherwise it returns a
canned response. Its output always starts with a
`FAKE AGENT RESPONSE — test only` marker line.

Rules:

- The fake is used only when explicitly asked for: `--fake` on the
  `agent` command, or `PLAN_AGENT_FAKE=1` together with a config whose
  command points at the fake script.
- A run that resolves to the fake script **without** `PLAN_AGENT_FAKE=1`
  is refused with a one-line error. The fake is never used silently.
- When the fake is used, the audit log and the output file header both
  say `FAKE (test-only)`.
- Probe tokens (fake only): if the prompt contains
  `PLAN_AGENT_PROBE_FS`, the fake attempts an `fs/read_text_file`
  call and reports whether it was denied; if it contains
  `PLAN_AGENT_PROBE_PERMISSION`, the fake requests a permission and
  reports the denial. These verify the deny-by-default contract.

## Audit-log contract (agent steps)

For every agent step that runs, the workflow audit log records:

- agent command and source (env var / config file path / `--fake`)
- agent name/version as reported in `initialize` (or "not reported")
- the full prompt (prompt template file + composed text)
- the result: first 2000 characters + total byte size
- stop reason (`end_turn`, `max_tokens`, `refusal`, `cancelled`, …)
- permission requests denied (count), if any
- `FAKE (test-only)` when the fake agent was used

The output file itself carries a header comment with the same facts
(agent, model, timestamp, prompt template, stop reason, FAKE flag).

## Prompt templates

Fixed prompt texts live in `prompts/` and are part of the repo:

- `prompts/w1-explanations.md` — w1-3: explain each checklist row in
  plain language. `{{CHECKLIST_DRAFT}}` is replaced with the contents
  of `checklist-draft.csv`.
- `prompts/w2-review.md` — w2-3: review conversion warnings and
  propose fixes. `{{CONVERSION_LOG}}` is replaced with
  `conversion-log.md`, `{{INDICATORS}}` with `indicators.csv`.

The runner records the composed prompt in the audit log, so a run can
be reproduced from the log alone.

## Limitations (honest)

- **Not tested against a real agent binary.** This VM has no Codex /
  Claude login and no API key, so the client is verified end-to-end
  only against the test fake agent. Real-agent behaviour (model
  reporting, fs-request behaviour, long turns) may differ; the first
  real-agent run should be watched, not assumed.
- Single-turn sessions: one prompt per spawned process. No
  `session/load` / resume yet — a later iteration can add it once the
  basic flow is proven against a real agent.
- The client sends the prompt as plain text blocks only (no images,
  no MCP servers, no embedded resources).
- ACP v1 stable only. The v2 draft is intentionally not used.
- The fake agent's "explanations" are template text, not real model
  output — never treat a `--fake` run as evidence about explanation
  quality.
