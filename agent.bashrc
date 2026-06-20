# TerminalClaw agent shell — used for project terminal sessions (via term.sh's
# `bash --rcfile`). It loads your normal bash environment first, then defines a
# thin `claude` wrapper so that typing plain `claude` refreshes this project's
# CLAUDE.md (agent brief) from the current tabs before launching the real claude.

# 1. Normal environment (system + user rc), so prompt/aliases/PATH are intact.
if [ -f /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi

# 2. The wrapper. TC_PROJECT is set per-session by term.sh (tmux -e). On every
#    launch it regenerates CLAUDE.md from projects.json, then runs real claude.
claude() {
  if [ -n "${TC_PROJECT:-}" ] && [ -n "${TC_HUB:-}" ] && [ -f "$TC_HUB/gen_claude_md.py" ]; then
    python3 "$TC_HUB/gen_claude_md.py" "$TC_PROJECT" >/dev/null 2>&1
  fi
  command claude "$@"
}
