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
  # Refresh this project's CLAUDE.md brief from its current tabs.
  if [ -n "${TC_PROJECT:-}" ] && [ -n "${TC_HUB:-}" ] && [ -f "$TC_HUB/gen_claude_md.py" ]; then
    python3 "$TC_HUB/gen_claude_md.py" "$TC_PROJECT" >/dev/null 2>&1
  fi
  # Bare `claude` (no args): resume this directory's most recent conversation if
  # one exists, so reopening a project picks up right where you left off (even
  # after a reboot — the transcript is on disk). For a fresh chat: `command claude`.
  if [ "$#" -eq 0 ]; then
    local slug proj latest start rc
    slug=$(printf '%s' "$PWD" | sed 's/[^A-Za-z0-9]/-/g')
    proj="$HOME/.claude/projects/$slug"
    # Newest *non-empty* transcript for this dir, if any.
    latest=$(ls -1t "$proj"/*.jsonl 2>/dev/null | head -1)
    if [ -n "$latest" ] && [ -s "$latest" ]; then
      start=$SECONDS
      command claude --continue
      rc=$?
      # If --continue bailed almost immediately (nothing resumable, or a
      # transient miss), don't strand the user at a bare bash prompt — just
      # open a fresh session. A real session the user quits runs longer than
      # this window, so this never turns into a relaunch loop.
      if [ "$rc" -ne 0 ] && [ $((SECONDS - start)) -lt 5 ]; then
        echo "↻ Couldn't resume last chat — starting a fresh session."
        command claude
      fi
      return
    fi
  fi
  command claude "$@"
}
