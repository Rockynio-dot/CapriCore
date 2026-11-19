#!/usr/bin/env bash
# Capri installer for Fedora Linux (x86_64).
# Installs private Node.js and llama.cpp runtimes into .runtime/, the npm
# dependencies, a hardware profile, the memory embedding model and a
# desktop launcher. Nothing is installed system-wide except the dnf packages.
set -euo pipefail
CAPRI_HOME="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "$CAPRI_HOME"

NODE_VERSION="$(sed -n 's/.*"nodeVersion": *"\([^"]*\)".*/\1/p' config/core.json)"
LLAMA_VERSION="$(sed -n 's/.*"llamaVersion": *"\([^"]*\)".*/\1/p' config/core.json)"
RUNTIME="$CAPRI_HOME/.runtime"
NODE_DIR="$RUNTIME/node-v$NODE_VERSION-linux-x64"
LLAMA_DIR="$RUNTIME/llama-$LLAMA_VERSION-vulkan"

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Capri for Linux currently supports x86_64 only." >&2
  exit 1
fi

step() { printf '\n==> %s\n' "$1"; }

step "System packages (sudo dnf)"
# Vulkan for GPU offload, libsecret for the encrypted API key store,
# curl/tar/xz for the downloads below.
sudo dnf install -y curl tar xz vulkan-loader libsecret

mkdir -p "$RUNTIME"

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  step "Node.js $NODE_VERSION"
  curl -fL --progress-bar "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
    | tar -xJ -C "$RUNTIME"
fi
export PATH="$NODE_DIR/bin:$PATH"

if [[ ! -x "$LLAMA_DIR/llama-server" ]]; then
  step "llama.cpp $LLAMA_VERSION (Vulkan)"
  tmp="$(mktemp -d)"
  curl -fL --progress-bar \
    "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_VERSION/llama-$LLAMA_VERSION-bin-ubuntu-vulkan-x64.tar.gz" \
    | tar -xz -C "$tmp"
  rm -rf "$LLAMA_DIR"
  mv "$tmp/llama-$LLAMA_VERSION" "$LLAMA_DIR"
  rmdir "$tmp"
fi

step "JavaScript dependencies (npm ci)"
npm ci

if [[ ! -f config/core.local.json ]]; then
  step "Hardware profile"
  node packages/runtime/bin/capri.mjs setup --yes
fi

step "Memory embedding model"
node packages/runtime/bin/capri.mjs models --embedding-only

step "Desktop launcher"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$apps"
cat > "$apps/capri.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Capri
Comment=Desktop AI companion
Exec="$CAPRI_HOME/capri.sh" desktop
Icon=$CAPRI_HOME/assets/default/icon-source.png
Terminal=false
Categories=Utility;
EOF
chmod +x "$CAPRI_HOME/capri.sh"

cat <<EOF

Capri is installed.
  Start:  ./capri.sh desktop   (or "Capri" in the application menu)
  Stop:   ./capri.sh stop
Then open Settings → API connections, choose "Claude API", paste your
Anthropic API key and press "Use connection".
To skip downloading a local chat model, keep API mode as the startup choice.
EOF
