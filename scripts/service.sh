#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${ROOT_DIR}/run/feishu-codex-agent.pid"
LOG_FILE="${ROOT_DIR}/logs/feishu-codex-agent.log"
ENTRYPOINT="${ROOT_DIR}/dist/src/index.js"

usage() {
  cat <<'EOF'
Usage: bash scripts/service.sh <start|stop|restart|status|logs>
EOF
}

read_pid() {
  if [[ -f "${PID_FILE}" ]]; then
    cat "${PID_FILE}"
  fi
}

is_running() {
  local pid
  pid="$(read_pid)"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

require_entrypoint() {
  if [[ ! -f "${ENTRYPOINT}" ]]; then
    echo "Missing ${ENTRYPOINT}; run npm ci && npm run build first." >&2
    exit 1
  fi
}

start() {
  if is_running; then
    echo "Feishu Codex agent is already running (PID $(read_pid))."
    return
  fi

  require_entrypoint
  mkdir -p \
    "${ROOT_DIR}/run" \
    "${ROOT_DIR}/logs" \
    "${ROOT_DIR}/data" \
    "${ROOT_DIR}/workspaces" \
    "${ROOT_DIR}/.codex-home"

  cd "${ROOT_DIR}"
  setsid nohup env \
    NODE_ENV=production \
    CODEX_HOME="${ROOT_DIR}/.codex-home" \
    DATA_DIR="${ROOT_DIR}/data" \
    WORKSPACE_ROOT="${ROOT_DIR}/workspaces" \
    node --enable-source-maps "${ENTRYPOINT}" \
    >>"${LOG_FILE}" 2>&1 </dev/null &

  local pid=$!
  printf '%s\n' "${pid}" >"${PID_FILE}"
  sleep 2

  if ! is_running; then
    rm -f "${PID_FILE}"
    echo "Feishu Codex agent failed to start. Recent log output:" >&2
    tail -n 40 "${LOG_FILE}" >&2 || true
    exit 1
  fi

  echo "Feishu Codex agent started (PID ${pid})."
}

stop() {
  if ! is_running; then
    rm -f "${PID_FILE}"
    echo "Feishu Codex agent is not running."
    return
  fi

  local pid
  pid="$(read_pid)"
  kill "${pid}"

  for _ in {1..30}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${PID_FILE}"
      echo "Feishu Codex agent stopped."
      return
    fi
    sleep 0.5
  done

  echo "Feishu Codex agent did not stop within 15 seconds (PID ${pid})." >&2
  exit 1
}

status() {
  if is_running; then
    echo "Running (PID $(read_pid))."
  else
    echo "Stopped."
    return 1
  fi

  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 5 http://127.0.0.1:3000/readyz || true
  fi
}

logs() {
  mkdir -p "${ROOT_DIR}/logs"
  touch "${LOG_FILE}"
  tail -n "${LINES:-100}" -f "${LOG_FILE}"
}

case "${1:-}" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop || true
    start
    ;;
  status)
    status
    ;;
  logs)
    logs
    ;;
  *)
    usage
    exit 2
    ;;
esac
