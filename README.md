# TerminalClaw

A single-page dashboard over all projects on one VPS, with an embedded
per-project browser terminal (type `claude` to open an agent) and a viewer for
the linked memory/context files. Tiny by design: a stdlib Python server + a
vanilla-JS SPA + `ttyd`, fronted by Caddy and exposed via a Cloudflare Tunnel.

Reachable at a single hostname behind **two cookie-based auth layers**
(Cloudflare Access at the edge + a server-side login at the origin) — no inbound
port is opened on the VPS; a Cloudflare Tunnel dials out instead.

📐 **Full request flow, tunnel, and auth design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).**
Sanitized Caddy / cloudflared / systemd configs: [`deploy/`](deploy).

The project sidebar is interactive: **drag a card to reorder**, **click its swatch
to assign a color tag**, **"+ New project"** to add a tab (name + directory), and a
card shows a pulsing green **"Claude is running"** light whenever its `tmux` session
has an active `claude` agent. The header **title is click-to-rename**, and a
**Compact** toggle collapses inactive cards to just their name.

Each project also has its own **document tabs** beside Terminal/Memory: click **+**
in the tab bar to add one (a label + a file path — `.md` renders as markdown,
`.txt`/code shows as text), and **×** to remove it. The server only reads files you
register in `projects.json`, never arbitrary client-supplied paths. All of this
(order, colors, title, new projects, doc tabs) persists to `projects.json` via
auth-checked `POST` endpoints, so it syncs across every device. Drag-reorder uses
native pointer drag (desktop); everything else works everywhere.

## Repository layout
```
server.py        dashboard backend (stdlib HTTP): SPA + /api/* + /gate/* cookie login
index.html       vanilla-JS SPA
term.sh          ttyd launcher: project id -> dir -> persistent tmux session; sets up the agent shell
gen_claude_md.py builds a project's CLAUDE.md "brief" from its tabs (memory @-imported)
agent.bashrc     per-session shell init: the `claude` wrapper (refresh brief + auto-resume)
tclaw            control helper: `tclaw update|status|restart` (self-locating, service-name agnostic)
projects.json    project registry (edit to add/rename projects, link memory)
docs/            ARCHITECTURE.md (tunnel + auth deep-dive)
deploy/          caddy block, cloudflared config template, systemd units
```

## Per-project agents & memory

Each project's terminal is a **project-scoped Claude Code agent**, not just a shell in a
folder. When you open a project and type `claude`:

1. **The brief is rebuilt.** A `claude` shell wrapper (in `agent.bashrc`, wired up by
   `term.sh`) runs `gen_claude_md.py`, which writes a fresh `CLAUDE.md` into the project's
   directory from its currently-attached tabs. The project's **memory** files are
   `@`-imported (Claude Code force-reads them at launch); doc tabs + Essentials/Credentials
   are listed as paths (read on demand, so secrets aren't dumped into context up front).
2. **Claude starts grounded.** Because Claude Code auto-loads `CLAUDE.md`, the agent boots
   already knowing the project — no clean slate. Add or remove a tab and the next `claude`
   reflects it (the brief is regenerated every launch; it's disposable, so it's gitignored).

The **🧠 Memory tab** manages this from the browser: **+ Add memory** creates/edits a
force-read `.md`; the tab also surfaces **Claude Code's own per-project memory** (what the
agent chose to remember, from `~/.claude/projects/<dir-slug>/memory/`) in a second group —
so you see and edit both your brief and the agent's recall in one place.

## Persistent conversations

- **Auto-resume.** A bare `claude` resumes the directory's most recent conversation if one
  exists (Claude Code journals every turn to disk), so reopening a project picks up where you
  left off — even after a reboot. `command claude` starts a fresh chat.
- **Survive restarts.** The ttyd unit ships with `KillMode=process`, so restarting the service
  / running `tclaw update` kills only `ttyd` and leaves the `tmux` server + running `claude`
  alive. Updates no longer drop your live sessions.

## Updating — `tclaw`

`tclaw` is a small control helper, symlinked into `/usr/local/bin`, that self-locates the
checkout and auto-detects the service names (boxes use either `hub-*` or `terminalclaw-*`):

```bash
tclaw update    # git pull latest + restart the app (one-command self-update)
tclaw status    # current commit + service health
tclaw restart   # restart the dashboard + terminal services
```

Workflow: `git push` from your dev machine, then `tclaw update` on each box.

## Pieces

