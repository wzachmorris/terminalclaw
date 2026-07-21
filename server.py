#!/usr/bin/env python3
"""TerminalClaw backend.

Tiny stdlib HTTP server (no external deps) bound to 127.0.0.1 only. Auth is two
independent layers, both cookie-based so they survive the terminal iframe on
mobile (HTTP Basic did not — mobile browsers won't re-send it into an iframe):

  Layer 1 (edge)  : Cloudflare Access / Zero Trust  -> CF_Authorization cookie
  Layer 2 (origin): this backend's signed-cookie login, enforced by Caddy via
                    forward_auth -> /gate/check

Serves the dashboard SPA and a small JSON API:

  GET  /                 -> index.html
  GET  /static/<file>    -> vendored frontend assets (xterm.js etc.)
  GET  /api/projects     -> registry + live docker container status
  GET  /api/memory       -> ?file=<name>  raw text of a whitelisted memory file
  GET  /api/notes        -> ?file=<name>  raw text of a whitelisted note file
  GET  /gate/login       -> login form
  POST /gate/login       -> verify password, set signed session cookie
  POST /api/login        -> verify password, return 30-day token (mobile app)
  GET  /gate/check       -> 200 if cookie valid else 302 (Caddy forward_auth target)
  GET  /gate/logout      -> clear cookie

File reads are restricted to known directories; names are basename-only to
prevent path traversal.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "projects.json")
OTA_IPA = "terminalclaw.ipa"      # served from ota/ by the public /app routes
# Directories of read-only .md files surfaced in the dashboard. Override via
# env to point at wherever your agent memory / notes live on this box.
MEMORY_DIR = os.environ.get("HUB_MEMORY_DIR", os.path.join(HERE, "memory"))
NOTES_DIR = os.environ.get("HUB_NOTES_DIR", os.path.join(HERE, "notes"))
# Claude Code keeps its OWN per-directory memory under ~/.claude/projects/<slug>/memory
# (slug = the project dir with non-alphanumerics turned into '-'). The dashboard and
# the agent run as the same user, so this resolves to that store; we surface it
# (read + edit) in the Memory tab alongside the user-written brief.
CLAUDE_PROJECTS = os.environ.get("HUB_CLAUDE_PROJECTS", os.path.expanduser("~/.claude/projects"))
HOST, PORT = "127.0.0.1", 7682

# --- Layer 2: signed-cookie session gate ----------------------------------
SECRET_FILE = os.path.join(HERE, ".gate_secret")   # HMAC key, auto-generated
PASS_FILE = os.path.join(HERE, ".gate_pass")        # salt:pbkdf2 of password
COOKIE = "hub_session"
TTL = 7 * 24 * 3600                                 # session lifetime, seconds
PBKDF2_ROUNDS = 200_000


def _write_private(path, data):
    """Write bytes to a 0600 file (overwriting)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def _load_secret():
    if os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, "rb") as f:
            return f.read()
    s = secrets.token_bytes(32)
    _write_private(SECRET_FILE, s)
    return s


def set_password(pw):
    """Set the layer-2 password (stored as salt:pbkdf2-sha256)."""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ROUNDS)
    _write_private(PASS_FILE, f"{salt.hex()}:{dk.hex()}".encode())


def verify_password(pw):
    try:
        with open(PASS_FILE) as f:
            salt_hex, hash_hex = f.read().strip().split(":")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt_hex), PBKDF2_ROUNDS)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


SECRET = _load_secret()
if not os.path.exists(PASS_FILE):
    # No password set yet: generate a random one rather than ship a hardcoded
    # secret. Printed once to the log; set a real one with set_password().
    _seed = secrets.token_urlsafe(12)
    set_password(_seed)
    print(f"[hub] no {os.path.basename(PASS_FILE)}; generated temporary layer-2 "
          f"password: {_seed}  -> change with server.set_password('...')")


def _b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make_token(ttl=TTL):
    exp = int(time.time()) + ttl
    sig = _b64u(hmac.new(SECRET, str(exp).encode(), hashlib.sha256).digest())
    return f"{exp}.{sig}"


# Mobile-app sessions live longer than browser cookies (scrcpy-native pattern:
# log in once, hold an HMAC token for a month). Same signed format as the gate
# cookie, so an app token IS a valid hub_session cookie value.
APP_TTL = 30 * 24 * 3600

# Login rate limit: 5 attempts/min per client IP, shared by the form and the
# JSON login. (Behind Caddy on localhost the IP is the proxy's, so effectively
# a global brake — fine for a single-user hub.)
_LOGIN_ATTEMPTS = {}


def login_limited(ip):
    now = time.time()
    recent = [t for t in _LOGIN_ATTEMPTS.get(ip, []) if now - t < 60]
    recent.append(now)
    _LOGIN_ATTEMPTS[ip] = recent
    return len(recent) > 5


def token_valid(tok):
    try:
        exp_s, sig = tok.split(".", 1)
        if int(exp_s) < int(time.time()):
            return False
        good = _b64u(hmac.new(SECRET, exp_s.encode(), hashlib.sha256).digest())
        return hmac.compare_digest(sig, good)
    except Exception:
        return False


def cookie_value(headers, name):
    for part in headers.get("Cookie", "").split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            if k == name:
                return v
    return None


