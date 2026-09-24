#!/usr/bin/env bash
# WSL entry wrapper for codex-tui-orchestrator.
#
# Why this exists: WSL does not forward custom environment variables to Windows
# processes (ORCH_TUI/ORCH_MODEL/... would silently be ignored), and the plugin
# itself must run on Windows (PowerShell launchers, Windows Terminal, PID APIs).
# This wrapper forwards the ORCH_* variables through WSLENV, translates absolute
# /mnt/... path arguments to Windows form, and executes the Windows node.exe.
#
# Usage:  scripts/wsl/orch.sh --doctor
#         scripts/wsl/orch.sh --exec "任务原文"
#         scripts/wsl/orch.sh --run-windows --workspace /mnt/c/proj "任务原文"
set -euo pipefail

self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$self_dir/../.." && pwd)"

if ! command -v wslpath >/dev/null 2>&1; then
  echo "orch.sh 只能在 WSL 里运行；Windows 侧请直接调用 scripts/orchestrate-sdk.mjs" >&2
  exit 2
fi
win_root="$(wslpath -w "$root")"

find_node() {
  if [ -n "${ORCH_NODE_EXE:-}" ]; then
    printf '%s\n' "$ORCH_NODE_EXE"; return 0
  fi
  if command -v node.exe >/dev/null 2>&1; then
    command -v node.exe; return 0
  fi
  local candidate
  for candidate in \
    "$HOME"/AppData/Local/fnm_multishells/*/node.exe \
    "$HOME"/.tools/node24-fresh/node.exe \
    /mnt/c/Program\ Files/nodejs/node.exe; do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

node_exe="$(find_node)" || {
  echo "找不到 Windows 版 node.exe；请设置 ORCH_NODE_EXE 指向它。" >&2
  exit 2
}
# Forward every ORCH_* variable that is set in this shell (WSLENV is the only
# supported way to pass custom variables into a Windows child process).
forward=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  forward="${forward:+$forward:}$name"
done < <(env | sed -n 's/^\(ORCH_[A-Za-z0-9_]*\|CODEX_THREAD_ID\|CODEX_SESSION_ID\)=.*/\1/p' | sort -u)
if [ -n "$forward" ]; then
  if [ -n "${WSLENV:-}" ]; then export WSLENV="$WSLENV:$forward"; else export WSLENV="$forward"; fi
fi

# Translate absolute POSIX paths for the flags that take one.
args=()
while [ "$#" -gt 0 ]; do
  arg="$1"; shift
  case "$arg" in
    --workspace|--acceptance-file|--acceptance)
      value="${1:-}"
      if [ -n "$value" ]; then
        shift
        if [[ "$value" == /* ]]; then value="$(wslpath -w "$value")"; fi
        args+=("$arg" "$value")
      else
        args+=("$arg")
      fi
      ;;
    *) args+=("$arg") ;;
  esac
done

# Execute the WSL-side path of node.exe (bash cannot exec a Windows path) while
# passing the entry script as a Windows path (that is what node.exe resolves).
exec "$node_exe" "$(wslpath -w "$root/scripts/orchestrate-sdk.mjs")" "${args[@]+"${args[@]}"}"
