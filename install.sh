#!/usr/bin/env bash
# Hourglass Billion Token Club installer.
#
# What this script does, in order:
#   1. Checks you have Node.js 20 or newer.
#   2. Downloads two small scripts from thehourglass.ai. Read them first if you like:
#        https://thehourglass.ai/billion-token-club/connect.mjs  reads token counts from
#          your Claude Code and Codex history (counts only: never prompts, paths or files).
#          It also searches your home folder, by folder names only, for other Claude or
#          Codex history folders and counts any it finds; run connect.mjs --review to
#          turn one off. Where old history was deleted, it also reads Claude Code's own
#          daily token summary and Codex's thread list. Only totals are uploaded.
#        https://thehourglass.ai/billion-token-club/sync.mjs     sends those counts every
#          15 minutes and handles sign-in and removal
#   3. Checks each file against the fingerprint published in release.json, so a broken or
#      altered download never runs.
#   4. Copies them into a folder of their own and starts sync.mjs, which asks you to
#      approve this machine with GitHub.
#
# It never asks for a password, never uses sudo and installs nothing else.
# To remove Token Club, run the same command with --uninstall on the end.
set -euo pipefail
umask 077
site='https://thehourglass.ai/billion-token-club'

# 1. Node.js 20 or newer.
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then
  echo 'Token Club needs Node.js 20 or newer. Install it from https://nodejs.org, then run this command again.' >&2
  exit 1
fi

# The folder Token Club keeps its two scripts in.
case "$(uname -s)" in
  Darwin) folder="$HOME/Library/Application Support/Hourglass Token Club" ;;
  Linux) folder="${XDG_STATE_HOME:-$HOME/.local/state}/hourglass-token-club" ;;
  *) echo 'Token Club works on macOS and Linux only.' >&2; exit 1 ;;
esac

# Removing Token Club: sync.mjs stops the background sync and deletes its own files.
if [ "${1:-}" = '--uninstall' ]; then
  if [ -L "$folder" ] || [ ! -f "$folder/sync.mjs" ]; then echo 'Token Club is not installed here.' >&2; exit 1; fi
  exec node "$folder/sync.mjs" --uninstall
fi
[ "$#" -eq 0 ] || { echo 'Usage: install.sh [--uninstall]' >&2; exit 1; }

# 2. Download into a temporary folder that is deleted when this script ends.
download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT
for file in release.json connect.mjs sync.mjs; do
  curl --proto '=https' --tlsv1.2 -fsS "$site/$file" -o "$download/$file"
done

# 3. Each file's SHA-256 fingerprint must match release.json before anything runs.
for file in connect.mjs sync.mjs; do
  expected=$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(m.sha256?.[process.argv[2]] ?? ""))' "$download/release.json" "$file")
  actual=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$download/$file")
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Token Club: $file did not match its published fingerprint. Nothing was installed. Run the command again." >&2
    exit 1
  fi
done

# 4. Copy into the Token Club folder (never through a link) and start it.
if [ -L "$folder" ]; then echo 'Token Club: the install folder is a link. Nothing was installed.' >&2; exit 1; fi
mkdir -p "$folder"
chmod 700 "$folder"
for file in connect.mjs sync.mjs; do
  rm -f "$folder/$file"
  cp "$download/$file" "$folder/$file"
  chmod 600 "$folder/$file"
done
node "$folder/sync.mjs" --install
