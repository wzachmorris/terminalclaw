// Thin client for each box's TerminalClaw server (server.py).
import { Box } from './boxes';

export class ApiError extends Error {
  constructor(public status: number, msg: string, public body?: any) { super(msg); }
}

async function req(url: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'unreachable');
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, body.error || `HTTP ${r.status}`, body);
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

// ＋ new tab: name + directory (server expands ~). With create=false a
// missing directory 400s with {missing_dir: true} so the caller can offer
// to mkdir -p it via a create=true retry.
export async function createProject(box: Box, name: string, dir: string, create = false):
    Promise<{ id: string }> {
  return req(`${box.url}/api/project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ name, dir, create }),
  });
}

// reorder a tab: swap with its neighbor (delta ±1); registry order is the
// tab order for every client
export async function moveProject(box: Box, project: string, delta: number) {
  return req(`${box.url}/api/project/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ project, delta }),
  });
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

// 💬 chat view: the project's Claude conversation from the transcript file
// Claude Code already writes — real message objects, no tmux screen-scraping.
// `since` = "<session>:<offset>" from the previous call for incremental reads.
export type ChatMsg = { role: string; text: string; ts: string };
export async function claudeTranscript(box: Box, project: string, since: string):
    Promise<{ session: string | null; offset: number; reset: boolean; messages: ChatMsg[] }> {
  return req(`${box.url}/api/claude/transcript?project=${encodeURIComponent(project)}` +
    `&since=${encodeURIComponent(since)}`, {
    headers: { 'X-TC-Token': box.token },
  });
}

// 📎 attach: ship a screenshot/file to the box; server saves it under
// /tmp/tc-uploads and returns the path, which goes into the prompt so
// Claude can read the image itself.
export async function uploadFile(box: Box, name: string, dataB64: string):
    Promise<{ path: string }> {
  return req(`${box.url}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ name, data: dataB64 }),
  });
}

export async function termPaste(box: Box, project: string, text: string) {
  return req(`${box.url}/api/term/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TC-Token': box.token },
    body: JSON.stringify({ project, text }),
  });
}
