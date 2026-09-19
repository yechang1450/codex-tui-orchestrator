#!/usr/bin/env bash
# Run the offline regression suite from WSL through Windows cmd.exe.
#
# The suite shells out to PowerShell/registry/task-scheduler APIs, so it must
# run on Windows. Some tests also call `git` directly, which is not on the PATH
# of a WSL-spawned Windows process; this wrapper restores Git and the plugin's
# scripts directory before starting the runner.
#
# Usage:  scripts/wsl/run-tests.sh                 # full suite
#         scripts/wsl/run-tests.sh test/runner.test.mjs
set -euo pipefail

self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$self_dir/../.." && pwd)"
win_root="$(wslpath -w "$root")"

if [ -n "${ORCH_NODE_EXE:-}" ]; then
  node_exe="$ORCH_NODE_EXE"
elif command -v node.exe >/dev/null 2>&1; then
  node_exe="$(command -v node.exe)"
else
  node_exe="$HOME/.tools/node24-fresh/node.exe"
fi
if [ ! -x "$node_exe" ]; then
  echo "找不到 Windows 版 node.exe；请设置 ORCH_NODE_EXE。" >&2
  exit 2
fi
win_node="$(wslpath -w "$node_exe")"

targets=()
if [ "$#" -gt 0 ]; then
  for t in "$@"; do
    if [[ "$t" == /* ]]; then t="$(wslpath -w "$t")"; else t="${t//\//\\}"; fi
    targets+=("$t")
  done
else
  targets=("test\\*.test.mjs")
fi

glob=""
for t in "${targets[@]}"; do glob="${glob:+$glob }$t"; done

# Quoting a path through cmd.exe from WSL mangles embedded quotes, so write the
# batch file to a temporary location, run it, and remove it again.
mkdir -p "$root/temp"
tmp_cmd="$root/temp/wsl-run-tests-$PPID.cmd"
cleanup() { rm -f "$tmp_cmd"; }
trap cleanup EXIT
{
  printf '@echo off\r\n'
  printf 'set "PATH=C:\\Program Files\\Git\\cmd;%s\\scripts;%%PATH%%"\r\n' "$win_root"
  printf 'set "ORCH_AGENT=codex"\r\n'
  printf 'cd /d "%s"\r\n' "$win_root"
  printf '"%s" --test --test-concurrency=1 %s\r\n' "$win_node" "$glob"
} > "$tmp_cmd"
if [ -n "${ORCH_WSL_DEBUG:-}" ]; then echo "cmd file: $tmp_cmd" >&2; fi
cmd.exe /c "$(wslpath -w "$tmp_cmd")"
