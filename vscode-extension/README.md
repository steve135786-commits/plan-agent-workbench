# PlanAgent Workbench — VS Code Extension (v0.1)

Thin editor shell over the local `plan-agent` CLI. It runs workflows,
surfaces the human-review gate, and reads run state from the files the
CLI wrote. It never writes workflow outputs itself and never fakes
agent output — approval always goes through the CLI's
`run --approve` path (hash verification + recorded decision).

## Install

```sh
cd vscode-extension
npm install
npm run compile
npx vsce package   # produces plan-agent-0.1.0.vsix
code --install-extension plan-agent-0.1.0.vsix
```

Then open the `plan-agent-workbench` repo folder in VS Code and build
the CLI once (`npm install && npm run build` in the repo root).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `planAgent.cliPath` | _(empty)_ | Path to the built CLI entry (`dist/cli.js`). Empty means `<workspaceRoot>/dist/cli.js`. Run with `node`. |
| `planAgent.workspaceRoot` | _(empty)_ | Workbench repo root (`workflows/`, `out/`). Empty means the first workspace folder. |

No absolute paths to any developer's machine are hardcoded.

## Commands

| Command | What it does |
|---|---|
| PlanAgent: Run Workflow | Quick-pick W1/W2/W3, run it, stream output to the PlanAgent output channel. Exit 3 (paused) opens a Review draft / Approve dialog. |
| PlanAgent: Approve Paused Run | Runs `--approve` for a paused workflow; says plainly if none is paused. |
| PlanAgent: Open Outputs | Quick-pick a workflow's outputs (checklist.md, indicators.csv, map.png, audit.log, …) and open the chosen one. |
| PlanAgent: Show Audit Log | Open the workflow's `audit.log`. |
| PlanAgent: Agent Status | Runs `plan-agent agent --status` (no model call) and reports whether an agent is configured, which one, or that agent steps will be skipped. |

## Views

- **PlanAgent** tree in the Explorer: W1/W2/W3 with run status read
  from `out/<id>/review-state.json` and `audit.log` — `not-run`,
  `paused`, `approved`, `done`, `failed`, or `unknown` when the state
  cannot be determined (never invented). Click a workflow to open its
  outputs.
- **Status bar**: last run result with the time it ran, e.g.
  `PlanAgent: W3 paused · 18:02`. Restored across sessions with its
  timestamp, so it never claims a stale result without saying when.

## What was verified (2026-11-16)

- `npm run compile` — tsc, 0 errors.
- `npm test` — 13/13 unit tests pass, including a scripted harness
  that drives a real W1 run (exit 3, paused) and the `--approve`
  round-trip (exit 0) through the extension's own runner code.
- `npx vsce package` — `plan-agent-0.1.0.vsix` (8 files, 10.06 KB).
- Integration tests in a real VS Code 1.146.0 (downloaded by
  @vscode/test-electron, headless under `xvfb-run`):
  `npm run test-integration` — 4/4 pass: extension activates, all five
  commands registered, Agent Status runs with no agent configured,
  Show Audit Log opens `out/w1/audit.log`.
- CLI addition for this extension: `plan-agent agent --status`
  (reports the resolved agent config without spawning an agent;
  exit 0 configured, 1 not). Existing CLI behaviour unchanged.

## What was NOT verified

- **Not tested in a real, interactive VS Code window.** All
  integration tests ran headless under xvfb; nobody has clicked
  through Run Workflow → Review draft → Approve by hand yet.
- **Not tested against a real ACP agent binary.** Agent Status was
  verified only in the not-configured state and via the CLI's
  `--fake` path in unit tests; a configured Codex/Claude run through
  the extension is still untested.
- The VS Code download itself: @vscode/test-electron's download
  extraction fails in this container (tar cannot chown files to uid
  1000 as root), so the integration run reuses the already-extracted
  binary under `.vscode-test/` (gitignored) and needs `--no-sandbox`
  as root. On a normal machine the download works as documented.

## Development

```sh
npm run compile   # tsc
npm test          # unit tests (node --test, no VS Code needed)
npm run test-integration  # real VS Code, needs xvfb on headless Linux
```
