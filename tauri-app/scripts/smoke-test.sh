#!/bin/bash
# Headless smoke test for the Tauri desktop app.
#
# Launches the built debug binary under Xvfb (:99) with PLAN_AGENT_DEBUG=1
# and checks that (a) the process stays alive, (b) the window is created
# ("window ready" on stderr), and (c) the frontend JS runs and calls back
# into Rust ("get_settings", "list_workflows returned 3 workflows"). It
# does NOT click anything — an interactive click-through still needs a
# human in a real window.
#
# NOTE: a debug binary with devUrl set loads the frontend from the Vite
# dev server (standard Tauri behaviour), so this script starts
# `npm run dev` first and waits for http://localhost:1420. To test the
# bundled frontend instead, install the .deb from `npm run tauri:build`
# and launch /usr/bin/plan-agent-workbench under Xvfb the same way.
#
# Usage: tauri-app/scripts/smoke-test.sh [seconds-to-watch]
# Requires: src-tauri/target/debug/plan-agent-workbench built
#   (cargo build in src-tauri), Xvfb, and a settings file pointing
#   at the workbench repo (see below).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/tauri-app/src-tauri/target/debug/plan-agent-workbench"
WATCH="${1:-15}"
LOG="/tmp/tauri-smoke.log"
DISPLAY_NUM=99

if [ ! -x "$BIN" ]; then
  echo "smoke: binary not built: $BIN"
  echo "smoke: run 'cargo build' in tauri-app/src-tauri first"
  exit 2
fi
if pgrep -f "[X]vfb :$DISPLAY_NUM" > /dev/null; then
  echo "smoke: display :$DISPLAY_NUM is already in use — kill leftover Xvfb servers first"
  exit 2
fi

# Seed settings so the app loads the real workspace on start.
# (The app stores settings in the Tauri app config dir.)
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/com.plan-agent.workbench"
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/settings.json" <<EOF
{
  "cli_path": "",
  "workspace_root": "$ROOT"
}
EOF

# Start the Vite dev server (the debug binary loads the frontend from it).
cd "$ROOT/tauri-app"
npm run dev -- --port 1420 --strictPort > /tmp/tauri-vite.log 2>&1 &
VITE_PID=$!
READY=0
for _ in $(seq 1 30); do
  if curl -s -m 2 -o /dev/null http://localhost:1420/; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != 1 ]; then
  echo "smoke: FAIL — Vite dev server did not come up on :1420"
  tail -10 /tmp/tauri-vite.log
  kill "$VITE_PID" 2>/dev/null
  pkill -f "[v]ite --port 1420" 2>/dev/null
  exit 1
fi
echo "smoke: Vite dev server up on :1420"

# Explicit Xvfb (not xvfb-run): the wrapper's PID is not the app's, and
# killing the wrapper leaves the app and the X server behind.
Xvfb :$DISPLAY_NUM -screen 0 1280x800x24 > /tmp/tauri-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "smoke: FAIL — Xvfb did not start"
  tail -5 /tmp/tauri-xvfb.log
  kill "$VITE_PID" 2>/dev/null
  pkill -f "[v]ite --port 1420" 2>/dev/null
  exit 1
fi

cleanup() {
  # Kill the app binary itself (its PID is not tracked: it is a child of
  # this script's shell only via the DISPLAY env, so match by path).
  pkill -f "[t]arget/debug/plan-agent-workbench" 2>/dev/null
  kill "$XVFB_PID" 2>/dev/null
  kill "$VITE_PID" 2>/dev/null
  pkill -f "[v]ite --port 1420" 2>/dev/null
  wait "$XVFB_PID" 2>/dev/null
  wait "$VITE_PID" 2>/dev/null
}
trap cleanup EXIT

rm -f "$LOG"
DISPLAY=:$DISPLAY_NUM PLAN_AGENT_DEBUG=1 "$BIN" > "$LOG" 2>&1 &
sleep "$WATCH"

PASS=1
if pgrep -f "[t]arget/debug/plan-agent-workbench" > /dev/null; then
  echo "smoke: app process alive after ${WATCH}s"
else
  echo "smoke: FAIL — app exited early"
  PASS=0
fi
for marker in "window ready" "get_settings -> workspace_root=\"/home/hatch/workspace/plan-agent-workbench\"" "list_workflows returned 3 workflows"; do
  if grep -q "$marker" "$LOG"; then
    echo "smoke: found '$marker'"
  else
    echo "smoke: FAIL — missing '$marker' in log"
    PASS=0
  fi
done
if grep -qiE "panic|fatal|error.*webview|failed to create" "$LOG"; then
  echo "smoke: FAIL — error lines in log:"
  grep -iE "panic|fatal|error.*webview|failed to create" "$LOG" | head -5
  PASS=0
fi
if [ "$PASS" = 1 ]; then
  echo "smoke: PASS — window opened and frontend JS ran (no clicks tested)"
  exit 0
else
  echo "smoke: FAIL — see $LOG"
  tail -20 "$LOG"
  exit 1
fi