| Piece | Where | Notes |
|-------|-------|-------|
| Project registry | `/opt/terminalclaw/projects.json` | Edit this to add/rename projects, link memory files, change dirs |
| Dashboard backend | `/opt/terminalclaw/server.py` | Python stdlib HTTP server, binds `127.0.0.1:7682`. Serves SPA + `/api/*` |
| Dashboard UI | `/opt/terminalclaw/index.html` | Vanilla JS SPA |
| Terminal launcher | `/opt/terminalclaw/term.sh` | Maps project id -> dir, attaches/creates `tmux` session `hub-<id>` |
| ttyd service | `hub-ttyd.service` | `ttyd -b /terminal -a -W` on `127.0.0.1:7681`, runs `term.sh` |
| Backend service | `hub-dashboard.service` | runs `server.py` |
| Edge routing | `/etc/caddy/Caddyfile` (`hub.example.com:8088` block) | cookie-gate (`forward_auth`) + reverse proxies |
| Public ingress | Cloudflare Tunnel `terminalclaw` (`/root/.cloudflared/config.yml`) | `hub.example.com` -> `127.0.0.1:8088` |

## How the terminal works
- The dashboard iframe loads `/terminal/?arg=<project-id>`.
- ttyd (`-a`/`--url-arg`) appends that id as an argument to `term.sh`.
- `term.sh` looks the id up in `projects.json`, then runs
  `tmux new-session -A -s hub-<id> -c <dir>` — so sessions persist across page
  reloads and you reattach to the same one. `Ctrl-b d` detaches.

## Managing
```bash
systemctl status hub-dashboard hub-ttyd
systemctl restart hub-dashboard      # after editing server.py / projects.json
systemctl restart hub-ttyd           # after editing term.sh
journalctl -u hub-dashboard -f
caddy reload --config /etc/caddy/Caddyfile # after editing the Caddy block (live file)
tmux ls                               # see live hub-* sessions
```

## Deploy / first-time setup
This repo is the dashboard app plus sanitized infra templates; live secrets are
NOT included (see Security below). To stand it up on a fresh box:
1. Put `server.py`, `index.html`, `term.sh` in `/opt/terminalclaw`, then
   `cp projects.example.json projects.json` and edit it for your projects
   (`projects.json` is git-ignored — it maps your server, so it stays local).
2. Install the units from `deploy/systemd/`, then `systemctl enable --now
   hub-dashboard hub-ttyd`. `server.py` auto-generates `.gate_secret` and a
   random `.gate_pass` on first run (printed once to the journal) — then set a
   real password with `python3 -c "import server; server.set_password('...')"`.
3. Add the `deploy/caddy/` block to your Caddyfile and `caddy reload`.
4. Create the Cloudflare Tunnel from `deploy/cloudflared/config.yml.example`
   (steps are in that file), and add a Cloudflare Access app for the hostname.

## Security
- **Never commit** `.gate_secret`, `.gate_pass`, the cloudflared `*.json`
  credentials, or `cert.pem` — all are git-ignored. The repo ships only
  sanitized templates.
- `projects.json` describes your full server topology (domains, container names,
  paths), so it is **git-ignored**. The repo ships `projects.example.json` with
  placeholders; your real registry never leaves the box.

## Adding a project
Append an object to `projects.json` `projects[]`:
```json
{ "id": "newproj", "name": "New Project", "dir": "/path/to/src",
  "domains": ["new.example.com"], "containers": ["newproj_web"],
  "services": ["newproj.service"], "memory": ["some-memory-file.md"] }
```
Then `systemctl restart hub-dashboard`. No restart needed for ttyd (it reads
the registry per session).

### Live status dots
Each project card shows a live status pill for whatever it runs:
- **`containers`** — Docker containers (status from `docker ps`). Round dot.
- **`services`** — systemd units (status from `systemctl is-active`). Square dot
  with a ⚙ glyph, so services read differently from containers at a glance.

Both use the same colors: green = up (`running` / `active`), red = down
(`exited` / `inactive` / `failed`), grey = absent (no such container/unit). A
project can list both, either, or neither; the dots refresh every 20s. `services`
is optional — omit it and the card just shows containers (or nothing).

## Auth (two independent, both cookie-based)
HTTP Basic was dropped because mobile browsers won't re-send it into the
terminal iframe (caused a re-login on every project switch). Both layers are
now cookie-based, so they survive the iframe on mobile.

1. **Layer 1 — Cloudflare Access** (edge): gates `hub.example.com` in the CF
   Zero Trust dashboard (team `<your-team>`), email OTP. Sets `CF_Authorization`.
2. **Layer 2 — server cookie login** (origin): `server.py` serves `/gate/login`
   and a `/gate/check` endpoint; Caddy enforces it via `forward_auth` on every
   route incl. `/terminal`. Signed session cookie (HMAC, `.gate_secret`),
   password is pbkdf2 in `.gate_pass`.

Change the layer-2 password (no restart needed):
```bash
cd /opt/terminalclaw && python3 -c "import server; server.set_password('NEW_PASSWORD')"
```
`.gate_secret` / `.gate_pass` are `0600`; deleting `.gate_secret` invalidates
all existing sessions (forces re-login).

## Ideas for later
- Per-project log tail / `docker compose logs` button
- Start/stop/restart container buttons (POST endpoints in server.py)
- Git status per project dir
- Deploy buttons wired to each project's build script

## License
MIT — see [`LICENSE`](LICENSE).
