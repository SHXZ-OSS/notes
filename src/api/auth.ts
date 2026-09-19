import { writable } from "svelte/store";
import { loadSettings, SS_FROM, type Settings } from "../config";
import {
  clearTokens,
  completeLogin,
  fetchUserinfo,
  loadTokens,
  refreshTokens,
  revokeToken,
  startLogin,
  tokenExpired,
  type Tokens,
} from "./oauth";

export interface AuthState {
  ready: boolean;
  authed: boolean;
  tokens: Tokens | null;
  user: Record<string, unknown> | null;
}

export const auth = writable<AuthState>({
  ready: false,
  authed: false,
  tokens: null,
  user: null,
});

export function userName(u: Record<string, unknown> | null): string {
  if (!u) return "";
  for (const k of [
    "name",
    "preferred_username",
    "nickname",
    "username",
    "login_name",
  ]) {
    if (typeof u[k] === "string" && u[k]) return u[k] as string;
  }
  return "";
}

let started = false;

export async function initAuth(): Promise<void> {
  if (started) return;
  started = true;
  const s = loadSettings();
  const t = loadTokens();
  if (!t) {
    auth.update((v) => ({ ...v, ready: true }));
    return;
  }
  let valid = t;
  if (tokenExpired(t)) {
    valid = (await tryRefreshSilently(s, t)) ?? t;
  }
  if (valid.refresh_token && !tokenExpired(valid)) {
    auth.update((v) => ({ ...v, ready: true, authed: true, tokens: valid }));
    const u = await fetchUserinfo(s, valid.access_token);
    auth.update((v) => ({ ...v, user: u }));
  } else {
    clearTokens();
    auth.update((v) => ({ ...v, ready: true }));
  }
}

export async function login(): Promise<void> {
  const from = sessionStorage.getItem(SS_FROM) ?? "/";
  await startLogin(loadSettings(), from);
}

export async function finishCallback(search: string): Promise<void> {
  const s = loadSettings();
  const { tokens: t } = await completeLogin(s, search);
  auth.update((v) => ({ ...v, authed: true, tokens: t }));
  const u = await fetchUserinfo(s, t.access_token);
  auth.update((v) => ({ ...v, user: u }));
}

export async function logout(): Promise<void> {
  const s = loadSettings();
  const t = loadTokens();
  if (t?.refresh_token) await revokeToken(s, t.refresh_token);
  clearTokens();
  auth.update((v) => ({ ...v, authed: false, tokens: null, user: null }));
}

export async function refreshNow(): Promise<boolean> {
  const s = loadSettings();
  const t = loadTokens();
  if (!t?.refresh_token) return false;
  const nt = await tryRefreshSilently(s, t);
  if (nt) {
    auth.update((v) => ({ ...v, authed: true, tokens: nt }));
    const u = await fetchUserinfo(s, nt.access_token);
    auth.update((v) => ({ ...v, user: u }));
    return true;
  }
  auth.update((v) => ({ ...v, authed: false, tokens: null, user: null }));
  return false;
}

async function tryRefreshSilently(
  s: Settings,
  t: Tokens,
): Promise<Tokens | null> {
  try {
    return await refreshTokens(s, t.refresh_token!);
  } catch {
    clearTokens();
    return null;
  }
}
