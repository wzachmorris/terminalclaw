# Architecture

TerminalClaw is a single-page dashboard over every project on one VPS, with an
embedded per-project browser terminal and a viewer for each project's
memory/context files. It is intentionally tiny: a stdlib Python HTTP server, a
vanilla-JS SPA, `ttyd` for the terminal, fronted by Caddy and exposed through a
Cloudflare Tunnel.

## Request flow

```
                          ┌─────────────────────────────────────────────┐
   your browser           │                Your VPS                     │
        │                 │                                             │
        │ HTTPS           │   ┌────────────┐  HTTP/localhost            │
        ▼                 │   │  cloudflared│  :8088                    │
┌───────────────┐  TLS    │   │  (tunnel    │────────┐                  │
│ Cloudflare edge│════════╪══▶│   "tunnel") │        ▼                  │
│  + Zero Trust  │ tunnel  │   └────────────┘   ┌──────────┐            │
│   (Access)     │ (no     │                    │  Caddy   │  route by  │
└───────────────┘  inbound│                    │ :8088    │  path:     │
   Layer 1 auth    ports)  │                    └────┬─────┘            │
   (CF_Authorization       │        /gate/* , /api , / │   /terminal/*  │
    cookie)                │                          ▼               ▼ │
                           │                   ┌────────────┐   ┌─────────┐
                           │  Layer 2 auth     │ server.py  │   │  ttyd   │
                           │  (forward_auth →  │  :7682     │   │ :7681   │
                           │   /gate/check,    │ SPA + API  │   │ term.sh │
                           │   cookie session) │ + cookie   │   │ + tmux  │
                           │                   │   gate     │   └─────────┘
                           │                   └────────────┘             │
                           └─────────────────────────────────────────────┘
```

1. **Cloudflare edge** terminates public TLS for `hub.example.com` and applies
   **Layer 1 auth — Cloudflare Access (Zero Trust)**: an email/OTP gate that sets
   a `CF_Authorization` cookie. Configured in the Cloudflare dashboard, not on
   the box.
2. **cloudflared** runs a named tunnel (`terminalclaw`) that dials *out* to Cloudflare
   and holds a persistent connection. Requests for the hostname are forwarded
   down it to `http://127.0.0.1:8088`. **No inbound port is opened** on the VPS —
   the origin is localhost-only.
3. **Caddy** (`:8088`, bound to `127.0.0.1`) does path routing and enforces
   **Layer 2 auth** via `forward_auth` against the backend's `/gate/check`
   endpoint (a signed-cookie session — see below). It proxies:
   - `/terminal/*` → `ttyd` (`:7681`)
   - `/api/*` and `/` → the dashboard backend (`:7682`)
   - `/gate/*` → the backend, *bypassing* the cookie check (login form lives here)
4. **server.py** (`:7682`) serves the SPA + JSON API and owns the Layer-2 login.
5. **ttyd** (`:7681`) serves the browser terminal; `term.sh` maps a project id to
   its dir and attaches/creates a persistent `tmux` session `hub-<id>`.

## Why two auth layers, both cookie-based

The dashboard embeds the terminal in an `<iframe>`. The original second lock was
HTTP **Basic Auth** in Caddy — but **mobile browsers don't re-send Basic Auth
credentials into an iframe**, so every project switch (which reloads the iframe)
re-prompted for login. Cookies *are* re-sent on every same-origin request,
including iframes, so both layers are cookie-based:

| Layer | Where | Mechanism |
|-------|-------|-----------|
| 1 — edge   | Cloudflare Access (Zero Trust) | `CF_Authorization` cookie (email/OTP) |
| 2 — origin | `server.py` + Caddy `forward_auth` | signed session cookie |

### Layer-2 session cookie (server.py)

- On `POST /gate/login`, the password is checked against a pbkdf2-sha256 hash in
  `.gate_pass`. On success the server sets `hub_session=<exp>.<hmac>` —
  `HttpOnly; Secure; SameSite=Lax` — where the HMAC is keyed by `.gate_secret`.
- `GET /gate/check` (Caddy's `forward_auth` target) returns `200` if the cookie's
  HMAC + expiry validate, else `302` to `/gate/login`.
- `.gate_secret` (HMAC key) and `.gate_pass` (password hash) are generated on
  first run, `chmod 600`, and are **git-ignored**. Deleting `.gate_secret`
  invalidates all sessions. Change the password with:
  `python3 -c "import server; server.set_password('NEW')"`.

## Components

| Piece | Port | Unit | Notes |
|-------|------|------|-------|
| Dashboard backend (`server.py`) | 7682 | `hub-dashboard.service` | SPA + `/api/*` + `/gate/*` |
| Browser terminal (`ttyd`)       | 7681 | `hub-ttyd.service` | runs `term.sh`, per-project tmux |
| Edge router (Caddy)             | 8088 | system `caddy`     | localhost-only; path routing + forward_auth |
| Public ingress (cloudflared)    | —    | `cloudflared` service | tunnel `terminalclaw` → `:8088` |

See [`deploy/`](../deploy) for the Caddy block, the cloudflared config template,
and the systemd units.

## Data the dashboard reads

- **Project registry:** `projects.json` — list of projects (id, name, dir,
  domains, containers, linked memory files). Edit to add/rename projects.
- **Container status:** live `docker ps` output, merged into the registry by
  `/api/projects`.
- **Memory/context:** whitelisted `.md` files under the configured memory dir,
  served read-only via `/api/memory` (basename-only, no path traversal).