LOGIN_HTML = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>TerminalClaw</title><style>
body{{background:#0d1117;color:#e6edf3;font:15px/1.5 system-ui,-apple-system,sans-serif;
display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}}
form{{background:#161b22;border:1px solid #2a3340;padding:28px;border-radius:12px;width:300px}}
h1{{font-size:17px;margin:0 0 16px}}
input{{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 14px;background:#0d1117;
border:1px solid #2a3340;border-radius:7px;color:#e6edf3;font-size:16px}}
button{{width:100%;padding:11px;background:#1f6feb;color:#fff;border:0;border-radius:7px;
font-size:14px;cursor:pointer}}.err{{color:#f85149;font-size:13px;margin-bottom:6px}}
</style></head><body><form method=post action="/gate/login"><h1>&#128274; TerminalClaw</h1>
{err}<input type=password name=password placeholder="Password" autofocus
autocomplete=current-password><button>Unlock</button></form></body></html>"""


def _cookie_header(token, max_age):
    return (f"{COOKIE}={token}; Path=/; Max-Age={max_age}; "
            "HttpOnly; Secure; SameSite=Lax")


def load_registry():
    with open(REGISTRY) as f:
        return json.load(f)


def list_md(directory):
    """Sorted (newest-first) basenames of .md files in a directory."""
    try:
        return sorted([f for f in os.listdir(directory) if f.endswith(".md")], reverse=True)
    except OSError:
        return []


def claude_mem_dir(project_dir):
    """The folder where Claude Code stores its own memory for a given working
    directory: ~/.claude/projects/<slug>/memory, slug = dir with non-alphanumerics
    replaced by '-' (e.g. /home/wzachmorris -> -home-wzachmorris)."""
    if not project_dir:
        return None
    slug = re.sub(r"[^A-Za-z0-9]", "-", project_dir)
    return os.path.join(CLAUDE_PROJECTS, slug, "memory")


def memory_search_dirs(proj):
    """All dirs to search for a project's memory files, in priority order:
    the project's own memory_dirs, then Claude's own memory store for the
    project dir, then the global MEMORY_DIR."""
    dirs = list(proj.get("memory_dirs", []))
    cmd = claude_mem_dir(proj.get("dir", ""))
    if cmd:
        dirs.append(cmd)
    dirs.append(MEMORY_DIR)
    return dirs


def project_dirs(reg, pid):
    """Dirs to search for a project's memory (incl. Claude's own memory store)."""
    for p in reg.get("projects", []):
        if p.get("id") == pid:
            return memory_search_dirs(p)
    return [MEMORY_DIR]


def container_status():
    """Return {name: {state, status, ports}} from docker ps."""
    out = {}
    try:
        res = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=10,
        )
        for line in res.stdout.splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            out[c.get("Names", "")] = {
                "state": c.get("State", ""),
                "status": c.get("Status", ""),
                "ports": c.get("Ports", ""),
            }
    except Exception as e:
        out["__error__"] = {"state": "error", "status": str(e), "ports": ""}
    return out


def service_status(units):
    """Return {unit: {state, status}} for systemd units, so the dashboard can
    show a live dot for things that run as services rather than containers.
    State is normalized to match container states ('running' / 'down' /
    'absent') so the frontend can reuse the same dot colors."""
    out = {}
    units = [u for u in units if u]
    if not units:
        return out
    try:
        res = subprocess.run(
            ["systemctl", "is-active", *units],
            capture_output=True, text=True, timeout=10,
        )
        lines = res.stdout.splitlines()
        for i, u in enumerate(units):
            raw = lines[i].strip() if i < len(lines) else "unknown"
            if raw == "active":
                state = "running"
            elif raw in ("inactive", "failed", "activating", "deactivating", "reloading"):
                state = "down"
            else:
                state = "absent"  # no such unit / unknown
            out[u] = {"state": state, "status": raw}
    except Exception as e:
        for u in units:
            out[u] = {"state": "down", "status": str(e)}
    return out


def claude_sessions():
    """Set of project ids whose tmux session (hub-<id>) is running `claude`.

    term.sh attaches each project to a tmux session named hub-<id>; when an
    agent is active, the pane's foreground command is the `claude` binary.
    """
    ids = set()
    try:
        res = subprocess.run(
            ["tmux", "list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}"],
            capture_output=True, text=True, timeout=5,
        )
        for line in res.stdout.splitlines():
            if "\t" not in line:
                continue
            sess, cmd = line.split("\t", 1)
            if sess.startswith("hub-") and cmd.strip() == "claude":
                ids.add(sess[len("hub-"):])
    except Exception:
        pass
    return ids


HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def save_layout(order, colors, title=None, favicon=None, projects_root=None):
    """Persist tab order, color tags, the hub title, the favicon emoji, and the
    default projects directory into projects.json (atomic, validated).

    order   : list of project ids defining the new top-to-bottom order. Unknown
              ids are ignored; known ids not listed keep their relative order
              after the listed ones (so a partial order is safe).
    colors  : {id: "#rrggbb" | null} — null/empty clears the tag. Only valid
              6-digit hex is accepted; anything else is ignored.
    title   : new dashboard title (string, trimmed, max 80 chars; ignored if blank).
    favicon : emoji shown in the browser tab (string, max 16 chars to allow
              multi-codepoint emoji; blank clears it back to the default).
    projects_root : default absolute directory new projects start in; only the
              add-project field is pre-filled with it, paths are never rewritten.
              Blank clears it; a relative path is ignored.
    Returns the rewritten registry dict.
    """
    reg = load_registry()
    projects = reg.get("projects", [])

    if isinstance(title, str):
        t = title.strip()[:80]
        if t:
            reg["title"] = t

    if isinstance(favicon, str):
        fav = favicon.strip()[:16]
        if fav:
            reg["favicon"] = fav
        else:
            reg.pop("favicon", None)

    if isinstance(projects_root, str):
        root = os.path.expanduser(projects_root.strip())
        if root and os.path.isabs(root):
            reg["projects_root"] = root.rstrip("/") or "/"
        elif not root:
            reg.pop("projects_root", None)
        # a non-empty relative path is ignored (the UI only sends absolute)

    if isinstance(order, list):
        rank = {pid: i for i, pid in enumerate(order) if isinstance(pid, str)}
        projects.sort(key=lambda p: rank.get(p.get("id"), len(rank) + 1))

    if isinstance(colors, dict):
        by_id = {p.get("id"): p for p in projects}
        for pid, col in colors.items():
            p = by_id.get(pid)
            if not p:
                continue
            if col in (None, ""):
                p.pop("color", None)
            elif isinstance(col, str) and HEX_COLOR.match(col):
                p["color"] = col.lower()

    reg["projects"] = projects
    return write_registry(reg)


def write_registry(reg):
    """Atomically write the registry back to projects.json."""
    tmp = REGISTRY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, REGISTRY)
    return reg


def add_project(name, directory, create=False):
    """Append a new project (name + directory) to the registry.

    With create=True a missing directory is created (mkdir -p); otherwise a
    missing directory raises FileNotFoundError so the caller can offer to make
    it. Generates a unique slug id from the name; other fields default empty.
    Returns the new id. Raises ValueError on invalid input.
    """
    name = (name or "").strip()[:60]
    if not name:
        raise ValueError("name is required")
    directory = os.path.expanduser((directory or "").strip())
    if not directory:
        raise ValueError("directory is required")
    if not os.path.isabs(directory):
        raise ValueError("directory must be an absolute path")
    if not os.path.isdir(directory):
        if not create:
            raise FileNotFoundError(directory)
        try:
            os.makedirs(directory, exist_ok=True)
        except OSError as e:
            raise ValueError("could not create directory: " +
                             (e.strerror or str(e)))
    reg = load_registry()
    existing = {p.get("id") for p in reg.get("projects", [])}
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "tab"
    pid, n = base, 2
    while pid in existing:
        pid, n = f"{base}-{n}", n + 1
    reg.setdefault("projects", []).append({
        "id": pid, "name": name, "dir": directory,
        "domains": [], "containers": [], "services": [], "memory": [],
    })
    write_registry(reg)
    return pid


def set_project_hidden(pid, hidden):
    """Hide/unhide a project card. Hidden projects keep their registry entry,
    tmux session and files — they just collapse into the sidebar's Hidden
    section (for people running 20+ projects)."""
    reg = load_registry()
    proj = _find_project(reg, (pid or "").strip())
    if not proj:
        raise ValueError("unknown project")
    if hidden:
        proj["hidden"] = True
    else:
        proj.pop("hidden", None)
    write_registry(reg)
    return bool(hidden)


def delete_project(pid):
    """Remove a project from the registry entirely. Files on disk are NOT
    touched; the project's tmux session is killed so it doesn't linger.
    The registry is backed up first (same convention as manual edits)."""
    reg = load_registry()
    proj = _find_project(reg, (pid or "").strip())
    if not proj:
        raise ValueError("unknown project")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    try:
        with open(f"{REGISTRY}.bak-pre-delete-{proj['id']}-{stamp}", "w", encoding="utf-8") as f:
            json.dump(reg, f, indent=2, ensure_ascii=False)
    except OSError:
        pass
    reg["projects"] = [p for p in reg.get("projects", []) if p.get("id") != proj["id"]]
    write_registry(reg)
    subprocess.run(["tmux", "kill-session", "-t", "hub-" + proj["id"]],
                   check=False, timeout=5)
    return proj["name"]


DOC_MAX = 512 * 1024   # cap on a single document tab's size, bytes


def _find_project(reg, pid):
    return next((p for p in reg.get("projects", []) if p.get("id") == pid), None)


def _read_spec(spec):
    """Read a {label,file} doc spec -> {label,file,kind,content}. The path comes
    from the spec (registry-sourced, never from the client), size-capped; a
    missing file surfaces a friendly note rather than an error."""
    path = os.path.expanduser(spec.get("file", ""))
    label = spec.get("label", "")
    if not path or not os.path.isfile(path):
        return {"label": label, "file": path, "kind": "text",
                "content": "(file not found: %s)" % path}
    with open(path, encoding="utf-8", errors="replace") as f:
        content = f.read(DOC_MAX + 1)
    if len(content) > DOC_MAX:
        content = content[:DOC_MAX] + "\n\n… (truncated)"
    ext = os.path.splitext(path)[1].lower()
    kind = "markdown" if ext in (".md", ".markdown") else "text"
    return {"label": label, "file": path, "kind": kind, "content": content}


def read_doc(reg, pid, index):
    """Read the file backing project <pid>'s doc tab #index. The path comes from
    the registry (set via add_tab), never from the client, so the browser can
    only ever read pre-registered files."""
    proj = _find_project(reg, pid)
    if not proj:
        raise ValueError("unknown project")
    tabs = proj.get("tabs", [])
    if not (0 <= index < len(tabs)):
        raise ValueError("unknown tab")
    return _read_spec(tabs[index])


def add_tab(pid, label, file):
    """Append a doc tab (label + existing file) to a project. Returns its index."""
    label = (label or "").strip()[:40]
    if not label:
        raise ValueError("label is required")
    path = os.path.expanduser((file or "").strip())
    if not path:
        raise ValueError("file is required")
    if not os.path.isabs(path):
        raise ValueError("file must be an absolute path")
    if not os.path.isfile(path):
        raise ValueError("file not found: " + path)
    reg = load_registry()
    proj = _find_project(reg, pid)
    if not proj:
        raise ValueError("unknown project")
    proj.setdefault("tabs", []).append({"label": label, "file": path})
    write_registry(reg)
    return len(proj["tabs"]) - 1


def remove_tab(pid, index):
    """Remove doc tab #index from a project."""
    reg = load_registry()
    proj = _find_project(reg, pid)
    if not proj:
        raise ValueError("unknown project")
    tabs = proj.get("tabs", [])
    if not (0 <= index < len(tabs)):
        raise ValueError("unknown tab")
    tabs.pop(index)
    proj["tabs"] = tabs
    write_registry(reg)


# --- Global reference tabs (Essentials / Credentials) ----------------------
# Stored as top-level arrays in projects.json (gitignored, per-box) so the
# filenames are never committed. Same {label,file} shape as project doc tabs.
GLOBAL_TABS = ("essentials", "credentials")
EDITABLE_EXT = (".md", ".markdown", ".txt")


def read_global_doc(reg, tab, index):
    """Read global tab <tab>'s entry #index (path from registry, not client)."""
    if tab not in GLOBAL_TABS:
        raise ValueError("unknown tab")
    items = reg.get(tab, [])
    if not (0 <= index < len(items)):
        raise ValueError("unknown entry")
    return _read_spec(items[index])


def add_global(tab, file, label=None):
    """Link an existing file into a global tab. Returns its index."""
    if tab not in GLOBAL_TABS:
        raise ValueError("unknown tab")
    path = os.path.expanduser((file or "").strip())
    if not path:
        raise ValueError("file is required")
    if not os.path.isabs(path):
        raise ValueError("file must be an absolute path")
    if not os.path.isfile(path):
        raise ValueError("file not found: " + path)
    label = (label or "").strip()[:40] or os.path.basename(path)
    reg = load_registry()
    reg.setdefault(tab, []).append({"label": label, "file": path})
    write_registry(reg)
    return len(reg[tab]) - 1


def remove_global(tab, index):
    """Unlink entry #index from a global tab (the file itself is not deleted)."""
    if tab not in GLOBAL_TABS:
        raise ValueError("unknown tab")
    reg = load_registry()
    items = reg.get(tab, [])
    if not (0 <= index < len(items)):
        raise ValueError("unknown entry")
    items.pop(index)
    reg[tab] = items
    write_registry(reg)


def _editable_path(reg, scope, project, tab, index):
    """Resolve the on-disk path for an editable doc, addressed by registry index
    (never a client path). scope is 'project' or 'global'."""
    if not isinstance(index, int):
        raise ValueError("index required")
    if scope == "global":
        if tab not in GLOBAL_TABS:
            raise ValueError("unknown tab")
        items = reg.get(tab, [])
    elif scope == "project":
        proj = _find_project(reg, project)
        if not proj:
            raise ValueError("unknown project")
        items = proj.get("tabs", [])
    else:
        raise ValueError("unknown scope")
    if not (0 <= index < len(items)):
        raise ValueError("unknown entry")
    return os.path.expanduser(items[index].get("file", ""))


def save_doc(scope, content, project=None, tab=None, index=None):
    """Overwrite an editable (.md/.txt) doc, addressed by registry index.

    The path is resolved from the registry, the extension must be editable, and
    the file must already exist -- so this can only ever rewrite a file that was
    deliberately linked into a tab, never an arbitrary client-supplied path."""
    if not isinstance(content, str):
        raise ValueError("content required")
    if len(content.encode("utf-8")) > DOC_MAX:
        raise ValueError("content too large")
    reg = load_registry()
    path = _editable_path(reg, scope, project, tab, index)
    if not path or not os.path.isabs(path):
        raise ValueError("bad path")
    if os.path.splitext(path)[1].lower() not in EDITABLE_EXT:
        raise ValueError("only .md/.markdown/.txt files are editable")
    if not os.path.isfile(path):
        raise ValueError("file not found")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)


# --- Editable project memory (the force-read @-imports in CLAUDE.md) --------
# These power the Memory tab's add/edit/remove. A project's "memory" array holds
# .md basenames resolved against its memory_dirs + the global MEMORY_DIR; the
# CLAUDE.md generator @-imports every one, so anything added here is force-read
# by the agent on launch.

def _slug_md(name):
    """Turn a user-supplied name into a safe <slug>.md basename."""
    stem = os.path.splitext(os.path.basename((name or "").strip()))[0]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._").lower()
    if not stem:
        raise ValueError("a name is required")
    return stem[:60] + ".md"


def _memory_dir_for(proj):
    """Where to create new memory files: the project's first memory_dir if set,
    else the global MEMORY_DIR."""
    dirs = proj.get("memory_dirs") or []
    return dirs[0] if dirs else MEMORY_DIR


def _resolve_memory(reg, project, fname):
    """Resolve a project memory basename to an existing on-disk path."""
    fname = os.path.basename(fname or "")
    if not fname or os.path.splitext(fname)[1].lower() not in EDITABLE_EXT:
        raise ValueError("bad file")
    proj = _find_project(reg, project)
    dirs = memory_search_dirs(proj) if proj else [MEMORY_DIR]
    for d in dirs:
        p = os.path.join(d, fname)
        if os.path.isfile(p):
            return p
    raise ValueError("file not found")


def add_memory(project, name):
    """Create a new .md memory file and link it to the project (force-read)."""
    reg = load_registry()
    proj = _find_project(reg, project)
    if not proj:
        raise ValueError("unknown project")
    fname = _slug_md(name)
    target = _memory_dir_for(proj)
    os.makedirs(target, exist_ok=True)
    path = os.path.join(target, fname)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write("# {}\n\n".format(os.path.splitext(fname)[0]))
    mem = proj.setdefault("memory", [])
    if fname not in mem:
        mem.append(fname)
    write_registry(reg)
    return fname


def save_memory(project, file, content):
    """Overwrite a linked memory file's content."""
    if not isinstance(content, str):
        raise ValueError("content required")
    if len(content.encode("utf-8")) > DOC_MAX:
        raise ValueError("content too large")
    reg = load_registry()
    path = _resolve_memory(reg, project, file)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)


def remove_memory(project, file):
    """Unlink a memory file from a project (the file itself is not deleted)."""
    reg = load_registry()
    proj = _find_project(reg, project)
    if not proj:
        raise ValueError("unknown project")
    fname = os.path.basename(file or "")
    proj["memory"] = [m for m in proj.get("memory", []) if m != fname]
    write_registry(reg)


# Keys the mobile tap-bar may inject into a project's terminal. A fixed
# whitelist (mapped to tmux key names) so a phone can answer interactive
# prompts — arrows, Enter, numbers, Space, Tab, Shift-Tab (auto-accept/plan
# mode), Ctrl-C — that a soft keyboard can't reliably send.
TERM_KEYS = {
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "enter": "Enter", "esc": "Escape", "space": "Space",
    "tab": "Tab", "btab": "BTab", "ctrl-c": "C-c",
    **{d: d for d in "0123456789"},
}


def term_send_key(project, key):
    """Inject one whitelisted keystroke into project <id>'s tmux session.

    The session name is derived from the registry (hub-<id>), never from the
    client, and the key must be in TERM_KEYS — so this can only ever send a
    known control key to a known session, not arbitrary input or shell.
    """
    reg = load_registry()
    proj = _find_project(reg, (project or "").strip())
    if not proj:
        raise ValueError("unknown project")
    tok = TERM_KEYS.get((key or "").strip().lower())
    if tok is None:
        raise ValueError("key not allowed")
    subprocess.run(["tmux", "send-keys", "-t", "hub-" + proj["id"], tok],
                   check=False, timeout=5)


def term_paste(project, text):
    """Paste clipboard text into project <id>'s terminal as a bracketed paste,
    so multi-line content lands as one block (and Claude's prompt / the shell
    won't auto-run each line). Text is length-capped; the session is derived
    from the registry, never the client."""
    reg = load_registry()
    proj = _find_project(reg, (project or "").strip())
    if not proj:
        raise ValueError("unknown project")
    if not isinstance(text, str):
        raise ValueError("text required")
    text = text[:100000]
    if not text:
        return
    session = "hub-" + proj["id"]
    subprocess.run(["tmux", "set-buffer", "-b", "tcpaste", "--", text],
                   check=False, timeout=5)
    subprocess.run(["tmux", "paste-buffer", "-p", "-d", "-b", "tcpaste",
                    "-t", session], check=False, timeout=5)


def term_mouse(project, on):
    """Set tmux mouse mode on/off for project <id>'s session — lets a phone
    swipe-scroll the terminal history. Per-session; returns the new state."""
    reg = load_registry()
    proj = _find_project(reg, (project or "").strip())
    if not proj:
        raise ValueError("unknown project")
    state = "on" if on else "off"
    subprocess.run(["tmux", "set-option", "-t", "hub-" + proj["id"],
                    "mouse", state], check=False, timeout=5)
    return state


def term_capture(project, lines):
    """Dump the last <lines> of project <id>'s tmux scrollback as plain text.
    Backs the dashboard's Copy button — the reliable copy path, since the
    bundled ttyd has no OSC-52 clipboard support and browser-side selection
    fights tmux/full-screen apps. -J joins wrapped lines so long commands
    copy as one line."""
    reg = load_registry()
    proj = _find_project(reg, (project or "").strip())
    if not proj:
        raise ValueError("unknown project")
    try:
        lines = max(1, min(int(lines), 50000))
    except (TypeError, ValueError):
        lines = 2000
    out = subprocess.run(["tmux", "capture-pane", "-p", "-J",
                          "-t", "hub-" + proj["id"], "-S", f"-{lines}"],
                         capture_output=True, text=True, timeout=10)
    return out.stdout


def term_buffer():
    """Most recent tmux paste buffer — what a mouse-mode drag just copied
    ('N characters copied to the tmux buffer'). Buffers are global to the
    tmux server, so no project target is needed; empty string if none."""
    out = subprocess.run(["tmux", "show-buffer"],
                         capture_output=True, text=True, timeout=5)
    return out.stdout if out.returncode == 0 else ""


def browse_dir(dirpath):
    """List a directory for the file picker (dirs first, then files). Read-only;
    auth-gated at the route. Falls back to $HOME for a missing/blank dir."""
    home = os.path.expanduser("~")
    base = os.path.abspath(os.path.expanduser(dirpath.strip())) if (dirpath or "").strip() else home
    if not os.path.isdir(base):
        base = home
    entries = []
    try:
        for name in os.listdir(base):
            full = os.path.join(base, name)
            try:
                is_dir = os.path.isdir(full)
            except OSError:
                continue
            entries.append({"name": name, "path": full, "is_dir": is_dir})
    except OSError as e:
        return {"dir": base, "parent": os.path.dirname(base) or "/", "entries": [], "error": str(e)}
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    parent = os.path.dirname(base.rstrip("/")) or "/"
    return {"dir": base, "parent": parent, "entries": entries[:2000]}


def safe_read(directory, name):
    """Read a file by basename from a single allowed directory."""
    name = os.path.basename(name or "")
    if not name or not name.endswith(".md"):
        return None
    path = os.path.join(directory, name)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body, ctype="application/json", cache=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache or "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location, set_cookie=None):
        self.send_response(302)
        self.send_header("Location", location)
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _authed(self):
        """True iff the request carries a valid layer-2 session cookie, or a
        valid session token in X-TC-Token (the mobile app's native fetches)."""
        tok = cookie_value(self.headers, COOKIE) or self.headers.get("X-TC-Token")
        return bool(tok and token_valid(tok))

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > 1_000_000:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except Exception:
            return None

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/gate/login":
            if login_limited(self.client_address[0]):
                err = '<div class="err">Too many attempts — wait a minute.</div>'
                return self._send(429, LOGIN_HTML.format(err=err), "text/html; charset=utf-8")
            length = int(self.headers.get("Content-Length", "0") or 0)
            body = self.rfile.read(length).decode("utf-8", "replace")
            pw = parse_qs(body).get("password", [""])[0]
            if verify_password(pw):
                return self._redirect("/", _cookie_header(make_token(), TTL))
            err = '<div class="err">Wrong password.</div>'
            return self._send(401, LOGIN_HTML.format(err=err), "text/html; charset=utf-8")

        if u.path == "/api/login":
            # Mobile-app login: password -> long-lived signed session token
            # {token, expiresAt(ms)}. The token doubles as a hub_session
            # cookie value (same format), which is how the app's terminal
            # webview authenticates its asset and websocket requests.
            if login_limited(self.client_address[0]):
                return self._send(429, {"error": "too many attempts"})
            data = self._read_json()
            pw = data.get("password") if isinstance(data, dict) else None
            if not (isinstance(pw, str) and verify_password(pw)):
                return self._send(401, {"error": "bad password"})
            tok = make_token(APP_TTL)
            return self._send(200, {"token": tok,
                                    "expiresAt": int(tok.split(".")[0]) * 1000})

        if u.path == "/api/layout":
            # Persist tab order + color tags. Mutating route, so enforce auth
            # in-process too (not just at the Caddy edge).
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                save_layout(data.get("order"), data.get("colors"),
                            data.get("title"), data.get("favicon"),
                            data.get("projects_root"))
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True})

        if u.path == "/api/term/key":
            # Inject a single whitelisted key into a project's terminal — the
            # mobile tap-bar's backend. Auth-gated; key + session validated.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                term_send_key(data.get("project"), data.get("key"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True})

        if u.path == "/api/term/paste":
            # Bracketed-paste clipboard text into a project's terminal.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                term_paste(data.get("project"), data.get("text"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True})

        if u.path == "/api/term/mouse":
            # Toggle tmux mouse/scroll mode for a project's session.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                state = term_mouse(data.get("project"), bool(data.get("on")))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True, "mouse": state})

        if u.path == "/api/project":
            # Create a new project tab (name + directory). Auth-gated + validated.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                pid = add_project(data.get("name"), data.get("dir"),
                                  create=bool(data.get("create")))
            except FileNotFoundError as e:
                return self._send(400, {"error": "directory not found: " + str(e),
                                        "missing_dir": True})
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True, "id": pid})

        if u.path == "/api/project/hide":
            # Hide/unhide a project card (registry + session untouched).
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                state = set_project_hidden(data.get("project"), bool(data.get("hidden")))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True, "hidden": state})

        if u.path == "/api/project/delete":
            # Remove a project from the registry (files untouched, tmux killed).
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                name = delete_project(data.get("project"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True, "deleted": name})

        if u.path == "/api/project/tabs/add":
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                idx = add_tab(data.get("project"), data.get("label"), data.get("file"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True, "index": idx})

        if u.path == "/api/project/tabs/remove":
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict) or not isinstance(data.get("index"), int):
                return self._send(400, {"error": "bad request"})
            try:
                remove_tab(data.get("project"), data["index"])
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True})

        if u.path == "/api/globals/add":
            # Link an existing file into a global tab (Essentials/Credentials).
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                idx = add_global(data.get("tab"), data.get("file"), data.get("label"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True, "index": idx})

        if u.path == "/api/globals/remove":
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict) or not isinstance(data.get("index"), int):
                return self._send(400, {"error": "bad request"})
            try:
                remove_global(data.get("tab"), data["index"])
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True})

        if u.path == "/api/doc/save":
            # Overwrite an editable doc, addressed by registry index (never a
            # client path). Restricted to existing .md/.markdown/.txt files.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                save_doc(data.get("scope"), data.get("content"),
                         project=data.get("project"), tab=data.get("tab"),
                         index=data.get("index"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True})

        if u.path == "/api/memory/add":
            # Create + link a new force-read memory file for a project.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                fname = add_memory(data.get("project"), data.get("name"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True, "file": fname})

        if u.path == "/api/memory/save":
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                save_memory(data.get("project"), data.get("file"), data.get("content"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True})

        if u.path == "/api/memory/remove":
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            data = self._read_json()
            if not isinstance(data, dict):
                return self._send(400, {"error": "bad request"})
            try:
                remove_memory(data.get("project"), data.get("file"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"ok": True})

        return self._send(404, {"error": "unknown route"})

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path

        # --- Layer 2 gate endpoints (bypass auth themselves) ---
        if path == "/gate/login":
            return self._send(200, LOGIN_HTML.format(err=""), "text/html; charset=utf-8")
        if path == "/gate/logout":
            return self._redirect("/gate/login", _cookie_header("", 0))
        if path == "/gate/check":
            # Caddy forward_auth target: 200 = allow, 302 = bounce to login.
            # forward_auth copies the original request headers, so the mobile
            # app can pass X-TC-Token on requests that can't carry the cookie.
            # The OTA install routes are public by design (iOS fetches the
            # manifest/ipa with no cookies; the build is UDID-locked anyway).
            fwd = self.headers.get("X-Forwarded-Uri", "")
            if (fwd == "/app" or fwd.startswith("/app/")
                    or fwd.split("?")[0] == "/api/login"):
                # /api/login does its own password check + rate limit; it must
                # be reachable without a session or the app could never log in.
                return self._send(200, "ok", "text/plain")
            # A valid session token in the query also passes: the app's
            # terminal page (term.html?token=...) plants the cookie via JS,
            # so its own page load arrives cookieless — the token in the URL
            # is the only credential it can carry on that first request.
            qtok = parse_qs(urlparse(fwd).query).get("token", [""])[0]
            if qtok and token_valid(qtok):
                return self._send(200, "ok", "text/plain")
            tok = (cookie_value(self.headers, COOKIE)
                   or self.headers.get("X-TC-Token"))
            if tok and token_valid(tok):
                return self._send(200, "ok", "text/plain")
            return self._redirect("/gate/login")

        # --- OTA install page for the mobile app (public; same pattern as the
        # notes app). update-app.sh pulls the signed ipa from the app-latest
        # GitHub release into ota/ where these routes serve it. Ad-hoc signed
        # -> runs only on registered UDIDs, so open serving is fine.
        if path == "/app":
            base = "https://%s/app" % self.headers.get("Host", "")
            has_ipa = os.path.isfile(os.path.join(HERE, "ota", OTA_IPA))
            body = (
                '<a href="itms-services://?action=download-manifest&url=%s"'
                ' style="background:#0a84ff;color:#fff;padding:16px 32px;'
                'border-radius:12px;text-decoration:none;font-size:20px">'
                'Install on iPhone</a>'
                '<p style="color:#888">On a Mac: <a href="%s" style="color:#0a84ff">'
                'download the .ipa</a> and double-click it.</p>'
                % (quote(base + "/manifest.plist", safe=""), base + "/" + OTA_IPA)
                if has_ipa else "<p>No build uploaded yet.</p>")
            return self._send(200,
                '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">'
                '<title>TerminalClaw app</title>'
                '<body style="font-family:-apple-system,sans-serif;background:#0d1117;color:#e6edf3;'
                'display:flex;flex-direction:column;align-items:center;justify-content:center;'
                'min-height:90vh;gap:24px"><h1 style="margin:0">🦀 TerminalClaw</h1>' + body,
                "text/html; charset=utf-8")

        if path == "/app/manifest.plist":
            base = "https://%s/app" % self.headers.get("Host", "")
            return self._send(200, """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
  <key>assets</key><array><dict>
    <key>kind</key><string>software-package</string>
    <key>url</key><string>%s/%s</string>
  </dict></array>
  <key>metadata</key><dict>
    <key>bundle-identifier</key><string>com.zacmorriss.terminalclaw</string>
    <key>bundle-version</key><string>1.0.0</string>
    <key>kind</key><string>software</string>
    <key>title</key><string>TerminalClaw</string>
  </dict>
</dict></array></dict></plist>""" % (base, OTA_IPA), "application/xml")

        if path == "/app/" + OTA_IPA:
            fp = os.path.join(HERE, "ota", OTA_IPA)
            if not os.path.isfile(fp):
                return self._send(404, {"error": "no build"})
            with open(fp, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)

        if path == "/" or path == "/index.html":
            try:
                with open(os.path.join(HERE, "index.html"), encoding="utf-8") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            except FileNotFoundError:
                return self._send(404, {"error": "index.html missing"})

        if path.startswith("/static/"):
            # Vendored frontend assets (xterm.js & friends). Flat filenames
            # only — any path separator or dotfile is rejected, so nothing
            # outside static/ is reachable.
            name = path[len("/static/"):]
            fp = os.path.join(HERE, "static", name)
            if ("/" in name or "\\" in name or name.startswith(".")
                    or not os.path.isfile(fp)):
                return self._send(404, {"error": "not found"})
            ctype = {"js": "application/javascript; charset=utf-8",
                     "css": "text/css; charset=utf-8"}.get(
                name.rsplit(".", 1)[-1], "application/octet-stream")
            # Vendored libs basically never change — let clients cache them so
            # a terminal open costs one small HTML fetch, not 300KB of assets
            # through the tunnel. term.html itself stays uncached so page
            # fixes deploy without cache-busting.
            cache = None if name == "term.html" else "public, max-age=604800"
            with open(fp, encoding="utf-8") as f:
                return self._send(200, f.read(), ctype, cache=cache)

        if path == "/api/projects":
            reg = load_registry()
            status = container_status()
            agents = claude_sessions()
            for p in reg["projects"]:
                p["status"] = {c: status.get(c, {"state": "absent", "status": "not found", "ports": ""})
                               for c in p.get("containers", [])}
                p["svc_status"] = service_status(p.get("services", []))
                p["claude_running"] = p.get("id") in agents
                files = list(p.get("memory", []))
                for d in p.get("memory_dirs", []):
                    files += list_md(d)
                seen = set()
                p["memory"] = [f for f in files if not (f in seen or seen.add(f))]
                # Claude Code's own memory for this project's directory (what the
                # agent has chosen to remember) — surfaced read/edit in the UI.
                cmd = claude_mem_dir(p.get("dir", ""))
                p["agent_memory"] = list_md(cmd) if cmd else []
            reg["generated"] = True
            return self._send(200, reg)

        if path == "/api/memory":
            pid = q.get("project", [""])[0]
            name = q.get("file", [""])[0]
            dirs = project_dirs(load_registry(), pid) if pid else [MEMORY_DIR]
            txt = next((t for t in (safe_read(d, name) for d in dirs) if t is not None), None)
            if txt is None:
                return self._send(404, {"error": "not found"})
            return self._send(200, {"content": txt})

        if path == "/api/notes":
            txt = safe_read(NOTES_DIR, q.get("file", [""])[0])
            if txt is None:
                return self._send(404, {"error": "not found"})
            return self._send(200, {"content": txt})

        if path == "/api/term/buffer":
            # Latest tmux paste buffer — the mobile app's Copy button prefers
            # this: with tmux mouse mode on, a drag lands here, not in xterm.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            try:
                return self._send(200, {"content": term_buffer()})
            except Exception as e:
                return self._send(500, {"error": str(e)})

        if path == "/api/term/capture":
            # Terminal scrollback as text — backs the Copy button.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            try:
                text = term_capture(q.get("project", [""])[0],
                                    q.get("lines", ["2000"])[0])
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {"content": text})

        if path == "/api/doc":
            # Read a project's doc tab by index. Path comes from the registry,
            # not the client, so only pre-registered files are reachable.
            pid = q.get("project", [""])[0]
            try:
                idx = int(q.get("tab", [""])[0])
            except (ValueError, TypeError):
                return self._send(400, {"error": "bad tab"})
            try:
                doc = read_doc(load_registry(), pid, idx)
            except ValueError as e:
                return self._send(404, {"error": str(e)})
            return self._send(200, doc)

        if path == "/api/globaldoc":
            # Read a global tab's doc by index (path from registry, not client).
            tab = q.get("tab", [""])[0]
            try:
                idx = int(q.get("i", [""])[0])
            except (ValueError, TypeError):
                return self._send(400, {"error": "bad index"})
            try:
                doc = read_global_doc(load_registry(), tab, idx)
            except ValueError as e:
                return self._send(404, {"error": str(e)})
            return self._send(200, doc)

        if path == "/api/browse":
            # File picker listing. Sensitive (exposes the filesystem), so it is
            # auth-gated in-process in addition to the Caddy edge gate.
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            return self._send(200, browse_dir(q.get("dir", [""])[0]))

        return self._send(404, {"error": "unknown route"})


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"hub-dashboard listening on http://{HOST}:{PORT}")
    srv.serve_forever()
