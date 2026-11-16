# PlanAgent Workbench — Desktop App (Tauri 2)

Thin desktop shell over the local `plan-agent` CLI (Phase 3). It runs the
three planning workflows, streams the run log, shows outputs in-app, and
surfaces the human-review gate — approval always goes through the CLI's
`run --approve` path (hash verification + recorded decision). The app
never writes workflow outputs itself, never fakes agent output, and never
holds model credentials: login lives with the ACP agent itself.

## What it does

- **Workflows**: W1 regulation screening, W2 CAD→GIS metrics, W3 standard
  map export — Run button each, status read from `review-state.json` +
  `audit.log` (unknown when it cannot be determined, never invented).
- **Run log**: streams the CLI's stdout/stderr live; the status line shows
  the last run result with the time it ran.
- **Human review**: a run that exits 3 (paused) opens a review dialog
  with the actual draft — the W1 checklist table, the W2 indicator table,
  or the W3 rendered map — and two buttons: *Review draft* (opens the
  outputs view) and *Approve* (runs `--approve` through the CLI).
- **Outputs view**: checklist.md (rendered), indicators.csv (table),
  map.png (image), map.pdf (embedded viewer), audit.log (text) — read
  in-app; files outside the workspace are refused.
- **Agent status**: `plan-agent agent --status` (no model call, no cost);
  shows the configured agent or that agent steps will be skipped.

## Setup

```bash
cd tauri-app
npm install
```

Build the CLI first (the app shells out to it):

```bash
cd ~/workspace/plan-agent-workbench   # repo root
npm install && npm run build
```

## Run

```bash
cd tauri-app
npm run tauri:dev        # dev window (Vite on :1420)
npm run tauri:build      # production bundle (.deb / .AppImage on Linux)
```

On first launch, pick the workbench repo folder in **Settings** (workspace
root). The CLI path defaults to `<workspace>/dist/cli.js`, run with node;
override it in Settings if your build lives elsewhere. Settings are stored
in the Tauri app config directory (`~/.config/com.plan-agent.workbench/`).

## System dependencies (Linux)

Tauri 2 needs the WebKitGTK runtime. On Ubuntu/Debian:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
  libgtk-3-dev libsoup-3.0-dev build-essential curl wget file libssl-dev
```

(Rust itself: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`,
then add `~/.cargo/bin` to `PATH` — the Tauri CLI spawns `cargo`, so
`npm run tauri:build` fails with "No such file or directory" if cargo is
not on PATH.)

Two environment gotchas found on this VM (2026-11-16):

- **libzstd1 pin**: the VM image ships `libzstd1 1.5.5+dfsg2-2build1.1+hatch1`,
  but `libzstd-dev` (pulled in via `libgtk-3-dev` → `libgdk-pixbuf-2.0-dev`
  → `libtiff-dev`) requires exactly the stock `1.5.5+dfsg2-2build1.1`.
  Fix — downgrade that one library to stock first:
  `apt-get install -y --allow-downgrades libzstd1=1.5.5+dfsg2-2build1.1`
  (same upstream 1.5.5, `dpkg` still works afterwards; the `+hatch1` .deb
  is not in any repo, so this is one-way on this image).
- **VM replacement wipes apt installs**: `apt-get install`ed system
  packages do not survive a VM replacement (observed 2026-11-16: the
  apt index, the libzstd1 downgrade and the dev packages all had to be
  redone after a service restart). Files under `$HOME` (repo, Rust
  toolchain, `node_modules`, cargo registry) survive. After a
  replacement, re-run `apt-get update` + the install above.

## Layout

- `src/` — vanilla TypeScript frontend (no framework): `main.ts` (UI),
  `api.ts` (typed Tauri invokes), `styles.css`.
- `src-tauri/src/` — Rust backend: `lib.rs` (app + command wiring),
  `settings.rs` (persisted settings), `cli.rs` (find/run the CLI,
  stream output, `agent --status`), `workflows.rs` (workflow list,
  status from CLI-written files, output reading, draft for review,
  run/approve commands).

## Testing

```bash
cd tauri-app/src-tauri
cargo test        # Rust unit tests (exit codes, status derivation,
                  # CLI discovery, output path guard, CSV parsing,
                  # draft kinds) + one end-to-end test
```

