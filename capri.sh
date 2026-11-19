#!/usr/bin/env bash
# Capri launcher for Linux. Usage: ./capri.sh desktop|start|stop|status|chat|doctor|...
set -euo pipefail
CAPRI_HOME="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "$CAPRI_HOME"

node_ok() {
  local version
  version="$("$1" -p 'process.versions.node' 2>/dev/null)" || return 1
  [[ "${version%%.*}" == "24" ]]
}

NODE=""
if [[ -n "${CAPRI_NODE_PATH:-}" ]]; then
  NODE="$CAPRI_NODE_PATH"
else
  for candidate in "$CAPRI_HOME"/.runtime/node-v24.*-linux-x64/bin/node "$(command -v node || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]] && node_ok "$candidate"; then
      NODE="$candidate"
      break
    fi
  done
fi
if [[ -z "$NODE" ]] || ! node_ok "$NODE"; then
  echo "Capri requires Node.js 24. Run ./install-linux.sh first." >&2
  exit 1
fi
export PATH="$(dirname "$NODE"):$PATH"
exec "$NODE" "$CAPRI_HOME/packages/runtime/bin/capri.mjs" "${@:-desktop}"
