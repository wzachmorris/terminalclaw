#!/usr/bin/env python3
"""TerminalClaw briefing helper — read any tab's Claude conversation.

Ships with the hub repo (overview/tabs.py) and backs the 📋 Overview tab that
server.py bakes into every box's registry on startup. Reuses the dashboard's
own transcript parser (server.py), so what this prints is exactly what the
app's chat mode shows: user/assistant text, tool calls collapsed to
one-liners, system recaps. No API calls, no tokens burned reading — it's all
local JSONL files Claude Code already writes.

Usage:
  tabs.py                 list all tabs, most recently active first
  tabs.py <id> [N]        last N messages from a tab (default 25)
"""
import os
import re
import sys
from datetime import datetime, timezone

# In the repo this file lives at <hub>/overview/tabs.py; deployed copies land
# in ~/overview/, so fall back to known hub locations that hold server.py.
_candidates = [
    os.environ.get("HUB_DIR"),
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    os.path.expanduser("~/terminalclaw"),
    "/opt/terminalclaw",
]
HUB = next(d for d in _candidates
           if d and os.path.isfile(os.path.join(d, "server.py")))
sys.path.insert(0, HUB)
import server  # noqa: E402  (safe: server only listens under __main__)


def _slug(d):
    return re.sub(r"[^A-Za-z0-9]", "-", os.path.normpath(d or ""))


def _age(ts):
    s = int(datetime.now(timezone.utc).timestamp() - ts)
    if s < 60:
        return "%ds ago" % s
    if s < 3600:
        return "%dm ago" % (s // 60)
    if s < 86400:
        return "%dh ago" % (s // 3600)
    return "%dd ago" % (s // 86400)


def _newest_mtime(proj):
    pdir = os.path.join(server.CLAUDE_PROJECTS, _slug(proj.get("dir")))
    try:
        files = [os.path.join(pdir, f) for f in os.listdir(pdir)
                 if f.endswith(".jsonl")]
        return max(os.path.getmtime(f) for f in files) if files else None
    except (OSError, ValueError):
        return None


def list_tabs():
    reg = server.load_registry()
    rows = []
    by_slug = {}
    for p in reg.get("projects", []):
        by_slug.setdefault(_slug(p.get("dir")), []).append(p)
    for p in reg.get("projects", []):
        if p.get("command"):
            rows.append((None, p, "ssh tab — no transcript here"))
            continue
        mt = _newest_mtime(p)
        note = ""
        twins = [x["id"] for x in by_slug[_slug(p.get("dir"))]
                 if x["id"] != p["id"] and not x.get("command")]
        if twins:
            note = "shares transcript with: " + ", ".join(twins)
        rows.append((mt, p, note))
    rows.sort(key=lambda r: r[0] or 0, reverse=True)
    for mt, p, note in rows:
        flags = []
        if p.get("hidden"):
            flags.append("hidden")
        if p.get("id") == "overview":
            flags.append("this is YOU")
        line = "%-22s %-32s %s" % (
            p["id"], p.get("name", ""),
            _age(mt) if mt else "(no transcript)")
        if flags:
            line += "  [" + ", ".join(flags) + "]"
        if note:
            line += "  (" + note + ")"
        print(line)


def show(pid, n):
    data = server.claude_transcript(pid, "")
    msgs = data.get("messages") or []
    st = data.get("status") or {}
    if not msgs:
        print("(no conversation found for %r)" % pid)
        return
    head = "— %s: last %d of %d messages" % (pid, min(n, len(msgs)), len(msgs))
    if st.get("permissionMode"):
        head += " · mode: " + st["permissionMode"]
    if st.get("contextTokens"):
        head += " · context: %.1fk tokens" % (st["contextTokens"] / 1000)
    print(head)
    for m in msgs[-n:]:
        ts = m.get("ts", "")
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            clock = t.astimezone().strftime("%m-%d %H:%M")
        except ValueError:
            clock = "?"
        text = m.get("text", "")
        if len(text) > 1500:
            text = text[:1500] + " … [+%dk chars]" % ((len(text) - 1500) // 1000 + 1)
        print("[%s] %s: %s" % (clock, m.get("role", "?"), text))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        list_tabs()
    else:
        try:
            n = int(sys.argv[2]) if len(sys.argv) > 2 else 25
        except ValueError:
            n = 25
        try:
            show(sys.argv[1], n)
        except ValueError as e:
            print("error: %s (run with no args to list tab ids)" % e)
            sys.exit(1)