The end-to-end test (`e2e_w1_pause_then_approve_through_app_path`,
`tauri::test::mock_app`, `tauri` dev-dependency feature `test`) drives
the app's own `run_cli_streaming` against the real CLI in this repo:
W1 run → exit 3 (paused, draft + review state) → `--approve` → exit 0
(checklist finalised, status `approved`), then W2 run → exit 0
(indicators regenerated) and an `agent --status` round-trip (exit code
and parsed state must agree). It mutates the real repo's `out/w1/` and
`out/w2/` (gitignored) and leaves them in the same approved/done state
they started in.

The frontend build (`npm run build`: `tsc` + Vite) must pass with 0
errors.

Headless smoke test — `tauri-app/scripts/smoke-test.sh [seconds]`:
starts the Vite dev server (a debug binary with `devUrl` set loads the
frontend from it — without the server the window is blank), seeds
settings pointing at this repo, launches the debug binary under
`xvfb-run` with `PLAN_AGENT_DEBUG=1`, and checks the window opens and
the frontend JS runs: `window ready`, `get_settings` returning the
seeded workspace, `list_workflows returned 3 workflows`, plus per-workflow
statuses and the agent-status check in the log. An interactive
click-through (Run → Review draft → Approve in a real window) has not
been done yet — see the main README's known gaps.

Debug hooks (all `PLAN_AGENT_DEBUG`-gated, silent otherwise): `window
ready` on window creation; `get_settings` prints the loaded workspace
root / CLI path; `list_workflows` prints the workflow count;
`workflow_status` / `agent_status` print their results.

## Gotchas found while building this

- **Invoke argument keys are camelCase.** Tauri converts Rust
  snake_case parameter names (`workspace_root` → `workspaceRoot`,
  `cli_path` → `cliPath`, `workflow_id` → `workflowId`). Passing
  snake_case keys fails with `missing required key workspaceRoot` and
  the frontend silently swallowed it (empty workflow list) until the
  error was surfaced. `src/api.ts` now uses camelCase keys; the Rust
  side stays snake_case.
- **A debug binary needs the Vite dev server.** With `devUrl` set, a
  debug build loads `http://localhost:1420`; running the bare binary
  shows a blank window. Use `npm run tauri:dev` (or the smoke script,
  which starts Vite first). A release bundle uses `frontendDist`
  (`tauri-app/dist/`).
- **Re-running W1 after a prior approval fails at approve time.**
  The CLI's `--approve` refuses to overwrite an already-finalised
  `out/w1/checklist.md` (`ERROR: ... already exists — refusing to
  overwrite`). That is CLI behaviour (not changed here); to re-run W1
  end-to-end, delete the old `checklist.md` first — the approve then
  regenerates it (same rows, new approval timestamp). W3's approve has
  no such guard (verified: re-run → pause → approve → exit 0, map.png
  and map.pdf byte-identical to before).
- **App icon is a placeholder.** `src-tauri/icons/icon.png` (512×512
  RGBA — Tauri requires RGBA, RGB is rejected at build time) and the
  128/32 px variants are solid deep-teal squares generated with a
  stdlib-only Python script; replace with a real icon later.

## Known gaps

- Not tested against a real ACP agent binary (no Codex/Claude login on
  the dev VM). Agent Status was verified only in the "not configured"
  state (exit 1, "no ACP agent configured"); the `--fake` agent path
  was not exercised through the app.
- The review dialog's Approve button and the Run → pause → dialog flow
  were verified through the app's Rust commands (E2E test) and the
  CLI directly, not by clicking in a real window.
- The PDF preview relies on the webview's built-in PDF viewer; if it
  stays blank, the file path is shown.
- Linux bundle only (`.deb` / `.AppImage`); no macOS/Windows build has
  been attempted.

## Bundle (verified 2026-11-16)

`npm run tauri:build` produces all three Linux bundles: the `.deb`
(3.1 MB), the `.rpm`, and the `.AppImage` (78 MB). The `.deb` was
installed (`dpkg -i`) and the packaged release binary launched headless
under xvfb: window opens, frontend loads from the bundled `frontendDist`
(not the dev server), 3 workflows list, statuses load, agent chip
reports not-configured — then uninstalled again (`dpkg -r`).

One bundler gotcha: without an explicit `bundle.icon` list in
`tauri.conf.json`, the AppImage step panics with "couldn't find a square
icon to use as AppImage icon" even though square PNGs exist in
`src-tauri/icons/` (the `.deb`/`.rpm` build fine without it). The
explicit list (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`)
fixes it.
