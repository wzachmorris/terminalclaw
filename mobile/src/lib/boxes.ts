// Box registry — the machines this app talks to. Stored on-device in the
// keychain (SecureStore): entries hold a session token, so they never leave
// the phone and nothing is hardcoded in this (public) repo.
import * as SecureStore from 'expo-secure-store';

export type Box = {
  id: string;
  name: string;
  url: string;        // e.g. https://minotaur.zacmorriss.com (no trailing /)
  token: string;      // 30-day session token from POST /api/login
  expiresAt: number;  // ms epoch
};

const KEY = 'tc.boxes';

export async function loadBoxes(): Promise<Box[]> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as Box[]; } catch { return []; }
}

async function save(boxes: Box[]) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(boxes));
}

export function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = 'https://' + u;
  return u;
}

export async function upsertBox(box: Box) {
  const boxes = await loadBoxes();
  const i = boxes.findIndex((b) => b.id === box.id);
  if (i >= 0) boxes[i] = box; else boxes.push(box);
  await save(boxes);
}

export async function deleteBox(id: string) {
  await save((await loadBoxes()).filter((b) => b.id !== id));
}

export async function getBox(id: string): Promise<Box | undefined> {
  return (await loadBoxes()).find((b) => b.id === id);
}

export function tokenAlive(box: Box): boolean {
  return !!box.token && box.expiresAt > Date.now() + 60_000;
}
