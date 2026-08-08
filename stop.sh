#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# claude-orchestrator — stop the detached servers started by run.sh.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")" || exit 1

BACKEND_PORT="${PORT:-3001}"
FRONTEND_PORT=5173
RUN_DIR=".run"

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

echo "🛑 Stopping orchestrator…"
for svc in backend vite; do
  pidfile="$RUN_DIR/$svc.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
done

# Belt & suspenders: free the ports even if pidfiles were stale.
free_port "$BACKEND_PORT"
free_port "$FRONTEND_PORT"
echo "Done."
