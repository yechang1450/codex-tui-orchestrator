# Visible-window behavior

Visible execution opens an owned Windows terminal in the initiating Codex workspace and inherits the initiating conversation's validated workspace identity. The ordinary `--run` path selects a visible window whenever the initiating policy may need approval; `--exec` is reserved for strictly read-only, noninteractive work.

Windows focus is controlled by the host and cannot be guaranteed universally. The plugin requests non-activation where the supported launcher allows it, but callers must not rely on visible work being interruption-free. Use headless execution when background behavior is required.

Visible execution remains subject to the initiating workspace's Codex trust and execution policies. Before creating a launcher and again before spawning it, the plugin refuses active or unsafe user/project `.rules` layers because Codex allow rules can bypass a sandbox. It never moves, rewrites, or disables the user's rules automatically.
