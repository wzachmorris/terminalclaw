// Thin client for each box's TerminalClaw server (server.py).
import { Box } from './boxes';

export class ApiError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

async function req(url: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'unreachable');
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, body.error || `HTTP ${r.status}`);
  return body;
}

// POST /api/login -> {token, expiresAt} (30-day HMAC session token)
export async function login(url: string, password: string):
    Promise<{ token: string; expiresAt: number }> {
  return req(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

export type Project = {
  id: string;
  name: string;
  dir: string;
  color?: string;
  hidden?: boolean;
  claude_running?: boolean;
  domains?: string[];
};

export async function getProjects(box: Box):
    Promise<{ title: string; projects: Project[] }> {
  return req(`${box.url}/api/projects`, {
    headers: { 'X-TC-Token': box.token },
  });
}

// URL the terminal WebView loads — the token doubles as the gate cookie,
// term.html plants it before loading anything else.
export function termUrl(box: Box, projectId: string): string {
  return `${box.url}/static/term.html?arg=${encodeURIComponent(projectId)}` +
         `&token=${encodeURIComponent(box.token)}`;
}

export async function setProjectHidden(box: Box, project: string, hidden: boolean) {
  return req(`${box.url}/api/project/hide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ project, hidden }),
  });
}

export async function deleteProject(box: Box, project: string) {
  return req(`${box.url}/api/project/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ project }),
  });
}

// Scrollback dump — backs the Copy button when nothing is selected.
export async function termCapture(box: Box, project: string):
    Promise<{ content: string }> {
  return req(`${box.url}/api/term/capture?project=${encodeURIComponent(project)}&lines=2000`, {
    headers: { 'X-TC-Token': box.token },
  });
}

// Latest tmux paste buffer — what a mouse-mode drag just copied. The Copy
// button's first choice: it's exactly what the user watched tmux capture.
export async function termBuffer(box: Box): Promise<{ content: string }> {
  return req(`${box.url}/api/term/buffer`, {
    headers: { 'X-TC-Token': box.token },
  });
}

// Toggle tmux mouse/scroll mode for a project's session (📜). Returns the
// new state ("on"/"off"); on = swipe scrolls history, off = selection mode.
export async function termMouse(box: Box, project: string, on: boolean):
    Promise<{ mouse: string }> {
  return req(`${box.url}/api/term/mouse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ project, on }),
  });
}

// Server-side input for 📖 reader mode — tmux send-keys / bracketed paste,
// so no terminal connection is needed to drive a session. `key` must be in
// the server's whitelist (arrows/enter/esc/space/tab/btab/ctrl-c/digits).
export async function termKey(box: Box, project: string, key: string) {
  return req(`${box.url}/api/term/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ project, key }),
  });
}

export async function termPaste(box: Box, project: string, text: string) {
  return req(`${box.url}/api/term/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ project, text }),
  });
}
