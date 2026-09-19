/**
 * 慧云（xzzx-sis）OAuth：authorization_code + PKCE(S256)，公共客户端。
 *
 * 流程与 epadnote 安卓端同源同 IdP：
 *   1. 浏览器整页跳转 GET /api/oauth/authorize（带 code_challenge）
 *   2. 服务端 302 到 xzzx-sis 自带前端的 /login/oauth/authorize 同意页（站点 session cookie）
 *   3. 同意后跳回 redirect_uri?code=..&state=..
 *   4. POST /api/oauth/token 换 access_token(JWT) + refresh_token（轮换式，7 天）
 */
import {
  LS_TOKENS,
  SS_FROM,
  SS_OAUTH,
  currentRedirectUri,
  normBase,
  type Settings,
} from "../config";

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope?: string;
}

export interface OAuthError extends Error {
  error?: string;
  errorDescription?: string;
}

function randomB64url(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b64url(b);
}

function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256B64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return b64url(new Uint8Array(digest));
}

export function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(LS_TOKENS);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

export function saveTokens(t: Tokens): void {
  localStorage.setItem(LS_TOKENS, JSON.stringify(t));
}

export function clearTokens(): void {
  localStorage.removeItem(LS_TOKENS);
}

export function tokenExpired(t: Tokens): boolean {
  return Date.now() >= t.expires_at;
}

/** 发起登录：整页跳转到授权端点 */
export async function startLogin(
  settings: Settings,
  rememberPath: string,
): Promise<void> {
  const verifier = randomB64url(48);
  const challenge = await sha256B64url(verifier);
  const state = randomB64url(16);
  sessionStorage.setItem(
    SS_OAUTH,
    JSON.stringify({ verifier, state, createdAt: Date.now() }),
  );
  if (rememberPath) sessionStorage.setItem(SS_FROM, rememberPath);

  const base = normBase(settings.serverBase);
  const redirectUri = currentRedirectUri();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    scope: settings.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.assign(`${base}/api/oauth/authorize?${q.toString()}`);
}

interface PkceState {
  verifier: string;
  state: string;
}

function takePkceState(): PkceState | null {
  try {
    const raw = sessionStorage.getItem(SS_OAUTH);
    if (!raw) return null;
    sessionStorage.removeItem(SS_OAUTH);
    return JSON.parse(raw) as PkceState;
  } catch {
    return null;
  }
}

async function tokenRequest(
  settings: Settings,
  params: Record<string, string>,
): Promise<Tokens> {
  const base = normBase(settings.serverBase);
  const resp = await fetch(`${base}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const bodyText = await resp.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(bodyText);
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok || !body.access_token) {
    const err = new Error(
      String(
        body.error_description ??
          body.error ??
          `token 请求失败 (HTTP ${resp.status})`,
      ),
    ) as OAuthError;
    err.error = body.error as string | undefined;
    err.errorDescription = body.error_description as string | undefined;
    throw err;
  }
  const expiresIn =
    typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    access_token: String(body.access_token),
    refresh_token: body.refresh_token ? String(body.refresh_token) : undefined,
    expires_at: Date.now() + expiresIn * 1000 - 30_000,
    scope: body.scope ? String(body.scope) : undefined,
  };
}

/** 授权回调处理：验证 state、换 token */
export async function completeLogin(
  settings: Settings,
  search: string,
): Promise<{ tokens: Tokens; stateOk: boolean }> {
  // 后端把 code 拼在 fragment 之前：/{dir}?code=..#/callback → 先看 location.search
  const q = new URLSearchParams(search);
  const code = q.get("code");
  const state = q.get("state");
  const oauthError = q.get("error");

  const pkce = takePkceState();
  if (oauthError) {
    throw Object.assign(new Error(q.get("error_description") ?? "授权被拒绝"), {
      error: oauthError,
    });
  }
  if (!code) throw new Error("回调缺少 code 参数");
  const stateOk = !!pkce && state === pkce.state;
  if (!stateOk) throw new Error("state 校验失败，请重新登录");

  const tokens = await tokenRequest(settings, {
    grant_type: "authorization_code",
    code,
    redirect_uri: currentRedirectUri(),
    client_id: settings.clientId,
    code_verifier: pkce.verifier,
  });
  saveTokens(tokens);
  return { tokens, stateOk };
}

/** 用 refresh_token 换新 token（轮换式：旧 token 立即作废） */
export async function refreshTokens(
  settings: Settings,
  refreshToken: string,
): Promise<Tokens> {
  const tokens = await tokenRequest(settings, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: settings.clientId,
  });
  saveTokens(tokens);
  return tokens;
}

/** 吊销 refresh_token（退出登录时尽力而为） */
export async function revokeToken(
  settings: Settings,
  token: string,
): Promise<void> {
  try {
    const base = normBase(settings.serverBase);
    await fetch(`${base}/api/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        client_id: settings.clientId,
      }).toString(),
    });
  } catch {
    /* 忽略 */
  }
}

export async function fetchUserinfo(
  settings: Settings,
  accessToken: string,
): Promise<Record<string, unknown> | null> {
  try {
    const base = normBase(settings.serverBase);
    const resp = await fetch(`${base}/api/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
