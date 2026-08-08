#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# claude-orchestrator — one-click launcher for Linux/macOS.
#
# Starts the Node backend (:3001) and the Vite dev server (:5173) as DETACHED
# background processes, waits for both to be ready, then opens your browser and
# exits. Because the servers are detached (setsid + nohup), they KEEP RUNNING
# even if you close this terminal window — which fixes the common
# "Firefox can't connect to localhost:5173" after the window closes.
#
# Logs:   .run/backend.log  and  .run/vite.log
# Stop:   ./stop.sh   (or re-run ./run.sh — it restarts cleanly)
#
# Vite is launched via `node node_modules/vite/bin/vite.js` (not the
# node_modules/.bin/vite shim) because on a VirtualBox shared folder npm is
# installed with --no-bin-links, so that shim doesn't exist.
# ---------------------------------------------------------------------------
set -u

cd "$(dirname "$0")" || { echo "❌ Could not cd to script directory."; exit 1; }

BACKEND_PORT="${PORT:-3001}"
FRONTEND_PORT=5173
URL="http://localhost:${FRONTEND_PORT}"
RUN_DIR=".run"
mkdir -p "$RUN_DIR"

# server.js reads process.env.PORT — export it so the detached backend inherits it.
export PORT="$BACKEND_PORT"

# The `claude` CLI installs to ~/.local/bin (or ~/.claude/local), which is NOT on
# PATH for GUI-launched processes (the .desktop icon). Make sure the backend can
# find it: add those dirs to PATH, and if we can resolve the binary, pin
# CLAUDE_BIN to its absolute path (server.js honours CLAUDE_BIN).
export PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH"
if [ -z "${CLAUDE_BIN:-}" ]; then
  for c in "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
    if [ -n "$c" ] && [ -x "$c" ]; then export CLAUDE_BIN="$c"; break; fi
  done
fi

# Kill whatever is listening on a TCP port (tries fuser, lsof, then ss).
free_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  elif command -v lsof >/dev/null 2>&1; then
    local pids; pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    [ -n "$pids" ] && kill $pids >/dev/null 2>&1 || true
  elif command -v ss >/dev/null 2>&1; then
    local pids; pids="$(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
    [ -n "$pids" ] && kill $pids >/dev/null 2>&1 || true
  fi
}

# Start a command fully detached from this terminal (survives window close).
# Writes its PID to $2 and its output to $3.
start_detached() {
  local name="$1" pidfile="$2" logfile="$3"; shift 3
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$@" >"$logfile" 2>&1 < /dev/null &
  else
    nohup "$@" >"$logfile" 2>&1 < /dev/null &
  fi
  echo $! > "$pidfile"
}

# --- sanity checks --------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "❌ node is not installed or not on PATH."; exit 1; }

if [ ! -f node_modules/vite/bin/vite.js ]; then
  echo "📦 Dependencies missing — installing (this shared folder needs --no-bin-links)…"
  npm install --no-bin-links || { echo "❌ npm install failed."; exit 1; }
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "⚠️  'claude' CLI not found on PATH. The UI will load, but running tasks"
  echo "    will fail until 'claude' is installed, authenticated, and on PATH."
fi

# --- stop any previous run (frees ports + kills old pids) ------------------
echo "🧹 Clearing any previous run…"
[ -f "$RUN_DIR/backend.pid" ] && kill "$(cat "$RUN_DIR/backend.pid")" 2>/dev/null || true
[ -f "$RUN_DIR/vite.pid" ]    && kill "$(cat "$RUN_DIR/vite.pid")"    2>/dev/null || true
free_port "$BACKEND_PORT"
free_port "$FRONTEND_PORT"
sleep 0.5

# --- start the backend (detached) -----------------------------------------
echo "🚀 Starting backend on http://localhost:${BACKEND_PORT} …"
start_detached backend "$RUN_DIR/backend.pid" "$RUN_DIR/backend.log" node server.js

backend_up=""
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:${BACKEND_PORT}/api/health"; then
    backend_up=1; echo "✅ Backend is up."; break
  fi
  sleep 0.5
done
if [ -z "$backend_up" ]; then
  echo "❌ Backend did not come up. Check $RUN_DIR/backend.log:"
  tail -n 20 "$RUN_DIR/backend.log" 2>/dev/null
  exit 1
fi

# --- start the frontend (detached) ----------------------------------------
echo "🎨 Starting Vite dev server on ${URL} …"
start_detached vite "$RUN_DIR/vite.pid" "$RUN_DIR/vite.log" \
  node node_modules/vite/bin/vite.js --port "$FRONTEND_PORT" --strictPort

vite_up=""
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "$URL"; then vite_up=1; echo "✅ UI is up."; break; fi
  sleep 0.5
done
if [ -z "$vite_up" ]; then
  echo "❌ Vite did not come up. Check $RUN_DIR/vite.log:"
  tail -n 20 "$RUN_DIR/vite.log" 2>/dev/null
  exit 1
fi

# --- open the browser ------------------------------------------------------
echo "🌐 Opening ${URL}"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then   # macOS
  open "$URL" >/dev/null 2>&1 || true
fi

echo ""
echo "───────────────────────────────────────────────"
echo " ✅ Orchestrator is running in the background."
echo "    UI:       ${URL}"
echo "    Backend:  http://localhost:${BACKEND_PORT}"
echo "    Logs:     ${RUN_DIR}/backend.log , ${RUN_DIR}/vite.log"
echo ""
echo "    It KEEPS RUNNING after you close this window."
echo "    To stop it:  ./stop.sh"
echo "───────────────────────────────────────────────"
