# Capri on Linux (Fedora)

Capri runs on Fedora x86_64 with the Claude API as its conversation model.

## Install

```bash
git clone https://github.com/Rockynio-dot/CapriCore.git
cd CapriCore
./install-linux.sh
```

The script installs a few dnf packages (`vulkan-loader`, `libsecret`, download
tools), then puts private copies of Node.js 24 and llama.cpp into `.runtime/`,
runs `npm ci`, saves a hardware profile and downloads the memory embedding
model (`bge-m3`). It also adds **Capri** to the application menu.

## Connect Claude

1. Start Capri: `./capri.sh desktop`.
2. Open **Settings → API connections → Add**, choose **Claude API**.
   The model (`claude-opus-5-5`), tool calls, images and context limit are
   filled in. Any current model ID works, for example `claude-sonnet-5-5`
   or `claude-haiku-5-5`.
3. Paste your Anthropic API key and save. The key is encrypted with the
   desktop keyring (GNOME Keyring / KWallet via libsecret).
4. Press **Use connection**.

Capri talks to Claude through the native Messages API (official
`@anthropic-ai/sdk`): streaming, tool calls, images, prompt caching and
server-side refusal fallbacks. Ordinary replies use `low` effort, and deep
thinking turns use the effort Capri requests.

## Commands

| Command              | What it does                      |
| -------------------- | --------------------------------- |
| `./capri.sh desktop` | Start the companion               |
| `./capri.sh stop`    | Stop Capri and its local services |
| `./capri.sh status`  | Show service status               |
| `./capri.sh doctor`  | Hardware and runtime check        |

## Wayland

The companion moves its own transparent windows, which Wayland does not
allow, so Capri runs through XWayland by default. Set `CAPRI_WAYLAND=1` to
try native Wayland.

## Not available on Linux yet

Windows-only features stay hidden or inactive: desktop/computer control,
Spotify and Discord control, window awareness, call audio, the NPU and the
graphical installer/updater. Voice and microphone need the Python speech
runtimes, which are not yet set up by `install-linux.sh`.
