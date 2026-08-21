#!/usr/bin/env bash
# dbchat installer — macOS (Apple Silicon)
#   curl -fsSL https://raw.githubusercontent.com/sonyabytes/dbchat/main/install.sh | bash
set -euo pipefail

REPO="${DBCHAT_REPO:-sonyabytes/dbchat}"
VERSION="${DBCHAT_VERSION:-latest}"
DEST="${DBCHAT_INSTALL_DIR:-/Applications}"

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "dbchat currently ships a macOS build only (web dev mode works elsewhere: see README)."
[[ "$(uname -m)" == "arm64" ]]  || fail "Only Apple Silicon (arm64) builds are published right now."
command -v curl >/dev/null || fail "curl is required."

if [[ "$VERSION" == "latest" ]]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
else
  API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi
say "Looking up ${REPO} (${VERSION})…"
URL="$(curl -fsSL "$API" | grep -Eo '"browser_download_url": *"[^"]+arm64\.dmg"' | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')"
[[ -n "$URL" ]] || fail "No arm64 .dmg asset found on the release. Build from source: bun run dist:desktop"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; [[ -n "${MOUNT:-}" ]] && hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true' EXIT
say "Downloading $(basename "${URL}")…"
curl -fL --progress-bar "$URL" -o "$TMP/dbchat.dmg"

say "Mounting…"
MOUNT="$(hdiutil attach -nobrowse -readonly "$TMP/dbchat.dmg" | grep -Eo '/Volumes/.*' | head -1)"
APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)"
[[ -n "$APP" ]] || fail "No .app inside the DMG."

if [[ -d "$DEST/dbchat.app" ]]; then
  say "Replacing existing $DEST/dbchat.app"
  rm -rf "$DEST/dbchat.app"
fi
say "Installing to ${DEST}…"
ditto "$APP" "$DEST/dbchat.app"
# The build is not notarized yet; clear quarantine so Gatekeeper allows it.
xattr -dr com.apple.quarantine "$DEST/dbchat.app" 2>/dev/null || true

hdiutil detach "$MOUNT" -quiet; MOUNT=""

if ! command -v claude >/dev/null; then
  printf '\n\033[1;33m!\033[0m Claude Code CLI not found. The chat assistant uses its login.\n  Install: https://docs.anthropic.com/en/docs/claude-code  then run `claude` once to sign in.\n'
fi

say "Done. Launching dbchat."
open "$DEST/dbchat.app"
