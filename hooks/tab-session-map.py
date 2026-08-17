#!/usr/bin/env python3
"""Claude Code SessionStart hook: record which Claude session belongs to
which TerminalClaw tab.

Several projects in projects.json share a working directory (many use the
home dir), so they also share one ~/.claude/projects/<slug>/ transcript
folder. The dashboard's chat view used to guess "newest .jsonl by mtime"
inside that folder, which shows whichever sibling project spoke last. This
hook removes the guess: every time Claude starts a session inside a hub-*
tmux tab, it writes the session's exact transcript path to
~/.cache/terminalclaw/tab-sessions/<tab>.json, which server.py reads.

Registered in ~/.claude/settings.json under hooks.SessionStart (fires on
startup, resume, and /clear, so the map tracks new session ids). Exits
silently for non-tmux shells and non-hub tmux sessions.
"""
import json
import os
import subprocess
import sys
import time


def main():
    pane = os.environ.get("TMUX_PANE")
    if not pane or not os.environ.get("TMUX"):
        return
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    try:
        tab = subprocess.run(
            ["tmux", "display-message", "-p", "-t", pane, "#{session_name}"],
            capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return
    if not tab.startswith("hub-") or "/" in tab:
        return
    out_dir = os.path.expanduser("~/.cache/terminalclaw/tab-sessions")
    os.makedirs(out_dir, exist_ok=True)
    entry = {
        "tab": tab,
        "session_id": payload.get("session_id"),
        "transcript_path": payload.get("transcript_path"),
        "cwd": payload.get("cwd"),
        "source": payload.get("source"),
        "ts": int(time.time()),
    }
    tmp = os.path.join(out_dir, tab + ".json.tmp")
    with open(tmp, "w") as fh:
        json.dump(entry, fh)
    os.replace(tmp, os.path.join(out_dir, tab + ".json"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # a hook failure must never block Claude startup
