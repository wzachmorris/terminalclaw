#!/usr/bin/env bash
# TerminalClaw terminal launcher.
# ttyd runs:  ttyd --url-arg --writable bash /opt/terminalclaw/term.sh
# An optional project id is passed as $1 via the URL (?arg=<id>).
# It maps the id -> source dir from projects.json, then attaches to (or
# creates) a persistent tmux session for that project so sessions survive
# page reloads. With no arg it shows an interactive menu.

set -uo pipefail
# Resolve the hub's own directory so nothing is tied to one box's path
# (works at /opt/terminalclaw, /root/hub, anywhere the repo is checked out).
HUB_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
REG="${HUB_REGISTRY:-$HUB_DIR/projects.json}"
export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.nvm/versions/node/v22.22.0/bin"

reg_field() {
  # reg_field <id> <field>
  python3 - "$1" "$2" "$REG" <<'PY'
import json, sys
pid, field, reg = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(reg))
for p in data["projects"]:
    if p["id"] == pid:
        print(p.get(field, ""))
        break
PY
}

menu() {
  echo "=== TerminalClaw — pick a project ==="
  mapfile -t IDS   < <(python3 -c "import json;[print(p['id'])   for p in json.load(open('$REG'))['projects']]")
  mapfile -t NAMES < <(python3 -c "import json;[print(p['name']) for p in json.load(open('$REG'))['projects']]")
  PS3=$'\nProject #: '
  select _name in "${NAMES[@]}"; do
    if [[ -n "${REPLY:-}" && "$REPLY" -ge 1 && "$REPLY" -le "${#IDS[@]}" ]]; then
      PROJ="${IDS[$((REPLY-1))]}"; return 0
    fi
    echo "Invalid choice."
  done
}

PROJ="${1:-}"
# Only accept ids that exist in the registry; otherwise prompt.
if [[ -n "$PROJ" ]]; then
  VALID="$(reg_field "$PROJ" id)"
  [[ "$VALID" != "$PROJ" ]] && PROJ=""
fi
[[ -z "$PROJ" ]] && menu

DIR="$(reg_field "$PROJ" dir)"
[[ -z "$DIR" || ! -d "$DIR" ]] && DIR="$HOME"
NAME="$(reg_field "$PROJ" name)"; [[ -z "$NAME" ]] && NAME="$PROJ"
CMD="$(reg_field "$PROJ" command)"
SESSION="hub-${PROJ}"

# Build this project's CLAUDE.md (agent brief) up front, so it's in place before
# the shell starts. The `claude` wrapper (agent.bashrc) also refreshes it on each
# launch, so it always reflects the project's currently-attached tabs.
python3 "$HUB_DIR/gen_claude_md.py" "$PROJ" >/dev/null 2>&1 || true

clear
echo "🐾 ${NAME} — project agent"
echo "   dir:    ${DIR}"
echo "   brief:  CLAUDE.md (auto-built from this project's tabs)"
echo "   tmux:   ${SESSION}   (Ctrl-b d to detach)"
if [[ -n "$CMD" ]]; then
  echo "   run:    ${CMD}"
  echo
  exec tmux new-session -A -s "$SESSION" -e "TC_PROJECT=$PROJ" -e "TC_HUB=$HUB_DIR" -c "$DIR" "$CMD"
else
  echo
  echo "   type 'claude' — resumes your last chat + reads this project's memory"
  echo "                   ('command claude' starts a fresh conversation)"
  echo
  exec tmux new-session -A -s "$SESSION" -e "TC_PROJECT=$PROJ" -e "TC_HUB=$HUB_DIR" -c "$DIR" \
       "bash --rcfile $HUB_DIR/agent.bashrc -i"
fi
